/**
 * Mock Anthropic (Claude API) invoice data payable by Pied Piper — the vendor
 * **cost** side of the fixture dataset's unit economics.
 *
 * Three monthly invoices (usage billed in arrears) covering the three months
 * leading up to the fixture usage window (`FIXTURE_EPOCH_MS` = 2024-03-04,
 * PiperNet era). Line items are explicit data — deterministic by construction,
 * no PRNG needed for 3 × ~7 rows.
 *
 * Consumers:
 * - `scripts/invoices/generate-anthropic-invoices.ts` renders them as PDFs.
 * - `scripts/fixtures/economics.ts` allocates the March invoice across clients
 *   by compression-bytes share (cost per KB per client).
 *
 * Model pricing matches Anthropic's published per-MTok rates:
 *   claude-opus-4-8   $5 in / $25 out   (cache read 0.1× input = $0.50)
 *   claude-sonnet-4-6 $3 in / $15 out
 *   claude-haiku-4-5  $1 in / $5 out
 */

export interface AnthropicLineItem {
  readonly description: string;
  /** Usage quantity in millions of tokens. */
  readonly mtok: number;
  /** USD per million tokens. */
  readonly ratePerMTok: number;
}

export interface AnthropicInvoice {
  /** Stable fixture id — also the idempotency anchor (sim_event_id suffix). */
  readonly id: string;
  readonly invoiceNumber: string;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly periodLabel: string;
  /** First day of the usage month, ISO date — the join key for cost allocation. */
  readonly periodMonth: string;
  readonly lineItems: ReadonlyArray<AnthropicLineItem>;
}

const OPUS_IN = 5;
const OPUS_OUT = 25;
const OPUS_CACHE_READ = 0.5;
const SONNET_IN = 3;
const SONNET_OUT = 15;
const HAIKU_IN = 1;
const HAIKU_OUT = 5;

/**
 * Usage ramps month over month (~1.5×) — PiperNet adoption is climbing and so
 * is Pied Piper's Claude bill. Quantities are MTok.
 */
export const ANTHROPIC_INVOICES: ReadonlyArray<AnthropicInvoice> = [
  {
    id: "anthropic-2024-01",
    invoiceNumber: "INV-ANTH-2024-0117",
    issueDate: "2024-02-01",
    dueDate: "2024-03-02",
    periodLabel: "January 1 – January 31, 2024",
    periodMonth: "2024-01",
    lineItems: [
      { description: "claude-opus-4-8 — input tokens", mtok: 184.6, ratePerMTok: OPUS_IN },
      { description: "claude-opus-4-8 — output tokens", mtok: 22.4, ratePerMTok: OPUS_OUT },
      { description: "claude-opus-4-8 — prompt caching read", mtok: 410.2, ratePerMTok: OPUS_CACHE_READ },
      { description: "claude-sonnet-4-6 — input tokens", mtok: 612.0, ratePerMTok: SONNET_IN },
      { description: "claude-sonnet-4-6 — output tokens", mtok: 73.5, ratePerMTok: SONNET_OUT },
      { description: "claude-haiku-4-5 — input tokens", mtok: 1530.8, ratePerMTok: HAIKU_IN },
      { description: "claude-haiku-4-5 — output tokens", mtok: 96.2, ratePerMTok: HAIKU_OUT },
    ],
  },
  {
    id: "anthropic-2024-02",
    invoiceNumber: "INV-ANTH-2024-0203",
    issueDate: "2024-03-01",
    dueDate: "2024-03-31",
    periodLabel: "February 1 – February 29, 2024",
    periodMonth: "2024-02",
    lineItems: [
      { description: "claude-opus-4-8 — input tokens", mtok: 277.1, ratePerMTok: OPUS_IN },
      { description: "claude-opus-4-8 — output tokens", mtok: 34.9, ratePerMTok: OPUS_OUT },
      { description: "claude-opus-4-8 — prompt caching read", mtok: 655.7, ratePerMTok: OPUS_CACHE_READ },
      { description: "claude-sonnet-4-6 — input tokens", mtok: 941.3, ratePerMTok: SONNET_IN },
      { description: "claude-sonnet-4-6 — output tokens", mtok: 112.8, ratePerMTok: SONNET_OUT },
      { description: "claude-haiku-4-5 — input tokens", mtok: 2304.5, ratePerMTok: HAIKU_IN },
      { description: "claude-haiku-4-5 — output tokens", mtok: 148.0, ratePerMTok: HAIKU_OUT },
    ],
  },
  {
    id: "anthropic-2024-03",
    invoiceNumber: "INV-ANTH-2024-0288",
    issueDate: "2024-04-01",
    dueDate: "2024-05-01",
    periodLabel: "March 1 – March 31, 2024",
    periodMonth: "2024-03",
    lineItems: [
      { description: "claude-opus-4-8 — input tokens", mtok: 419.4, ratePerMTok: OPUS_IN },
      { description: "claude-opus-4-8 — output tokens", mtok: 51.6, ratePerMTok: OPUS_OUT },
      { description: "claude-opus-4-8 — prompt caching read", mtok: 988.1, ratePerMTok: OPUS_CACHE_READ },
      { description: "claude-sonnet-4-6 — input tokens", mtok: 1422.7, ratePerMTok: SONNET_IN },
      { description: "claude-sonnet-4-6 — output tokens", mtok: 169.3, ratePerMTok: SONNET_OUT },
      { description: "claude-haiku-4-5 — input tokens", mtok: 3477.9, ratePerMTok: HAIKU_IN },
      { description: "claude-haiku-4-5 — output tokens", mtok: 221.4, ratePerMTok: HAIKU_OUT },
    ],
  },
];

const round2 = (n: number): number => Math.round(n * 100) / 100;

export const lineTotal = (item: AnthropicLineItem): number =>
  round2(item.mtok * item.ratePerMTok);

export const invoiceTotal = (invoice: AnthropicInvoice): number =>
  round2(invoice.lineItems.reduce((sum, item) => sum + lineTotal(item), 0));
