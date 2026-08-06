import { createHash } from "node:crypto";
import {
  DOOM_INDEX_V121_AUXILIARY_FACTOR_NAMES,
  DOOM_INDEX_V121_FACTOR_NAMES,
  calculateDoomIndexV121,
  calculateDoomIndexV121FromFactors,
  createDoomIndexV121Fingerprint,
  normalizedDoomIndexV121Weights,
} from "./doom-index-v1.2.1.mjs";

export const DOOM_INDEX_V122_FACTOR_NAMES = [
  ...DOOM_INDEX_V121_FACTOR_NAMES,
];
export const DOOM_INDEX_V122_AUXILIARY_FACTOR_NAMES = [
  ...DOOM_INDEX_V121_AUXILIARY_FACTOR_NAMES,
];

const FORMULA_VERSION = "1.2.2-shadow.1";
const PARENT_FORMULA_VERSION = "1.2.1-shadow.3";

const NON_HUMAN_SCIENCE_PATTERNS = [
  /\b(?:star|stellar|supernova|black hole|galaxy|galactic|cosmic|planetary|asteroid)\b/i,
  /\b(?:magma|tectonic|geological|fossil|protein|molecule|particle)\b/i,
];

const HUMAN_OR_INSTITUTIONAL_IMPACT_PATTERNS = [
  /\b(?:people|person|human|users?|students?|patients?|children|workers?|employees?)\b/i,
  /\b(?:accounts?|companies|organizations?|schools?|hospitals?|government|infrastructure)\b/i,
  /\b(?:injur(?:y|ed)|fatalities|human deaths?|people (?:died|were killed)|financial loss|reputation damage)\b/i,
];

const CONTROLLED_TEST_PATTERNS = [
  /\b(?:in|during|under|inside) (?:a )?(?:controlled )?(?:safety )?(?:tests?|testing|simulation|evaluation|benchmark)\b/i,
  /\b(?:red[- ]team(?:ing)?|lab test|safety test|test environment)\b/i,
];

const EXTERNAL_INCIDENT_PATTERNS = [
  /\b(?:hacked? into|breached|compromised) (?:another|an external|a third[- ]party) (?:company|organization|system|project)\b/i,
  /\b(?:gained unauthorized access|production infrastructure|production systems?|exposed credentials)\b/i,
  /\b(?:targeted (?:people|users?|accounts?)|targeted user accounts?)\b/i,
  /\b(?:malware|account takeover|data breach|security breach)\b/i,
];

const CONFIRMED_CONSEQUENCE_PATTERNS = [
  /\b(?:must retake|forced to retake|recalled by (?:the )?fda)\b/i,
];

const EQUIVALENT_INTRUSION_PATTERNS = [
  /\b(?:used|created) fake (?:online )?(?:identities|profiles)\b/i,
  /\b(?:hacking spree|hacking attempt|rogue attack|unauthorized behavior)\b/i,
  /\b(?:hid|concealed|covered up) (?:the )?(?:evidence|activity|attack)\b/i,
  /\b(?:impersonated|impersonating) (?:people|users?|developers?)\b/i,
];

const PROPOSED_OR_OPINION_PATTERNS = [
  /\b(?:could|may|might|would|proposal|proposed|bill|act|should|opinion|commentary)\b/i,
  /\b(?:warns?|warning|risks?|concerns?|what if|how worried should)\b/i,
];

const LOW_LEVEL_CONCERN_PATTERNS = [
  /\b(?:privacy|bias|inequality|surveillance|misinformation|disinformation)\b/i,
  /\b(?:job loss|lost jobs|replacing workers|dependency|accountability)\b/i,
  /\b(?:deepfake|impersonation|deception|manipulation)\b/i,
];

function normalize(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([\da-f]+);/gi, (_, number) =>
      String.fromCodePoint(Number.parseInt(number, 16)),
    )
    .replace(/&(?:nbsp|amp|quot|apos|lt|gt);/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .normalize("NFKD")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function round(value, places = 4) {
  return Number(Number(value).toFixed(places));
}

function adjustedReasons(factors, actuality, score) {
  const reasons = [];
  const labels = {
    realizedHarm: "realized harm",
    scale: "large affected population or reach",
    vulnerability: "vulnerable people affected",
    lossOfControl: "unauthorized behavior or loss of control",
    irreversibility: "potentially irreversible consequences",
    immediacy: "immediate or ongoing consequences",
    systemicReach: "systemic or institutional reach",
    credibleThreat: "credible threat or safety risk",
  };

  for (const name of DOOM_INDEX_V122_FACTOR_NAMES) {
    if (factors[name] >= 0.5) reasons.push(labels[name]);
  }

  reasons.push(`${actuality} event status`);
  if (factors.evidence >= 0.7) reasons.push("strong or specific evidence");
  if (factors.evidence <= 0.3) reasons.push("speculative or weakly evidenced");
  if (factors.protectiveContext >= 0.5) {
    reasons.push("protective or positive context adjustment");
  }
  if (factors.routinePenalty > 0 && score.routineMultiplier < 1) {
    reasons.push("routine or promotional adjustment");
  }
  if (score.compoundBonus > 0) {
    reasons.push("compound confirmed-consequence escalation");
  }

  return reasons;
}

export function normalizedDoomIndexV122Weights(configuredWeights = {}) {
  return normalizedDoomIndexV121Weights(configuredWeights);
}

export function calculateDoomIndexV122FromFactors(
  factors,
  configuredWeights = {},
) {
  return calculateDoomIndexV121FromFactors(factors, configuredWeights);
}

export function calculateDoomIndexV122({
  title,
  summary = "",
  coverageSources = 1,
  weights = {},
} = {}) {
  const baseline = calculateDoomIndexV121({
    title,
    summary,
    coverageSources,
    weights,
  });
  const titleText = normalize(title);
  const summaryText = normalize(summary);
  const text = `${titleText}. ${summaryText}`.trim();
  const factors = { ...baseline.factors };
  let actuality = baseline.actuality;

  const scienceOnly =
    matchesAny(text, NON_HUMAN_SCIENCE_PATTERNS) &&
    !matchesAny(text, HUMAN_OR_INSTITUTIONAL_IMPACT_PATTERNS);
  const controlledTest = matchesAny(text, CONTROLLED_TEST_PATTERNS);
  const externalIncident = matchesAny(text, EXTERNAL_INCIDENT_PATTERNS);
  const equivalentIntrusion = matchesAny(
    text,
    EQUIVALENT_INTRUSION_PATTERNS,
  );
  const confirmedConsequence = matchesAny(
    text,
    CONFIRMED_CONSEQUENCE_PATTERNS,
  );
  const proposedOrOpinion = matchesAny(
    text,
    PROPOSED_OR_OPINION_PATTERNS,
  );

  if (scienceOnly) {
    for (const name of DOOM_INDEX_V122_FACTOR_NAMES) factors[name] = 0;
    factors.actuality = 0.25;
    factors.contextualConcern = 0;
    factors.protectiveContext = 0;
    factors.routinePenalty = 0;
    actuality = "neutral";
  } else {
    if (equivalentIntrusion || externalIncident || confirmedConsequence) {
      factors.realizedHarm = Math.max(factors.realizedHarm, 0.6667);
      if (equivalentIntrusion || externalIncident) {
        factors.lossOfControl = Math.max(
          factors.lossOfControl,
          equivalentIntrusion ? 1 : 0.5,
        );
      }
      factors.evidence = Math.max(factors.evidence, 0.55);
      factors.actuality = 1;
      factors.protectiveContext = 0;
      actuality = "confirmed";
    } else if (controlledTest) {
      factors.realizedHarm = round(factors.realizedHarm * 0.35);
      factors.evidence = Math.min(factors.evidence, 0.55);
      factors.actuality = 0.45;
      actuality = "testing";
    }

    if (
      proposedOrOpinion &&
      !externalIncident &&
      !equivalentIntrusion &&
      !confirmedConsequence &&
      !controlledTest
    ) {
      factors.realizedHarm = Math.min(factors.realizedHarm, 0.35);
      factors.irreversibility = Math.min(factors.irreversibility, 0.35);
      factors.immediacy = Math.min(factors.immediacy, 0.35);
      factors.actuality = Math.min(factors.actuality, 0.35);
      if (!["positive", "preventative"].includes(actuality)) {
        actuality = "proposed";
      }
    }

    if (
      factors.contextualConcern === 0 &&
      matchesAny(text, LOW_LEVEL_CONCERN_PATTERNS)
    ) {
      factors.contextualConcern = 0.2;
    }
  }

  const score = calculateDoomIndexV122FromFactors(factors, weights);
  const polarity =
    factors.protectiveContext >= 0.5
      ? "protective-or-positive"
      : factors.realizedHarm >= 0.5 ||
          factors.lossOfControl >= 0.5 ||
          factors.credibleThreat >= 0.5
        ? "adverse"
        : "neutral";

  return {
    ...score,
    actuality,
    polarity,
    factors,
    reasons: adjustedReasons(factors, actuality, score),
  };
}

export function createDoomIndexV122InputFingerprint({
  title,
  summary = "",
  coverageSources = 1,
  formulaVersion = FORMULA_VERSION,
} = {}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        formulaVersion,
        title: normalize(title),
        summary: normalize(summary),
        coverageSources: Math.max(1, Number(coverageSources) || 1),
      }),
    )
    .digest("hex")
    .slice(0, 20);
}

export function createDoomIndexV122Fingerprint({
  formulaVersion = FORMULA_VERSION,
  weights = {},
} = {}) {
  const definition = {
    formulaVersion,
    parentFingerprint: createDoomIndexV121Fingerprint({
      formulaVersion: PARENT_FORMULA_VERSION,
      weights,
    }),
    weights: normalizedDoomIndexV122Weights(weights),
    patterns: {
      nonHumanScience: NON_HUMAN_SCIENCE_PATTERNS.map(String),
      humanOrInstitutionalImpact: HUMAN_OR_INSTITUTIONAL_IMPACT_PATTERNS.map(String),
      controlledTest: CONTROLLED_TEST_PATTERNS.map(String),
      externalIncident: EXTERNAL_INCIDENT_PATTERNS.map(String),
      confirmedConsequence: CONFIRMED_CONSEQUENCE_PATTERNS.map(String),
      equivalentIntrusion: EQUIVALENT_INTRUSION_PATTERNS.map(String),
      proposedOrOpinion: PROPOSED_OR_OPINION_PATTERNS.map(String),
      lowLevelConcern: LOW_LEVEL_CONCERN_PATTERNS.map(String),
    },
    implementations: [
      normalize,
      matchesAny,
      round,
      adjustedReasons,
      calculateDoomIndexV122FromFactors,
      calculateDoomIndexV122,
    ].map(String),
  };

  return createHash("sha256")
    .update(JSON.stringify(definition))
    .digest("hex")
    .slice(0, 20);
}
