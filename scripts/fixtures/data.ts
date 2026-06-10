/**
 * Deterministic fixture dataset for sink seeding (HubSpot CRM, PostHog).
 *
 * Reproducibility contract (CLAUDE.md §4): everything here is a pure function of
 * `FIXTURE_SEED` + `FIXTURE_EPOCH_MS` — a small seeded PRNG (mulberry32), no
 * `Math.random()`, no `Date.now()`. Re-running any seeder always produces the
 * exact same records, ids, and timestamps, which is what makes the sinks'
 * idempotency keys (`sim_event_id`, UUIDv5 per event) stable across replays.
 *
 * Canon (docs/COMPANY.md): the dataset is pinned to the **PiperNet platform
 * era** (`FIXTURE_ERA_SLUG = "pipernet"`, S5) of Pied Piper's history. Marquee
 * accounts are the canon customers/partners/rivals (Maleant Data Systems,
 * Intersite, FGI, Hooli, K-Hole Games, …) with deal stages reflecting their
 * canon arcs; filler accounts are invented but named to fit the show's world.
 * The quality metric is the **Weissman score** (plausible range 2.0–5.2; 5.2 is
 * Richard's TechCrunch Disrupt breakthrough, 2.89 the old theoretical limit).
 *
 * This is a static stand-in for the real event-log projection: once the
 * discrete-event engine exists, the seeders should consume "company state as of
 * sim_time T" from the log instead of this module (see CLAUDE.md §7).
 *
 * Dataset shape
 * -------------
 * - 12 B2B accounts of the PiperNet platform (canon marquee + show-flavored
 *   filler), with domain, plan tier, MRR.
 * - 1–3 contacts per company (fake people on the company's fake domain).
 * - One deal per company: canon accounts carry their canon-arc stage and a
 *   fixed persona owner; filler deals get a varying default-pipeline stage.
 *   Owners are persona slugs from PERSONAS.md (real HubSpot owners are
 *   seat-bound, so the owner travels as a custom property / event property).
 * - ~4 sim-weeks of product-usage events per paying company (logins, files
 *   compressed with per-file Weissman scores, daily Weissman measurements,
 *   PiperNet `node_joined` events) spread over a historical date range.
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
 * Company-history era the fixture window represents — an era slug from
 * docs/COMPANY.md (the PiperNet platform era, S5). The sim_time axis is
 * independent of the show's broadcast years; eras carry ordering, not dates.
 */
export const FIXTURE_ERA_SLUG = "pipernet";

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
  /** Stable fixture id, e.g. "maleant-data-systems" — also the idempotency anchor. */
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
  | "weissman_score_measured"
  | "node_joined";

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
// Seed pools
// ---------------------------------------------------------------------------

/**
 * Persona slugs from PERSONAS.md who own deals (the single source of truth for
 * the cast — see its format contract): Monica (investor/board-side), Erlich
 * (evangelist), Jared (biz-ops). Real HubSpot owners are seat-bound users, so
 * deals carry the persona as the `persona_owner` custom property instead.
 */
export const SALES_PERSONA_SLUGS = ["monica", "erlich", "jared"] as const;

export type SalesPersonaSlug = (typeof SALES_PERSONA_SLUGS)[number];

/** Fixed canon deal facts for a marquee account (see docs/COMPANY.md relationships). */
interface CanonDeal {
  readonly dealName: string;
  readonly stage: DealStage;
  readonly owner: SalesPersonaSlug;
}

interface CompanySeed {
  readonly name: string;
  readonly domain: string;
  readonly industry: string;
  readonly tier: PlanTier;
  /** Present on canon marquee accounts; filler deals are drawn from the PRNG. */
  readonly canon?: CanonDeal;
}

/**
 * B2B accounts of the PiperNet platform. The first five are canon marquee
 * accounts whose deal stage/owner reflect their show arcs (docs/COMPANY.md);
 * the rest are canon minor companies or invented names that fit the show's
 * world. Domains stay on .example.com — no real businesses.
 */
const COMPANY_POOL: ReadonlyArray<CompanySeed> = [
  {
    name: "Maleant Data Systems",
    domain: "maleant.example.com",
    industry: "enterprise data appliances",
    tier: "enterprise",
    canon: {
      // S3: the box appliance contract closed under Jack Barker — legacy won account.
      dealName: "Maleant Data Systems — appliance contract (the box)",
      stage: "closedwon",
      owner: "jared",
    },
  },
  {
    name: "Intersite",
    domain: "intersite.example.com",
    industry: "adult content streaming",
    tier: "enterprise",
    canon: {
      // S2: ~$20M storage/transcode contract won in the bake-off vs Endframe.
      dealName: "Intersite — storage & transcode contract (bake-off win)",
      stage: "closedwon",
      owner: "erlich",
    },
  },
  {
    name: "FGI",
    domain: "fgi.example.com",
    industry: "insurance",
    tier: "enterprise",
    canon: {
      // S4: first commercial pilot of the decentralized internet.
      dealName: "FGI — decentralized data pilot",
      stage: "closedwon",
      owner: "jared",
    },
  },
  {
    name: "Hooli",
    domain: "hooli.example.com",
    industry: "internet conglomerate (rival)",
    tier: "enterprise",
    canon: {
      // Rival, not a customer: every acquisition/licensing overture was declined or hostile.
      dealName: "Hooli — platform licensing (declined)",
      stage: "closedlost",
      owner: "monica",
    },
  },
  {
    name: "K-Hole Games",
    domain: "k-hole.example.com",
    industry: "game development",
    tier: "enterprise",
    canon: {
      // S5: the flagship PiperNet compute customer (the 51%-attack-era launch).
      dealName: "K-Hole Games — PiperNet compute (flagship)",
      stage: "closedwon",
      owner: "monica",
    },
  },
  // Canon minor companies (deal stage/owner drawn from the PRNG).
  { name: "Seppen", domain: "seppen.example.com", industry: "smart home appliances", tier: "team" },
  { name: "RussFest", domain: "russfest.example.com", industry: "live events & festivals", tier: "team" },
  { name: "Optimoji", domain: "optimoji.example.com", industry: "messaging", tier: "starter" },
  // Invented filler, named for the show's world — any resemblance to real businesses is accidental.
  { name: "Vrtigo Immersive", domain: "vrtigo.example.com", industry: "virtual reality", tier: "team" },
  { name: "Dineros Pay", domain: "dineros.example.com", industry: "payments", tier: "team" },
  { name: "Fropple", domain: "fropple.example.com", industry: "photo sharing", tier: "starter" },
  { name: "Snibbet", domain: "snibbet.example.com", industry: "social analytics", tier: "starter" },
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

/**
 * Typical Weissman score per tier (higher tiers get tuned middle-out models).
 * Canon bounds (docs/COMPANY.md products): 2.89 was the believed theoretical
 * limit; 5.2 is Richard's record. Jitter is ±0.3, clamped to [2.0, 5.2].
 */
const TIER_WEISSMAN_BASE: Record<PlanTier, number> = {
  starter: 3.2,
  team: 4.1,
  enterprise: 4.9,
};

export const WEISSMAN_SCORE_MIN = 2.0;
export const WEISSMAN_SCORE_MAX = 5.2;

/** PiperNet regions for node_joined events. */
const PIPERNET_REGIONS = ["us-west", "us-east", "eu-central", "ap-south"] as const;

const slugify = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const round2 = (n: number): number => Math.round(n * 100) / 100;

const clampScore = (n: number): number =>
  Math.min(WEISSMAN_SCORE_MAX, Math.max(WEISSMAN_SCORE_MIN, n));

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
    const planTier = base.tier;
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

    // One deal per company. Canon marquee accounts carry their canon-arc stage
    // and a fixed persona owner; filler deals are drawn from the PRNG.
    const stage = base.canon?.stage ?? pick(rng, DEAL_STAGES);
    const ownerSlug =
      base.canon?.owner ?? SALES_PERSONA_SLUGS[companyIndex % SALES_PERSONA_SLUGS.length]!;
    deals.push({
      id: `${companyId}-platform-deal`,
      simEventId: `fixture:deal:${companyId}-platform-deal`,
      simTime: isoAt(signupMs + int(rng, 3, 21) * DAY_MS),
      companyId,
      name: base.canon?.dealName ?? `${base.name} — PiperNet platform (${planTier})`,
      stage,
      amount: mrr * 12,
      ownerSlug,
    });

    // Canon-pinned lost accounts (Hooli, the rival) never used the product — no
    // usage. Filler accounts keep usage regardless of stage (a PRNG-drawn
    // closedlost reads as a lost expansion deal on an active account).
    if (base.canon?.stage === "closedlost") return;

    // ~4 weeks of product usage. Weekday-weighted, attributed to real contacts.
    const scoreBase = TIER_WEISSMAN_BASE[planTier];
    let nodeCounter = 0;
    for (let day = 0; day < USAGE_WINDOW_DAYS; day++) {
      const dayStartMs = FIXTURE_EPOCH_MS + day * DAY_MS;
      const weekday = new Date(dayStartMs).getUTCDay();
      const isWeekend = weekday === 0 || weekday === 6;
      let dailyBytesIn = 0;
      let dailyBytesOut = 0;
      let dailyScoreSum = 0;
      let dailyScoreCount = 0;
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
            const weissmanScore = round2(clampScore(scoreBase + int(rng, -30, 30) / 100));
            // Effective size reduction scales loosely with the score.
            const bytesOut = Math.round(bytesIn / (weissmanScore * 1.2));
            dailyBytesIn += bytesIn;
            dailyBytesOut += bytesOut;
            dailyScoreSum += weissmanScore;
            dailyScoreCount += 1;
            usageEvents.push({
              simEventId: `fixture:usage:${companyId}:d${day}:${seq++}`,
              simTime: isoAt(loginMs + int(rng, 1, 50) * 60 * 1000),
              event: "file_compressed",
              distinctId: contact.id,
              companyId,
              properties: {
                bytes_in: bytesIn,
                bytes_out: bytesOut,
                weissman_score: weissmanScore,
              },
            });
          }
        }
      }

      // PiperNet-era flavor: occasionally the account brings a new node onto
      // the network (~1 in 10 weekdays), attributed to the first contact.
      if (!isWeekend && companyContacts[0] !== undefined && int(rng, 0, 9) === 0) {
        nodeCounter += 1;
        usageEvents.push({
          simEventId: `fixture:usage:${companyId}:d${day}:${seq++}`,
          simTime: isoAt(dayStartMs + 12 * 60 * 60 * 1000),
          event: "node_joined",
          distinctId: companyContacts[0].id,
          companyId,
          properties: {
            node_id: `${companyId}-node-${nodeCounter}`,
            region: pick(rng, PIPERNET_REGIONS),
          },
        });
      }

      // One end-of-day aggregate Weissman measurement per active day,
      // attributed to the first contact (a service account would also work).
      if (dailyScoreCount > 0 && companyContacts[0] !== undefined) {
        usageEvents.push({
          simEventId: `fixture:usage:${companyId}:d${day}:${seq++}`,
          simTime: isoAt(dayStartMs + 23 * 60 * 60 * 1000),
          event: "weissman_score_measured",
          distinctId: companyContacts[0].id,
          companyId,
          properties: {
            bytes_in_total: dailyBytesIn,
            bytes_out_total: dailyBytesOut,
            weissman_score: round2(dailyScoreSum / dailyScoreCount),
          },
        });
      }
    }
  });

  return { companies, contacts, deals, usageEvents };
};

/** The fixture dataset — deterministic, same on every import. */
export const fixtures: FixtureDataset = generateFixtures(FIXTURE_SEED);
