/**
 * Unit economics join: Stripe-side **revenue** × Anthropic-side **cost**, per
 * client, over the fixture usage window (March 2024, PiperNet era).
 *
 * Everything derives from the two existing fixture sources — no new
 * randomness, so the reproducibility contract (CLAUDE.md §4) holds:
 *
 *   `fixtures.usageEvents` (data.ts)        →  compressed bytes per client/day
 *   `ANTHROPIC_INVOICES` (anthropic-invoices.ts) →  Claude spend for the month
 *
 * Revenue model (usage-based pricing, mirrored by the Stripe seeder):
 *   - flat platform base fee  = the company's `mrr` (per-tier PRNG draw)
 *   - metered compression fee = per-GB-ingested rate by plan tier
 *
 * Cost model: the March Anthropic invoice (the month overlapping the usage
 * window) is allocated across clients by share of **tier-weighted bytes
 * ingested for compression** — middle-out runs on Claude in this simulation,
 * so compression compute is the cost driver, and higher tiers' tuned models
 * burn more Opus per byte (`CLAUDE_COMPUTE_WEIGHT`). From the join we derive
 * the headline metric:
 *
 *   claudeCostPerKbUsd = allocated Claude cost / KB ingested for compression
 *
 * Canon-flavored caveat the numbers deliberately surface: Claude cost per GB
 * (~$4–5) far exceeds the metered price per GB ($0.07–0.15) — compression is
 * sold below compute cost and margin lives entirely in the base fee. Richard
 * prices for growth; Jared has a spreadsheet about it.
 */

import {
  ANTHROPIC_INVOICES,
  invoiceTotal,
  type AnthropicInvoice,
} from "./anthropic-invoices.ts";
import {
  FIXTURE_EPOCH_MS,
  USAGE_WINDOW_DAYS,
  fixtures,
  type FixtureCompany,
  type PlanTier,
} from "./data.ts";

// ---------------------------------------------------------------------------
// Usage-based pricing (shared with scripts/stripe/seed-fixtures.ts)
// ---------------------------------------------------------------------------

/** Metered price per GB ingested for compression, USD, by plan tier. */
export const METERED_RATE_PER_GB_USD: Record<PlanTier, number> = {
  starter: 0.15,
  team: 0.1,
  enterprise: 0.07,
};

/**
 * Relative Claude compute per byte, by plan tier — the cost-allocation weight.
 * Higher tiers run tuned middle-out models (cf. `TIER_WEISSMAN_BASE` in
 * data.ts): better Weissman scores cost more Opus tokens per byte ingested.
 */
export const CLAUDE_COMPUTE_WEIGHT: Record<PlanTier, number> = {
  starter: 0.6,
  team: 1.0,
  enterprise: 1.35,
};

/** The Anthropic invoice whose usage month overlaps the fixture window. */
export const WINDOW_ANTHROPIC_INVOICE: AnthropicInvoice = (() => {
  const windowMonth = new Date(FIXTURE_EPOCH_MS).toISOString().slice(0, 7);
  const invoice = ANTHROPIC_INVOICES.find((i) => i.periodMonth === windowMonth);
  if (invoice === undefined) {
    throw new Error(`no Anthropic invoice covers fixture month ${windowMonth}`);
  }
  return invoice;
})();

const BYTES_PER_KB = 1024;
const BYTES_PER_GB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Per-client/day compression aggregates (from file_compressed usage events)
// ---------------------------------------------------------------------------

export interface DailyCompression {
  readonly companyId: string;
  /** 0-based day offset from FIXTURE_EPOCH_MS. */
  readonly dayIndex: number;
  /** ISO date (UTC) of the day. */
  readonly date: string;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly fileCount: number;
}

/**
 * Compressed-bytes-per-day per company, derived from `file_compressed` events.
 * This is the same aggregation the Stripe seeder reports as meter events, so
 * Stripe revenue and the economics report can never disagree.
 */
export const dailyCompressionByCompany = (): ReadonlyMap<
  string,
  ReadonlyArray<DailyCompression>
> => {
  const byKey = new Map<string, DailyCompression>();
  for (const event of fixtures.usageEvents) {
    if (event.event !== "file_compressed") continue;
    const dayIndex = Math.floor((Date.parse(event.simTime) - FIXTURE_EPOCH_MS) / DAY_MS);
    const key = `${event.companyId}:${dayIndex}`;
    const previous = byKey.get(key);
    const bytesIn = Number(event.properties["bytes_in"] ?? 0);
    const bytesOut = Number(event.properties["bytes_out"] ?? 0);
    byKey.set(key, {
      companyId: event.companyId,
      dayIndex,
      date: new Date(FIXTURE_EPOCH_MS + dayIndex * DAY_MS).toISOString().slice(0, 10),
      bytesIn: (previous?.bytesIn ?? 0) + bytesIn,
      bytesOut: (previous?.bytesOut ?? 0) + bytesOut,
      fileCount: (previous?.fileCount ?? 0) + 1,
    });
  }
  const byCompany = new Map<string, Array<DailyCompression>>();
  for (const day of byKey.values()) {
    const list = byCompany.get(day.companyId) ?? [];
    list.push(day);
    byCompany.set(day.companyId, list);
  }
  for (const list of byCompany.values()) list.sort((a, b) => a.dayIndex - b.dayIndex);
  return byCompany;
};

// ---------------------------------------------------------------------------
// The join — revenue × allocated Claude cost, per client
// ---------------------------------------------------------------------------

export interface ClientEconomics {
  readonly companyId: string;
  readonly companyName: string;
  readonly planTier: PlanTier;
  /** Bytes ingested for compression over the usage window. */
  readonly bytesIn: number;
  readonly kbIn: number;
  readonly gbIn: number;
  /** Flat platform fee (the company's MRR), USD. */
  readonly baseFeeUsd: number;
  readonly meteredRatePerGbUsd: number;
  readonly meteredRevenueUsd: number;
  readonly revenueUsd: number;
  /** Share of tier-weighted compressed bytes (the cost-allocation key). */
  readonly usageShare: number;
  /** Share of the window month's Anthropic invoice, USD. */
  readonly allocatedClaudeCostUsd: number;
  /** Headline metric: Claude spend per KB ingested for compression. */
  readonly claudeCostPerKbUsd: number;
  readonly claudeCostPerGbUsd: number;
  readonly grossMarginUsd: number;
  readonly grossMarginPct: number;
}

/**
 * One row per client with compression usage in the window. Clients with no
 * usage (canon-lost rival Hooli) have no Stripe subscription and no allocated
 * cost — they are intentionally absent.
 */
export const computeClientEconomics = (): ReadonlyArray<ClientEconomics> => {
  const daily = dailyCompressionByCompany();
  const claudeCostUsd = invoiceTotal(WINDOW_ANTHROPIC_INVOICE);

  const companiesById = new Map<string, FixtureCompany>(
    fixtures.companies.map((c) => [c.id, c]),
  );

  const totals = [...daily.entries()].map(([companyId, days]) => {
    const company = companiesById.get(companyId);
    if (company === undefined) throw new Error(`unknown fixture company ${companyId}`);
    const bytesIn = days.reduce((sum, d) => sum + d.bytesIn, 0);
    return {
      companyId,
      bytesIn,
      weightedBytes: bytesIn * CLAUDE_COMPUTE_WEIGHT[company.planTier],
    };
  });
  const totalWeightedBytes = totals.reduce((sum, t) => sum + t.weightedBytes, 0);

  return totals
    .map(({ companyId, bytesIn, weightedBytes }) => {
      const company = companiesById.get(companyId);
      if (company === undefined) throw new Error(`unknown fixture company ${companyId}`);
      const gbIn = bytesIn / BYTES_PER_GB;
      const kbIn = bytesIn / BYTES_PER_KB;
      const meteredRate = METERED_RATE_PER_GB_USD[company.planTier];
      const meteredRevenueUsd = round2(gbIn * meteredRate);
      const revenueUsd = round2(company.mrr + meteredRevenueUsd);
      const usageShare = weightedBytes / totalWeightedBytes;
      const allocatedClaudeCostUsd = round2(claudeCostUsd * usageShare);
      const grossMarginUsd = round2(revenueUsd - allocatedClaudeCostUsd);
      return {
        companyId,
        companyName: company.name,
        planTier: company.planTier,
        bytesIn,
        kbIn,
        gbIn,
        baseFeeUsd: company.mrr,
        meteredRatePerGbUsd: meteredRate,
        meteredRevenueUsd,
        revenueUsd,
        usageShare,
        allocatedClaudeCostUsd,
        claudeCostPerKbUsd: allocatedClaudeCostUsd / kbIn,
        claudeCostPerGbUsd: allocatedClaudeCostUsd / gbIn,
        grossMarginUsd,
        grossMarginPct: (grossMarginUsd / revenueUsd) * 100,
      };
    })
    .sort((a, b) => b.revenueUsd - a.revenueUsd);
};

export { USAGE_WINDOW_DAYS };
