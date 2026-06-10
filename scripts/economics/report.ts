/**
 * Print the per-client unit-economics join (scripts/fixtures/economics.ts):
 * usage-based revenue per client × allocated Anthropic (Claude) cost, and the
 * headline "Claude cost per KB of compression per client" metric.
 *
 * Pure projection over the deterministic fixture dataset — no env vars, no
 * network. Run: pnpm report:economics
 */

import {
  METERED_RATE_PER_GB_USD,
  USAGE_WINDOW_DAYS,
  WINDOW_ANTHROPIC_INVOICE,
  computeClientEconomics,
} from "../fixtures/economics.ts";
import { invoiceTotal } from "../fixtures/anthropic-invoices.ts";
import { FIXTURE_EPOCH_MS, FIXTURE_TIMELINE_ID } from "../fixtures/data.ts";

const usd = (n: number): string =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const rows = computeClientEconomics();

interface Column {
  readonly header: string;
  readonly value: (r: (typeof rows)[number]) => string;
  readonly align: "left" | "right";
}

const COLUMNS: ReadonlyArray<Column> = [
  { header: "Client", value: (r) => r.companyName, align: "left" },
  { header: "Tier", value: (r) => r.planTier, align: "left" },
  { header: "GB in", value: (r) => r.gbIn.toFixed(1), align: "right" },
  { header: "Base fee", value: (r) => usd(r.baseFeeUsd), align: "right" },
  { header: "Metered", value: (r) => usd(r.meteredRevenueUsd), align: "right" },
  { header: "Revenue", value: (r) => usd(r.revenueUsd), align: "right" },
  { header: "Claude cost", value: (r) => usd(r.allocatedClaudeCostUsd), align: "right" },
  { header: "$/KB", value: (r) => r.claudeCostPerKbUsd.toExponential(2), align: "right" },
  { header: "$/GB", value: (r) => usd(r.claudeCostPerGbUsd), align: "right" },
  { header: "Margin", value: (r) => `${r.grossMarginPct.toFixed(1)}%`, align: "right" },
];

const widths = COLUMNS.map((col) =>
  Math.max(col.header.length, ...rows.map((r) => col.value(r).length)),
);

const formatRow = (cells: ReadonlyArray<string>): string =>
  cells
    .map((cell, i) => {
      const width = widths[i] ?? cell.length;
      return COLUMNS[i]?.align === "right" ? cell.padStart(width) : cell.padEnd(width);
    })
    .join("  ");

const windowStart = new Date(FIXTURE_EPOCH_MS).toISOString().slice(0, 10);
console.log(
  `Unit economics — usage window ${windowStart} +${USAGE_WINDOW_DAYS}d (timeline ${FIXTURE_TIMELINE_ID})`,
);
console.log(
  `Claude cost source: ${WINDOW_ANTHROPIC_INVOICE.invoiceNumber} (${WINDOW_ANTHROPIC_INVOICE.periodLabel}) = ${usd(invoiceTotal(WINDOW_ANTHROPIC_INVOICE))}, allocated by tier-weighted compressed-bytes share`,
);
console.log(
  `Metered price per GB: starter ${usd(METERED_RATE_PER_GB_USD.starter)}, team ${usd(METERED_RATE_PER_GB_USD.team)}, enterprise ${usd(METERED_RATE_PER_GB_USD.enterprise)}`,
);
console.log("");
console.log(formatRow(COLUMNS.map((c) => c.header)));
console.log(formatRow(widths.map((w) => "-".repeat(w))));
for (const row of rows) {
  console.log(formatRow(COLUMNS.map((c) => c.value(row))));
}

const sum = (f: (r: (typeof rows)[number]) => number): number =>
  rows.reduce((acc, r) => acc + f(r), 0);

console.log("");
console.log(
  `Totals: ${rows.length} clients, ${sum((r) => r.gbIn).toFixed(1)} GB compressed, revenue ${usd(sum((r) => r.revenueUsd))}, Claude cost ${usd(sum((r) => r.allocatedClaudeCostUsd))}, gross margin ${usd(sum((r) => r.grossMarginUsd))}`,
);
console.log(
  `Blended Claude cost per KB: ${(sum((r) => r.allocatedClaudeCostUsd) / sum((r) => r.kbIn)).toExponential(2)} USD (${usd(sum((r) => r.allocatedClaudeCostUsd) / sum((r) => r.gbIn))}/GB vs metered price ${usd(METERED_RATE_PER_GB_USD.enterprise)}–${usd(METERED_RATE_PER_GB_USD.starter)}/GB — compression compute is sold below cost; margin lives in the base fee)`,
);
