import { createHash } from "node:crypto";

export const DREAD_V130_VERSION = "1.3.0";
export const DREAD_V130_FORMULA_VERSION = "1.3.0-body-context.1";
export const DREAD_V130_ANALYZER_VERSION = "1.3.0-context-rules.1";

export const DREAD_V130_FACTORS = Object.freeze([
  { id: "harm", weight: 0 },
  { id: "certainty", weight: 0.2 },
  { id: "reach", weight: 0.18 },
  { id: "reversibility", weight: 0.15 },
  { id: "containment", weight: 0.18 },
  { id: "recurrence", weight: 0.12 },
  { id: "vulnerability", weight: 0.17 },
]);

const DEFAULT_SCALE = Object.freeze([
  { minimum: 0, maximum: 19.99, label: "UNEASY" },
  { minimum: 20, maximum: 39.99, label: "OMINOUS" },
  { minimum: 40, maximum: 59.99, label: "ALARMING" },
  { minimum: 60, maximum: 79.99, label: "DIRE" },
  { minimum: 80, maximum: 100, label: "CATASTROPHIC" },
]);

const SPECULATIVE_PATTERNS = [
  /\b(?:could|may|might|potentially|possibly|theoretical|hypothetical)\b/i,
  /\b(?:risk|risks|warning|warns?|fears?|concern|threat)\b/i,
  /\b(?:if|unless|prediction|forecast|scenario|opinion|editorial)\b/i,
];

const REALIZED_PATTERNS = [
  /\b(?:confirmed|documented|demonstrated|observed|found|revealed|showed)\b/i,
  /\b(?:caused|resulted in|led to|left|affected|exposed|stole|disrupted)\b/i,
  /\b(?:breach(?:ed)?|hack(?:ed)?|attack(?:ed)?|failed|denied|injured|killed)\b/i,
  /\b(?:is occurring|are occurring|has occurred|have occurred|already)\b/i,
];

const NEGATED_REALIZED_PATTERNS = [
  /\b(?:no|not|never|without)\b.{0,35}\b(?:harm|damage|incident|attack|breach|consequence|disruption|failure)\b/i,
  /\b(?:has not|have not|had not|hasn't|haven't|hadn't)\b.{0,25}\b(?:occurred|happened|caused|affected)\b/i,
  /\b(?:prevented|avoided)\b.{0,30}\b(?:harm|damage|attack|breach|incident)\b/i,
];

const ROUTINE_OR_PROTECTIVE_PATTERNS = [
  /\b(?:funding round|raised \$|valuation|product launch|new feature|partnership)\b/i,
  /\b(?:fix(?:ed)?|patch(?:ed)?|prevent(?:ed)?|protect(?:s|ed)?|safeguard)\b/i,
  /\b(?:improve(?:s|d)?|benefit(?:s|ed)?|breakthrough|research project)\b/i,
  /\b(?:label(?:s|ed)?|exclude from recommendations|authenticate photographs)\b/i,
];

const FACTOR_RULES = Object.freeze({
  harm: [
    {
      level: 4,
      patterns: [
        /\b(?:mass casualties|mass deaths|millions? (?:dead|killed|displaced))\b/i,
        /\b(?:global catastrophe|existential event|civilization(?:al)? collapse)\b/i,
        /\b(?:worldwide|global)\b.*\b(?:essential systems? (?:collapsed|failed)|irreversible damage)\b/i,
      ],
    },
    {
      level: 3,
      patterns: [
        /\b(?:death toll|fatalities|people (?:died|were killed)|loss of life)\b/i,
        /\b(?:major|widespread|severe)\b.*\b(?:outage|breach|disruption|harm|pollution|damage)\b/i,
        /\b(?:hospital|power grid|water supply|emergency services?)\b.*\b(?:failed|disrupted|compromised|shut down)\b/i,
        /\b(?:escaped|went rogue|ran amok)\b.*\b(?:breach|attack|hack|internet|production)\b/i,
      ],
    },
    {
      level: 2,
      patterns: [
        /\b(?:hacked|breached|compromised|stolen|exposed|leaked)\b/i,
        /\b(?:lost jobs|job losses|laid off|displaced workers?|denied benefits?)\b/i,
        /\b(?:harassment|abuse|fraud|scam|deepfake|surveillance|privacy violation)\b/i,
        /\b(?:material harm|meaningful harm|significant disruption|financial loss|pollution)\b/i,
        /\b(?:malware|malicious code|unauthorized access|took over|hijack)\b/i,
      ],
    },
    {
      level: 1,
      patterns: [
        /\b(?:risk|warning|concern|vulnerability|flaw|danger|unsafe)\b/i,
        /\b(?:controversy|backlash|criticism|pressure|uncertainty)\b/i,
        /\b(?:could harm|may harm|might harm|potential consequences?)\b/i,
      ],
    },
  ],
  certainty: [
    {
      level: 4,
      patterns: [
        /\b(?:\d[\d,.]*|dozens|hundreds|thousands|millions)\b.*\b(?:affected|exposed|lost|killed|injured|displaced|hours?|days?)\b/i,
        /\b(?:court ruled|judge ruled|regulator found|official investigation confirmed)\b/i,
        /\b(?:measured|verified)\b.*\b(?:damage|loss|consequences?|impact)\b/i,
      ],
    },
    {
      level: 3,
      patterns: [
        /\b(?:confirmed|documented|demonstrated|verified|observed|evidence shows)\b/i,
        /\b(?:investigation|researchers?|officials?|court|regulator)\b.*\b(?:found|concluded|reported|ruled)\b/i,
      ],
    },
    {
      level: 2,
      patterns: [
        /\b(?:reported|according to|study|analysis|researchers? say|experts? say)\b/i,
        /\b(?:still developing|preliminary|early findings?)\b/i,
      ],
    },
    {
      level: 1,
      patterns: [
        /\b(?:alleged|reportedly|appears?|seems?|unclear|unverified)\b/i,
        /\b(?:proposal|proposed|planned|considering|expects?|predicts?)\b/i,
      ],
    },
  ],
  reach: [
    {
      level: 4,
      patterns: [
        /\b(?:global|worldwide|international|across countries|multiple countries)\b/i,
        /\b(?:billions of people|across the world|around the world)\b/i,
      ],
    },
    {
      level: 3,
      patterns: [
        /\b(?:national|nationwide|systemic|regional|statewide|industry-wide)\b/i,
        /\b(?:millions|hundreds of thousands)\b.*\b(?:people|users|workers|patients|students|customers)\b/i,
      ],
    },
    {
      level: 2,
      patterns: [
        /\b(?:multiple|several|many)\b.*\b(?:people|organizations|companies|systems|communities)\b/i,
        /\b(?:thousands|hundreds)\b.*\b(?:people|users|workers|patients|students|customers)\b/i,
      ],
    },
    {
      level: 1,
      patterns: [
        /\b(?:one|single|individual|local)\b.*\b(?:person|organization|company|system|community|incident)\b/i,
      ],
    },
  ],
  reversibility: [
    {
      level: 4,
      patterns: [
        /\b(?:irreversible|permanent|cannot be undone|mass casualties|deaths?|fatalities)\b/i,
      ],
    },
    {
      level: 3,
      patterns: [
        /\b(?:long-lasting|lasting damage|years to recover|chronic|only partially reversible)\b/i,
      ],
    },
    {
      level: 2,
      patterns: [
        /\b(?:substantial effort|costly recovery|rebuild|restore|remediation|months to recover)\b/i,
      ],
    },
    {
      level: 1,
      patterns: [
        /\b(?:patched|fixed|restored|recovered|reversible|quickly resolved)\b/i,
      ],
    },
  ],
  containment: [
    {
      level: 4,
      patterns: [
        /\b(?:out of control|uncontrollable|control (?:was|has been) lost|escaped containment)\b/i,
      ],
    },
    {
      level: 3,
      patterns: [
        /\b(?:actively escalating|rapidly spreading|ongoing attack|continues? to spread|still attacking)\b/i,
      ],
    },
    {
      level: 2,
      patterns: [
        /\b(?:partially contained|still developing|unresolved|ongoing investigation|remains active)\b/i,
      ],
    },
    {
      level: 1,
      patterns: [
        /\b(?:patched|fixed|blocked|stopped|fully contained|prevented|shut down)\b/i,
      ],
    },
  ],
  recurrence: [
    {
      level: 4,
      patterns: [
        /\b(?:widespread and continuous|continuously occurring|every day|daily occurrence)\b/i,
      ],
    },
    {
      level: 3,
      patterns: [
        /\b(?:repeated|recurring|ongoing pattern|pattern of|again and again)\b/i,
      ],
    },
    {
      level: 2,
      patterns: [
        /\b(?:multiple|several|two|three|four|five)\b.*\b(?:incidents?|attacks?|breaches?|cases?|organizations?)\b/i,
      ],
    },
    {
      level: 1,
      patterns: [
        /\b(?:single|isolated|one-time|one incident|first reported)\b/i,
      ],
    },
  ],
  vulnerability: [
    {
      level: 4,
      patterns: [
        /\b(?:essential systems?|critical infrastructure|hospitals?|power grid|water supply|emergency services?)\b.*\b(?:affected|failed|disrupted|compromised)\b/i,
        /\b(?:large populations? of children|millions of patients|mass vulnerable populations?)\b/i,
      ],
    },
    {
      level: 3,
      patterns: [
        /\b(?:children|patients|elderly|disabled people|low-income|victims of abuse)\b.*\b(?:harmed|targeted|exposed|affected|at risk)\b/i,
      ],
    },
    {
      level: 2,
      patterns: [
        /\b(?:students|workers|consumers|patients|children|communities)\b.*\b(?:affected|exposed|targeted|disrupted)\b/i,
      ],
    },
    {
      level: 1,
      patterns: [
        /\b(?:could affect|may affect|potentially affects?)\b.*\b(?:children|patients|workers|students|essential systems?)\b/i,
      ],
    },
  ],
});

function normalizeEvidenceText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|quot|apos|lt|gt);/gi, " ")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function sentences(value) {
  return normalizeEvidenceText(value)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9“‘])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 20);
}

function matchRule(text, rules) {
  for (const rule of rules) {
    const pattern = rule.patterns.find((candidate) => candidate.test(text));
    if (pattern) return { level: rule.level, pattern: String(pattern) };
  }
  return { level: 0, pattern: "" };
}

function hasAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

export function analyzeDreadV130Evidence({
  title = "",
  summary = "",
  body = "",
  evidenceScope = "article-body",
} = {}) {
  const weightedSegments = [
    ...sentences(title).map((text) => ({ text, source: "title", weight: 1.2 })),
    ...sentences(summary).map((text) => ({ text, source: "summary", weight: 1.1 })),
    ...sentences(body).map((text) => ({ text, source: "body", weight: 1 })),
  ];
  const combined = weightedSegments.map(({ text }) => text).join(" ");
  const realized = weightedSegments.some(
    ({ text }) =>
      hasAny(text, REALIZED_PATTERNS) &&
      !hasAny(text, NEGATED_REALIZED_PATTERNS) &&
      !hasAny(text, SPECULATIVE_PATTERNS),
  );
  const speculative = hasAny(combined, SPECULATIVE_PATTERNS);
  const routineOrProtective = hasAny(combined, ROUTINE_OR_PROTECTIVE_PATTERNS);
  const factors = {};
  const evidence = [];

  for (const factor of DREAD_V130_FACTORS) {
    let best = { level: 0, adjustedLevel: 0, text: "", source: "", pattern: "" };

    for (const segment of weightedSegments) {
      const match = matchRule(segment.text, FACTOR_RULES[factor.id]);
      const adjustedLevel = match.level * segment.weight;
      if (adjustedLevel > best.adjustedLevel) {
        best = { ...match, adjustedLevel, text: segment.text, source: segment.source };
      }
    }

    factors[factor.id] = best.level;
    if (best.level > 0) {
      evidence.push({
        factor: factor.id,
        level: best.level,
        source: best.source,
        excerpt: best.text.slice(0, 240),
        matchedRule: best.pattern,
      });
    }
  }

  const constraints = [];

  if (!realized) {
    factors.harm = Math.min(factors.harm, 1);
    factors.certainty = Math.min(factors.certainty, speculative ? 1 : 2);
    factors.reach = Math.min(factors.reach, 1);
    factors.reversibility = 0;
    factors.containment = 0;
    factors.recurrence = 0;
    factors.vulnerability = Math.min(factors.vulnerability, 1);
    constraints.push("No realized or credibly imminent harmful consequence was detected.");
  }

  if (routineOrProtective && factors.harm <= 1 && !realized) {
    factors.harm = 0;
    constraints.push("Routine, beneficial, or protective context prevents risk language from becoming harm.");
  }

  if (factors.harm === 0) {
    for (const factor of ["reach", "reversibility", "containment", "recurrence", "vulnerability"]) {
      factors[factor] = 0;
    }
  }

  if (speculative && factors.certainty > 2 && !realized) {
    factors.certainty = 1;
  }

  const matchedEvidence = evidence.filter(
    (item) => factors[item.factor] > 0 && item.level >= factors[item.factor],
  );
  const centralEvent = normalizeEvidenceText(title) || weightedSegments[0]?.text || "Untitled story";
  const confidence =
    evidenceScope === "feed-only"
      ? "low"
      : matchedEvidence.length >= 4 && realized
        ? "high"
        : matchedEvidence.length >= 2
          ? "medium"
          : "low";

  return {
    centralEvent,
    ...factors,
    confidence,
    evidence: matchedEvidence,
    constraints,
    rationale: matchedEvidence.length
      ? `Local context rules found ${matchedEvidence.length} supported factor${matchedEvidence.length === 1 ? "" : "s"}; ${realized ? "realized consequences are present" : "the story remains speculative or preventive"}.`
      : "No phrase-context rule established material harmful consequences.",
    diagnostics: {
      realized,
      speculative,
      routineOrProtective,
      segmentCount: weightedSegments.length,
      evidenceScope,
    },
  };
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizedScale(scale) {
  return Array.isArray(scale) && scale.length === 5 ? scale : DEFAULT_SCALE;
}

function level(value, factor) {
  const number = Number(value);

  if (!Number.isInteger(number) || number < 0 || number > 4) {
    throw new Error(`${factor} must be an integer from 0 through 4`);
  }

  return number;
}

export function normalizedDreadV130Levels(assessment = {}) {
  const levels = Object.fromEntries(
    DREAD_V130_FACTORS.map((factor) => [
      factor.id,
      level(assessment[factor.id], factor.id),
    ]),
  );

  if (levels.harm === 0) {
    for (const factor of [
      "reach",
      "reversibility",
      "containment",
      "recurrence",
      "vulnerability",
    ]) {
      levels[factor] = 0;
    }
  }

  return levels;
}

function bandFor(score, scale) {
  return (
    scale.find(
      (band) => score >= Number(band.minimum) && score <= Number(band.maximum),
    ) || scale[0]
  );
}

export function calculateDoomIndexV130FromAssessment(
  assessment,
  { severityScale } = {},
) {
  const levels = normalizedDreadV130Levels(assessment);
  const scale = normalizedScale(severityScale);
  const supportIntensity = DREAD_V130_FACTORS.filter(
    (factor) => factor.id !== "harm",
  ).reduce(
    (total, factor) => total + (levels[factor.id] / 4) * factor.weight,
    0,
  );
  const aggravatingFactors = [
    "reach",
    "reversibility",
    "containment",
    "recurrence",
    "vulnerability",
  ].filter((factor) => levels[factor] >= 3).length;
  const direEligible =
    levels.harm >= 3 && levels.certainty >= 3 && aggravatingFactors >= 2;
  const catastrophicEligible =
    levels.harm === 4 &&
    levels.certainty === 4 &&
    levels.reach >= 3 &&
    ["reversibility", "containment", "recurrence", "vulnerability"].filter(
      (factor) => levels[factor] === 4,
    ).length >= 2;
  let effectiveBandLevel = levels.harm;
  const constraints = [];

  if (levels.harm === 0) {
    constraints.push(
      "No material harm anchors the story in Uneasy; contextual risk cannot raise its severity band.",
    );
  }

  if (levels.harm === 3 && !direEligible) {
    effectiveBandLevel = 2;
    constraints.push(
      "Dire requires strongly confirmed severe harm and at least two aggravating conditions.",
    );
  }

  if (levels.harm === 4 && !catastrophicEligible) {
    effectiveBandLevel = direEligible ? 3 : 2;
    constraints.push(
      "Catastrophic requires confirmed exceptional harm, widespread reach, and at least two extreme conditions.",
    );

    if (!direEligible) {
      constraints.push("The compound Dire conditions are also not established.");
    }
  }

  function scoreWithinBand(bandLevel) {
    const band = scale[bandLevel] || scale[0];
    const minimum = Math.ceil(Number(band.minimum));
    const maximum = Math.floor(Number(band.maximum));

    if (bandLevel === 0) {
      return clamp(
        Number((5 + supportIntensity * 5).toFixed(2)),
        minimum,
        maximum,
      );
    }

    const innerMinimum = Math.min(maximum, minimum + 4);
    const innerMaximum = Math.max(innerMinimum, maximum - 4);

    return clamp(
      Number(
        (innerMinimum + supportIntensity * (innerMaximum - innerMinimum)).toFixed(
          2,
        ),
      ),
      minimum,
      maximum,
    );
  }

  const rawScore = scoreWithinBand(levels.harm);
  const value = scoreWithinBand(effectiveBandLevel);
  const band = bandFor(value, scale);

  return {
    value: Number(value.toFixed(2)),
    rawScore: Number(rawScore.toFixed(2)),
    band: String(band.label || "UNCLASSIFIED"),
    requestedBand: String(
      (scale[levels.harm] || scale[0]).label || "UNCLASSIFIED",
    ),
    effectiveBand: String(band.label || "UNCLASSIFIED"),
    supportIntensity: Number(supportIntensity.toFixed(4)),
    direEligible,
    catastrophicEligible,
    constraints,
    factors: levels,
  };
}

export function createDoomIndexV130Fingerprint({
  formulaVersion = DREAD_V130_FORMULA_VERSION,
} = {}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: DREAD_V130_VERSION,
        formulaVersion,
        factors: DREAD_V130_FACTORS,
        direGate: "harm>=3;certainty>=3;two aggravating factors>=3",
        catastrophicGate:
          "harm=4;certainty=4;reach>=3;two extreme factors=4",
        analyzerVersion: DREAD_V130_ANALYZER_VERSION,
        rules: Object.fromEntries(
          Object.entries(FACTOR_RULES).map(([factor, rules]) => [
            factor,
            rules.map((rule) => ({
              level: rule.level,
              patterns: rule.patterns.map(String),
            })),
          ]),
        ),
        contextPatterns: {
          speculative: SPECULATIVE_PATTERNS.map(String),
          realized: REALIZED_PATTERNS.map(String),
          negatedRealized: NEGATED_REALIZED_PATTERNS.map(String),
          routineOrProtective: ROUTINE_OR_PROTECTIVE_PATTERNS.map(String),
        },
        analyzer: analyzeDreadV130Evidence.toString(),
      }),
    )
    .digest("hex")
    .slice(0, 20);
}

export function createDoomIndexV130InputFingerprint({
  title,
  summary,
  bodyFingerprint,
  source,
  formulaVersion = DREAD_V130_FORMULA_VERSION,
  analyzerVersion = DREAD_V130_ANALYZER_VERSION,
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: String(title || "").trim(),
        summary: String(summary || "").trim(),
        bodyFingerprint: String(bodyFingerprint || ""),
        source: String(source || "").trim(),
        formulaVersion,
        analyzerVersion,
      }),
    )
    .digest("hex")
    .slice(0, 24);
}
