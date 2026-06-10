/**
 * Set each persona account's Slack profile: real name, display name, title,
 * and avatar — so the real sandbox accounts look like the cast.
 *
 * Prerequisites
 * -------------
 * Per-persona user tokens in .env (SLACK_USER_TOKEN_<SLUG>=xoxp-...), collected
 * via `pnpm slack:user-tokens`. Personas without a token are skipped with a note.
 *
 * Uses (per persona, with that persona's own token):
 *   - users.profile.set  → real_name, display_name, title   (scope users.profile:write)
 *   - users.setPhoto     → avatar from the card's avatar_url (scope users.profile:write)
 *
 * Run
 * ---
 *   pnpm slack:profiles
 */
import { Cause, Effect, Exit } from "effect";
import {
  type AvatarInvalidError,
  type Persona,
  type PersonasParseError,
  SlackApiError,
  type SlackRateLimitedError,
  fetchAvatar,
  loadPersonas,
  makeSlackApi,
  userTokenEnvKey,
} from "./lib.ts";

type ProfilesError =
  | PersonasParseError
  | AvatarInvalidError
  | SlackApiError
  | SlackRateLimitedError;

/** users.setPhoto is multipart, unlike every JSON method in makeSlackApi. */
const setPhoto = (
  token: string,
  persona: Persona,
): Effect.Effect<void, AvatarInvalidError | SlackApiError> =>
  Effect.gen(function* () {
    const avatar = yield* fetchAvatar(persona);
    const form = new FormData();
    form.append("image", new Blob([avatar.bytes], { type: avatar.contentType }), "avatar");
    const data = yield* Effect.tryPromise({
      try: () =>
        fetch("https://slack.com/api/users.setPhoto", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        }).then((res) => res.json() as Promise<{ ok: boolean; error?: string }>),
      catch: (cause) =>
        new SlackApiError({ method: "users.setPhoto", code: `transport_error: ${String(cause)}` }),
    });
    if (!data.ok) {
      return yield* Effect.fail(
        new SlackApiError({ method: "users.setPhoto", code: data.error ?? "unknown_error" }),
      );
    }
  });

const setupProfile = (token: string, persona: Persona): Effect.Effect<void, ProfilesError> =>
  Effect.gen(function* () {
    const api = makeSlackApi(token);
    const identity = yield* api("auth.test", {});
    yield* api("users.profile.set", {
      profile: {
        real_name: persona.name,
        display_name: persona.name,
        title: persona.role,
      },
    });
    yield* setPhoto(token, persona);
    yield* Effect.log(
      `profile set for ${persona.slug} (${persona.name}) on account ${identity.user ?? "?"} (${identity.user_id ?? "?"})`,
    );
    yield* Effect.sleep("1 second");
  });

const program = Effect.gen(function* () {
  const personas = yield* loadPersonas;

  const withTokens: Array<{ persona: Persona; token: string }> = [];
  for (const persona of personas) {
    const token = process.env[userTokenEnvKey(persona.slug)];
    if (token !== undefined && token !== "") {
      withTokens.push({ persona, token });
    } else {
      yield* Effect.log(
        `skip ${persona.slug} — no ${userTokenEnvKey(persona.slug)} in .env (run pnpm slack:user-tokens)`,
      );
    }
  }

  yield* Effect.forEach(
    withTokens,
    ({ persona, token }) => setupProfile(token, persona),
    { concurrency: 1 }, // sequential: throttling
  );
  yield* Effect.log(`done. ${withTokens.length}/${personas.length} profiles updated.`);
});

const fail = Effect.sync(() => {
  process.exitCode = 1;
});

const main = program.pipe(
  Effect.catchTags({
    PersonasParseError: (e) =>
      Effect.logError(`PERSONAS.md could not be parsed: ${e.reason}`).pipe(Effect.andThen(fail)),
    AvatarInvalidError: (e) =>
      Effect.logError(
        `avatar for "${e.slug}" is not a usable image (${e.detail}): ${e.url}`,
      ).pipe(Effect.andThen(fail)),
    SlackApiError: (e) =>
      Effect.logError(`Slack API ${e.method} failed: ${e.code}`).pipe(Effect.andThen(fail)),
    SlackRateLimitedError: (e) =>
      Effect.logError(
        `Slack API ${e.method} still rate-limited after retries (last Retry-After: ${e.retryAfterSeconds}s)`,
      ).pipe(Effect.andThen(fail)),
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
