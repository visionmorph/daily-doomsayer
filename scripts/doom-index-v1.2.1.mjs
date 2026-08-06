import { createHash } from "node:crypto";

export const DOOM_INDEX_V121_FACTOR_NAMES = [
  "realizedHarm",
  "scale",
  "vulnerability",
  "lossOfControl",
  "irreversibility",
  "immediacy",
  "systemicReach",
  "credibleThreat",
];

export const DOOM_INDEX_V121_AUXILIARY_FACTOR_NAMES = [
  "evidence",
  "actuality",
  "protectiveContext",
  "routinePenalty",
  "contextualConcern",
];

export const DEFAULT_DOOM_INDEX_V121_WEIGHTS = {
  realizedHarm: 0.23,
  scale: 0.13,
  vulnerability: 0.1,
  lossOfControl: 0.17,
  irreversibility: 0.1,
  immediacy: 0.06,
  systemicReach: 0.08,
  credibleThreat: 0.13,
};

const SIGNAL_PATTERNS = {
  realizedHarm: [
    /\b(?:gained unauthorized access|account takeover|data breach|security breach)\b/i,
    /\b(?:hack(?:ed|ing)|attack(?:ed|ing)|compromis(?:e|ed)|malfunction(?:ed)?)\b/i,
    /\b(?:forced to|must retake|wrongly denied|invalidated|locked out|targeted accounts?)\b/i,
    /\b(?:recalled by (?:the )?fda|unsafe supplements?|harmful products?)\b/i,
    /\b(?:harm(?:ed|ful)?|injur(?:y|ed)|victims?|deaths?|fatal(?:ity|ities)?)\b/i,
    /\b(?:deceiv(?:e|ed|ing)|manipulat(?:e|ed|ion)|impersonat(?:e|ed|ion)|fake identities)\b/i,
    /\b(?:stole|stolen|theft|fraud|scam(?:med|s)?|financial loss|lost income)\b/i,
    /\b(?:harassment|blackmail|extortion|discriminat(?:e|ed|ion)|reputation damage)\b/i,
    /\b(?:child sexual abuse|sexual abuse imagery|csam|nonconsensual intimate imagery)\b/i,
  ],
  scale: [
    /\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?\s*(?:hundred|thousand|million|billion|trillion)\b/i,
    /\b(?:hundreds|thousands|millions|billions)\b/i,
    /\b(?:mass|massive|widespread|global|nationwide|industry-wide|large-scale)\b/i,
    /\b(?:multiple|several|dozens of|scores of|two|three|four|five)\s+(?:\w+\s+){0,2}(?:people|users|students|patients|accounts|companies|organizations|countries|schools)\b/i,
    /\b(?:across|throughout)\s+(?:the world|the country|countries|companies|organizations|schools|universities|industries)\b/i,
  ],
  vulnerability: [
    /\b(?:children|child|kids|minors|teenagers|students|pupils)\b/i,
    /\b(?:patients|disabled|elderly|seniors|vulnerable|survivors|victims)\b/i,
    /\b(?:low-income|marginalized|minority|refugees|immigrants)\b/i,
  ],
  lossOfControl: [
    /\b(?:unauthorized|without permission|without consent|exposed credentials|publicly exposed)\b/i,
    /\b(?:rogue|escaped|bypass(?:ed)?|evad(?:e|ed)|acted autonomously|ran amok)\b/i,
    /\b(?:breach(?:ed)?|hack(?:ed)?|account takeover|production infrastructure|production systems)\b/i,
    /\b(?:deepfake|impersonat(?:e|ed|ion)|nudif(?:y|ied)|identity theft|fake identities)\b/i,
    /\b(?:out of control|loss of control|jailbreak(?:ed)?|deceiv(?:e|ed|ing))\b/i,
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
    /\b(?:continues?|spreading|accelerat(?:e|ed|ing)|surging|must retake)\b/i,
    /\b(?:urgent|immediate|within days|today|this week)\b/i,
  ],
  systemicReach: [
    /\b(?:government|congress|parliament|election|court|law|regulator|public sector|fda)\b/i,
    /\b(?:hospital|health system|school|college|university|education system)\b/i,
    /\b(?:critical infrastructure|power grid|nuclear plant|supply chain|financial system)\b/i,
    /\b(?:industry|institutions|production infrastructure|data centers?)\b/i,
    /\b(?:national security|public safety|civil rights|freedom of speech)\b/i,
    /\b(?:frontier models?|industry leaders?)\b/i,
  ],
  credibleThreat: [
    /\b(?:danger(?:ous)?|threat(?:s|en|ened)?|unsafe|safety gap|without safeguards?)\b/i,
    /\b(?:risk(?:s|y)?|warning|warns?|vulnerability|vulnerabilities|sound(?:s|ed)? alarm)\b/i,
    /\b(?:weapon(?:s|ized)?|biological|chemical|military|surveillance)\b/i,
    /\b(?:censorship|restrict(?:s|ed|ion)|unaccountable|uncharted territory)\b/i,
    /\b(?:misinformation|disinformation|abuse|harassment|blackmail|extortion)\b/i,
    /\b(?:recalled by (?:the )?fda|harmful products?|outpac(?:e|ed|ing) supply)\b/i,
    /\b(?:secretive|secret framework|reverse engineer(?:ed|ing)?|stolen model)\b/i,
  ],
};

const FACTOR_SATURATION = {
  realizedHarm: 1.5,
  scale: 2,
  vulnerability: 1,
  lossOfControl: 2,
  irreversibility: 1,
  immediacy: 2,
  systemicReach: 2,
  credibleThreat: 2,
};

const HIGH_CONFIDENCE_INCIDENT_PATTERNS = [
  /\b(?:gained unauthorized access|recalled by (?:the )?fda|must retake|forced to retake)\b/i,
  /\b(?:was|were|has been|have been)\s+(?:breached|hacked|attacked|compromised|targeted|exposed|denied)\b/i,
  /\b(?:created fake identities|used fake identities|targeted user accounts?|caused financial loss)\b/i,
  /\b(?:investigation|researchers|court records|internal documents)\s+(?:confirmed|found|showed|revealed)\b/i,
  /\b(?:ai|models?|agents?)\b.*\b(?:tried|tries|used|created)\b.*\b(?:deceive|fake identities|malware|hack)\b/i,
  /\b(?:ran|served|published)\s+(?:ads?|images?)\s+that\s+contained\s+(?:ai-generated\s+)?(?:child sexual abuse|csam)\b/i,
  /\b(?:models?|agents?)\s+(?:have been\s+)?(?:going|gone)\s+rogue\s+in\s+tests?\b/i,
  /\b(?:ai|models?|agents?)\b.*\b(?:hacked into|hacking spree)\b/i,
];

const CONFIRMED_EVIDENCE_PATTERNS = [
  /\b(?:confirmed|found|revealed|documented|demonstrated|showed|shows|caused)\b/i,
  /\b(?:according to|court records|internal documents|investigation|researchers found)\b/i,
  /\b(?:was|were|has been|have been)\s+(?:breached|hacked|attacked|forced|targeted|exposed|denied)\b/i,
];

const ONGOING_PATTERNS = [
  /\b(?:ongoing|underway|currently|active attack|continues?|spreading|surging)\b/i,
  /\b(?:is harming|are harming|keeps targeting|still affecting)\b/i,
];

const REPORTED_PATTERNS = [
  /\b(?:reportedly|reported to|according to|allegedly)\b/i,
  /\b(?:report says|investigation finds|researchers say)\b/i,
];

const PROPOSED_PATTERNS = [
  /\b(?:could|may|might|possibly|potentially|would)\b/i,
  /\b(?:bill|act|proposal|proposed|senate vote|should reject|should pass)\b/i,
  /\b(?:warns?|warning|raises questions|risks?|concerns?)\b/i,
  /\b(?:prediction|predicts?|someday|eventually|future of)\b/i,
  /\b(?:opinion|commentary|i'll never|i will never|we should be worried)\b/i,
];

const PREVENTATIVE_PATTERNS = [
  /\b(?:designed to|tool to|system to)\s+(?:protect|prevent|reduce|detect|prepare|improve safety)\b/i,
  /\b(?:protect|prevent|prepare for|mitigate|safeguard|early warning)\b/i,
  /\b(?:fight cancer|track harmful|detect illness|secure systems?)\b/i,
];

const POSITIVE_PATTERNS = [
  /\b(?:award|prize|honou?r|recognition|named a fellow)\b/i,
  /\b(?:raises?|raised|funding|fundraise|investment|valuation|venture round|series [a-z])\b/i,
  /\b(?:acquires?|acquired|appoints?|hires?|new ceo|leadership change)\b/i,
  /\b(?:breakthrough|promising|improves?|eases?|benefits?|successfully|more efficient)\b/i,
  /\b(?:court|judge|ruling)\s+(?:agrees|blocks|protects|rejects|strikes down)\b/i,
];

const ROUTINE_PATTERNS = [
  ...POSITIVE_PATTERNS,
  /\b(?:launches?|launched|unveils?|unveiled|introduces?|released?|new feature|product update)\b/i,
  /\b(?:how to|guide to|what is|explainer|tips for|want to get more)\b/i,
  /\b(?:opinion|commentary|i'll never|i will never)\b/i,
  /\b(?:costs? up to|pricing|subscription|same thing for free)\b/i,
];

const CONTEXTUAL_CONCERN_PATTERNS = [
  /\b(?:privacy|accountability|inequality|bias|control|pressure|controversy)\b/i,
  /\b(?:expensive|costs?|shortage|demand outpac(?:es|ing) supply|forced upgrade)\b/i,
  /\b(?:disappear|shutdown|retire|obsolete|incompatible|left behind)\b/i,
  /\b(?:labor|jobs?|employment|creators?|artists?|influencers?)\b/i,
  /\b(?:legal uncertainty|legal territory|responsibility|liability)\b/i,
];

const BASELINE = 5;
const SEVERITY_CURVE = 0.72;
const ROUTINE_REDUCTION = 0.7;
const PROTECTIVE_REDUCTION = 0.55;

function clamp(value, minimum = 0, maximum = 1) {
  return Math.max(minimum, Math.min(Number(value) || 0, maximum));
}

function round(value, places = 4) {
  return Number(Number(value).toFixed(places));
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, number) =>
      String.fromCodePoint(Number(number)),
    )
    .replace(/&#x([\da-f]+);/gi, (_, number) =>
      String.fromCodePoint(Number.parseInt(number, 16)),
    )
    .replace(/&(?:nbsp|amp|quot|apos|lt|gt);/gi, " ");
}

function normalizedText(value) {
  return decodeEntities(value)
    .replace(/<[^>]*>/g, " ")
    .normalize("NFKD")
    .replace(/\s+/g, " ")
    .trim();
}

function matchRatio(text, patterns, saturation = 2) {
  const matches = patterns.reduce(
    (count, pattern) => count + (pattern.test(text) ? 1 : 0),
    0,
  );

  return clamp(matches / saturation);
}

function contextualPatternScore(title, summary, patterns, saturation = 2) {
  const titleScore = matchRatio(title, patterns, saturation);
  const summaryScore = matchRatio(summary, patterns, saturation);

  return clamp(
    Math.max(titleScore, summaryScore * 0.85) +
      Math.min(titleScore, summaryScore) * 0.15,
  );
}

function hasSpecificEvidence(text) {
  return /\b\d{1,3}(?:,\d{3})+\b|\b\d+(?:\.\d+)?\s*(?:%|percent|hundred|thousand|million|billion|trillion)\b|\b(?:two|three|four|five|six|seven|eight|nine|ten)\s+(?:people|users|students|patients|accounts|companies|organizations|countries|schools)\b/i.test(
    text,
  );
}

function actualityClassification(title, summary, severityFactors) {
  const incident = contextualPatternScore(
    title,
    summary,
    HIGH_CONFIDENCE_INCIDENT_PATTERNS,
    1,
  );
  const ongoing = contextualPatternScore(title, summary, ONGOING_PATTERNS, 1);
  const reported = contextualPatternScore(title, summary, REPORTED_PATTERNS, 1);
  const proposed = contextualPatternScore(title, summary, PROPOSED_PATTERNS, 1);
  const preventative = contextualPatternScore(
    title,
    summary,
    PREVENTATIVE_PATTERNS,
    1,
  );
  const positive = contextualPatternScore(title, summary, POSITIVE_PATTERNS, 1);
  const hasAdverseSignal =
    severityFactors.realizedHarm >= 0.35 ||
    severityFactors.lossOfControl >= 0.35 ||
    severityFactors.credibleThreat >= 0.35;

  if (incident >= 0.5) return { label: "confirmed", value: 1 };
  if (
    positive >= 0.5 &&
    severityFactors.realizedHarm < 0.5 &&
    severityFactors.lossOfControl < 0.5 &&
    severityFactors.credibleThreat < 0.5
  ) {
    return { label: "positive", value: 0.2 };
  }
  if (proposed >= 0.5) return { label: "proposed", value: 0.35 };
  if (ongoing >= 0.5 && hasAdverseSignal) {
    return { label: "ongoing", value: 0.85 };
  }
  if (reported >= 0.5 && hasAdverseSignal) {
    return { label: "reported", value: 0.65 };
  }
  if (preventative >= 0.5) return { label: "preventative", value: 0.3 };
  if (positive >= 0.5) return { label: "positive", value: 0.2 };
  if (hasAdverseSignal) return { label: "unclear", value: 0.5 };
  return { label: "neutral", value: 0.25 };
}

export function normalizedDoomIndexV121Weights(configuredWeights = {}) {
  const weights = Object.fromEntries(
    DOOM_INDEX_V121_FACTOR_NAMES.map((name) => {
      const configured = Number(configuredWeights[name]);
      return [
        name,
        Number.isFinite(configured) && configured >= 0
          ? configured
          : DEFAULT_DOOM_INDEX_V121_WEIGHTS[name],
      ];
    }),
  );
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);

  if (total <= 0) return { ...DEFAULT_DOOM_INDEX_V121_WEIGHTS };

  return Object.fromEntries(
    Object.entries(weights).map(([name, value]) => [name, value / total]),
  );
}

export function calculateDoomIndexV121FromFactors(
  factors,
  configuredWeights = {},
) {
  const weights = normalizedDoomIndexV121Weights(configuredWeights);
  const weightedSeverity = DOOM_INDEX_V121_FACTOR_NAMES.reduce(
    (total, name) => total + clamp(factors[name]) * weights[name],
    0,
  );
  const evidence = clamp(factors.evidence);
  const actuality = clamp(factors.actuality);
  const evidenceMultiplier = 0.5 + evidence * 0.5;
  const actualityMultiplier = 0.35 + actuality * 0.65;
  const credibleIncident =
    actuality >= 0.65 &&
    evidence >= 0.5 &&
    (clamp(factors.realizedHarm) >= 0.5 ||
      clamp(factors.lossOfControl) >= 0.5);
  const routinePenalty = clamp(factors.routinePenalty);
  const routineReduction = credibleIncident ? 0.15 : ROUTINE_REDUCTION;
  const routineMultiplier = 1 - routinePenalty * routineReduction;
  const protectiveContext = clamp(factors.protectiveContext);
  const protectiveMultiplier =
    credibleIncident && clamp(factors.realizedHarm) >= 0.5
      ? 1
      : 1 - protectiveContext * PROTECTIVE_REDUCTION;
  const contextualFloor = 12 * clamp(factors.contextualConcern);
  const severityContribution =
    83 *
    Math.pow(clamp(weightedSeverity), SEVERITY_CURVE) *
    evidenceMultiplier *
    actualityMultiplier;
  const compoundDimensions = [
    "realizedHarm",
    "scale",
    "vulnerability",
    "lossOfControl",
    "irreversibility",
    "systemicReach",
  ].filter((name) => clamp(factors[name]) >= 0.5).length;
  const compoundBonus = credibleIncident
    ? Math.max(0, compoundDimensions - 2) * 4 +
      (clamp(factors.realizedHarm) >= 0.5 &&
      clamp(factors.lossOfControl) >= 0.5
        ? 6
        : 0)
    : 0;
  let value =
    BASELINE +
    (contextualFloor + severityContribution + compoundBonus) *
      routineMultiplier *
      protectiveMultiplier;

  if (actuality <= 0.35 && evidence < 0.4) {
    value = Math.min(value, 39);
  }

  if (protectiveContext >= 0.75 && !credibleIncident) {
    value = Math.min(value, 24.99);
  }

  return {
    value: round(clamp(value, 0, 100), 2),
    weightedSeverity: round(weightedSeverity),
    evidenceMultiplier: round(evidenceMultiplier),
    actualityMultiplier: round(actualityMultiplier),
    routineMultiplier: round(routineMultiplier),
    protectiveMultiplier: round(protectiveMultiplier),
    compoundBonus: round(compoundBonus, 2),
  };
}

export function calculateDoomIndexV121({
  title,
  summary = "",
  coverageSources = 1,
  weights = {},
} = {}) {
  const titleText = normalizedText(title);
  let summaryText = normalizedText(summary);

  if (titleText && summaryText.toLowerCase().startsWith(titleText.toLowerCase())) {
    summaryText = summaryText.slice(titleText.length).trim();
  }

  const combinedText = `${titleText}. ${summaryText}`.trim();
  const factors = Object.fromEntries(
    DOOM_INDEX_V121_FACTOR_NAMES.map((name) => [
      name,
      round(
        contextualPatternScore(
          titleText,
          summaryText,
          SIGNAL_PATTERNS[name],
          FACTOR_SATURATION[name],
        ),
      ),
    ]),
  );
  const actuality = actualityClassification(titleText, summaryText, factors);
  const confirmedEvidence = contextualPatternScore(
    titleText,
    summaryText,
    CONFIRMED_EVIDENCE_PATTERNS,
    2,
  );
  const incidentEvidence = contextualPatternScore(
    titleText,
    summaryText,
    HIGH_CONFIDENCE_INCIDENT_PATTERNS,
    1,
  );
  const reportedEvidence = contextualPatternScore(
    titleText,
    summaryText,
    REPORTED_PATTERNS,
    1,
  );
  const proposedLanguage = contextualPatternScore(
    titleText,
    summaryText,
    PROPOSED_PATTERNS,
    2,
  );
  const specificity = hasSpecificEvidence(combinedText) ? 1 : 0;
  const corroboration = clamp((Number(coverageSources) - 1) / 2);
  const routinePenalty = contextualPatternScore(
    titleText,
    summaryText,
    ROUTINE_PATTERNS,
    2,
  );
  const preventative = contextualPatternScore(
    titleText,
    summaryText,
    PREVENTATIVE_PATTERNS,
    1,
  );
  const positive = contextualPatternScore(
    titleText,
    summaryText,
    POSITIVE_PATTERNS,
    2,
  );

  factors.evidence = round(
    clamp(
      0.3 +
        confirmedEvidence * 0.35 +
        incidentEvidence * 0.25 +
        reportedEvidence * 0.1 +
        specificity * 0.2 +
        corroboration * 0.1 -
        proposedLanguage * 0.2,
    ),
  );
  factors.actuality = actuality.value;
  factors.protectiveContext = round(clamp(Math.max(preventative, positive)));
  factors.routinePenalty = round(routinePenalty);
  factors.contextualConcern = round(
    contextualPatternScore(
      titleText,
      summaryText,
      CONTEXTUAL_CONCERN_PATTERNS,
      2,
    ),
  );

  const score = calculateDoomIndexV121FromFactors(factors, weights);
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

  for (const name of DOOM_INDEX_V121_FACTOR_NAMES) {
    if (factors[name] >= 0.5) reasons.push(reasonLabels[name]);
  }

  reasons.push(`${actuality.label} event status`);
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

  return {
    ...score,
    actuality: actuality.label,
    polarity:
      factors.protectiveContext >= 0.5
        ? "protective-or-positive"
        : factors.realizedHarm >= 0.5 || factors.credibleThreat >= 0.5
          ? "adverse"
          : "neutral",
    factors,
    reasons,
  };
}

export function createDoomIndexV121Fingerprint({
  formulaVersion,
  weights = {},
} = {}) {
  const patternGroups = {
    signalPatterns: SIGNAL_PATTERNS,
    highConfidenceIncidentPatterns: HIGH_CONFIDENCE_INCIDENT_PATTERNS,
    confirmedEvidencePatterns: CONFIRMED_EVIDENCE_PATTERNS,
    ongoingPatterns: ONGOING_PATTERNS,
    reportedPatterns: REPORTED_PATTERNS,
    proposedPatterns: PROPOSED_PATTERNS,
    preventativePatterns: PREVENTATIVE_PATTERNS,
    positivePatterns: POSITIVE_PATTERNS,
    routinePatterns: ROUTINE_PATTERNS,
    contextualConcernPatterns: CONTEXTUAL_CONCERN_PATTERNS,
  };
  const definition = {
    formulaVersion: String(formulaVersion || "1.2.1-shadow.3"),
    weights: normalizedDoomIndexV121Weights(weights),
    constants: {
      BASELINE,
      SEVERITY_CURVE,
      ROUTINE_REDUCTION,
      PROTECTIVE_REDUCTION,
      FACTOR_SATURATION,
    },
    patterns: Object.fromEntries(
      Object.entries(patternGroups).map(([groupName, group]) => [
        groupName,
        Array.isArray(group)
          ? group.map((pattern) => pattern.toString())
          : Object.fromEntries(
              Object.entries(group).map(([name, patterns]) => [
                name,
                patterns.map((pattern) => pattern.toString()),
              ]),
            ),
      ]),
    ),
    implementations: [
      clamp,
      round,
      decodeEntities,
      normalizedText,
      matchRatio,
      contextualPatternScore,
      hasSpecificEvidence,
      actualityClassification,
      normalizedDoomIndexV121Weights,
      calculateDoomIndexV121FromFactors,
      calculateDoomIndexV121,
    ].map((implementation) => implementation.toString()),
  };

  return createHash("sha256")
    .update(JSON.stringify(definition))
    .digest("hex")
    .slice(0, 20);
}
