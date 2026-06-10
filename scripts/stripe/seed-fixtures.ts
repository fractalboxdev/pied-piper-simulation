/**
 * Seed mock **usage-based revenue by client** into a Stripe test-mode account:
 * one customer + metered subscription per fixture company, with compression
 * usage reported as billing meter events, so Stripe itself generates the
 * per-client invoices (base platform fee + per-GB metered compression).
 *
 * Sink taxonomy (CLAUDE.md §7): Stripe is the **backdatable** sink — we map
 * `sim_time` ↔ test-clock time and advance the clock in lockstep. Stripe
 * allows a *new* test clock's `frozen_time` in the past, so by default the
 * clock runs on canonical sim_time (fixture epoch 2024-03-04). Per-clock
 * limits force one test clock per customer (max 3 customers/clock).
 *
 * Billing model (shared with scripts/fixtures/economics.ts so Stripe revenue
 * and the unit-economics report can never disagree):
 *   - flat monthly platform fee  = the company's fixture `mrr`
 *   - metered compression price  = per-GB-ingested rate by plan tier
 *     (one shared billing meter `pipernet_compression_gb`, summed)
 *
 * Per company flow:
 *   1. create a test clock frozen at the usage-window start
 *   2. create the customer on that clock (metadata: sim_event_id, sim_time,
 *      timeline_id) and a 2-item subscription (base + metered,
 *      collection_method=send_invoice so no card is needed)
 *   3. advance the clock to the usage-window end, then report each day's
 *      compressed GB as meter events (timestamps = sim day; for a test-clock
 *      customer Stripe validates them against the clock's frozen time, so the
 *      whole window fits in the 35-day lookback)
 *   4. poll the meter's event summaries until the customer's aggregate matches
 *      what we sent — meter aggregation is async, and crossing the cycle
 *      boundary too early generates an invoice with metered quantity 0
 *   5. advance past the billing-cycle end → Stripe invoices the month,
 *      metered usage and all. Revenue by client lands in the dashboard.
 *
 * Replay safety: products/prices are looked up by fixed ids / lookup_keys;
 * customers are looked up by metadata `sim_event_id` and **seeded companies
 * are skipped wholesale** (re-advancing a clock would double-bill). Meter
 * events additionally carry deterministic `identifier`s. Use --replace to
 * delete this timeline's test clocks (cascades to their customers and
 * subscriptions) and reseed from scratch.
 *
 * Environment
 * -----------
 *   STRIPE_SECRET_KEY        (required) test-mode secret key, sk_test_...
 *   STRIPE_TEST_CLOCK_EPOCH  (optional) ISO timestamp to remap the clock
 *     epoch if your Stripe account rejects far-past frozen times. sim_time in
 *     metadata stays canonical; only the sim_time → clock-time offset shifts.
 *
 * Run
 * ---
 *   pnpm seed:stripe             # idempotent; skips already-seeded companies
 *   pnpm seed:stripe --replace   # delete this timeline's clocks, then reseed
 */
import { Cause, Duration, Effect, Exit, Schedule, Schema } from "effect";
import {
  FIXTURE_EPOCH_MS,
  FIXTURE_TIMELINE_ID,
  USAGE_WINDOW_DAYS,
  fixtures,
  type FixtureCompany,
  type PlanTier,
} from "../fixtures/data.ts";
import {
  METERED_RATE_PER_GB_USD,
  dailyCompressionByCompany,
  type DailyCompression,
} from "../fixtures/economics.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class MissingTokenError extends Schema.TaggedError<MissingTokenError>()(
  "MissingTokenError",
  { variable: Schema.String },
) {}

export class LiveKeyError extends Schema.TaggedError<LiveKeyError>()(
  "LiveKeyError",
  {},
) {}

export class StripeApiError extends Schema.TaggedError<StripeApiError>()(
  "StripeApiError",
  {
    endpoint: Schema.String,
    status: Schema.Number,
    /** Stripe error `code`/`type`, or a transport description. */
    code: Schema.String,
    message: Schema.String,
  },
) {}

export class StripeRateLimitedError extends Schema.TaggedError<StripeRateLimitedError>()(
  "StripeRateLimitedError",
  { endpoint: Schema.String, retryAfterSeconds: Schema.Number },
) {}

export class ClockAdvanceTimeoutError extends Schema.TaggedError<ClockAdvanceTimeoutError>()(
  "ClockAdvanceTimeoutError",
  { clockId: Schema.String, targetTime: Schema.Number },
) {}

export class MeterAggregationTimeoutError extends Schema.TaggedError<MeterAggregationTimeoutError>()(
  "MeterAggregationTimeoutError",
  { companyName: Schema.String, expectedGb: Schema.Number, observedGb: Schema.Number },
) {}

// ---------------------------------------------------------------------------
// Minimal Stripe client (fetch + Effect, form-encoded, no SDK)
// ---------------------------------------------------------------------------

const STRIPE_BASE = "https://api.stripe.com";
/** Pinned: billing meters are stable from this version on. */
const STRIPE_VERSION = "2024-06-20";
const THROTTLE = Duration.millis(120);

interface StripeErrorBody {
  readonly error?: { readonly type?: string; readonly code?: string; readonly message?: string };
}

const rateLimitRetryPolicy = Schedule.identity<StripeApiError | StripeRateLimitedError>().pipe(
  Schedule.whileInput(
    (e: StripeApiError | StripeRateLimitedError) => e._tag === "StripeRateLimitedError",
  ),
  Schedule.addDelay((e) =>
    e._tag === "StripeRateLimitedError"
      ? Duration.seconds(Math.max(1, e.retryAfterSeconds))
      : Duration.zero,
  ),
  Schedule.intersect(Schedule.recurs(3)),
);

/** Flat form params — nested fields use bracket keys ("payload[value]"). */
type FormParams = Record<string, string>;

const makeStripeApi =
  (secretKey: string) =>
  (
    method: "GET" | "POST" | "DELETE",
    endpoint: string,
    params?: FormParams,
  ): Effect.Effect<unknown, StripeApiError | StripeRateLimitedError> => {
    const search = params !== undefined ? new URLSearchParams(params).toString() : "";
    const url =
      method === "GET" && search !== ""
        ? `${STRIPE_BASE}${endpoint}?${search}`
        : `${STRIPE_BASE}${endpoint}`;
    const callOnce = Effect.gen(function* () {
      const res = yield* Effect.tryPromise({
        try: () =>
          fetch(url, {
            method,
            headers: {
              Authorization: `Bearer ${secretKey}`,
              "Stripe-Version": STRIPE_VERSION,
              ...(method === "POST"
                ? { "Content-Type": "application/x-www-form-urlencoded" }
                : {}),
            },
            ...(method === "POST" ? { body: search } : {}),
          }),
        catch: (cause) =>
          new StripeApiError({ endpoint, status: 0, code: "TRANSPORT_ERROR", message: String(cause) }),
      });
      if (res.status === 429) {
        const retryAfterSeconds = Number(res.headers.get("retry-after") ?? "2");
        return yield* Effect.fail(
          new StripeRateLimitedError({
            endpoint,
            retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 2,
          }),
        );
      }
      const body = yield* Effect.tryPromise({
        try: () => res.json() as Promise<unknown>,
        catch: (cause) =>
          new StripeApiError({ endpoint, status: res.status, code: "INVALID_JSON", message: String(cause) }),
      });
      if (!res.ok) {
        const err = (body as StripeErrorBody).error;
        return yield* Effect.fail(
          new StripeApiError({
            endpoint,
            status: res.status,
            code: err?.code ?? err?.type ?? "UNKNOWN",
            message: err?.message ?? `HTTP ${res.status}`,
          }),
        );
      }
      return body;
    });
    return callOnce.pipe(
      Effect.retry(rateLimitRetryPolicy),
      Effect.tap(() => Effect.sleep(THROTTLE)),
    );
  };

type StripeApi = ReturnType<typeof makeStripeApi>;

interface StripeList {
  readonly data?: ReadonlyArray<Record<string, unknown>>;
}

interface StripeObject {
  readonly id?: string;
  readonly status?: string;
  readonly name?: string;
  readonly event_name?: string;
}

const idOf = (value: unknown): string => {
  const id = (value as StripeObject).id;
  if (id === undefined) throw new Error("Stripe response missing id");
  return id;
};

// ---------------------------------------------------------------------------
// sim_time ↔ test-clock time mapping
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_START_MS = FIXTURE_EPOCH_MS;
/** One day past the subscription's first cycle end → triggers the invoice. */
const FINAL_CLOCK_MS = WINDOW_START_MS + 32 * DAY_MS;

/**
 * sim_time → clock-time offset (CLAUDE.md §7 "map sim_time ↔ test-clock
 * time"). 0 by default (the clock runs on canonical sim_time, frozen in the
 * past). If Stripe rejects far-past frozen times, set STRIPE_TEST_CLOCK_EPOCH
 * to a recent ISO timestamp — metadata keeps canonical sim_time either way.
 */
const clockOffsetMs = (): number => {
  const override = process.env.STRIPE_TEST_CLOCK_EPOCH;
  if (override === undefined || override === "") return 0;
  const parsed = Date.parse(override);
  if (Number.isNaN(parsed)) throw new Error(`STRIPE_TEST_CLOCK_EPOCH is not ISO 8601: ${override}`);
  return parsed - WINDOW_START_MS;
};

const toClockSeconds = (simMs: number, offsetMs: number): number =>
  Math.floor((simMs + offsetMs) / 1000);

// ---------------------------------------------------------------------------
// Billing primitives (shared across companies) — idempotent ensure
// ---------------------------------------------------------------------------

const METER_EVENT_NAME = "pipernet_compression_gb";
const PLATFORM_PRODUCT_ID = "pp_sim_pipernet_platform";
const COMPRESSION_PRODUCT_ID = "pp_sim_pipernet_compression";
const TIERS: ReadonlyArray<PlanTier> = ["starter", "team", "enterprise"];

const ensureMeter = (api: StripeApi): Effect.Effect<string, StripeApiError | StripeRateLimitedError> =>
  Effect.gen(function* () {
    const list = (yield* api("GET", "/v1/billing/meters", { limit: "100", status: "active" })) as StripeList;
    const existing = list.data?.find((m) => (m as StripeObject).event_name === METER_EVENT_NAME);
    if (existing !== undefined) return idOf(existing);
    const created = yield* api("POST", "/v1/billing/meters", {
      display_name: "PiperNet compression (GB ingested)",
      event_name: METER_EVENT_NAME,
      "default_aggregation[formula]": "sum",
      "customer_mapping[type]": "by_id",
      "customer_mapping[event_payload_key]": "stripe_customer_id",
      "value_settings[event_payload_key]": "value",
    });
    return idOf(created);
  });

const ensureProduct = (
  api: StripeApi,
  id: string,
  name: string,
): Effect.Effect<string, StripeApiError | StripeRateLimitedError> =>
  api("GET", `/v1/products/${id}`).pipe(
    Effect.map(idOf),
    Effect.catchTag("StripeApiError", (e) =>
      e.status === 404
        ? api("POST", "/v1/products", {
            id,
            name,
            "metadata[timeline_id]": FIXTURE_TIMELINE_ID,
          }).pipe(Effect.map(idOf))
        : Effect.fail(e),
    ),
  );

const ensurePrice = (
  api: StripeApi,
  lookupKey: string,
  create: FormParams,
): Effect.Effect<string, StripeApiError | StripeRateLimitedError> =>
  Effect.gen(function* () {
    const list = (yield* api("GET", "/v1/prices", { "lookup_keys[]": lookupKey, limit: "1" })) as StripeList;
    const existing = list.data?.[0];
    if (existing !== undefined) return idOf(existing);
    return idOf(yield* api("POST", "/v1/prices", { ...create, lookup_key: lookupKey }));
  });

/** Metered per-tier prices (3) on the shared meter; flat base prices are per company. */
const ensureMeteredPrices = (
  api: StripeApi,
  meterId: string,
): Effect.Effect<Record<PlanTier, string>, StripeApiError | StripeRateLimitedError> =>
  Effect.gen(function* () {
    const out: Partial<Record<PlanTier, string>> = {};
    for (const tier of TIERS) {
      out[tier] = yield* ensurePrice(api, `pp-sim-compression-${tier}`, {
        product: COMPRESSION_PRODUCT_ID,
        currency: "usd",
        // USD/GB → cents/GB; whole cents by construction (15 / 10 / 7).
        unit_amount: String(Math.round(METERED_RATE_PER_GB_USD[tier] * 100)),
        "recurring[interval]": "month",
        "recurring[usage_type]": "metered",
        "recurring[meter]": meterId,
        "metadata[timeline_id]": FIXTURE_TIMELINE_ID,
      });
    }
    return out as Record<PlanTier, string>;
  });

// ---------------------------------------------------------------------------
// Per-company seeding
// ---------------------------------------------------------------------------

const clockName = (companyId: string): string =>
  `pied-piper-sim:${FIXTURE_TIMELINE_ID}:${companyId}`;

const findCustomer = (
  api: StripeApi,
  simEventId: string,
): Effect.Effect<string | undefined, StripeApiError | StripeRateLimitedError> =>
  Effect.gen(function* () {
    const res = (yield* api("GET", "/v1/customers/search", {
      query: `metadata['sim_event_id']:'${simEventId}'`,
      limit: "1",
    })) as StripeList;
    const hit = res.data?.[0];
    if (hit === undefined) return undefined;
    // The search index is eventually consistent: right after --replace it
    // still returns customers whose test clock (and thus the customer) was
    // just deleted. Verify the hit against the source of truth.
    const customer = (yield* api("GET", `/v1/customers/${idOf(hit)}`).pipe(
      Effect.catchTag("StripeApiError", (e) =>
        e.status === 404 ? Effect.succeed({ deleted: true }) : Effect.fail(e),
      ),
    )) as StripeObject & { readonly deleted?: boolean };
    return customer.deleted === true ? undefined : idOf(hit);
  });

/** Advance a clock and poll until it settles back to `ready`. */
const advanceClock = (
  api: StripeApi,
  clockId: string,
  toSeconds: number,
): Effect.Effect<
  void,
  StripeApiError | StripeRateLimitedError | ClockAdvanceTimeoutError
> =>
  Effect.gen(function* () {
    yield* api("POST", `/v1/test_helpers/test_clocks/${clockId}/advance`, {
      frozen_time: String(toSeconds),
    });
    const poll = Effect.gen(function* () {
      const clock = (yield* api("GET", `/v1/test_helpers/test_clocks/${clockId}`)) as StripeObject;
      if (clock.status !== "ready") {
        return yield* Effect.fail(
          new ClockAdvanceTimeoutError({ clockId, targetTime: toSeconds }),
        );
      }
    });
    yield* poll.pipe(
      Effect.retry(
        Schedule.spaced(Duration.seconds(2)).pipe(
          Schedule.intersect(Schedule.recurs(60)),
          Schedule.whileInput(
            (e: StripeApiError | StripeRateLimitedError | ClockAdvanceTimeoutError) =>
              e._tag === "ClockAdvanceTimeoutError",
          ),
        ),
      ),
    );
  });

const BYTES_PER_GB = 1024 ** 3;

interface MeterSummaryList {
  readonly data?: ReadonlyArray<{ readonly aggregated_value?: number }>;
}

/**
 * Meter ingestion → aggregation is asynchronous. An invoice generated while
 * events are still aggregating bills quantity 0, so before crossing the
 * billing-cycle boundary we poll the meter's event summaries until the
 * customer's aggregate matches what we sent (observed lag: ~0.5–2 min).
 */
const awaitMeterAggregation = (
  api: StripeApi,
  meterId: string,
  customerId: string,
  companyName: string,
  expectedGb: number,
  startSeconds: number,
  endSeconds: number,
): Effect.Effect<
  void,
  StripeApiError | StripeRateLimitedError | MeterAggregationTimeoutError
> =>
  Effect.gen(function* () {
    const summaries = (yield* api(
      "GET",
      `/v1/billing/meters/${meterId}/event_summaries`,
      {
        customer: customerId,
        start_time: String(startSeconds),
        end_time: String(endSeconds),
        value_grouping_window: "day",
        limit: "40",
      },
    )) as MeterSummaryList;
    const observed = (summaries.data ?? []).reduce(
      (sum, s) => sum + (s.aggregated_value ?? 0),
      0,
    );
    if (observed < expectedGb - 0.01) {
      return yield* Effect.fail(
        new MeterAggregationTimeoutError({
          companyName,
          expectedGb,
          observedGb: observed,
        }),
      );
    }
  }).pipe(
    Effect.retry(
      Schedule.spaced(Duration.seconds(5)).pipe(
        Schedule.intersect(Schedule.recurs(60)), // up to ~5 min
        Schedule.whileInput(
          (e: StripeApiError | StripeRateLimitedError | MeterAggregationTimeoutError) =>
            e._tag === "MeterAggregationTimeoutError",
        ),
      ),
    ),
  );

const seedCompany = (
  api: StripeApi,
  company: FixtureCompany,
  days: ReadonlyArray<DailyCompression>,
  meterId: string,
  meteredPriceByTier: Record<PlanTier, string>,
  offsetMs: number,
): Effect.Effect<
  void,
  | StripeApiError
  | StripeRateLimitedError
  | ClockAdvanceTimeoutError
  | MeterAggregationTimeoutError
> =>
  Effect.gen(function* () {
    const customerSimEventId = `fixture:stripe-customer:${company.id}`;
    const existing = yield* findCustomer(api, customerSimEventId);
    if (existing !== undefined) {
      yield* Effect.log(`= ${company.name}: already seeded (${existing}), skipping`);
      return;
    }

    // 1. Test clock frozen at the usage-window start (= subscription anchor).
    const clock = yield* api("POST", "/v1/test_helpers/test_clocks", {
      frozen_time: String(toClockSeconds(WINDOW_START_MS, offsetMs)),
      name: clockName(company.id),
    });
    const clockId = idOf(clock);

    // 2. Customer pinned to the clock; canonical sim_time rides in metadata.
    const customer = yield* api("POST", "/v1/customers", {
      name: company.name,
      email: `billing@${company.domain}`,
      test_clock: clockId,
      "metadata[sim_event_id]": customerSimEventId,
      "metadata[sim_time]": new Date(WINDOW_START_MS).toISOString(),
      "metadata[timeline_id]": FIXTURE_TIMELINE_ID,
      "metadata[company_id]": company.id,
      "metadata[plan_tier]": company.planTier,
    });
    const customerId = idOf(customer);

    // Flat base fee is per company (the fixture MRR draw), so the price is too.
    const basePriceId = yield* ensurePrice(api, `pp-sim-base-${company.id}`, {
      product: PLATFORM_PRODUCT_ID,
      currency: "usd",
      unit_amount: String(company.mrr * 100),
      "recurring[interval]": "month",
      "metadata[timeline_id]": FIXTURE_TIMELINE_ID,
      "metadata[company_id]": company.id,
    });

    yield* api("POST", "/v1/subscriptions", {
      customer: customerId,
      "items[0][price]": basePriceId,
      "items[1][price]": meteredPriceByTier[company.planTier],
      collection_method: "send_invoice",
      days_until_due: "30",
      "metadata[sim_event_id]": `fixture:stripe-subscription:${company.id}`,
      "metadata[sim_time]": new Date(WINDOW_START_MS).toISOString(),
      "metadata[timeline_id]": FIXTURE_TIMELINE_ID,
      "metadata[company_id]": company.id,
    });

    // 3. Advance to the usage-window end, then replay every day's usage —
    // all timestamps sit in [frozen−35d, frozen], inside the open period.
    // The identifier is customer-scoped so retries within a run dedupe but a
    // --replace reseed (new customer id) is not swallowed by Stripe's
    // meter-event dedup window.
    const windowEndMs = WINDOW_START_MS + USAGE_WINDOW_DAYS * DAY_MS;
    yield* advanceClock(api, clockId, toClockSeconds(windowEndMs, offsetMs));
    for (const day of days) {
      const gb = day.bytesIn / BYTES_PER_GB;
      const dayNoonMs = WINDOW_START_MS + day.dayIndex * DAY_MS + 12 * 60 * 60 * 1000;
      yield* api("POST", "/v1/billing/meter_events", {
        event_name: METER_EVENT_NAME,
        identifier: `${customerId}:d${day.dayIndex}`,
        timestamp: String(toClockSeconds(dayNoonMs, offsetMs)),
        "payload[stripe_customer_id]": customerId,
        "payload[value]": gb.toFixed(4),
      });
    }

    // 4. Wait for async meter aggregation to catch up — crossing the cycle
    // boundary earlier generates an invoice with metered quantity 0.
    const totalGb = days.reduce((sum, d) => sum + d.bytesIn, 0) / BYTES_PER_GB;
    yield* awaitMeterAggregation(
      api,
      meterId,
      customerId,
      company.name,
      totalGb,
      toClockSeconds(WINDOW_START_MS, offsetMs),
      toClockSeconds(windowEndMs, offsetMs),
    );

    // 5. Cross the cycle boundary → Stripe generates the month's invoice.
    yield* advanceClock(api, clockId, toClockSeconds(FINAL_CLOCK_MS, offsetMs));
    yield* Effect.log(
      `+ ${company.name}: customer ${customerId}, ${days.length} usage days, ${totalGb.toFixed(1)} GB metered, invoiced`,
    );
  });

// ---------------------------------------------------------------------------
// --replace: delete this timeline's test clocks (cascades to their objects)
// ---------------------------------------------------------------------------

const deleteTimelineClocks = (
  api: StripeApi,
): Effect.Effect<void, StripeApiError | StripeRateLimitedError> =>
  Effect.gen(function* () {
    const prefix = `pied-piper-sim:${FIXTURE_TIMELINE_ID}:`;
    const list = (yield* api("GET", "/v1/test_helpers/test_clocks", { limit: "100" })) as StripeList;
    const mine = (list.data ?? []).filter((c) =>
      String((c as StripeObject).name ?? "").startsWith(prefix),
    );
    for (const clock of mine) {
      yield* api("DELETE", `/v1/test_helpers/test_clocks/${idOf(clock)}`);
      yield* Effect.log(`- deleted test clock ${(clock as StripeObject).name}`);
    }
  });

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (secretKey === undefined || secretKey === "") {
    return yield* Effect.fail(new MissingTokenError({ variable: "STRIPE_SECRET_KEY" }));
  }
  if (!secretKey.startsWith("sk_test_") && !secretKey.startsWith("rk_test_")) {
    return yield* Effect.fail(new LiveKeyError());
  }
  const api = makeStripeApi(secretKey);
  const offsetMs = clockOffsetMs();

  if (process.argv.includes("--replace")) {
    yield* deleteTimelineClocks(api);
  }

  const daily = dailyCompressionByCompany();
  const active = fixtures.companies.filter((c) => (daily.get(c.id)?.length ?? 0) > 0);
  yield* Effect.log(
    `seeding ${active.length} customers with metered subscriptions (timeline ${FIXTURE_TIMELINE_ID}, window ${new Date(WINDOW_START_MS).toISOString().slice(0, 10)} +${USAGE_WINDOW_DAYS}d${offsetMs === 0 ? "" : `, clock offset ${offsetMs / DAY_MS}d`})`,
  );

  const meterId = yield* ensureMeter(api);
  yield* ensureProduct(api, PLATFORM_PRODUCT_ID, "PiperNet Platform");
  yield* ensureProduct(api, COMPRESSION_PRODUCT_ID, "PiperNet Compression");
  const meteredPriceByTier = yield* ensureMeteredPrices(api, meterId);

  // Clocks are independent; modest parallelism keeps total advance-poll time sane.
  yield* Effect.forEach(
    active,
    (company) =>
      seedCompany(api, company, daily.get(company.id) ?? [], meterId, meteredPriceByTier, offsetMs),
    { concurrency: 3 },
  );
  yield* Effect.log("done. Revenue by client: Stripe dashboard → Billing → Invoices (test mode).");
});

const fail = Effect.sync(() => {
  process.exitCode = 1;
});

const main = program.pipe(
  Effect.catchTags({
    MissingTokenError: (e) =>
      Effect.logError(
        `${e.variable} is not set. Use a test-mode secret key (sk_test_...) from a Stripe sandbox — see the header of this script.`,
      ).pipe(Effect.andThen(fail)),
    LiveKeyError: () =>
      Effect.logError(
        "STRIPE_SECRET_KEY is not a test-mode key (sk_test_...). Refusing to seed fixtures into a live account.",
      ).pipe(Effect.andThen(fail)),
    StripeApiError: (e) =>
      Effect.logError(
        `Stripe API ${e.endpoint} failed: HTTP ${e.status} [${e.code}] ${e.message}` +
          (e.code === "timestamp_too_far_in_past"
            ? "\nHint: this account rejects historical meter timestamps — set STRIPE_TEST_CLOCK_EPOCH to a recent ISO date (see script header) and reseed with --replace."
            : ""),
      ).pipe(Effect.andThen(fail)),
    StripeRateLimitedError: (e) =>
      Effect.logError(
        `Stripe API ${e.endpoint} still rate-limited after retries (last Retry-After: ${e.retryAfterSeconds}s)`,
      ).pipe(Effect.andThen(fail)),
    ClockAdvanceTimeoutError: (e) =>
      Effect.logError(
        `test clock ${e.clockId} did not reach 'ready' after advancing to ${new Date(e.targetTime * 1000).toISOString()} — check the Stripe dashboard, then re-run (seeded companies are skipped).`,
      ).pipe(Effect.andThen(fail)),
    MeterAggregationTimeoutError: (e) =>
      Effect.logError(
        `${e.companyName}: meter aggregation still at ${e.observedGb.toFixed(2)} GB of ${e.expectedGb.toFixed(2)} GB after ~5 min — the customer's cycle-end invoice was NOT generated. Reseed this timeline with --replace once Stripe catches up.`,
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
