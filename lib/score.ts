/**
 * Lead scorer — evaluates ml/model.json in TypeScript.
 *
 * The whole model is `sigmoid(intercept + Σ wᵢxᵢ)`, so serving it needs no
 * Python runtime, no cold start and no extra service on Vercel. That
 * portability is one of the two reasons Part 3 uses logistic regression (the
 * other being that the coefficients are directly explainable to a sales
 * manager). See ml/train.py → export_model for the other side of this contract.
 */
import model from "../ml/model.json";

export type LeadInput = {
  source?: string;
  city?: string;
  area?: string;
  property_type?: string;
  budget_pkr_lac?: number | null;
  bedrooms?: number | null;
  is_overseas?: boolean;
  referred_by_existing_client?: boolean;
  has_financing_approved?: boolean;
  agent_experience_years?: number | null;
  /** ISO timestamp; defaults to now, matching how a real intake would score. */
  created_at?: string;
};

export type Contribution = { feature: string; value: string; weight: number };

export type ScoreResult = {
  probability: number;
  band: "Low" | "Medium" | "High";
  /** Strongest signed contributions, so the salesperson sees *why*. */
  topFactors: Contribution[];
  baseline: number;
  /** How many times the base conversion rate this lead scores. */
  lift: number;
};

const CITY_ALIASES: Record<string, string> = {
  ISB: "ISLAMABAD",
  RWP: "RAWALPINDI",
  KHI: "KARACHI",
};

/** Must mirror clean() in ml/train.py exactly, or the coefficients are meaningless. */
function normaliseCity(raw: string | undefined): string {
  const upper = (raw ?? "").trim().toUpperCase();
  return CITY_ALIASES[upper] ?? upper;
}

function bedroomsCategory(
  bedrooms: number | null | undefined,
  propertyType: string | undefined,
): string {
  // The training data's NULL bedrooms are exactly the Plot and Commercial Shop
  // rows — inapplicable, not missing.
  if (propertyType === "Plot" || propertyType === "Commercial Shop") {
    return "not_applicable";
  }
  if (bedrooms === null || bedrooms === undefined || Number.isNaN(bedrooms)) {
    return "not_applicable";
  }
  return String(Math.trunc(bedrooms));
}

export function scoreLead(input: LeadInput): ScoreResult {
  const created = input.created_at ? new Date(input.created_at) : new Date();

  const categoricalValues: Record<string, string> = {
    source: input.source ?? "",
    city: normaliseCity(input.city),
    area: input.area?.trim() || "Unknown",
    property_type: input.property_type ?? "",
    bedrooms_cat: bedroomsCategory(input.bedrooms, input.property_type),
  };

  const budget = input.budget_pkr_lac ?? null;
  const agentExp = input.agent_experience_years ?? null;

  const numericValues: Record<string, number | null> = {
    budget_pkr_lac: budget,
    // Imputation for the log feature happens in train.py before the log is
    // taken, so a missing budget uses the imputed median here too.
    log_budget: budget === null ? null : Math.log1p(budget),
    agent_experience_years: agentExp,
    hour_of_day: created.getHours(),
    day_of_week: (created.getDay() + 6) % 7, // JS Sunday=0 → pandas Monday=0
    month: created.getMonth() + 1,
    is_overseas: input.is_overseas ? 1 : 0,
    referred_by_existing_client: input.referred_by_existing_client ? 1 : 0,
    has_financing_approved: input.has_financing_approved ? 1 : 0,
    budget_missing: budget === null ? 1 : 0,
    agent_exp_missing: agentExp === null ? 1 : 0,
  };

  // `logit_offset` undoes the class_weight="balanced" prior shift — without it
  // predict_proba is on a 50/50 scale and a good lead reads as "93% likely to
  // convert", which is not true and not safe to show a salesperson.
  let z = model.intercept + model.logit_offset;
  const contributions: Contribution[] = [];

  for (const cat of model.categorical) {
    const value = categoricalValues[cat.name];
    const coefs: Record<string, number | undefined> = cat.coefs;
    // handle_unknown="ignore" at training time: an unseen level contributes 0.
    const weight = coefs[value] ?? cat.unknown;
    z += weight;
    if (value) {
      contributions.push({ feature: cat.name, value, weight });
    }
  }

  for (const num of model.numeric) {
    const raw = numericValues[num.name];
    const imputed = raw === null || raw === undefined ? num.impute : raw;
    // Same order as the sklearn pipeline: impute → standardise → multiply.
    const standardised = (imputed - num.mean) / (num.scale || 1);
    const weight = standardised * num.coef;
    z += weight;
    contributions.push({
      feature: num.name,
      value: String(Math.round(imputed * 100) / 100),
      weight,
    });
  }

  const probability = 1 / (1 + Math.exp(-z));
  const baseline = model.meta.prevalence;

  return {
    probability,
    // Bands are set from the model's own operating characteristics, not round
    // numbers: 2× and 4× the base conversion rate.
    band:
      probability >= baseline * 4
        ? "High"
        : probability >= baseline * 2
          ? "Medium"
          : "Low",
    topFactors: [...contributions]
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
      .slice(0, 3),
    baseline,
    lift: probability / baseline,
  };
}

export const MODEL_META = model.meta;
