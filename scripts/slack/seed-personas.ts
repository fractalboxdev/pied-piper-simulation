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
 * create fake human user accounts here — for real per-persona accounts in the
 * sandbox (mentionable, in the member directory), see collect-user-tokens.ts
 * and setup-profiles.ts.
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
 * (A repo-root `.env` is injected automatically via dotenvx — `pnpm seed:slack`
 * runs `dotenvx run -- tsx ...`. The script itself just reads process.env.)
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
import { Cause, Effect, Exit } from "effect";
import {
  type AvatarInvalidError,
  MissingEnvError,
  type Persona,
  type PersonasParseError,
  type SlackApi,
  SlackApiError,
  type SlackCallError,
  type SlackOkResponse,
  type SlackRateLimitedError,
  loadPersonas,
  makeSlackApi,
  validateAvatar,
} from "./lib.ts";

type SeedError =
  | MissingEnvError
  | PersonasParseError
  | AvatarInvalidError
  | SlackApiError
  | SlackRateLimitedError;

// ---------------------------------------------------------------------------
// Channel resolution + membership
// ---------------------------------------------------------------------------

const resolveChannelId = (
  api: SlackApi,
  channel: string,
): Effect.Effect<string, SlackCallError> => {
  if (/^[CG][A-Z0-9]+$/.test(channel)) return Effect.succeed(channel);
  const name = channel.replace(/^#/, "");
  const page = (cursor: string | undefined): Effect.Effect<string, SlackCallError> =>
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
): Effect.Effect<void, SlackCallError> =>
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
): Effect.Effect<ReadonlyArray<SeededIntro>, SlackCallError> =>
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

/**
 * chat.delete our own previously seeded intro. A message deleted out from under
 * us is success; cant_delete_message (intro posted by a previous app install's
 * bot identity — e.g. workspace-level vs org-level installs are distinct bots)
 * is warned and skipped so --replace still posts the fresh cast.
 */
const deleteSeededIntro = (
  api: SlackApi,
  channelId: string,
  intro: SeededIntro,
): Effect.Effect<void, SlackCallError> =>
  Effect.gen(function* () {
    const outcome = yield* api("chat.delete", { channel: channelId, ts: intro.ts }).pipe(
      Effect.as("deleted" as const),
      Effect.catchTag("SlackApiError", (e) =>
        e.code === "message_not_found"
          ? Effect.succeed("already-gone" as const)
          : e.code === "cant_delete_message"
            ? Effect.succeed("not-ours" as const)
            : Effect.fail(e),
      ),
    );
    yield* outcome === "not-ours"
      ? Effect.logWarning(
          `cannot delete old intro for ${intro.slug} (ts ${intro.ts}) — posted by a different app install; remove it manually`,
        )
      : Effect.log(`deleted previous intro for ${intro.slug}`);
    // Same throttle as posting: chat.delete sits in the same rate-limit tier.
    yield* Effect.sleep("1 second");
  });

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
    return yield* Effect.fail(new MissingEnvError({ variable: "SLACK_BOT_TOKEN" }));
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
    MissingEnvError: (e) =>
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
