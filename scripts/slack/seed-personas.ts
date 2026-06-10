/**
 * Seed the Pied Piper persona cast into a Slack channel.
 *
 * Reads the persona cards from PERSONAS.md (the single source of truth — see
 * CLAUDE.md §5) and posts one short in-character intro message per persona so
 * the persona's name + avatar render in Slack.
 *
 * Persona mechanism (sanctioned, single-app)
 * ------------------------------------------
 * Uses `chat.postMessage` with the `username` + `icon_url` overrides. This is
 * the Slack-sanctioned way for ONE app to speak as many characters. We do NOT
 * create fake human user accounts (against Slack ToS, and unnecessary).
 *
 * Target workspace
 * ----------------
 * Intended for a Slack Developer Program sandbox workspace
 * (https://docs.slack.dev/tools/developer-sandboxes) — free, disposable, and
 * isolated from any real workspace.
 *
 * Slack app setup (one-time)
 * --------------------------
 * Create an app from a manifest at https://api.slack.com/apps → "Create New
 * App" → "From a manifest", install it into the sandbox, then copy the Bot
 * User OAuth Token (xoxb-...). Manifest:
 *
 *   display_information:
 *     name: pied-piper-sim
 *   features:
 *     bot_user:
 *       display_name: pied-piper-sim
 *   oauth_config:
 *     scopes:
 *       bot:
 *         - chat:write            # post messages
 *         - chat:write.customize  # username + icon_url overrides (the persona mechanism)
 *         - channels:read         # resolve channel name -> ID
 *         - channels:join         # join the target public channel
 *         - channels:history      # idempotency: read back already-seeded personas
 *
 * Environment
 * -----------
 *   SLACK_BOT_TOKEN  (required) bot token, xoxb-...
 *   SLACK_CHANNEL    (optional) channel name or ID; default "#pied-piper"
 *
 * Run
 * ---
 *   pnpm seed:slack             # seed; skip personas already in the channel
 *   pnpm seed:slack --replace   # delete previously seeded intros, then re-seed all
 *
 * (`.env` at the repo root is loaded automatically via node --env-file-if-exists.)
 *
 * Behavior
 * --------
 * - Validates each persona's avatar_url (HEAD must be 2xx image/*) before posting.
 * - Idempotent: every intro carries Slack message metadata
 *   { event_type: "persona_seeded", event_payload: { persona_slug } }; recent
 *   channel history is scanned first and already-seeded personas are skipped.
 * - --replace: instead of skipping, every previously seeded intro (found via the
 *   same metadata markers) is chat.delete'd first, then the full cast is
 *   re-posted. Useful when persona cards change — Slack sandboxes cap the cast
 *   size, so we swap messages in place rather than accumulate.
 * - Throttled to <= 1 message/sec; 429s honor Retry-After via Effect Schedule.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cause, Duration, Effect, Exit, Schedule, Schema } from "effect";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class MissingTokenError extends Schema.TaggedError<MissingTokenError>()(
  "MissingTokenError",
  { variable: Schema.String },
) {}

export class PersonasParseError extends Schema.TaggedError<PersonasParseError>()(
  "PersonasParseError",
  { reason: Schema.String },
) {}

export class AvatarInvalidError extends Schema.TaggedError<AvatarInvalidError>()(
  "AvatarInvalidError",
  {
    slug: Schema.String,
    url: Schema.String,
    detail: Schema.String,
  },
) {}

export class SlackApiError extends Schema.TaggedError<SlackApiError>()(
  "SlackApiError",
  {
    method: Schema.String,
    /** Slack's `error` code (e.g. "channel_not_found", "missing_scope"), or a transport description. */
    code: Schema.String,
  },
) {}

export class SlackRateLimitedError extends Schema.TaggedError<SlackRateLimitedError>()(
  "SlackRateLimitedError",
  {
    method: Schema.String,
    retryAfterSeconds: Schema.Number,
  },
) {}

type SeedError =
  | MissingTokenError
  | PersonasParseError
  | AvatarInvalidError
  | SlackApiError
  | SlackRateLimitedError;

// ---------------------------------------------------------------------------
// Persona cards — parsed straight out of PERSONAS.md
// ---------------------------------------------------------------------------

const Persona = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  role: Schema.String,
  reports_to: Schema.NullOr(Schema.String),
  voice: Schema.String,
  sentiments: Schema.Array(Schema.String),
  intents: Schema.Array(Schema.String),
  quirks: Schema.Array(Schema.String),
  catchphrases: Schema.Array(Schema.String),
  avatar_url: Schema.String,
  intro: Schema.String,
});
type Persona = typeof Persona.Type;

const PersonaFromJsonBlock = Schema.parseJson(Persona);

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const personasPath = join(repoRoot, "PERSONAS.md");

/** Tooling contract (documented in PERSONAS.md): one ```json persona fence per card. */
const PERSONA_BLOCK = /```json persona\n([\s\S]*?)```/g;

const loadPersonas: Effect.Effect<ReadonlyArray<Persona>, PersonasParseError> =
  Effect.tryPromise({
    try: () => readFile(personasPath, "utf8"),
    catch: (cause) =>
      new PersonasParseError({ reason: `cannot read PERSONAS.md: ${String(cause)}` }),
  }).pipe(
    Effect.flatMap((markdown) => {
      const blocks = [...markdown.matchAll(PERSONA_BLOCK)].map((m) => m[1] ?? "");
      if (blocks.length === 0) {
        return Effect.fail(
          new PersonasParseError({ reason: "no ```json persona blocks found in PERSONAS.md" }),
        );
      }
      return Effect.forEach(blocks, (block, i) =>
        Schema.decodeUnknown(PersonaFromJsonBlock)(block).pipe(
          Effect.mapError(
            (parseError) =>
              new PersonasParseError({
                reason: `persona block #${i + 1} is invalid: ${parseError.message}`,
              }),
          ),
        ),
      );
    }),
  );

// ---------------------------------------------------------------------------
// Minimal Slack Web API client (fetch + Effect, no SDK)
// ---------------------------------------------------------------------------

interface SlackMessage {
  readonly ts?: string;
  readonly metadata?: {
    readonly event_type?: string;
    readonly event_payload?: { readonly persona_slug?: string };
  };
}

interface SlackOkResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly channels?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly messages?: ReadonlyArray<SlackMessage>;
  readonly response_metadata?: { readonly next_cursor?: string };
}

/**
 * Honors 429 Retry-After: the schedule's delay is taken from the error itself.
 * (`_tag` access inside Schedule predicates is the one sanctioned exception.)
 */
const rateLimitRetryPolicy = Schedule.identity<SeedError>().pipe(
  Schedule.whileInput((e: SeedError) => e._tag === "SlackRateLimitedError"),
  Schedule.addDelay((e) =>
    e._tag === "SlackRateLimitedError"
      ? Duration.seconds(Math.max(1, e.retryAfterSeconds))
      : Duration.zero,
  ),
  Schedule.intersect(Schedule.recurs(3)),
);

const makeSlackApi =
  (token: string) =>
  (
    method: string,
    payload: Record<string, unknown>,
  ): Effect.Effect<SlackOkResponse, SlackApiError | SlackRateLimitedError> => {
    const callOnce = Effect.gen(function* () {
      const res = yield* Effect.tryPromise({
        try: () =>
          fetch(`https://slack.com/api/${method}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify(payload),
          }),
        catch: (cause) => new SlackApiError({ method, code: `transport_error: ${String(cause)}` }),
      });
      if (res.status === 429) {
        const retryAfterSeconds = Number(res.headers.get("retry-after") ?? "1");
        return yield* Effect.fail(
          new SlackRateLimitedError({
            method,
            retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 1,
          }),
        );
      }
      const data = yield* Effect.tryPromise({
        try: () => res.json() as Promise<SlackOkResponse>,
        catch: (cause) => new SlackApiError({ method, code: `invalid_json: ${String(cause)}` }),
      });
      if (!data.ok) {
        return yield* Effect.fail(new SlackApiError({ method, code: data.error ?? "unknown_error" }));
      }
      return data;
    });
    return callOnce.pipe(Effect.retry(rateLimitRetryPolicy));
  };

type SlackApi = ReturnType<typeof makeSlackApi>;

// ---------------------------------------------------------------------------
// Channel resolution + membership
// ---------------------------------------------------------------------------

const resolveChannelId = (
  api: SlackApi,
  channel: string,
): Effect.Effect<string, SlackApiError | SlackRateLimitedError> => {
  if (/^[CG][A-Z0-9]+$/.test(channel)) return Effect.succeed(channel);
  const name = channel.replace(/^#/, "");
  const page = (
    cursor: string | undefined,
  ): Effect.Effect<string, SlackApiError | SlackRateLimitedError> =>
    api("conversations.list", {
      types: "public_channel",
      exclude_archived: true,
      limit: 200,
      ...(cursor !== undefined && cursor !== "" ? { cursor } : {}),
    }).pipe(
      Effect.flatMap((data) => {
        const hit = (data.channels ?? []).find((c) => c.name === name);
        if (hit !== undefined) return Effect.succeed(hit.id);
        const next = data.response_metadata?.next_cursor;
        return next !== undefined && next !== ""
          ? page(next)
          : Effect.fail(
              new SlackApiError({ method: "conversations.list", code: `channel_not_found: #${name}` }),
            );
      }),
    );
  return page(undefined);
};

/** Join the channel so we can read history + post. Public channels only; fails loudly otherwise. */
const ensureMembership = (
  api: SlackApi,
  channelId: string,
): Effect.Effect<void, SlackApiError | SlackRateLimitedError> =>
  api("conversations.join", { channel: channelId }).pipe(
    Effect.asVoid,
    Effect.catchTag("SlackApiError", (e) =>
      e.code === "already_in_channel"
        ? Effect.void
        : Effect.fail(
            new SlackApiError({
              method: e.method,
              code: `${e.code} — bot could not join the channel. For private channels, /invite the app manually; also check the channels:join scope.`,
            }),
          ),
    ),
  );

// ---------------------------------------------------------------------------
// Idempotency — scan recent history for our persona_seeded metadata markers
// ---------------------------------------------------------------------------

const SEED_EVENT_TYPE = "persona_seeded";

interface SeededIntro {
  readonly slug: string;
  readonly ts: string;
}

const seededIntros = (
  api: SlackApi,
  channelId: string,
): Effect.Effect<ReadonlyArray<SeededIntro>, SlackApiError | SlackRateLimitedError> =>
  api("conversations.history", {
    channel: channelId,
    limit: 200,
    include_all_metadata: true,
  }).pipe(
    Effect.map((data) => {
      const intros: Array<SeededIntro> = [];
      for (const message of data.messages ?? []) {
        const meta = message.metadata;
        const slug = meta?.event_payload?.persona_slug;
        if (meta?.event_type === SEED_EVENT_TYPE && slug !== undefined && message.ts !== undefined) {
          intros.push({ slug, ts: message.ts });
        }
      }
      return intros;
    }),
  );

/** chat.delete our own previously seeded intro. A message deleted out from under us is success. */
const deleteSeededIntro = (
  api: SlackApi,
  channelId: string,
  intro: SeededIntro,
): Effect.Effect<void, SlackApiError | SlackRateLimitedError> =>
  Effect.gen(function* () {
    yield* api("chat.delete", { channel: channelId, ts: intro.ts }).pipe(
      Effect.catchTag("SlackApiError", (e) =>
        e.code === "message_not_found"
          ? Effect.succeed<SlackOkResponse>({ ok: true })
          : Effect.fail(e),
      ),
    );
    yield* Effect.log(`deleted previous intro for ${intro.slug}`);
    // Same throttle as posting: chat.delete sits in the same rate-limit tier.
    yield* Effect.sleep("1 second");
  });

// ---------------------------------------------------------------------------
// Avatar validation — HEAD must be 2xx with an image/* content-type
// ---------------------------------------------------------------------------

const validateAvatar = (persona: Persona): Effect.Effect<void, AvatarInvalidError> =>
  Effect.tryPromise({
    try: () => fetch(persona.avatar_url, { method: "HEAD", redirect: "follow" }),
    catch: (cause) =>
      new AvatarInvalidError({
        slug: persona.slug,
        url: persona.avatar_url,
        detail: `request failed: ${String(cause)}`,
      }),
  }).pipe(
    Effect.flatMap((res) => {
      const contentType = res.headers.get("content-type") ?? "<none>";
      return res.ok && contentType.startsWith("image/")
        ? Effect.void
        : Effect.fail(
            new AvatarInvalidError({
              slug: persona.slug,
              url: persona.avatar_url,
              detail: `HTTP ${res.status}, content-type ${contentType}`,
            }),
          );
    }),
  );

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

const seedPersona = (
  api: SlackApi,
  channelId: string,
  persona: Persona,
): Effect.Effect<void, SeedError> =>
  Effect.gen(function* () {
    yield* validateAvatar(persona);
    yield* api("chat.postMessage", {
      channel: channelId,
      text: persona.intro,
      username: persona.name,
      icon_url: persona.avatar_url,
      unfurl_links: false,
      unfurl_media: false,
      metadata: {
        event_type: SEED_EVENT_TYPE,
        event_payload: { persona_slug: persona.slug },
      },
    });
    yield* Effect.log(`seeded ${persona.slug} (${persona.name})`);
    // Throttle: stay at or under 1 message/sec (chat.postMessage tier guidance).
    yield* Effect.sleep("1 second");
  });

const program = Effect.gen(function* () {
  const token = process.env.SLACK_BOT_TOKEN;
  if (token === undefined || token === "") {
    return yield* Effect.fail(new MissingTokenError({ variable: "SLACK_BOT_TOKEN" }));
  }
  // `??` alone is not enough: an empty `SLACK_CHANNEL=` line in .env yields "".
  const channelEnv = process.env.SLACK_CHANNEL;
  const channel = channelEnv !== undefined && channelEnv !== "" ? channelEnv : "#pied-piper";
  const replace = process.argv.includes("--replace");
  const api = makeSlackApi(token);

  const personas = yield* loadPersonas;
  yield* Effect.log(`loaded ${personas.length} persona cards from PERSONAS.md`);

  const channelId = yield* resolveChannelId(api, channel);
  yield* ensureMembership(api, channelId);

  const existing = yield* seededIntros(api, channelId);
  if (replace && existing.length > 0) {
    yield* Effect.log(`--replace: deleting ${existing.length} previously seeded intro(s)`);
    yield* Effect.forEach(existing, (intro) => deleteSeededIntro(api, channelId, intro), {
      concurrency: 1, // sequential: throttling
    });
  }
  const seeded: ReadonlySet<string> = replace
    ? new Set<string>()
    : new Set(existing.map((intro) => intro.slug));

  yield* Effect.forEach(
    personas,
    (persona) =>
      seeded.has(persona.slug)
        ? Effect.log(`skip ${persona.slug} — already seeded in ${channel} (use --replace to re-seed)`)
        : seedPersona(api, channelId, persona),
    { concurrency: 1 }, // sequential: ordering + throttling
  );
  yield* Effect.log("done.");
});

const fail = Effect.sync(() => {
  process.exitCode = 1;
});

// Recover every domain error inside the Effect (no try/catch around runPromise).
const main = program.pipe(
  Effect.catchTags({
    MissingTokenError: (e) =>
      Effect.logError(
        `${e.variable} is not set. Export a bot token (xoxb-...) from your sandbox Slack app — see the header of this script.`,
      ).pipe(Effect.andThen(fail)),
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
      // Only defects reach here — all domain errors are recovered above.
      console.error(Cause.pretty(cause));
      process.exitCode = 1;
    },
  }),
);
