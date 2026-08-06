import { createHash } from "node:crypto";

export const DOOM_INDEX_V12_FACTOR_NAMES = [
  "realizedHarm",
  "scale",
  "vulnerability",
  "lossOfControl",
  "irreversibility",
  "immediacy",
  "systemicReach",
  "credibleThreat",
];

export const DEFAULT_DOOM_INDEX_V12_WEIGHTS = {
  realizedHarm: 0.22,
  scale: 0.14,
  vulnerability: 0.1,
  lossOfControl: 0.16,
  irreversibility: 0.11,
  immediacy: 0.07,
  systemicReach: 0.08,
  credibleThreat: 0.12,
};

const SIGNAL_PATTERNS = {
  realizedHarm: [
    /\b(?:breach(?:ed)?|hack(?:ed)?|attack(?:ed)?|compromis(?:e|ed)|unauthorized access)\b/i,
    /\b(?:harm(?:ed|ful)?|injur(?:y|ed)|fatal(?:ity|ities)?|deaths?|victims?)\b/i,
    /\b(?:forced|denied|lost|retake|malfunction(?:ed)?|wrongly|discriminat(?:e|ed|ion))\b/i,
    /\b(?:target(?:ed|ing)|deceiv(?:e|ed|ing)|manipulat(?:e|ed|ion)|exploit(?:ed|ing|ation))\b/i,
    /\b(?:stole|stolen|theft|fraud|scam(?:med|s)?)\b/i,
  ],
  scale: [
    /\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?\s*(?:hundred|thousand|million|billion|trillion)\b/i,
    /\b(?:hundreds|thousands|millions|billions)\b/i,
    /\b(?:mass|massive|widespread|global|nationwide|industry-wide|large-scale)\b/i,
    /\b(?:multiple|several|dozens of|scores of|three|four|five)\s+(?:\w+\s+){0,2}(?:people|users|students|patients|accounts|companies|organizations|countries|schools)\b/i,
    /\b(?:across|throughout)\s+(?:the world|the country|countries|companies|organizations|schools|universities|industries)\b/i,
  ],
  vulnerability: [
    /\b(?:children|child|kids|minors|teenagers|students|pupils)\b/i,
    /\b(?:patients|disabled|elderly|seniors|vulnerable|survivors|victims)\b/i,
    /\b(?:low-income|marginalized|minority|refugees|immigrants)\b/i,
    /\b(?:job seekers|workers|employees|consumers|tenants)\b/i,
  ],
  lossOfControl: [
    /\b(?:unauthorized|without permission|without consent|exposed credentials|publicly exposed)\b/i,
    /\b(?:rogue|deceiv(?:e|ed|ing)|escaped|bypass(?:ed)?|evad(?:e|ed)|acted autonomously)\b/i,
    /\b(?:breach(?:ed)?|hack(?:ed)?|account takeover|production infrastructure|production systems)\b/i,
    /\b(?:deepfake|impersonat(?:e|ed|ion)|nudif(?:y|ied)|identity theft)\b/i,
    /\b(?:ran amok|out of control|loss of control|jailbreak(?:ed)?)\b/i,
    /\b(?:open[- ]weight|open source)\s+(?:ai\s+)?models?\b.*\b(?:without safeguards?|safety gap|unsafe)\b/i,
  ],
  irreversibility: [
    /\b(?:death|deaths|dead|fatal|killed\s+(?:a|an|the|\d+)|permanent|irreversible)\b/i,
    /\b(?:stolen|leaked|exposed)\s+(?:data|records|credentials|identity|identities|information)\b/i,
    /\b(?:reputation(?:al)? (?:damage|loss)|financial loss|lost income|bankrupt(?:cy)?)\b/i,
    /\b(?:destroyed|deleted|unrecoverable|cannot be undone|long-term damage)\b/i,
  ],
  immediacy: [
    /\b(?:ongoing|underway|currently|right now|active attack|emergency|imminent)\b/i,
    /\b(?:already|continues?|spreading|accelerat(?:e|ed|ing)|surging)\b/i,
    /\b(?:urgent|immediate|within days|this week|today)\b/i,
  ],
  systemicReach: [
    /\b(?:government|congress|parliament|election|court|law|regulator|public sector)\b/i,
    /\b(?:hospital|health system|school|college|university|education system)\b/i,
    /\b(?:critical infrastructure|power grid|nuclear plant|supply chain|financial system)\b/i,
    /\b(?:industry|institutions|production infrastructure|data centers?)\b/i,
    /\b(?:frontier models?|industry leaders?)\b/i,
    /\b(?:national security|public safety|civil rights|freedom of speech)\b/i,
  ],
  credibleThreat: [
    /\b(?:danger(?:ous)?|threat(?:s|en|ened)?|unsafe|safety gap|without safeguards?)\b/i,
    /\b(?:risk(?:s|y)?|warning|warns?|vulnerability|vulnerabilities)\b/i,
    /\b(?:weapon(?:s|ized)?|biological|chemical|military|surveillance)\b/i,
    /\b(?:censorship|restrict(?:s|ed|ion)|unaccountable|uncharted legal territory)\b/i,
    /\b(?:misinformation|disinformation|abuse|harassment|blackmail|extortion)\b/i,
  ],
};

const CONFIRMED_EVIDENCE_PATTERNS = [
  /\b(?:confirmed|found|revealed|documented|demonstrated|showed|shows|caused)\b/i,
  /\b(?:according to|court records|internal documents|investigation|researchers found)\b/i,
  /\b(?:was|were|has been|have been)\s+(?:breached|hacked|attacked|forced|targeted|exposed|denied)\b/i,
];

const SPECULATIVE_PATTERNS = [
  /\b(?:could|may|might|possibly|potentially|theoretical(?:ly)?)\b/i,
  /\b(?:reportedly|allegedly|speculation|speculates?|prediction|predicts?)\b/i,
  /\b(?:if|would|could someday|may eventually)\b/i,
];

const ROUTINE_PATTERNS = [
  /\b(?:raises?|raised|funding|fundraise|investment|valuation|venture round|series [a-z])\b/i,
  /\b(?:award|prize|honou?r|recognition|named a fellow)\b/i,
  /\b(?:appoints?|appointed|hires?|hired|leadership change|new ceo|steps down)\b/i,
  /\b(?:launches?|launched|unveils?|unveiled|introduces?|released?|new feature|product update)\b/i,
  /\b(?:how to|guide to|what is|explainer|tips for|want to get more)\b/i,
  /\b(?:breakthrough|promising|improves?|helps?|benefits?|successfully)\b/i,
];

const BASELINE = 5;
const ROUTINE_REDUCTION = 0.72;
const SEVERITY_CURVE = 0.78;
const FACTOR_SATURATION = {
  realizedHarm: 2,
  scale: 2,
  vulnerability: 1,
  lossOfControl: 2,
  irreversibility: 1,
  immediacy: 2,
  systemicReach: 2,
  credibleThreat: 2,
};

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(Number(value) || 0, maximum));
}

function round(value, places = 4) {
  return Number(Number(value).toFixed(places));
}

function normalizedText(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|amp|quot|apos|lt|gt);/gi, " ")
    .normalize("NFKD")
    .replace(/\s+/g, " ")
    .trim();
}

function patternScore(text, patterns, saturation = 2) {
  const matches = patterns.reduce(
    (count, pattern) => count + (pattern.test(text) ? 1 : 0),
    0,
  );

  return clamp(matches / saturation);
}

function hasSpecificEvidence(text) {
  return /\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?\s*(?:%|percent|hundred|thousand|million|billion|trillion)\b|\b(?:two|three|four|five|six|seven|eight|nine|ten)\s+(?:people|users|students|patients|accounts|companies|organizations|countries|schools)\b/i.test(
    text,
  );
}

export function normalizedDoomIndexV12Weights(configuredWeights = {}) {
  const weights = Object.fromEntries(
    DOOM_INDEX_V12_FACTOR_NAMES.map((name) => {
      const configured = Number(configuredWeights[name]);
      return [
        name,
        Number.isFinite(configured) && configured >= 0
          ? configured
          : DEFAULT_DOOM_INDEX_V12_WEIGHTS[name],
      ];
    }),
  );
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);

  if (total <= 0) {
    return { ...DEFAULT_DOOM_INDEX_V12_WEIGHTS };
  }

  return Object.fromEntries(
    Object.entries(weights).map(([name, value]) => [name, value / total]),
  );
}

export function calculateDoomIndexV12FromFactors(
  factors,
  configuredWeights = {},
) {
  const weights = normalizedDoomIndexV12Weights(configuredWeights);
  const weightedSeverity = DOOM_INDEX_V12_FACTOR_NAMES.reduce(
    (total, name) => total + clamp(factors[name]) * weights[name],
    0,
  );
  const evidence = clamp(factors.evidence);
  const evidenceMultiplier = 0.55 + evidence * 0.45;
  const unadjusted =
    BASELINE +
    (100 - BASELINE) *
      Math.pow(clamp(weightedSeverity), SEVERITY_CURVE) *
      evidenceMultiplier;
  const severeIncident =
    clamp(factors.realizedHarm) >= 0.5 ||
    clamp(factors.lossOfControl) >= 0.5 ||
    clamp(factors.credibleThreat) >= 0.75;
  const routinePenalty = severeIncident ? 0 : clamp(factors.routinePenalty);
  const routineMultiplier = 1 - routinePenalty * ROUTINE_REDUCTION;
  const value = BASELINE + (unadjusted - BASELINE) * routineMultiplier;

  return {
    value: round(clamp(value, 0, 100), 2),
    weightedSeverity: round(weightedSeverity),
    evidenceMultiplier: round(evidenceMultiplier),
    routineMultiplier: round(routineMultiplier),
  };
}

export function calculateDoomIndexV12({
  title,
  summary = "",
  coverageSources = 1,
  weights = {},
} = {}) {
  const titleText = normalizedText(title);
  const summaryText = normalizedText(summary);
  const combinedText = `${titleText}. ${summaryText}`.trim();
  const factors = Object.fromEntries(
    DOOM_INDEX_V12_FACTOR_NAMES.map((name) => [
      name,
      round(
        patternScore(
          combinedText,
          SIGNAL_PATTERNS[name],
          FACTOR_SATURATION[name],
        ),
      ),
    ]),
  );
  const confirmedEvidence = patternScore(
    combinedText,
    CONFIRMED_EVIDENCE_PATTERNS,
    2,
  );
  const speculativeLanguage = patternScore(
    combinedText,
    SPECULATIVE_PATTERNS,
    2,
  );
  const specificity = hasSpecificEvidence(combinedText) ? 1 : 0;
  const corroboration = clamp((Number(coverageSources) - 1) / 2);
  const routinePenalty = patternScore(combinedText, ROUTINE_PATTERNS, 2);

  factors.evidence = round(
    clamp(
      0.35 +
        confirmedEvidence * 0.35 +
        specificity * 0.2 +
        corroboration * 0.1 -
        speculativeLanguage * 0.25,
    ),
  );
  factors.routinePenalty = round(routinePenalty);

  const score = calculateDoomIndexV12FromFactors(factors, weights);
  const reasons = [];
  const reasonLabels = {
    realizedHarm: "realized harm",
    scale: "large affected population or reach",
    vulnerability: "vulnerable people affected",
    lossOfControl: "unauthorized behavior or loss of control",
    irreversibility: "potentially irreversible consequences",
    immediacy: "immediate or ongoing consequences",
    systemicReach: "systemic or institutional reach",
    credibleThreat: "credible threat or safety risk",
  };

  for (const name of DOOM_INDEX_V12_FACTOR_NAMES) {
    if (factors[name] >= 0.5) {
      reasons.push(reasonLabels[name]);
    }
  }

  if (factors.evidence >= 0.7) reasons.push("strong or specific evidence");
  if (factors.evidence <= 0.3) reasons.push("speculative or weakly evidenced");
  if (factors.routinePenalty > 0 && score.routineMultiplier < 1) {
    reasons.push("routine, promotional, or positive-news adjustment");
  }

  return {
    ...score,
    factors,
    reasons,
  };
}

export function createDoomIndexV12Fingerprint({
  formulaVersion,
  weights = {},
} = {}) {
  const definition = {
    formulaVersion: String(formulaVersion || "1.2-shadow.1"),
    weights: normalizedDoomIndexV12Weights(weights),
    constants: {
      BASELINE,
      ROUTINE_REDUCTION,
      SEVERITY_CURVE,
      FACTOR_SATURATION,
    },
    signalPatterns: Object.fromEntries(
      Object.entries(SIGNAL_PATTERNS).map(([name, patterns]) => [
        name,
        patterns.map((pattern) => pattern.toString()),
      ]),
    ),
    confirmedEvidencePatterns: CONFIRMED_EVIDENCE_PATTERNS.map((pattern) =>
      pattern.toString(),
    ),
    speculativePatterns: SPECULATIVE_PATTERNS.map((pattern) =>
      pattern.toString(),
    ),
    routinePatterns: ROUTINE_PATTERNS.map((pattern) => pattern.toString()),
    implementations: [
      clamp,
      round,
      normalizedText,
      patternScore,
      hasSpecificEvidence,
      normalizedDoomIndexV12Weights,
      calculateDoomIndexV12FromFactors,
      calculateDoomIndexV12,
    ].map((implementation) => implementation.toString()),
  };

  return createHash("sha256")
    .update(JSON.stringify(definition))
    .digest("hex")
    .slice(0, 20);
}
