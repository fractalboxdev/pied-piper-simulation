/**
 * Seed the deterministic fixture product-usage events (scripts/fixtures/data.ts)
 * into a PostHog project via the batch capture API.
 *
 * Sink taxonomy (CLAUDE.md §7): PostHog is **quasi-backdatable** — the capture
 * API accepts a historical `timestamp` per event, so fixture events land at
 * their canonical `sim_time` (unlike HubSpot, whose `createdate` is
 * server-assigned). We send `historical_migration: true` since timestamps are
 * far in the past (PostHog requires it for events older than ~48h; it also
 * routes them off the realtime ingestion path).
 *
 * Idempotency / replay safety: every event carries a client-supplied `uuid`,
 * derived **deterministically** (UUIDv5, implemented inline on node:crypto —
 * no extra dependency) from `(timeline_id, sim_event_id)`. Re-running the
 * seeder produces byte-identical uuids, and PostHog dedupes events with the
 * same (uuid, event, distinct_id, timestamp).
 *
 * PostHog setup (one-time)
 * ------------------------
 * - Free tier includes 1M events/month — this dataset is a few thousand.
 * - Project API key: PostHog → Settings → Project → "Project API Key"
 *   (starts with `phc_`). It is a *public, write-only* key (safe to ship in
 *   client bundles), but we still env-inject it — never commit values.
 *
 * Environment
 * -----------
 *   POSTHOG_PROJECT_API_KEY  (required) project API key, phc_...
 *   POSTHOG_HOST             (optional) ingestion host; default
 *                            https://us.i.posthog.com (EU: https://eu.i.posthog.com)
 *
 * Run
 * ---
 *   pnpm seed:posthog
 *
 * Behavior
 * --------
 * - Sends one `$identify` per fixture contact (person properties: email, name,
 *   company, plan tier), then all usage events, chunked into batches of 200
 *   (well under the 20MB request-body limit on /batch/).
 * - Throttled to 1 batch / 500ms; 429s honor Retry-After and 5xx retry with
 *   exponential backoff via Effect Schedule.
 *
 * Caveat: PostHog's capture endpoints are fire-and-forget — an *invalid* (but
 * well-formed) api_key still returns 2xx and the events are silently dropped
 * during async ingestion. Malformed payloads return 4xx (surfaced in the
 * tagged error); key typos do not. Verify arrival in the PostHog activity view.
 */
import { createHash } from "node:crypto";
import { Cause, Duration, Effect, Exit, Schedule, Schema } from "effect";
import {
  FIXTURE_TIMELINE_ID,
  fixtures,
  type FixtureUsageEvent,
} from "../fixtures/data.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class MissingTokenError extends Schema.TaggedError<MissingTokenError>()(
  "MissingTokenError",
  { variable: Schema.String },
) {}

export class PostHogApiError extends Schema.TaggedError<PostHogApiError>()(
  "PostHogApiError",
  {
    endpoint: Schema.String,
    status: Schema.Number,
    /** PostHog's error `code`/`type` (e.g. "invalid_api_key"), or a transport description. */
    code: Schema.String,
    detail: Schema.String,
  },
) {}

export class PostHogRateLimitedError extends Schema.TaggedError<PostHogRateLimitedError>()(
  "PostHogRateLimitedError",
  {
    endpoint: Schema.String,
    retryAfterSeconds: Schema.Number,
  },
) {}

export class PostHogServerError extends Schema.TaggedError<PostHogServerError>()(
  "PostHogServerError",
  {
    endpoint: Schema.String,
    status: Schema.Number,
  },
) {}

// ---------------------------------------------------------------------------
// Deterministic UUIDv5 (RFC 4122) — inline, node:crypto only
// ---------------------------------------------------------------------------

/**
 * Fixed namespace for this project's PostHog event uuids. Itself a UUIDv5 of
 * the string "pied-piper-simulation/posthog" under the RFC 4122 DNS namespace —
 * precomputed and frozen here so the namespace never drifts.
 */
const POSTHOG_UUID_NAMESPACE = "4550a3b0-ee74-5d01-85d3-42e609542c21";

const uuidToBytes = (uuid: string): Uint8Array => {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

/** UUIDv5: SHA-1(namespace bytes ++ name), with version/variant bits set. */
export const uuidV5 = (name: string, namespace: string): string => {
  const hash = createHash("sha1");
  hash.update(uuidToBytes(namespace));
  hash.update(Buffer.from(name, "utf8"));
  const bytes = hash.digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50; // version 5
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Deterministic event uuid from (timeline_id, sim_event_id) — replays dedupe. */
const eventUuid = (simEventId: string): string =>
  uuidV5(`${FIXTURE_TIMELINE_ID}:${simEventId}`, POSTHOG_UUID_NAMESPACE);

// ---------------------------------------------------------------------------
// Batch payloads
// ---------------------------------------------------------------------------

interface PostHogEvent {
  readonly event: string;
  readonly distinct_id: string;
  readonly timestamp: string;
  readonly uuid: string;
  readonly properties: Record<string, unknown>;
}

const BATCH_SIZE = 200;
const THROTTLE = Duration.millis(500);

const companyById = new Map(fixtures.companies.map((c) => [c.id, c]));

const toIdentifyEvent = (contactId: string): PostHogEvent | undefined => {
  const contact = fixtures.contacts.find((c) => c.id === contactId);
  if (contact === undefined) return undefined;
  const company = companyById.get(contact.companyId);
  return {
    event: "$identify",
    distinct_id: contact.id,
    timestamp: contact.simTime,
    uuid: eventUuid(`${contact.simEventId}:identify`),
    properties: {
      sim_event_id: `${contact.simEventId}:identify`,
      timeline_id: FIXTURE_TIMELINE_ID,
      $set: {
        email: contact.email,
        name: `${contact.firstName} ${contact.lastName}`,
        job_title: contact.jobTitle,
        company_id: contact.companyId,
        company_name: company?.name ?? contact.companyId,
        plan_tier: company?.planTier ?? "unknown",
      },
    },
  };
};

const toUsageEvent = (usage: FixtureUsageEvent): PostHogEvent => {
  const company = companyById.get(usage.companyId);
  return {
    event: usage.event,
    distinct_id: usage.distinctId,
    timestamp: usage.simTime,
    uuid: eventUuid(usage.simEventId),
    properties: {
      ...usage.properties,
      sim_event_id: usage.simEventId,
      sim_time: usage.simTime,
      timeline_id: FIXTURE_TIMELINE_ID,
      company_id: usage.companyId,
      company_name: company?.name ?? usage.companyId,
      plan_tier: company?.planTier ?? "unknown",
    },
  };
};

const chunk = <T>(items: ReadonlyArray<T>, size: number): ReadonlyArray<ReadonlyArray<T>> => {
  const chunks: Array<ReadonlyArray<T>> = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};

// ---------------------------------------------------------------------------
// Batch client (fetch + Effect, no SDK)
// ---------------------------------------------------------------------------

type BatchError = PostHogApiError | PostHogRateLimitedError | PostHogServerError;

/**
 * 429 honors Retry-After (delay from the error itself); 5xx retries with
 * exponential backoff. (`_tag` access inside Schedule predicates is the one
 * sanctioned exception.)
 */
const retryPolicy = Schedule.identity<BatchError>().pipe(
  Schedule.whileInput(
    (e: BatchError) => e._tag === "PostHogRateLimitedError" || e._tag === "PostHogServerError",
  ),
  Schedule.addDelay((e) =>
    e._tag === "PostHogRateLimitedError"
      ? Duration.seconds(Math.max(1, e.retryAfterSeconds))
      : Duration.zero,
  ),
  Schedule.intersect(Schedule.exponential("1 second")),
  Schedule.intersect(Schedule.recurs(4)),
);

const makeSendBatch =
  (host: string, apiKey: string) =>
  (batch: ReadonlyArray<PostHogEvent>): Effect.Effect<void, BatchError> => {
    const endpoint = "/batch/";
    const callOnce = Effect.gen(function* () {
      const res = yield* Effect.tryPromise({
        try: () =>
          fetch(`${host}${endpoint}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              api_key: apiKey,
              historical_migration: true,
              batch,
            }),
          }),
        catch: (cause) =>
          new PostHogApiError({
            endpoint,
            status: 0,
            code: "transport_error",
            detail: String(cause),
          }),
      });
      if (res.status === 429) {
        const retryAfterSeconds = Number(res.headers.get("retry-after") ?? "1");
        return yield* Effect.fail(
          new PostHogRateLimitedError({
            endpoint,
            retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 1,
          }),
        );
      }
      if (res.status >= 500) {
        return yield* Effect.fail(new PostHogServerError({ endpoint, status: res.status }));
      }
      if (!res.ok) {
        // Error bodies may be JSON ({type, code, detail}) or plain text.
        const text = yield* Effect.tryPromise({
          try: () => res.text(),
          catch: () => new PostHogApiError({ endpoint, status: res.status, code: "unreadable_error_body", detail: `HTTP ${res.status}` }),
        }).pipe(Effect.orElseSucceed(() => ""));
        const body = yield* Effect.try(
          () => JSON.parse(text) as { readonly type?: string; readonly code?: string; readonly detail?: string },
        ).pipe(Effect.orElseSucceed(() => ({}) as { type?: string; code?: string; detail?: string }));
        return yield* Effect.fail(
          new PostHogApiError({
            endpoint,
            status: res.status,
            code: body.code ?? body.type ?? "unknown_error",
            detail: body.detail ?? (text !== "" ? text : `HTTP ${res.status}`),
          }),
        );
      }
    });
    return callOnce.pipe(
      Effect.retry(retryPolicy),
      Effect.tap(() => Effect.sleep(THROTTLE)),
    );
  };

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const apiKey = process.env.POSTHOG_PROJECT_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    return yield* Effect.fail(new MissingTokenError({ variable: "POSTHOG_PROJECT_API_KEY" }));
  }
  const host = (process.env.POSTHOG_HOST ?? "https://us.i.posthog.com").replace(/\/$/, "");
  const sendBatch = makeSendBatch(host, apiKey);

  const identifyEvents = fixtures.contacts
    .map((c) => toIdentifyEvent(c.id))
    .filter((e): e is PostHogEvent => e !== undefined);
  const usageEvents = fixtures.usageEvents.map(toUsageEvent);
  const allEvents = [...identifyEvents, ...usageEvents];

  yield* Effect.log(
    `sending ${allEvents.length} events (${identifyEvents.length} $identify + ${usageEvents.length} usage) to ${host} (timeline ${FIXTURE_TIMELINE_ID})`,
  );

  const batches = chunk(allEvents, BATCH_SIZE);
  yield* Effect.forEach(
    batches,
    (batch, i) =>
      sendBatch(batch).pipe(
        Effect.tap(() =>
          Effect.log(`batch ${i + 1}/${batches.length} accepted (${batch.length} events)`),
        ),
      ),
    { concurrency: 1 }, // sequential: ordering + throttling
  );
  yield* Effect.log("done. Events are deterministic — re-runs dedupe on uuid.");
});

const fail = Effect.sync(() => {
  process.exitCode = 1;
});

// Recover every domain error inside the Effect (no try/catch around runPromise).
const main = program.pipe(
  Effect.catchTags({
    MissingTokenError: (e) =>
      Effect.logError(
        `${e.variable} is not set. Copy the project API key (phc_...) from PostHog project settings — see the header of this script.`,
      ).pipe(Effect.andThen(fail)),
    PostHogApiError: (e) =>
      Effect.logError(
        `PostHog ${e.endpoint} failed: HTTP ${e.status} [${e.code}] ${e.detail}`,
      ).pipe(Effect.andThen(fail)),
    PostHogRateLimitedError: (e) =>
      Effect.logError(
        `PostHog ${e.endpoint} still rate-limited after retries (last Retry-After: ${e.retryAfterSeconds}s)`,
      ).pipe(Effect.andThen(fail)),
    PostHogServerError: (e) =>
      Effect.logError(
        `PostHog ${e.endpoint} still failing after retries (last status: ${e.status})`,
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
