/**
 * Deterministic price quoting.
 *
 * Every number in the tables below is transcribed from
 * mgc-task-pack/docs/02_price_list_payment_plan.md and carries the section id it
 * came from, so a quote can be cited like any other claim.
 *
 * The model never performs this arithmetic. It receives a finished trace and its
 * job is to present it. LLM arithmetic on PKR millions is exactly the
 * confident-wrong-answer the brief warns about, and there is no upside to
 * risking it when the rules are four lines of percentages.
 */

const PRICE_SECTION_A = "price-list#base-prices-block-a";
const PRICE_SECTION_B = "price-list#base-prices-block-b";
const PREMIUM_SECTION = "price-list#location-premiums";
const CHARGES_SECTION = "price-list#other-charges";
const DISCOUNT_SECTION = "price-list#discounts";

export type Block = "A" | "B";

export type UnitKey =
  | "studio"
  | "1-bed"
  | "2-bed"
  | "2-bed-corner"
  | "3-bed"
  | "penthouse";

type UnitRow = {
  key: UnitKey;
  label: string;
  areaSqFt: number;
  basePrice: number;
};

/** Block A price table. */
const BLOCK_A: UnitRow[] = [
  { key: "studio", label: "Studio", areaSqFt: 480, basePrice: 8_640_000 },
  { key: "1-bed", label: "1-Bed Standard", areaSqFt: 720, basePrice: 13_320_000 },
  { key: "2-bed", label: "2-Bed Standard", areaSqFt: 1_150, basePrice: 21_850_000 },
];

/** Block B price table. Note 2-Bed Corner is its own line item, not a modifier. */
const BLOCK_B: UnitRow[] = [
  { key: "1-bed", label: "1-Bed Standard", areaSqFt: 720, basePrice: 13_680_000 },
  { key: "2-bed", label: "2-Bed Standard", areaSqFt: 1_150, basePrice: 22_425_000 },
  { key: "2-bed-corner", label: "2-Bed Corner", areaSqFt: 1_310, basePrice: 26_855_000 },
  { key: "3-bed", label: "3-Bed Executive", areaSqFt: 1_880, basePrice: 39_480_000 },
  { key: "penthouse", label: "4-Bed Penthouse", areaSqFt: 3_400, basePrice: 88_400_000 },
];

const TABLES: Record<Block, UnitRow[]> = { A: BLOCK_A, B: BLOCK_B };

/** Mandatory extras, from §Other Charges. Not part of the unit price. */
const UTILITY_CHARGE = 285_000;
const PARKING_SLOT = 1_450_000;
const MAINTENANCE_PER_SQFT_PER_MONTH = 9.5;
const MAINTENANCE_MONTHS = 12;

export type Slots = {
  block?: Block;
  unit?: UnitKey;
  floor?: number;
  corner?: boolean;
  margalla?: boolean;
  /** Full cash / 50% upfront, from §Discounts. */
  payment?: "cash" | "half";
  overseas?: boolean;
};

export type QuoteLine = {
  label: string;
  amount: number;
  /** Section this line's rule came from. */
  sourceId: string;
};

export type Quote = {
  unitLabel: string;
  block: Block;
  areaSqFt: number;
  basePrice: number;
  lines: QuoteLine[];
  premiumPercent: number;
  total: number;
  /** Mandatory costs the quoted total deliberately excludes. */
  notIncluded: QuoteLine[];
  /** Things a salesperson must be told before quoting this. */
  warnings: string[];
  /** The other defensible reading of an ambiguous request, if there is one. */
  alternative: { label: string; total: number; explanation: string } | null;
  sourceIds: string[];
};

const UNIT_PATTERNS: { key: UnitKey; re: RegExp }[] = [
  { key: "penthouse", re: /\b(penthouse|4[\s-]?bed)\b/i },
  { key: "3-bed", re: /\b(3[\s-]?bed|three[\s-]?bed|executive)\b/i },
  { key: "2-bed", re: /\b(2[\s-]?bed|two[\s-]?bed)\b/i },
  { key: "1-bed", re: /\b(1[\s-]?bed|one[\s-]?bed|single[\s-]?bed)\b/i },
  { key: "studio", re: /\bstudio\b/i },
];

/**
 * Slot extraction over a closed vocabulary.
 *
 * Not an LLM call: block, unit type, orientation and payment mode are a fixed
 * set of ~15 tokens, and a regex over them is free, instant and testable. The
 * cost of being wrong is also low — a missing slot means we ask, rather than
 * guess.
 */
export function parseSlots(text: string): Slots {
  const slots: Slots = {};
  const t = text.toLowerCase();

  const block = /\bblock\s*([ab])\b/i.exec(text);
  if (block) slots.block = block[1].toUpperCase() as Block;

  for (const { key, re } of UNIT_PATTERNS) {
    if (re.test(t)) {
      slots.unit = key;
      break;
    }
  }

  const floor = /\b(?:floor|storey|story|level)\s*(\d{1,2})\b/i.exec(t)
    ?? /\b(\d{1,2})(?:st|nd|rd|th)\s+floor\b/i.exec(t);
  if (floor) slots.floor = Number(floor[1]);

  if (/\bcorner\b/i.test(t)) slots.corner = true;
  if (/\bmargalla\b/i.test(t)) slots.margalla = true;
  if (/\b(full\s+cash|cash\s+payment|pay\s+cash|lump\s+sum)\b/i.test(t)) {
    slots.payment = "cash";
  } else if (/\b(50\s*%|half)\s*(upfront|down|advance)?\b/i.test(t)) {
    slots.payment = "half";
  }
  if (/\b(overseas|roshan|non[\s-]?resident|expat)\b/i.test(t)) slots.overseas = true;

  return slots;
}

/** True when there is enough to quote: a unit type and a block. */
export function canQuote(slots: Slots): boolean {
  return Boolean(slots.unit && slots.block);
}

/** Floor premium bands, from §Location Premiums. */
function floorPremium(floor: number | undefined): number {
  if (floor === undefined) return 0;
  if (floor >= 20 && floor <= 22) return 7;
  if (floor >= 13 && floor <= 19) return 4;
  return 0;
}

function findRow(block: Block, unit: UnitKey): UnitRow | undefined {
  return TABLES[block].find((r) => r.key === unit);
}

export function quote(slots: Slots): Quote | null {
  if (!slots.unit || !slots.block) return null;

  const block = slots.block;
  const warnings: string[] = [];

  let row = findRow(block, slots.unit);
  if (!row) {
    // e.g. a 3-bed in Block A. The brochure's unit table says which blocks have what.
    return null;
  }

  let alternative: Quote["alternative"] = null;

  /**
   * The ambiguity worth flagging: Block B prices "2-Bed Corner" as its own SKU
   * at 26,855,000, so "corner" is already in that price — yet §Location Premiums
   * also lists a +3% corner premium, and the document's OWN worked example
   * ("A Margalla-facing corner unit on floor 15 carries +4% +3% +6% = +13%")
   * applies that premium on top of a base. Both readings are defensible.
   *
   * We follow the document's worked example (premium on the Standard base) and
   * surface the other reading rather than silently choosing. Quoting 25.3M for a
   * unit that lists at 26.9M is a refund conversation.
   */
  const cornerSkuExists =
    slots.corner && slots.unit === "2-bed" && findRow(block, "2-bed-corner");

  // §Unit Configuration: Studio and 1-Bed are never Margalla-facing.
  if (slots.margalla && (slots.unit === "studio" || slots.unit === "1-bed")) {
    warnings.push(
      "The brochure states Studio and 1-Bed units are not available with a Margalla-facing orientation, so the +6% Margalla premium should not apply here — confirm the unit before quoting.",
    );
  }

  const premiums: QuoteLine[] = [];
  const fp = floorPremium(slots.floor);
  let premiumPercent = 0;

  if (fp > 0) {
    premiumPercent += fp;
    premiums.push({
      label: `+${fp}% floor ${slots.floor} (${fp === 7 ? "band 20–22" : "band 13–19"})`,
      amount: Math.round((row.basePrice * fp) / 100),
      sourceId: PREMIUM_SECTION,
    });
  }
  if (slots.corner) {
    premiumPercent += 3;
    premiums.push({
      label: "+3% corner unit",
      amount: Math.round((row.basePrice * 3) / 100),
      sourceId: PREMIUM_SECTION,
    });
  }
  if (slots.margalla) {
    premiumPercent += 6;
    premiums.push({
      label: "+6% Margalla-facing",
      amount: Math.round((row.basePrice * 6) / 100),
      sourceId: PREMIUM_SECTION,
    });
  }

  let total = row.basePrice + Math.round((row.basePrice * premiumPercent) / 100);

  // §Discounts: applied to the base only — "Location premiums are not discounted".
  const discountLines: QuoteLine[] = [];
  let discountPercent = 0;
  if (slots.payment === "cash") discountPercent += 12;
  else if (slots.payment === "half") discountPercent += 6;
  if (slots.overseas) discountPercent += 2;

  if (discountPercent > 0) {
    const amount = Math.round((row.basePrice * discountPercent) / 100);
    discountLines.push({
      label: `−${discountPercent}% discount on base price (premiums are not discounted)`,
      amount: -amount,
      sourceId: DISCOUNT_SECTION,
    });
    total -= amount;
  }

  if (cornerSkuExists) {
    const cornerRow = findRow(block, "2-bed-corner")!;
    // The corner premium is not applied twice in this reading — the SKU includes it.
    const altPremium = premiumPercent - 3;
    const altTotal =
      cornerRow.basePrice + Math.round((cornerRow.basePrice * altPremium) / 100);
    alternative = {
      label: `${cornerRow.label}, Block ${block} (${cornerRow.areaSqFt.toLocaleString()} sq ft)`,
      total: altTotal,
      explanation:
        `Block ${block} also lists "2-Bed Corner" as a separate unit type at ` +
        `PKR ${cornerRow.basePrice.toLocaleString()} (${cornerRow.areaSqFt.toLocaleString()} sq ft), where the corner is ` +
        `already priced in. On that reading the total would be PKR ${altTotal.toLocaleString()} ` +
        `(base +${altPremium}%, corner premium not re-applied). Confirm which unit the customer means.`,
    };
  }

  const maintenance = Math.round(
    row.areaSqFt * MAINTENANCE_PER_SQFT_PER_MONTH * MAINTENANCE_MONTHS,
  );

  return {
    unitLabel: row.label,
    block,
    areaSqFt: row.areaSqFt,
    basePrice: row.basePrice,
    lines: [
      {
        label: `Base — ${row.label}, Block ${block}, ${row.areaSqFt.toLocaleString()} sq ft`,
        amount: row.basePrice,
        sourceId: block === "A" ? PRICE_SECTION_A : PRICE_SECTION_B,
      },
      ...premiums,
      ...discountLines,
    ],
    premiumPercent,
    total,
    notIncluded: [
      { label: "Parking slot (mandatory, 1 per unit)", amount: PARKING_SLOT, sourceId: CHARGES_SECTION },
      { label: "Utility connection and meter charges", amount: UTILITY_CHARGE, sourceId: CHARGES_SECTION },
      {
        label: `Maintenance advance (12 months × PKR 9.50 × ${row.areaSqFt.toLocaleString()} sq ft, payable at possession)`,
        amount: maintenance,
        sourceId: CHARGES_SECTION,
      },
    ],
    warnings,
    alternative,
    sourceIds: [
      block === "A" ? PRICE_SECTION_A : PRICE_SECTION_B,
      ...(premiums.length ? [PREMIUM_SECTION] : []),
      ...(discountLines.length ? [DISCOUNT_SECTION] : []),
      CHARGES_SECTION,
    ],
  };
}

const pkr = (n: number) => `PKR ${n.toLocaleString("en-US")}`;

/** Renders the trace for the prompt. The model presents this; it does not recompute it. */
export function formatQuote(q: Quote): string {
  const lines = q.lines.map(
    (l) => `  ${l.label.padEnd(60)} ${(l.amount < 0 ? "−" : "") + pkr(Math.abs(l.amount))}`,
  );
  const extras = q.notIncluded.map((l) => `  ${l.label}: ${pkr(l.amount)}`);

  return [
    `COMPUTED (deterministic, from the price list — do not recalculate)`,
    ...lines,
    `  ${"TOTAL".padEnd(60)} ${pkr(q.total)}`,
    q.premiumPercent > 0
      ? `  (base + ${q.premiumPercent}% in cumulative location premiums)`
      : "",
    ``,
    `  NOT INCLUDED in the total above:`,
    ...extras,
    q.warnings.length ? `\n  WARNINGS:\n${q.warnings.map((w) => `  - ${w}`).join("\n")}` : "",
    q.alternative
      ? `\n  ALTERNATIVE READING (must be mentioned to the salesperson):\n  - ${q.alternative.explanation}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

