/**
 * Seed the deterministic fixture dataset (scripts/fixtures/data.ts) into a
 * HubSpot developer **test account**: companies → contacts (associated to their
 * company) → deals (associated to their company).
 *
 * Sink taxonomy (CLAUDE.md §7): HubSpot is a **realtime-only** sink — the
 * system `createdate` is server-assigned and cannot be backdated. The canonical
 * clock therefore travels as custom properties on every record:
 * `sim_event_id`, `sim_time`, `timeline_id` (+ `persona_owner` on deals,
 * because real HubSpot owners are seat-bound users we don't have).
 *
 * HubSpot setup (one-time)
 * ------------------------
 * 1. Create a free developer account at https://developers.hubspot.com, then a
 *    **developer test account** (Testing → Create test account) — full CRM,
 *    free, disposable; external email sending is disabled there by design.
 * 2. In the test account: Settings → Integrations → Private Apps → Create a
 *    private app with scopes:
 *      - crm.objects.companies.read / .write
 *      - crm.objects.contacts.read  / .write
 *      - crm.objects.deals.read     / .write
 *      - crm.schemas.companies.read / .write   (custom properties)
 *      - crm.schemas.contacts.read  / .write
 *      - crm.schemas.deals.read     / .write
 * 3. Copy the private app access token (pat-...).
 *
 * Environment
 * -----------
 *   HUBSPOT_PRIVATE_APP_TOKEN  (required) private app token, pat-...
 *
 * Run
 * ---
 *   pnpm seed:hubspot
 *
 * Behavior
 * --------
 * - First ensures the custom properties exist on companies/contacts/deals
 *   (idempotent: GET the property, create on 404).
 * - Idempotent upserts: HubSpot has no native idempotency keys, so every create
 *   is preceded by a CRM **search** on `sim_event_id` (EQ filter). Caveat: the
 *   search index lags writes by a few seconds — re-running *immediately* after
 *   a partial run can race it; wait ~30s between runs.
 * - Throttled to <= 4 req/s (search API allows 5 req/s; private apps ~110
 *   req/10s overall); 429s honor Retry-After via Effect Schedule.
 * - HubSpot error `category` + `message` surface in the tagged error.
 */
import { Cause, Duration, Effect, Exit, Option, Schedule, Schema } from "effect";
import {
  FIXTURE_ERA_SLUG,
  FIXTURE_TIMELINE_ID,
  fixtures,
  type FixtureCompany,
  type FixtureContact,
  type FixtureDeal,
} from "../fixtures/data.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class MissingTokenError extends Schema.TaggedError<MissingTokenError>()(
  "MissingTokenError",
  { variable: Schema.String },
) {}

export class HubSpotApiError extends Schema.TaggedError<HubSpotApiError>()(
  "HubSpotApiError",
  {
    endpoint: Schema.String,
    status: Schema.Number,
    /** HubSpot's error `category` (e.g. "INVALID_AUTHENTICATION", "VALIDATION_ERROR"), or a transport description. */
    category: Schema.String,
    message: Schema.String,
  },
) {}

export class HubSpotRateLimitedError extends Schema.TaggedError<HubSpotRateLimitedError>()(
  "HubSpotRateLimitedError",
  {
    endpoint: Schema.String,
    retryAfterSeconds: Schema.Number,
  },
) {}

// ---------------------------------------------------------------------------
// Minimal HubSpot CRM v3 client (fetch + Effect, no SDK)
// ---------------------------------------------------------------------------

const HUBSPOT_BASE = "https://api.hubapi.com";

/** Stay safely under the search API's 5 req/s account limit. */
const THROTTLE = Duration.millis(250);

interface HubSpotErrorBody {
  readonly category?: string;
  readonly message?: string;
}

interface HubSpotSearchResponse {
  readonly total?: number;
  readonly results?: ReadonlyArray<{ readonly id: string }>;
}

interface HubSpotCreateResponse {
  readonly id: string;
}

/**
 * Honors 429 Retry-After: the schedule's delay is taken from the error itself.
 * (`_tag` access inside Schedule predicates is the one sanctioned exception.)
 */
const rateLimitRetryPolicy = Schedule.identity<HubSpotApiError | HubSpotRateLimitedError>().pipe(
  Schedule.whileInput(
    (e: HubSpotApiError | HubSpotRateLimitedError) => e._tag === "HubSpotRateLimitedError",
  ),
  Schedule.addDelay((e) =>
    e._tag === "HubSpotRateLimitedError"
      ? Duration.seconds(Math.max(1, e.retryAfterSeconds))
      : Duration.zero,
  ),
  Schedule.intersect(Schedule.recurs(3)),
);

const makeHubSpotApi =
  (token: string) =>
  (
    method: "GET" | "POST",
    endpoint: string,
    body?: Record<string, unknown>,
  ): Effect.Effect<unknown, HubSpotApiError | HubSpotRateLimitedError> => {
    const callOnce = Effect.gen(function* () {
      const res = yield* Effect.tryPromise({
        try: () =>
          fetch(`${HUBSPOT_BASE}${endpoint}`, {
            method,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          }),
        catch: (cause) =>
          new HubSpotApiError({
            endpoint,
            status: 0,
            category: "TRANSPORT_ERROR",
            message: String(cause),
          }),
      });
      if (res.status === 429) {
        const retryAfterSeconds = Number(res.headers.get("retry-after") ?? "10");
        return yield* Effect.fail(
          new HubSpotRateLimitedError({
            endpoint,
            retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 10,
          }),
        );
      }
      if (!res.ok) {
        const errorBody = yield* Effect.tryPromise({
          try: () => res.json() as Promise<HubSpotErrorBody>,
          catch: () => new HubSpotApiError({ endpoint, status: res.status, category: "UNPARSEABLE_ERROR_BODY", message: `HTTP ${res.status}` }),
        }).pipe(Effect.orElseSucceed((): HubSpotErrorBody => ({})));
        return yield* Effect.fail(
          new HubSpotApiError({
            endpoint,
            status: res.status,
            category: errorBody.category ?? "UNKNOWN",
            message: errorBody.message ?? `HTTP ${res.status}`,
          }),
        );
      }
      // 204 No Content has no body.
      if (res.status === 204) return undefined as unknown;
      return yield* Effect.tryPromise({
        try: () => res.json() as Promise<unknown>,
        catch: (cause) =>
          new HubSpotApiError({
            endpoint,
            status: res.status,
            category: "INVALID_JSON",
            message: String(cause),
          }),
      });
    });
    // Global pacing: every call (incl. retries' successors) waits THROTTLE.
    return callOnce.pipe(
      Effect.retry(rateLimitRetryPolicy),
      Effect.tap(() => Effect.sleep(THROTTLE)),
    );
  };

type HubSpotApi = ReturnType<typeof makeHubSpotApi>;

// ---------------------------------------------------------------------------
// Custom properties — idempotent ensure (GET, create on 404)
// ---------------------------------------------------------------------------

type CrmObjectType = "companies" | "contacts" | "deals";

interface PropertyDef {
  readonly name: string;
  readonly label: string;
}

const SIM_PROPERTIES: ReadonlyArray<PropertyDef> = [
  { name: "sim_event_id", label: "Sim Event ID" },
  { name: "sim_time", label: "Sim Time (canonical virtual clock, ISO 8601)" },
  { name: "timeline_id", label: "Sim Timeline ID" },
];

const PROPERTY_GROUP: Record<CrmObjectType, string> = {
  companies: "companyinformation",
  contacts: "contactinformation",
  deals: "dealinformation",
};

const ensureProperty = (
  api: HubSpotApi,
  objectType: CrmObjectType,
  prop: PropertyDef,
): Effect.Effect<void, HubSpotApiError | HubSpotRateLimitedError> =>
  api("GET", `/crm/v3/properties/${objectType}/${prop.name}`).pipe(
    Effect.tap(() => Effect.log(`property ${objectType}.${prop.name} already exists`)),
    Effect.asVoid,
    Effect.catchTag("HubSpotApiError", (e) =>
      e.status === 404
        ? api("POST", `/crm/v3/properties/${objectType}`, {
            name: prop.name,
            label: prop.label,
            type: "string",
            fieldType: "text",
            groupName: PROPERTY_GROUP[objectType],
          }).pipe(
            Effect.tap(() => Effect.log(`created property ${objectType}.${prop.name}`)),
            Effect.asVoid,
          )
        : Effect.fail(e),
    ),
  );

const ensureAllProperties = (
  api: HubSpotApi,
): Effect.Effect<void, HubSpotApiError | HubSpotRateLimitedError> =>
  Effect.forEach(
    ["companies", "contacts", "deals"] as const,
    (objectType) =>
      Effect.forEach(
        objectType === "deals"
          ? [...SIM_PROPERTIES, { name: "persona_owner", label: "Persona Owner (PERSONAS.md slug)" }]
          : SIM_PROPERTIES,
        (prop) => ensureProperty(api, objectType, prop),
        { concurrency: 1 },
      ),
    { concurrency: 1 },
  ).pipe(Effect.asVoid);

// ---------------------------------------------------------------------------
// Idempotency — search by sim_event_id before every create
// ---------------------------------------------------------------------------

const findBySimEventId = (
  api: HubSpotApi,
  objectType: CrmObjectType,
  simEventId: string,
): Effect.Effect<Option.Option<string>, HubSpotApiError | HubSpotRateLimitedError> =>
  api("POST", `/crm/v3/objects/${objectType}/search`, {
    filterGroups: [
      {
        filters: [{ propertyName: "sim_event_id", operator: "EQ", value: simEventId }],
      },
    ],
    properties: ["sim_event_id"],
    limit: 1,
  }).pipe(
    Effect.map((raw) => {
      const data = raw as HubSpotSearchResponse;
      const hit = data.results?.[0];
      return hit !== undefined ? Option.some(hit.id) : Option.none<string>();
    }),
  );

/** Default HubSpot-defined association type ids (v4 association docs). */
const ASSOC_CONTACT_TO_COMPANY = 279;
const ASSOC_DEAL_TO_COMPANY = 341;

const association = (companyHubSpotId: string, associationTypeId: number) => ({
  to: { id: companyHubSpotId },
  types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId }],
});

const upsert = (
  api: HubSpotApi,
  objectType: CrmObjectType,
  simEventId: string,
  label: string,
  payload: Record<string, unknown>,
): Effect.Effect<string, HubSpotApiError | HubSpotRateLimitedError> =>
  findBySimEventId(api, objectType, simEventId).pipe(
    Effect.flatMap(
      Option.match({
        onSome: (id) =>
          Effect.log(`skip ${label} — already seeded (${objectType}/${id})`).pipe(Effect.as(id)),
        onNone: () =>
          api("POST", `/crm/v3/objects/${objectType}`, payload).pipe(
            Effect.map((raw) => (raw as HubSpotCreateResponse).id),
            Effect.tap((id) => Effect.log(`created ${label} (${objectType}/${id})`)),
          ),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

const seedCompany = (api: HubSpotApi, company: FixtureCompany) =>
  upsert(api, "companies", company.simEventId, company.name, {
    properties: {
      name: company.name,
      domain: company.domain,
      industry: company.industry,
      description: `${company.industry} — ${company.planTier} plan, $${company.mrr}/mo MRR (simulated Pied Piper account, era: ${FIXTURE_ERA_SLUG})`,
      sim_event_id: company.simEventId,
      sim_time: company.simTime,
      timeline_id: FIXTURE_TIMELINE_ID,
    },
  });

const seedContact = (api: HubSpotApi, contact: FixtureContact, companyHubSpotId: string) =>
  upsert(api, "contacts", contact.simEventId, contact.email, {
    properties: {
      email: contact.email,
      firstname: contact.firstName,
      lastname: contact.lastName,
      jobtitle: contact.jobTitle,
      sim_event_id: contact.simEventId,
      sim_time: contact.simTime,
      timeline_id: FIXTURE_TIMELINE_ID,
    },
    associations: [association(companyHubSpotId, ASSOC_CONTACT_TO_COMPANY)],
  });

const seedDeal = (api: HubSpotApi, deal: FixtureDeal, companyHubSpotId: string) =>
  upsert(api, "deals", deal.simEventId, deal.name, {
    properties: {
      dealname: deal.name,
      pipeline: "default",
      dealstage: deal.stage,
      amount: String(deal.amount),
      sim_event_id: deal.simEventId,
      sim_time: deal.simTime,
      timeline_id: FIXTURE_TIMELINE_ID,
      persona_owner: deal.ownerSlug,
    },
    associations: [association(companyHubSpotId, ASSOC_DEAL_TO_COMPANY)],
  });

const program = Effect.gen(function* () {
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (token === undefined || token === "") {
    return yield* Effect.fail(new MissingTokenError({ variable: "HUBSPOT_PRIVATE_APP_TOKEN" }));
  }
  const api = makeHubSpotApi(token);

  yield* Effect.log(
    `seeding ${fixtures.companies.length} companies, ${fixtures.contacts.length} contacts, ${fixtures.deals.length} deals (timeline ${FIXTURE_TIMELINE_ID})`,
  );

  yield* ensureAllProperties(api);

  for (const company of fixtures.companies) {
    const companyHubSpotId = yield* seedCompany(api, company);
    yield* Effect.forEach(
      fixtures.contacts.filter((c) => c.companyId === company.id),
      (contact) => seedContact(api, contact, companyHubSpotId),
      { concurrency: 1 }, // sequential: ordering + throttling
    );
    const deal = fixtures.deals.find((d) => d.companyId === company.id);
    if (deal !== undefined) {
      yield* seedDeal(api, deal, companyHubSpotId);
    }
  }
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
        `${e.variable} is not set. Create a private app in a HubSpot developer test account and export its token (pat-...) — see the header of this script.`,
      ).pipe(Effect.andThen(fail)),
    HubSpotApiError: (e) =>
      Effect.logError(
        `HubSpot API ${e.endpoint} failed: HTTP ${e.status} [${e.category}] ${e.message}`,
      ).pipe(Effect.andThen(fail)),
    HubSpotRateLimitedError: (e) =>
      Effect.logError(
        `HubSpot API ${e.endpoint} still rate-limited after retries (last Retry-After: ${e.retryAfterSeconds}s)`,
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
