/**
 * Collect a Slack *user* token (xoxp-...) for each persona's real sandbox account.
 *
 * Why
 * ---
 * Real per-persona accounts (mentionable, in the member directory, can DM each
 * other) can only post as themselves with their own user token. Slack issues
 * user tokens exclusively through the OAuth flow, so each persona account must
 * authorize our app once. This script walks that flow persona-by-persona
 * without needing a local HTTPS server: you log in as the persona, open the
 * printed authorize URL, approve, and paste the redirect URL (or just its
 * `code` param) back here. The exchanged token is appended to `.env`.
 *
 * One-time app setup (adds to the manifest in seed-personas.ts)
 * -------------------------------------------------------------
 *   oauth_config:
 *     redirect_urls:
 *       - https://debuggingfuture.com/slack-oauth   # any HTTPS URL you control; page content is irrelevant
 *     scopes:
 *       user:
 *         - chat:write            # post as the persona
 *         - users.profile:write   # set display name + avatar (setup-profiles.ts)
 *
 * Reinstall is NOT needed for redirect URLs / user scopes — they take effect on
 * the next authorize. Client ID + secret are under the app's "Basic Information".
 *
 * Environment
 * -----------
 *   SLACK_CLIENT_ID          (required) app client id
 *   SLACK_CLIENT_SECRET      (required) app client secret
 *   SLACK_OAUTH_REDIRECT_URL (required) must exactly match a redirect URL on the app
 *   PERSONA_EMAIL_DOMAIN     (optional) email-hint domain, default "debuggingfuture.com"
 *
 * Run
 * ---
 *   pnpm slack:user-tokens
 *
 * For each persona without a SLACK_USER_TOKEN_<SLUG> in .env:
 *   1. Sign in to the sandbox in a private/incognito window as
 *      pied-piper-sim-<slug>@<domain>.
 *   2. Open the printed URL in that window, click Allow.
 *   3. The browser lands on the redirect URL with ?code=... — paste the full
 *      URL (or the code) here. Press Enter on an empty line to skip a persona.
 */
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Cause, Effect, Exit, Schema } from "effect";
import {
  MissingEnvError,
  type Persona,
  type PersonasParseError,
  SlackApiError,
  type SlackRateLimitedError,
  loadPersonas,
  makeSlackApi,
  repoRoot,
  userTokenEnvKey,
} from "./lib.ts";

export class EnvFileError extends Schema.TaggedError<EnvFileError>()(
  "EnvFileError",
  { detail: Schema.String },
) {}

const USER_SCOPES = "chat:write,users.profile:write";

type CollectError =
  | MissingEnvError
  | PersonasParseError
  | SlackApiError
  | SlackRateLimitedError
  | EnvFileError;

const requireEnv = (variable: string): Effect.Effect<string, MissingEnvError> => {
  const value = process.env[variable];
  return value !== undefined && value !== ""
    ? Effect.succeed(value)
    : Effect.fail(new MissingEnvError({ variable }));
};

/** Read one line from the terminal. Rejection (ctrl-d) surfaces as a defect — fine for a CLI. */
const ask = (question: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  });

/** Accept either the bare code or the full pasted redirect URL. */
const extractCode = (input: string): string =>
  URL.canParse(input) ? (new URL(input).searchParams.get("code") ?? input) : input;

interface OAuthAccessResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly authed_user?: {
    readonly id?: string;
    readonly access_token?: string;
    readonly token_type?: string;
  };
}

const exchangeCode = (
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  code: string,
): Effect.Effect<string, SlackApiError> =>
  Effect.tryPromise({
    try: () =>
      fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      }).then((res) => res.json() as Promise<OAuthAccessResponse>),
    catch: (cause) =>
      new SlackApiError({ method: "oauth.v2.access", code: `transport_error: ${String(cause)}` }),
  }).pipe(
    Effect.flatMap((data) => {
      const token = data.authed_user?.access_token;
      return data.ok && token !== undefined
        ? Effect.succeed(token)
        : Effect.fail(
            new SlackApiError({
              method: "oauth.v2.access",
              code: data.error ?? "no_user_token_in_response",
            }),
          );
    }),
  );

const appendToEnvFile = (key: string, value: string): Effect.Effect<void, EnvFileError> =>
  Effect.tryPromise({
    try: () => appendFile(join(repoRoot, ".env"), `${key}=${value}\n`),
    catch: (cause) => new EnvFileError({ detail: String(cause) }),
  });

const collectForPersona = (
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  emailDomain: string,
  persona: Persona,
): Effect.Effect<void, CollectError> =>
  Effect.gen(function* () {
    const envKey = userTokenEnvKey(persona.slug);
    const authorizeUrl =
      "https://slack.com/oauth/v2/authorize" +
      `?client_id=${encodeURIComponent(clientId)}` +
      `&user_scope=${encodeURIComponent(USER_SCOPES)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(persona.slug)}`;

    yield* Effect.log(
      `\n=== ${persona.name} (${persona.slug}) ===\n` +
        `1. In a private window, sign in to the sandbox as pied-piper-sim-${persona.slug}@${emailDomain}\n` +
        `2. Open:\n   ${authorizeUrl}\n` +
        `3. Click Allow, then paste the redirect URL (or its code=) below.`,
    );
    const input = yield* ask(`code for ${persona.slug} (empty to skip): `);
    if (input === "") {
      yield* Effect.log(`skipped ${persona.slug}`);
      return;
    }
    const token = yield* exchangeCode(clientId, clientSecret, redirectUri, extractCode(input));

    // Sanity check: whose token did we actually get?
    const identity = yield* makeSlackApi(token)("auth.test", {});
    yield* Effect.log(
      `captured token for ${persona.slug} → ${identity.user ?? "?"} (${identity.user_id ?? "?"})`,
    );
    yield* appendToEnvFile(envKey, token);
    yield* Effect.log(`wrote ${envKey} to .env`);
  });

const program = Effect.gen(function* () {
  const clientId = yield* requireEnv("SLACK_CLIENT_ID");
  const clientSecret = yield* requireEnv("SLACK_CLIENT_SECRET");
  const redirectUri = yield* requireEnv("SLACK_OAUTH_REDIRECT_URL");
  const emailDomain =
    process.env.PERSONA_EMAIL_DOMAIN !== undefined && process.env.PERSONA_EMAIL_DOMAIN !== ""
      ? process.env.PERSONA_EMAIL_DOMAIN
      : "debuggingfuture.com";

  const personas = yield* loadPersonas;
  const pending = personas.filter((p) => {
    const existing = process.env[userTokenEnvKey(p.slug)];
    return existing === undefined || existing === "";
  });
  yield* Effect.log(
    `${personas.length} personas; ${personas.length - pending.length} already have tokens; collecting ${pending.length}`,
  );

  yield* Effect.forEach(
    pending,
    (persona) => collectForPersona(clientId, clientSecret, redirectUri, emailDomain, persona),
    { concurrency: 1 }, // strictly sequential: one human, one browser
  );
  yield* Effect.log("done. Run `pnpm slack:profiles` next to set names + avatars.");
});

const fail = Effect.sync(() => {
  process.exitCode = 1;
});

const main = program.pipe(
  Effect.catchTags({
    MissingEnvError: (e) =>
      Effect.logError(
        `${e.variable} is not set — see the header of this script for app setup.`,
      ).pipe(Effect.andThen(fail)),
    PersonasParseError: (e) =>
      Effect.logError(`PERSONAS.md could not be parsed: ${e.reason}`).pipe(Effect.andThen(fail)),
    SlackApiError: (e) =>
      Effect.logError(`Slack API ${e.method} failed: ${e.code}`).pipe(Effect.andThen(fail)),
    SlackRateLimitedError: (e) =>
      Effect.logError(
        `Slack API ${e.method} still rate-limited after retries (last Retry-After: ${e.retryAfterSeconds}s)`,
      ).pipe(Effect.andThen(fail)),
    EnvFileError: (e) =>
      Effect.logError(`could not append to .env: ${e.detail}`).pipe(Effect.andThen(fail)),
  }),
);

void Effect.runPromiseExit(main).then(
  Exit.match({
    onSuccess: () => undefined,
    onFailure: (cause) => {
      console.error(Cause.pretty(cause));
      process.exitCode = 1;
    },
  }),
);
