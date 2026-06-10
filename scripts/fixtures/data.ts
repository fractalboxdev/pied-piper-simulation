/**
 * Deterministic fixture dataset for sink seeding (HubSpot CRM, PostHog).
 *
 * Reproducibility contract (CLAUDE.md §4): everything here is a pure function of
 * `FIXTURE_SEED` + `FIXTURE_EPOCH_MS` — a small seeded PRNG (mulberry32), no
 * `Math.random()`, no `Date.now()`. Re-running any seeder always produces the
 * exact same records, ids, and timestamps, which is what makes the sinks'
 * idempotency keys (`sim_event_id`, UUIDv5 per event) stable across replays.
 *
 * This is a static stand-in for the real event-log projection: once the
 * discrete-event engine exists, the seeders should consume "company state as of
 * sim_time T" from the log instead of this module (see CLAUDE.md §7).
 *
 * Dataset shape
 * -------------
 * - ~12 fake B2B customer companies of Pied Piper's middle-out compression
 *   platform (invented names — no real businesses), with domain, plan tier, MRR.
 * - 1–3 contacts per company (fake people on the company's fake domain).
 * - One deal per company at a varying default-pipeline stage, conceptually owned
 *   by a sales-ish persona from PERSONAS.md (real HubSpot owners are seat-bound,
 *   so the owner travels as a custom property / event property instead).
 * - ~4 sim-weeks of product-usage events per company (logins, files compressed,
 *   compression-ratio measurements) spread over a historical date range.
 *
 * Every record carries a stable `simEventId` and belongs to `FIXTURE_TIMELINE_ID`.
 */

// ---------------------------------------------------------------------------
// Reproducibility constants
// ---------------------------------------------------------------------------

/** Fixed PRNG seed — change it and you have declared a new fixture dataset. */
export const FIXTURE_SEED = 0x51c0de01;

/** Timeline every fixture record belongs to (CLAUDE.md §3 branching timelines). */
export const FIXTURE_TIMELINE_ID = "fixtures-main";

/**
 * Fixed epoch for the usage window: 2024-03-04T00:00:00Z (a Monday).
 * All timestamps are explicit offsets from this constant — never the wall clock.
 */
export const FIXTURE_EPOCH_MS = Date.UTC(2024, 2, 4, 0, 0, 0, 0);

/** Length of the product-usage window, in days. */
export const USAGE_WINDOW_DAYS = 28;

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32
// ---------------------------------------------------------------------------

/** mulberry32: tiny, fast, good-enough 32-bit seeded PRNG. Returns [0, 1). */
const mulberry32 = (seed: number): (() => number) => {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

type Rng = () => number;

/** Integer in [min, max], inclusive. */
const int = (rng: Rng, min: number, max: number): number =>
  min + Math.floor(rng() * (max - min + 1));

const pick = <T>(rng: Rng, items: ReadonlyArray<T>): T => {
  const item = items[int(rng, 0, items.length - 1)];
  if (item === undefined) throw new Error("pick: empty array");
  return item;
};

const isoAt = (ms: number): string => new Date(ms).toISOString();

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlanTier = "starter" | "team" | "enterprise";

/** Default HubSpot sales-pipeline stage ids (pipeline "default"). */
export type DealStage =
  | "appointmentscheduled"
  | "qualifiedtobuy"
  | "presentationscheduled"
  | "decisionmakerboughtin"
  | "contractsent"
  | "closedwon"
  | "closedlost";

export interface FixtureCompany {
  /** Stable fixture id, e.g. "octopipe-media" — also the idempotency anchor. */
  readonly id: string;
  readonly simEventId: string;
  /** Canonical sim_time of the company's signup, ISO 8601. */
  readonly simTime: string;
  readonly name: string;
  readonly domain: string;
  readonly industry: string;
  readonly planTier: PlanTier;
  /** Monthly recurring revenue, USD. */
  readonly mrr: number;
}

export interface FixtureContact {
  readonly id: string;
  readonly simEventId: string;
  readonly simTime: string;
  readonly companyId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly jobTitle: string;
}

export interface FixtureDeal {
  readonly id: string;
  readonly simEventId: string;
  readonly simTime: string;
  readonly companyId: string;
  readonly name: string;
  readonly stage: DealStage;
  /** Deal amount, USD (annualized MRR). */
  readonly amount: number;
  /** Persona slug from PERSONAS.md (sales-ish cast) — custom property, not a HubSpot owner. */
  readonly ownerSlug: string;
}

export type UsageEventName =
  | "user_logged_in"
  | "file_compressed"
  | "compression_ratio_measured";

export interface FixtureUsageEvent {
  readonly simEventId: string;
  /** Canonical sim_time of the event, ISO 8601 — also the PostHog timestamp. */
  readonly simTime: string;
  readonly event: UsageEventName;
  /** PostHog distinct_id: the acting fixture contact's id. */
  readonly distinctId: string;
  readonly companyId: string;
  readonly properties: Readonly<Record<string, string | number>>;
}

export interface FixtureDataset {
  readonly companies: ReadonlyArray<FixtureCompany>;
  readonly contacts: ReadonlyArray<FixtureContact>;
  readonly deals: ReadonlyArray<FixtureDeal>;
  readonly usageEvents: ReadonlyArray<FixtureUsageEvent>;
}

// ---------------------------------------------------------------------------
// Seed pools (static, invented)
// ---------------------------------------------------------------------------

/**
 * Invented B2B customers of a middle-out compression platform. Names are
 * fictional; any resemblance to real companies is accidental.
 */
const COMPANY_POOL: ReadonlyArray<{ name: string; domain: string; industry: string }> = [
  { name: "Octopipe Media", domain: "octopipe.example.com", industry: "video streaming" },
  { name: "Datagrove Analytics", domain: "datagrove.example.com", industry: "data warehousing" },
  { name: "Ferrostack Imaging", domain: "ferrostack.example.com", industry: "medical imaging" },
  { name: "Cloudchapel Backup", domain: "cloudchapel.example.com", industry: "backup & archival" },
  { name: "Snapfern Genomics", domain: "snapfern.example.com", industry: "genomics" },
  { name: "Bitparcel CDN", domain: "bitparcel.example.com", industry: "content delivery" },
  { name: "Torrentide Studios", domain: "torrentide.example.com", industry: "game development" },
  { name: "Heliotrope VFX", domain: "heliotrope.example.com", industry: "visual effects" },
  { name: "Quillstone Archive", domain: "quillstone.example.com", industry: "digital preservation" },
  { name: "Loopline Robotics", domain: "loopline.example.com", industry: "robotics telemetry" },
  { name: "Maribel Health", domain: "maribelhealth.example.com", industry: "health records" },
  { name: "Granary Works", domain: "granaryworks.example.com", industry: "satellite imagery" },
] as const;

const FIRST_NAMES = [
  "Ava", "Marcus", "Priya", "Diego", "Hannah", "Kenji", "Lena", "Omar",
  "Sofia", "Theo", "Ingrid", "Rafael", "Mei", "Casper", "Nadia", "Felix",
] as const;

const LAST_NAMES = [
  "Okafor", "Lindqvist", "Marchetti", "Tanaka", "Beaumont", "Castellanos",
  "Novak", "Ferreira", "Hartmann", "Osei", "Kowalski", "Devereux",
] as const;

const JOB_TITLES = [
  "VP Engineering", "Head of Infrastructure", "CTO", "Director of Data Platform",
  "Principal Engineer", "Head of Media Pipeline", "Engineering Manager",
] as const;

/**
 * Sales-ish persona slugs from PERSONAS.md (the single source of truth for the
 * cast — see its format contract). Real HubSpot owners are seat-bound users, so
 * deals carry the persona as the `persona_owner` custom property instead.
 */
export const SALES_PERSONA_SLUGS = ["monica", "erlich", "jared"] as const;

const DEAL_STAGES: ReadonlyArray<DealStage> = [
  "appointmentscheduled",
  "qualifiedtobuy",
  "presentationscheduled",
  "decisionmakerboughtin",
  "contractsent",
  "closedwon",
  "closedlost",
];

const TIER_MRR_RANGE: Record<PlanTier, readonly [number, number]> = {
  starter: [49, 199],
  team: [500, 1900],
  enterprise: [3200, 11800],
};

/** Typical middle-out compression ratio per tier (higher tiers get tuned models). */
const TIER_RATIO_BASE: Record<PlanTier, number> = {
  starter: 3.8,
  team: 4.6,
  enterprise: 5.2,
};

const slugify = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ---------------------------------------------------------------------------
// Generation — pure function of the seed
// ---------------------------------------------------------------------------

export const generateFixtures = (seed: number): FixtureDataset => {
  const rng = mulberry32(seed);

  const companies: Array<FixtureCompany> = [];
  const contacts: Array<FixtureContact> = [];
  const deals: Array<FixtureDeal> = [];
  const usageEvents: Array<FixtureUsageEvent> = [];

  COMPANY_POOL.forEach((base, companyIndex) => {
    const companyId = slugify(base.name);
    const planTier: PlanTier =
      companyIndex % 3 === 0 ? "enterprise" : companyIndex % 3 === 1 ? "team" : "starter";
    const [mrrMin, mrrMax] = TIER_MRR_RANGE[planTier];
    const mrr = int(rng, mrrMin, mrrMax);
    // Signed up 30–180 days before the usage window opens.
    const signupMs = FIXTURE_EPOCH_MS - int(rng, 30, 180) * DAY_MS;

    companies.push({
      id: companyId,
      simEventId: `fixture:company:${companyId}`,
      simTime: isoAt(signupMs),
      name: base.name,
      domain: base.domain,
      industry: base.industry,
      planTier,
      mrr,
    });

    // 1–3 contacts on the company's fake domain.
    const contactCount = int(rng, 1, 3);
    const companyContacts: Array<FixtureContact> = [];
    for (let c = 0; c < contactCount; c++) {
      const firstName = FIRST_NAMES[(int(rng, 0, FIRST_NAMES.length - 1) + c) % FIRST_NAMES.length]!;
      const lastName = LAST_NAMES[(int(rng, 0, LAST_NAMES.length - 1) + c) % LAST_NAMES.length]!;
      const contactId = `${companyId}-${slugify(firstName)}-${slugify(lastName)}`;
      const contact: FixtureContact = {
        id: contactId,
        simEventId: `fixture:contact:${contactId}`,
        simTime: isoAt(signupMs + int(rng, 0, 5) * DAY_MS),
        companyId,
        firstName,
        lastName,
        email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${base.domain}`,
        jobTitle: pick(rng, JOB_TITLES),
      };
      companyContacts.push(contact);
      contacts.push(contact);
    }

    // One deal per company, owned (conceptually) by a sales-ish persona.
    const stage = pick(rng, DEAL_STAGES);
    deals.push({
      id: `${companyId}-platform-deal`,
      simEventId: `fixture:deal:${companyId}-platform-deal`,
      simTime: isoAt(signupMs + int(rng, 3, 21) * DAY_MS),
      companyId,
      name: `${base.name} — middle-out platform (${planTier})`,
      stage,
      amount: mrr * 12,
      ownerSlug: SALES_PERSONA_SLUGS[companyIndex % SALES_PERSONA_SLUGS.length]!,
    });

    // ~4 weeks of product usage. Weekday-weighted, attributed to real contacts.
    const ratioBase = TIER_RATIO_BASE[planTier];
    for (let day = 0; day < USAGE_WINDOW_DAYS; day++) {
      const dayStartMs = FIXTURE_EPOCH_MS + day * DAY_MS;
      const weekday = new Date(dayStartMs).getUTCDay();
      const isWeekend = weekday === 0 || weekday === 6;
      let dailyBytesIn = 0;
      let dailyBytesOut = 0;
      let seq = 0;

      for (const contact of companyContacts) {
        // Weekends are mostly quiet; weekdays 0–2 sessions per contact.
        const sessions = isWeekend ? int(rng, 0, 1) : int(rng, 0, 2);
        for (let s = 0; s < sessions; s++) {
          const loginMs = dayStartMs + (9 * 60 + int(rng, 0, 9 * 60)) * 60 * 1000; // 09:00–18:00 UTC
          usageEvents.push({
            simEventId: `fixture:usage:${companyId}:d${day}:${seq++}`,
            simTime: isoAt(loginMs),
            event: "user_logged_in",
            distinctId: contact.id,
            companyId,
            properties: { session: s + 1 },
          });

          const filesCompressed = int(rng, 1, 4);
          for (let f = 0; f < filesCompressed; f++) {
            const bytesIn = int(rng, 5, 4800) * 1024 * 1024; // 5MB–4.8GB
            const ratio = ratioBase + int(rng, -40, 60) / 100;
            const bytesOut = Math.round(bytesIn / ratio);
            dailyBytesIn += bytesIn;
            dailyBytesOut += bytesOut;
            usageEvents.push({
              simEventId: `fixture:usage:${companyId}:d${day}:${seq++}`,
              simTime: isoAt(loginMs + int(rng, 1, 50) * 60 * 1000),
              event: "file_compressed",
              distinctId: contact.id,
              companyId,
              properties: {
                bytes_in: bytesIn,
                bytes_out: bytesOut,
                compression_ratio: Math.round((bytesIn / bytesOut) * 100) / 100,
              },
            });
          }
        }
      }

      // One end-of-day aggregate ratio measurement per active day, attributed
      // to the first contact (a service account would also work).
      if (dailyBytesIn > 0 && companyContacts[0] !== undefined) {
        usageEvents.push({
          simEventId: `fixture:usage:${companyId}:d${day}:${seq++}`,
          simTime: isoAt(dayStartMs + 23 * 60 * 60 * 1000),
          event: "compression_ratio_measured",
          distinctId: companyContacts[0].id,
          companyId,
          properties: {
            bytes_in_total: dailyBytesIn,
            bytes_out_total: dailyBytesOut,
            weissman_adjacent_ratio: Math.round((dailyBytesIn / dailyBytesOut) * 100) / 100,
          },
        });
      }
    }
  });

  return { companies, contacts, deals, usageEvents };
};

/** The fixture dataset — deterministic, same on every import. */
export const fixtures: FixtureDataset = generateFixtures(FIXTURE_SEED);
