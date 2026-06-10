/**
 * Shared pieces for the Slack persona scripts (seed-personas, collect-user-tokens,
 * setup-profiles): persona cards parsed from PERSONAS.md, a minimal fetch+Effect
 * Slack Web API client with 429 handling, and avatar helpers.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Duration, Effect, Schedule, Schema } from "effect";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class MissingEnvError extends Schema.TaggedError<MissingEnvError>()(
  "MissingEnvError",
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

export type SlackCallError = SlackApiError | SlackRateLimitedError;

// ---------------------------------------------------------------------------
// Persona cards — parsed straight out of PERSONAS.md
// ---------------------------------------------------------------------------

export const Persona = Schema.Struct({
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
  avatar_file: Schema.String,
  intro: Schema.String,
});
export type Persona = typeof Persona.Type;

const PersonaFromJsonBlock = Schema.parseJson(Persona);

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const personasPath = join(repoRoot, "PERSONAS.md");

/** Tooling contract (documented in PERSONAS.md): one ```json persona fence per card. */
const PERSONA_BLOCK = /```json persona\n([\s\S]*?)```/g;

export const loadPersonas: Effect.Effect<ReadonlyArray<Persona>, PersonasParseError> =
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

/** .env key that holds a persona account's user token (xoxp-...). */
export const userTokenEnvKey = (slug: string): string =>
  `SLACK_USER_TOKEN_${slug.toUpperCase()}`;

// ---------------------------------------------------------------------------
// Minimal Slack Web API client (fetch + Effect, no SDK)
// ---------------------------------------------------------------------------

export interface SlackMessage {
  readonly ts?: string;
  readonly metadata?: {
    readonly event_type?: string;
    readonly event_payload?: { readonly persona_slug?: string };
  };
}

export interface SlackOkResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly channels?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly messages?: ReadonlyArray<SlackMessage>;
  readonly response_metadata?: { readonly next_cursor?: string };
  readonly user_id?: string;
  readonly user?: string;
  readonly team?: string;
}

/**
 * Honors 429 Retry-After: the schedule's delay is taken from the error itself.
 * (`_tag` access inside Schedule predicates is the one sanctioned exception.)
 */
const rateLimitRetryPolicy = Schedule.identity<SlackCallError>().pipe(
  Schedule.whileInput((e: SlackCallError) => e._tag === "SlackRateLimitedError"),
  Schedule.addDelay((e) =>
    e._tag === "SlackRateLimitedError"
      ? Duration.seconds(Math.max(1, e.retryAfterSeconds))
      : Duration.zero,
  ),
  Schedule.intersect(Schedule.recurs(3)),
);

export const makeSlackApi =
  (token: string) =>
  (
    method: string,
    payload: Record<string, unknown>,
  ): Effect.Effect<SlackOkResponse, SlackCallError> => {
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

export type SlackApi = ReturnType<typeof makeSlackApi>;

// ---------------------------------------------------------------------------
// Avatar helpers
// ---------------------------------------------------------------------------

/**
 * Slack renders icon_url avatars only for jpeg/png/gif — webp is silently
 * dropped (the message falls back to the default app icon). Fandom's CDN
 * content-negotiates to webp unless the URL carries `format=original`
 * (the PERSONAS.md contract for avatar_url).
 */
const SLACK_SAFE_IMAGE = /^image\/(jpeg|png|gif)\b/;

/** HEAD must be 2xx with a Slack-renderable image content-type (not webp). */
export const validateAvatar = (persona: Persona): Effect.Effect<void, AvatarInvalidError> =>
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
      return res.ok && SLACK_SAFE_IMAGE.test(contentType)
        ? Effect.void
        : Effect.fail(
            new AvatarInvalidError({
              slug: persona.slug,
              url: persona.avatar_url,
              detail: `HTTP ${res.status}, content-type ${contentType} (Slack icon_url needs jpeg/png/gif — append format=original to fandom URLs)`,
            }),
          );
    }),
  );

const EXT_CONTENT_TYPE: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
};

/** Read the committed avatar from `avatar_file` (assets/avatars/<slug>.*). */
const readLocalAvatar = (
  persona: Persona,
): Effect.Effect<{ bytes: ArrayBuffer; contentType: string }, AvatarInvalidError> =>
  Effect.gen(function* () {
    const ext = persona.avatar_file.split(".").pop() ?? "";
    const contentType = EXT_CONTENT_TYPE[ext.toLowerCase()];
    if (contentType === undefined) {
      return yield* Effect.fail(
        new AvatarInvalidError({
          slug: persona.slug,
          url: persona.avatar_file,
          detail: `unsupported avatar_file extension: .${ext}`,
        }),
      );
    }
    const buf = yield* Effect.tryPromise({
      try: () => readFile(join(repoRoot, persona.avatar_file)),
      catch: (cause) =>
        new AvatarInvalidError({
          slug: persona.slug,
          url: persona.avatar_file,
          detail: `local read failed: ${String(cause)}`,
        }),
    });
    const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return { bytes, contentType };
  });

/** Download the avatar bytes from `avatar_url` (fallback when the vendored file is unusable). */
const fetchRemoteAvatar = (
  persona: Persona,
): Effect.Effect<{ bytes: ArrayBuffer; contentType: string }, AvatarInvalidError> =>
  Effect.tryPromise({
    try: () => fetch(persona.avatar_url, { redirect: "follow" }),
    catch: (cause) =>
      new AvatarInvalidError({
        slug: persona.slug,
        url: persona.avatar_url,
        detail: `request failed: ${String(cause)}`,
      }),
  }).pipe(
    Effect.flatMap((res) => {
      const contentType = res.headers.get("content-type") ?? "<none>";
      if (!res.ok || !contentType.startsWith("image/")) {
        return Effect.fail(
          new AvatarInvalidError({
            slug: persona.slug,
            url: persona.avatar_url,
            detail: `HTTP ${res.status}, content-type ${contentType}`,
          }),
        );
      }
      return Effect.tryPromise({
        try: async () => ({ bytes: await res.arrayBuffer(), contentType }),
        catch: (cause) =>
          new AvatarInvalidError({
            slug: persona.slug,
            url: persona.avatar_url,
            detail: `body read failed: ${String(cause)}`,
          }),
      });
    }),
  );

/** Avatar bytes for uploads (users.setPhoto): committed file first, remote URL fallback. */
export const fetchAvatar = (
  persona: Persona,
): Effect.Effect<{ bytes: ArrayBuffer; contentType: string }, AvatarInvalidError> =>
  readLocalAvatar(persona).pipe(
    Effect.catchTag("AvatarInvalidError", (localError) =>
      fetchRemoteAvatar(persona).pipe(
        Effect.tapError(() =>
          Effect.logWarning(
            `avatar for "${persona.slug}": local file failed (${localError.detail}), remote fallback also failed`,
          ),
        ),
      ),
    ),
  );
