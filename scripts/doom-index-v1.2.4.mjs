import { createHash } from "node:crypto";
import {
  DOOM_INDEX_V123_AUXILIARY_FACTOR_NAMES,
  DOOM_INDEX_V123_FACTOR_NAMES,
  calculateDoomIndexV123,
  calculateDoomIndexV123FromFactors,
  createDoomIndexV123Fingerprint,
  normalizedDoomIndexV123Weights,
} from "./doom-index-v1.2.3.mjs";

export const DOOM_INDEX_V124_FACTOR_NAMES = [
  ...DOOM_INDEX_V123_FACTOR_NAMES,
];
export const DOOM_INDEX_V124_AUXILIARY_FACTOR_NAMES = [
  ...DOOM_INDEX_V123_AUXILIARY_FACTOR_NAMES,
];

const FORMULA_VERSION = "1.2.4-offline.1";
const PARENT_FORMULA_VERSION = "1.2.3-shadow.1";

const PROPOSED_POLICY_PATTERNS = [
  /\b(?:bill|legislation|proposal|proposed law|senate vote|committee vote)\b/i,
  /\b(?:would|could|may|might) (?:require|force|create|expand|restrict|allow)\b/i,
  /\b(?:should reject|should pass|tell congress|if passed|still needs approval)\b/i,
];

const ACTIVE_POLICY_CONSEQUENCE_PATTERNS = [
  /\b(?:signed into law|became law|takes? effect|in force|now enforced)\b/i,
  /\b(?:implemented|already requires|required by law|court (?:ruled|ordered|blocked))\b/i,
];

const PROPOSED_POLICY_CONCERN_PATTERNS = [
  /\b(?:privacy|surveillance|monitoring|age verification|age[- ]gat(?:e|ing))\b/i,
  /\b(?:data collection|collect personal|restrict lawful speech|censorship|security risks?)\b/i,
];

const AUTONOMOUS_AI_INCIDENT_PATTERNS = [
  /\b(?:ai|model|models|agent|agents)\b.*\b(?:fake (?:online )?(?:identities|profiles)|malware|rogue attack|hacking spree)\b/i,
  /\b(?:ai|model|models|agent|agents)\b.*\b(?:deceiv(?:e|ed|ing)|trick(?:ed|ing)?|sabotage(?:d)?|hid the evidence)\b/i,
  /\b(?:unprompted actions?|unsanctioned actions?|acted autonomously|went rogue|ran amok)\b/i,
  /\b(?:using a message board to plan|psychologically manipulate)\b.*\b(?:hack|attack|malware|access)\b/i,
];

const CONFIRMED_EXTERNAL_AI_HACK_PATTERNS = [
  /\b(?:ai|model|agent)\b.*\bhacked?\b.*\b(?:company|companies|organization|project|system)\b/i,
  /\b(?:ai agent breach|disclos(?:e|ed|ure) an ai breach)\b/i,
  /\bhacked several other companies\b/i,
];

const HUMAN_ASSISTED_CYBER_PATTERNS = [
  /\b(?:ai(?:'s)? hacking abilities|ai hacking techniques?|ai-powered hacking)\b/i,
  /\b(?:combined with human expertise|humans? in the loop)\b.*\b(?:hack|cyber|attack)\b/i,
  /\bsecurity researcher\b.*\b(?:hacking|attack vectors?|exploit)\b/i,
];

const CONTAINMENT_ESCAPE_PATTERNS = [
  /\b(?:escaped containment|wandered off to the internet|left the test environment)\b/i,
  /\b(?:cheat(?:ed|ing)? on (?:a )?test|bypass(?:ed)? (?:a )?test)\b/i,
];

const MASS_SURVEILLANCE_PATTERNS = [
  /\b(?:drone-as-first-responder|dfr programs?)\b/i,
  /\b(?:police|law enforcement|public safety agencies?)\b.*\b(?:surveillance|drones?|facial recognition|license plate)\b/i,
  /\b(?:workplace surveillance|employee monitoring|monitor employees?)\b/i,
];

const SENSITIVE_PRIVACY_PATTERNS = [
  /\b(?:medical|mental health|healthcare|patient|patients)\b.*\b(?:privacy|record(?:ed|ing)?|conversations?|confidential)\b/i,
  /\bprivacy (?:attacks?|risks?|violation)\b.*\b(?:medical|health|patient|training data)\b/i,
];

const DECEPTION_OR_SCAM_PATTERNS = [
  /\b(?:impersonator|recruiter scam|application scams?|job scams?)\b/i,
  /\b(?:fake authenticity|fake personas?|deceptive marketing|ai slop)\b.*\b(?:sell|market|shop|scam|impersonat)\b/i,
];

const DANGEROUS_PRODUCT_PATTERNS = [
  /\b(?:supplements?|products?)\b.*\b(?:recalled by (?:the )?fda|fda recall|unsafe|harmful)\b/i,
  /\b(?:recalled by (?:the )?fda|fda recall)\b.*\b(?:supplements?|products?)\b/i,
];

const INSTITUTIONAL_SERVICE_FAILURE_PATTERNS = [
  /\b(?:faulty|outdated|inaccurate|malfunctioning)\b.*\b(?:chatbot|ai system|algorithm)\b/i,
  /\b(?:technology|ai|algorithm)\b.*\b(?:patient care|student services?|public benefits?)\b.*\b(?:worse|failed|denied|unsafe)\b/i,
];

const WORKFORCE_HARM_PATTERNS = [
  /\b(?:human cost|job loss|lost jobs|replacing workers|workers? replaced|automation-driven job losses?)\b/i,
  /\b(?:jobs?|workers?|employees?)\b.*\b(?:replaced|displaced|surveillance|micromanag(?:e|ed|ing))\b/i,
];

const CONFIRMED_LEGAL_OUTCOME_PATTERNS = [
  /\b(?:court|judge|jury|regulator)\s+orders?\b.*\b(?:pay|fine|penalty|damages)\b/i,
  /\b(?:fined|ordered to pay|awarded damages|settlement)\b.*\b(?:\$|million|billion)\b/i,
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

function raise(factors, minimums) {
  for (const [name, minimum] of Object.entries(minimums)) {
    factors[name] = Math.max(Number(factors[name]) || 0, minimum);
  }
}

function cap(factors, maximums) {
  for (const [name, maximum] of Object.entries(maximums)) {
    factors[name] = Math.min(Number(factors[name]) || 0, maximum);
  }
}

function reasonsFor(factors, actuality, score, adjustments) {
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
  const reasons = DOOM_INDEX_V124_FACTOR_NAMES
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
  if (score.value >= 80) reasons.push("catastrophic threshold criteria met");
  else if (score.value >= 60) reasons.push("dire threshold criteria met");

  return [...new Set([...reasons, ...adjustments])];
}

export function normalizedDoomIndexV124Weights(configuredWeights = {}) {
  return normalizedDoomIndexV123Weights(configuredWeights);
}

export function calculateDoomIndexV124FromFactors(
  factors,
  configuredWeights = {},
) {
  return calculateDoomIndexV123FromFactors(factors, configuredWeights);
}

export function calculateDoomIndexV124({
  title,
  summary = "",
  coverageSources = 1,
  weights = {},
} = {}) {
  const baseline = calculateDoomIndexV123({
    title,
    summary,
    coverageSources,
    weights,
  });
  const text = `${normalize(title)}. ${normalize(summary)}`.trim();
  const factors = { ...baseline.factors };
  const adjustments = [];
  let actuality = baseline.actuality;

  const proposedPolicy =
    matchesAny(text, PROPOSED_POLICY_PATTERNS) &&
    !matchesAny(text, ACTIVE_POLICY_CONSEQUENCE_PATTERNS);
  const proposedPolicyConcern = matchesAny(
    text,
    PROPOSED_POLICY_CONCERN_PATTERNS,
  );
  const autonomousIncident = matchesAny(
    text,
    AUTONOMOUS_AI_INCIDENT_PATTERNS,
  );
  const externalAiHack = matchesAny(
    text,
    CONFIRMED_EXTERNAL_AI_HACK_PATTERNS,
  );
  const humanAssistedCyber = matchesAny(
    text,
    HUMAN_ASSISTED_CYBER_PATTERNS,
  );
  const containmentEscape = matchesAny(text, CONTAINMENT_ESCAPE_PATTERNS);
  const massSurveillance = matchesAny(text, MASS_SURVEILLANCE_PATTERNS);
  const sensitivePrivacy = matchesAny(text, SENSITIVE_PRIVACY_PATTERNS);
  const deceptionOrScam = matchesAny(text, DECEPTION_OR_SCAM_PATTERNS);
  const dangerousProduct = matchesAny(text, DANGEROUS_PRODUCT_PATTERNS);
  const institutionalFailure = matchesAny(
    text,
    INSTITUTIONAL_SERVICE_FAILURE_PATTERNS,
  );
  const workforceHarm = matchesAny(text, WORKFORCE_HARM_PATTERNS);
  const confirmedLegalOutcome = matchesAny(
    text,
    CONFIRMED_LEGAL_OUTCOME_PATTERNS,
  );

  if (autonomousIncident) {
    raise(factors, {
      realizedHarm: 0.6,
      lossOfControl: 0.85,
      irreversibility: 0.4,
      immediacy: 0.5,
      systemicReach: 0.5,
      credibleThreat: 0.8,
      evidence: 0.7,
      actuality: 0.85,
    });
    factors.protectiveContext = 0;
    actuality = "confirmed-or-observed";
    adjustments.push("autonomous malicious-behavior escalation");
  }

  if (externalAiHack) {
    raise(factors, {
      realizedHarm: 0.6,
      scale: 0.4,
      lossOfControl: 0.7,
      immediacy: 0.4,
      systemicReach: 0.5,
      credibleThreat: 0.65,
      evidence: 0.6,
      actuality: 0.75,
    });
    factors.protectiveContext = 0;
    actuality = "reported-or-confirmed";
    adjustments.push("external AI cyber-incident recognition");
  }

  if (humanAssistedCyber && !autonomousIncident) {
    raise(factors, {
      realizedHarm: 0.4,
      lossOfControl: 0.55,
      systemicReach: 0.5,
      credibleThreat: 0.8,
      evidence: 0.65,
      actuality: 0.65,
      contextualConcern: 0.4,
    });
    factors.protectiveContext = Math.min(factors.protectiveContext, 0.25);
    actuality = "demonstrated-capability";
    adjustments.push("demonstrated human-assisted cyber capability");
  }

  if (containmentEscape && !autonomousIncident && !externalAiHack) {
    raise(factors, {
      lossOfControl: 0.5,
      credibleThreat: 0.5,
      evidence: 0.55,
      actuality: 0.55,
      contextualConcern: 0.35,
    });
    actuality = "observed-testing";
    adjustments.push("contained autonomy failure recognition");
  }

  if (massSurveillance) {
    raise(factors, {
      realizedHarm: 0.45,
      scale: 0.75,
      vulnerability: 0.4,
      lossOfControl: 0.45,
      systemicReach: 0.75,
      credibleThreat: 0.65,
      evidence: 0.65,
      actuality: 0.65,
      immediacy: 0.5,
      contextualConcern: 0.5,
    });
    factors.protectiveContext = Math.min(factors.protectiveContext, 0.2);
    factors.routinePenalty = Math.min(factors.routinePenalty, 0.15);
    actuality = "deployed-or-imminent";
    adjustments.push("institutional surveillance deployment recognition");
  }

  if (sensitivePrivacy) {
    raise(factors, {
      realizedHarm: 0.35,
      vulnerability: 0.5,
      lossOfControl: 0.4,
      irreversibility: 0.35,
      systemicReach: 0.5,
      credibleThreat: 0.55,
      evidence: 0.5,
      actuality: 0.6,
      contextualConcern: 0.5,
    });
    factors.protectiveContext = Math.min(factors.protectiveContext, 0.25);
    if (!["confirmed-or-observed", "reported-or-confirmed"].includes(actuality)) {
      actuality = "reported-practice";
    }
    adjustments.push("sensitive-data privacy recognition");
  }

  if (deceptionOrScam) {
    raise(factors, {
      realizedHarm: 0.5,
      vulnerability: 0.5,
      lossOfControl: 0.5,
      irreversibility: 0.35,
      credibleThreat: 0.6,
      evidence: 0.55,
      actuality: 0.65,
      contextualConcern: 0.45,
    });
    factors.protectiveContext = 0;
    actuality = "reported-harm";
    adjustments.push("deception or scam harm recognition");
  }

  if (dangerousProduct) {
    raise(factors, {
      realizedHarm: 0.75,
      scale: 0.5,
      vulnerability: 0.6,
      irreversibility: 0.4,
      immediacy: 0.65,
      systemicReach: 0.5,
      credibleThreat: 0.75,
      evidence: 0.75,
      actuality: 1,
    });
    factors.protectiveContext = 0;
    actuality = "confirmed";
    adjustments.push("confirmed dangerous-product escalation");
  }

  if (institutionalFailure) {
    raise(factors, {
      realizedHarm: 0.35,
      vulnerability: 0.5,
      systemicReach: 0.6,
      credibleThreat: 0.45,
      evidence: 0.55,
      actuality: 0.65,
      contextualConcern: 0.45,
    });
    factors.protectiveContext = Math.min(factors.protectiveContext, 0.25);
    actuality = "reported-failure";
    adjustments.push("institutional service failure recognition");
  }

  if (workforceHarm && !massSurveillance) {
    raise(factors, {
      realizedHarm: 0.3,
      scale: 0.45,
      systemicReach: 0.45,
      credibleThreat: 0.45,
      evidence: 0.45,
      actuality: 0.45,
      contextualConcern: 0.5,
    });
    factors.protectiveContext = Math.min(factors.protectiveContext, 0.25);
    actuality = "reported-trend";
    adjustments.push("workforce displacement recognition");
  }

  if (confirmedLegalOutcome) {
    raise(factors, {
      realizedHarm: 0.2,
      systemicReach: 0.5,
      evidence: 0.75,
      actuality: 1,
      contextualConcern: 0.3,
    });
    factors.protectiveContext = Math.min(factors.protectiveContext, 0.25);
    actuality = "confirmed-legal-consequence";
    adjustments.push("confirmed legal consequence recognition");
  }

  if (proposedPolicy) {
    cap(factors, {
      realizedHarm: 0.35,
      lossOfControl: 0.4,
      irreversibility: 0.35,
      immediacy: 0.35,
      evidence: 0.55,
      actuality: 0.35,
      protectiveContext: 0.25,
    });
    raise(factors, {
      systemicReach: 0.5,
      credibleThreat: 0.45,
      contextualConcern: 0.4,
    });
    if (proposedPolicyConcern) {
      raise(factors, {
        realizedHarm: 0.15,
        lossOfControl: 0.2,
        evidence: 0.4,
        contextualConcern: 0.5,
      });
      adjustments.push("documented policy-risk recognition");
    }
    actuality = "proposed";
    adjustments.push("unrealized policy proposal constraint");
  }

  const score = calculateDoomIndexV124FromFactors(factors, weights);

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
    reasons: reasonsFor(factors, actuality, score, adjustments),
  };
}

export function createDoomIndexV124InputFingerprint({
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

export function createDoomIndexV124Fingerprint({
  formulaVersion = FORMULA_VERSION,
  weights = {},
} = {}) {
  const definition = {
    formulaVersion,
    parentFingerprint: createDoomIndexV123Fingerprint({
      formulaVersion: PARENT_FORMULA_VERSION,
      weights,
    }),
    weights: normalizedDoomIndexV124Weights(weights),
    patterns: {
      proposedPolicy: PROPOSED_POLICY_PATTERNS.map(String),
      activePolicyConsequence: ACTIVE_POLICY_CONSEQUENCE_PATTERNS.map(String),
      proposedPolicyConcern: PROPOSED_POLICY_CONCERN_PATTERNS.map(String),
      autonomousAiIncident: AUTONOMOUS_AI_INCIDENT_PATTERNS.map(String),
      confirmedExternalAiHack: CONFIRMED_EXTERNAL_AI_HACK_PATTERNS.map(String),
      humanAssistedCyber: HUMAN_ASSISTED_CYBER_PATTERNS.map(String),
      containmentEscape: CONTAINMENT_ESCAPE_PATTERNS.map(String),
      massSurveillance: MASS_SURVEILLANCE_PATTERNS.map(String),
      sensitivePrivacy: SENSITIVE_PRIVACY_PATTERNS.map(String),
      deceptionOrScam: DECEPTION_OR_SCAM_PATTERNS.map(String),
      dangerousProduct: DANGEROUS_PRODUCT_PATTERNS.map(String),
      institutionalServiceFailure: INSTITUTIONAL_SERVICE_FAILURE_PATTERNS.map(String),
      workforceHarm: WORKFORCE_HARM_PATTERNS.map(String),
      confirmedLegalOutcome: CONFIRMED_LEGAL_OUTCOME_PATTERNS.map(String),
    },
    implementations: [
      normalize,
      matchesAny,
      raise,
      cap,
      reasonsFor,
      calculateDoomIndexV124FromFactors,
      calculateDoomIndexV124,
    ].map(String),
  };

  return createHash("sha256")
    .update(JSON.stringify(definition))
    .digest("hex")
    .slice(0, 20);
}
