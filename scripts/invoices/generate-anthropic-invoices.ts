/**
 * Generate mock Anthropic (Claude API) invoices payable by Pied Piper, as PDFs.
 *
 * Three monthly invoices (usage billed in arrears) covering the three months
 * leading up to the fixture usage window in `scripts/fixtures/data.ts`
 * (FIXTURE_EPOCH_MS = 2024-03-04, PiperNet era). Like the rest of the fixture
 * dataset, the invoices are fully deterministic: line items are explicit data
 * (no PRNG needed), and the PDF metadata dates are pinned to the invoice issue
 * date — never the wall clock — so re-running the script produces
 * byte-identical PDFs.
 *
 * Every invoice is clearly marked SPECIMEN and carries the fixture timeline /
 * sim_event_id conventions in its footer, mirroring the HubSpot/PostHog
 * seeders' replay-safety contract (CLAUDE.md §7).
 *
 * Model pricing matches Anthropic's published per-MTok rates:
 *   claude-opus-4-8   $5 in / $25 out   (cache read 0.1× input = $0.50)
 *   claude-sonnet-4-6 $3 in / $15 out
 *   claude-haiku-4-5  $1 in / $5 out
 *
 * Run: pnpm generate:invoices  →  fixtures/invoices/*.pdf
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";

import {
  ANTHROPIC_INVOICES,
  invoiceTotal,
  lineTotal,
  type AnthropicInvoice,
} from "../fixtures/anthropic-invoices.ts";
import { FIXTURE_TIMELINE_ID } from "../fixtures/data.ts";

const VENDOR_LINES = [
  "Anthropic, PBC",
  "548 Market Street, PMB 90375",
  "San Francisco, CA 94104",
  "United States",
] as const;

const BILL_TO_LINES = [
  "Pied Piper, Inc.",
  "Attn: Jared Dunn (Accounts Payable)",
  "5230 Newell Road",
  "Palo Alto, CA 94303",
  "ap@piedpiper.example.com",
] as const;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const usd = (n: number): string =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const mtokQty = (n: number): string =>
  `${n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MTok`;

const longDate = (iso: string): string => {
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  return `${months[(m ?? 1) - 1]} ${d}, ${y}`;
};

// ---------------------------------------------------------------------------
// PDF layout (US Letter, 612 × 792 pt)
// ---------------------------------------------------------------------------

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;

const INK = rgb(0.13, 0.12, 0.11);
const MUTED = rgb(0.45, 0.43, 0.41);
const RULE = rgb(0.8, 0.78, 0.75);
const ACCENT = rgb(0.79, 0.38, 0.25); // terracotta, close to Anthropic's brand

interface Fonts {
  readonly regular: PDFFont;
  readonly bold: PDFFont;
}

const drawRightAligned = (
  page: PDFPage,
  text: string,
  rightX: number,
  y: number,
  font: PDFFont,
  size: number,
  color = INK,
): void => {
  page.drawText(text, { x: rightX - font.widthOfTextAtSize(text, size), y, size, font, color });
};

const renderInvoice = async (spec: AnthropicInvoice): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

  // Determinism: pin all PDF metadata dates to the invoice issue date.
  const issued = new Date(`${spec.issueDate}T00:00:00Z`);
  doc.setTitle(`${spec.invoiceNumber} — Anthropic invoice to Pied Piper (specimen)`);
  doc.setAuthor("pied-piper-simulation fixtures");
  doc.setProducer("pied-piper-simulation");
  doc.setCreator("scripts/invoices/generate-anthropic-invoices.ts");
  doc.setCreationDate(issued);
  doc.setModificationDate(issued);

  let y = PAGE_HEIGHT - MARGIN - 10;

  // Header
  page.drawText("ANTHROPIC", { x: MARGIN, y, size: 22, font: fonts.bold, color: ACCENT });
  drawRightAligned(page, "INVOICE", PAGE_WIDTH - MARGIN, y, fonts.bold, 22, INK);
  y -= 16;
  page.drawText("anthropic.com", { x: MARGIN, y, size: 9, font: fonts.regular, color: MUTED });
  drawRightAligned(page, "SPECIMEN — simulated fixture, not a real invoice", PAGE_WIDTH - MARGIN, y, fonts.regular, 8, ACCENT);

  y -= 18;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 1, color: RULE });

  // Invoice meta block (right) + vendor/bill-to (left)
  y -= 24;
  const metaLabelX = 360;
  const metaValueRight = PAGE_WIDTH - MARGIN;
  const meta: ReadonlyArray<readonly [string, string]> = [
    ["Invoice number", spec.invoiceNumber],
    ["Date of issue", longDate(spec.issueDate)],
    ["Date due", longDate(spec.dueDate)],
    ["Billing period", spec.periodLabel],
    ["Terms", "Net 30"],
  ];

  let metaY = y;
  for (const [label, value] of meta) {
    page.drawText(label, { x: metaLabelX, y: metaY, size: 9, font: fonts.regular, color: MUTED });
    drawRightAligned(page, value, metaValueRight, metaY, fonts.bold, 9, INK);
    metaY -= 15;
  }

  page.drawText("From", { x: MARGIN, y, size: 9, font: fonts.bold, color: MUTED });
  let addrY = y - 14;
  for (const line of VENDOR_LINES) {
    page.drawText(line, { x: MARGIN, y: addrY, size: 9.5, font: fonts.regular, color: INK });
    addrY -= 13;
  }

  addrY -= 12;
  page.drawText("Bill to", { x: MARGIN, y: addrY, size: 9, font: fonts.bold, color: MUTED });
  addrY -= 14;
  for (const line of BILL_TO_LINES) {
    page.drawText(line, { x: MARGIN, y: addrY, size: 9.5, font: fonts.regular, color: INK });
    addrY -= 13;
  }

  // Amount-due banner
  y = addrY - 18;
  page.drawText(`${usd(invoiceTotal(spec))} due ${longDate(spec.dueDate)}`, {
    x: MARGIN, y, size: 14, font: fonts.bold, color: INK,
  });
  y -= 10;
  page.drawText("Claude API usage — billed monthly in arrears.", {
    x: MARGIN, y: y - 4, size: 9, font: fonts.regular, color: MUTED,
  });

  // Line-item table
  y -= 34;
  const qtyRight = 388;
  const rateRight = 470;
  const amountRight = PAGE_WIDTH - MARGIN;

  page.drawText("Description", { x: MARGIN, y, size: 9, font: fonts.bold, color: MUTED });
  drawRightAligned(page, "Qty", qtyRight, y, fonts.bold, 9, MUTED);
  drawRightAligned(page, "Unit price / MTok", rateRight, y, fonts.bold, 9, MUTED);
  drawRightAligned(page, "Amount", amountRight, y, fonts.bold, 9, MUTED);
  y -= 8;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 0.8, color: RULE });

  for (const item of spec.lineItems) {
    y -= 19;
    page.drawText(item.description, { x: MARGIN, y, size: 9.5, font: fonts.regular, color: INK });
    drawRightAligned(page, mtokQty(item.mtok), qtyRight, y, fonts.regular, 9.5, INK);
    drawRightAligned(page, usd(item.ratePerMTok), rateRight, y, fonts.regular, 9.5, INK);
    drawRightAligned(page, usd(lineTotal(item)), amountRight, y, fonts.regular, 9.5, INK);
  }

  y -= 12;
  page.drawLine({ start: { x: 330, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 0.8, color: RULE });

  const total = invoiceTotal(spec);
  const totals: ReadonlyArray<readonly [string, string, PDFFont]> = [
    ["Subtotal", usd(total), fonts.regular],
    ["Tax (0%)", usd(0), fonts.regular],
    ["Total", usd(total), fonts.bold],
    ["Amount due", usd(total), fonts.bold],
  ];
  for (const [label, value, font] of totals) {
    y -= 17;
    page.drawText(label, { x: 330, y, size: 10, font, color: INK });
    drawRightAligned(page, value, amountRight, y, font, 10, INK);
  }

  // Footer — fixture provenance, mirroring the other sinks' replay-safety keys.
  const footerY = MARGIN;
  page.drawLine({
    start: { x: MARGIN, y: footerY + 26 },
    end: { x: PAGE_WIDTH - MARGIN, y: footerY + 26 },
    thickness: 0.8,
    color: RULE,
  });
  page.drawText(
    "Mock fixture for the pied-piper-simulation demo dataset. Pied Piper is a fictional company (HBO Silicon Valley).",
    { x: MARGIN, y: footerY + 12, size: 7.5, font: fonts.regular, color: MUTED },
  );
  page.drawText(
    `timeline_id=${FIXTURE_TIMELINE_ID}  sim_event_id=fixture:invoice:${spec.id}`,
    { x: MARGIN, y: footerY, size: 7.5, font: fonts.regular, color: MUTED },
  );

  return doc.save();
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const OUTPUT_DIR = join(process.cwd(), "fixtures", "invoices");

const main = async (): Promise<void> => {
  await mkdir(OUTPUT_DIR, { recursive: true });
  for (const spec of ANTHROPIC_INVOICES) {
    const bytes = await renderInvoice(spec);
    const path = join(OUTPUT_DIR, `${spec.id}.pdf`);
    await writeFile(path, bytes);
    console.log(`wrote ${path} (${spec.invoiceNumber}, total ${usd(invoiceTotal(spec))})`);
  }
};

await main();
