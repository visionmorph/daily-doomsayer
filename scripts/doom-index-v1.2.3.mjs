import { createHash } from "node:crypto";
import {
  DOOM_INDEX_V122_AUXILIARY_FACTOR_NAMES,
  DOOM_INDEX_V122_FACTOR_NAMES,
  calculateDoomIndexV122,
  calculateDoomIndexV122FromFactors,
  createDoomIndexV122Fingerprint,
  normalizedDoomIndexV122Weights,
} from "./doom-index-v1.2.2.mjs";

export const DOOM_INDEX_V123_FACTOR_NAMES = [
  ...DOOM_INDEX_V122_FACTOR_NAMES,
];
export const DOOM_INDEX_V123_AUXILIARY_FACTOR_NAMES = [
  ...DOOM_INDEX_V122_AUXILIARY_FACTOR_NAMES,
];

const FORMULA_VERSION = "1.2.3-shadow.1";
const PARENT_FORMULA_VERSION = "1.2.2-shadow.1";

const ORDINARY_LEGAL_DISPUTE_PATTERNS = [
  /\b(?:lawsuit|sues?|suing|legal battle|court filing|trade secrets?|copyright dispute)\b/i,
  /\b(?:antitrust|competition law|merger challenge|patent dispute)\b/i,
];

const CONFIRMED_LEGAL_CONSEQUENCE_PATTERNS = [
  /\b(?:court|judge|jury|regulator) (?:ruled|found|ordered|blocked|convicted|fined)\b/i,
  /\b(?:found liable|judgment|conviction|sentenced|fine of|ordered to pay|wrongly denied)\b/i,
];

const INSTITUTIONAL_HARM_PATTERNS = [
  /\b(?:government|public sector|election|law enforcement|immigration|public benefits?)\b/i,
  /\b(?:hospital|health system|healthcare|insurance claims?|school|college|university|education system)\b/i,
  /\b(?:civil rights|freedom of speech|freedom of expression|mass surveillance|discrimination)\b/i,
];

const MATERIAL_NONPHYSICAL_HARM_PATTERNS = [
  /\b(?:privacy violation|identity theft|financial loss|lost income|reputation damage)\b/i,
  /\b(?:wrongly denied|denied care|denied benefits|discriminat(?:e|ed|ion)|harassment|blackmail|extortion)\b/i,
  /\b(?:nonconsensual|non-consensual|nudif(?:y|ied)|sexualized deepfakes?|child sexual abuse|csam)\b/i,
];

const EXTERNAL_PRODUCTION_COMPROMISE_PATTERNS = [
  /\b(?:gained unauthorized access|breached|compromised|hacked into)\b.*\b(?:production|company|companies|organization|organizations|system|systems|infrastructure)\b/i,
  /\b(?:production infrastructure|production systems?|exposed credentials|stolen credentials|data exfiltration|exfiltrated data)\b/i,
  /\b(?:zero[- ]day|supply[- ]chain attack|account takeover|hacking spree)\b/i,
];

const MASS_REACH_PATTERNS = [
  /\b(?:hundreds|thousands|millions|billions|mass|massive|widespread|nationwide|global)\b/i,
  /\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?\s*(?:thousand|million|billion)\b/i,
  /\b(?:across|throughout) (?:the world|the country|multiple countries|an industry|institutions)\b/i,
];

const IRREVERSIBLE_CONSEQUENCE_PATTERNS = [
  /\b(?:death|deaths|dead|fatal|killed|permanent|irreversible)\b/i,
  /\b(?:stolen|leaked|exposed|exfiltrated)\b.*\b(?:data|records|credentials|identity|identities|information)\b/i,
  /\b(?:child sexual abuse|csam|nonconsensual intimate imagery)\b/i,
];

const CONFIRMED_OR_ONGOING_PATTERNS = [
  /\b(?:confirmed|documented|investigation found|researchers found|court records show)\b/i,
  /\b(?:caused|forced|compromised|exfiltrated|gained unauthorized access|wrongly denied)\b/i,
  /\b(?:ongoing|underway|currently|continues|active attack)\b/i,
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

function severityDimensionCount(factors, threshold = 0.5) {
  return DOOM_INDEX_V123_FACTOR_NAMES.filter(
    (name) => Number(factors[name]) >= threshold,
  ).length;
}

function applyBandEligibility(value, factors) {
  const direEligible =
    factors.evidence >= 0.55 &&
    factors.actuality >= 0.65 &&
    factors.realizedHarm >= 0.5 &&
    severityDimensionCount(factors) >= 3;
  const catastrophicEligible =
    factors.evidence >= 0.7 &&
    factors.actuality >= 0.85 &&
    factors.realizedHarm >= 0.75 &&
    factors.scale >= 0.75 &&
    factors.systemicReach >= 0.5 &&
    Math.max(factors.lossOfControl, factors.irreversibility) >= 0.75 &&
    severityDimensionCount(factors) >= 5;

  if (value >= 80 && !catastrophicEligible) return 79.99;
  if (value >= 60 && !direEligible) return 59.99;
  return value;
}

function round(value, places = 4) {
  return Number(Number(value).toFixed(places));
}

function adjustedReasons(factors, actuality, score, adjustments) {
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
  const reasons = DOOM_INDEX_V123_FACTOR_NAMES
    .filter((name) => factors[name] >= 0.5)
    .map((name) => labels[name]);

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

  return [...new Set([...reasons, ...adjustments])];
}

export function normalizedDoomIndexV123Weights(configuredWeights = {}) {
  return normalizedDoomIndexV122Weights(configuredWeights);
}

export function calculateDoomIndexV123FromFactors(
  factors,
  configuredWeights = {},
) {
  const score = calculateDoomIndexV122FromFactors(factors, configuredWeights);

  return {
    ...score,
    value: round(applyBandEligibility(score.value, factors), 2),
  };
}

export function calculateDoomIndexV123({
  title,
  summary = "",
  coverageSources = 1,
  weights = {},
} = {}) {
  const baseline = calculateDoomIndexV122({
    title,
    summary,
    coverageSources,
    weights,
  });
  const text = `${normalize(title)}. ${normalize(summary)}`.trim();
  const factors = { ...baseline.factors };
  const adjustments = [];
  let actuality = baseline.actuality;

  const ordinaryLegalDispute =
    matchesAny(text, ORDINARY_LEGAL_DISPUTE_PATTERNS) &&
    !matchesAny(text, CONFIRMED_LEGAL_CONSEQUENCE_PATTERNS) &&
    !matchesAny(text, MATERIAL_NONPHYSICAL_HARM_PATTERNS);
  const confirmedOrOngoing = matchesAny(
    text,
    CONFIRMED_OR_ONGOING_PATTERNS,
  );
  const institutionalHarm = matchesAny(text, INSTITUTIONAL_HARM_PATTERNS);
  const materialNonphysicalHarm = matchesAny(
    text,
    MATERIAL_NONPHYSICAL_HARM_PATTERNS,
  );
  const externalCompromise = matchesAny(
    text,
    EXTERNAL_PRODUCTION_COMPROMISE_PATTERNS,
  );
  const massReach = matchesAny(text, MASS_REACH_PATTERNS);
  const irreversibleConsequence = matchesAny(
    text,
    IRREVERSIBLE_CONSEQUENCE_PATTERNS,
  );

  if (ordinaryLegalDispute) {
    factors.realizedHarm = Math.min(factors.realizedHarm, 0.15);
    factors.lossOfControl = Math.min(factors.lossOfControl, 0.2);
    factors.irreversibility = Math.min(factors.irreversibility, 0.2);
    factors.credibleThreat = Math.min(factors.credibleThreat, 0.35);
    factors.actuality = Math.min(factors.actuality, 0.35);
    factors.contextualConcern = Math.max(factors.contextualConcern, 0.1);
    actuality = "disputed";
    adjustments.push("ordinary unresolved legal dispute adjustment");
  }

  if (institutionalHarm) {
    factors.systemicReach = Math.max(factors.systemicReach, 0.5);
    factors.contextualConcern = Math.max(factors.contextualConcern, 0.3);
    adjustments.push("institutional consequence recognition");
  }

  if (confirmedOrOngoing && materialNonphysicalHarm) {
    factors.realizedHarm = Math.max(factors.realizedHarm, 0.6667);
    factors.irreversibility = Math.max(factors.irreversibility, 0.5);
    factors.evidence = Math.max(factors.evidence, 0.6);
    factors.actuality = Math.max(factors.actuality, 0.85);
    factors.protectiveContext = 0;
    actuality = factors.actuality >= 1 ? "confirmed" : "ongoing";
    adjustments.push("confirmed material nonphysical harm recognition");
  }

  if (externalCompromise && confirmedOrOngoing) {
    factors.realizedHarm = Math.max(factors.realizedHarm, 0.7);
    factors.scale = Math.max(factors.scale, 0.5);
    factors.lossOfControl = Math.max(factors.lossOfControl, 0.85);
    factors.irreversibility = Math.max(factors.irreversibility, 0.4);
    factors.immediacy = Math.max(factors.immediacy, 0.5);
    factors.systemicReach = Math.max(factors.systemicReach, 0.55);
    factors.credibleThreat = Math.max(factors.credibleThreat, 0.6);
    factors.evidence = Math.max(factors.evidence, 0.7);
    factors.actuality = 1;
    factors.protectiveContext = 0;
    actuality = "confirmed";
    adjustments.push("confirmed external production compromise escalation");
  }

  if (massReach && (confirmedOrOngoing || factors.actuality >= 0.65)) {
    factors.scale = Math.max(factors.scale, 0.75);
    factors.systemicReach = Math.max(factors.systemicReach, 0.5);
    adjustments.push("confirmed mass-reach escalation");
  }

  if (irreversibleConsequence && confirmedOrOngoing) {
    factors.realizedHarm = Math.max(factors.realizedHarm, 0.75);
    factors.irreversibility = Math.max(factors.irreversibility, 0.8);
    factors.evidence = Math.max(factors.evidence, 0.7);
    factors.actuality = Math.max(factors.actuality, 0.85);
    factors.protectiveContext = 0;
    adjustments.push("confirmed irreversible-consequence escalation");
  }

  if (
    materialNonphysicalHarm &&
    irreversibleConsequence &&
    confirmedOrOngoing
  ) {
    factors.lossOfControl = Math.max(factors.lossOfControl, 0.75);
    factors.credibleThreat = Math.max(factors.credibleThreat, 0.75);
    if (massReach) factors.immediacy = Math.max(factors.immediacy, 0.5);
    adjustments.push("compound nonconsensual-abuse escalation");
  }

  const score = calculateDoomIndexV123FromFactors(factors, weights);
  const reasons = adjustedReasons(factors, actuality, score, adjustments);

  if (score.value >= 80) reasons.push("catastrophic threshold criteria met");
  else if (score.value >= 60) reasons.push("dire threshold criteria met");

  return {
    ...score,
    actuality,
    polarity:
      factors.protectiveContext >= 0.5
        ? "protective-or-positive"
        : factors.realizedHarm >= 0.5 ||
            factors.lossOfControl >= 0.5 ||
            factors.credibleThreat >= 0.5
          ? "adverse"
          : "neutral",
    factors,
    reasons,
  };
}

export function createDoomIndexV123InputFingerprint({
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

export function createDoomIndexV123Fingerprint({
  formulaVersion = FORMULA_VERSION,
  weights = {},
} = {}) {
  const definition = {
    formulaVersion,
    parentFingerprint: createDoomIndexV122Fingerprint({
      formulaVersion: PARENT_FORMULA_VERSION,
      weights,
    }),
    weights: normalizedDoomIndexV123Weights(weights),
    patterns: {
      ordinaryLegalDispute: ORDINARY_LEGAL_DISPUTE_PATTERNS.map(String),
      confirmedLegalConsequence: CONFIRMED_LEGAL_CONSEQUENCE_PATTERNS.map(String),
      institutionalHarm: INSTITUTIONAL_HARM_PATTERNS.map(String),
      materialNonphysicalHarm: MATERIAL_NONPHYSICAL_HARM_PATTERNS.map(String),
      externalProductionCompromise: EXTERNAL_PRODUCTION_COMPROMISE_PATTERNS.map(String),
      massReach: MASS_REACH_PATTERNS.map(String),
      irreversibleConsequence: IRREVERSIBLE_CONSEQUENCE_PATTERNS.map(String),
      confirmedOrOngoing: CONFIRMED_OR_ONGOING_PATTERNS.map(String),
    },
    implementations: [
      normalize,
      matchesAny,
      severityDimensionCount,
      applyBandEligibility,
      round,
      adjustedReasons,
      calculateDoomIndexV123FromFactors,
      calculateDoomIndexV123,
    ].map(String),
  };

  return createHash("sha256")
    .update(JSON.stringify(definition))
    .digest("hex")
    .slice(0, 20);
}
