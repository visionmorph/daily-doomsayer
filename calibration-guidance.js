(function exposeCalibrationGuidance(global) {
  "use strict";

  const factors = [
    {
      id: "harm",
      label: "What level of harm is established?",
      weight: 0,
      options: [
        "No material harm is established",
        "Credible concern or limited harm",
        "Meaningful harm or disruption",
        "Severe harm that is difficult to contain",
        "Exceptional mass harm or systemic failure",
      ],
    },
    {
      id: "certainty",
      label: "How certain are the harmful consequences?",
      weight: 0.2,
      options: [
        "Hypothetical, predicted, or speculative",
        "Proposed, alleged, or incompletely documented",
        "Credibly reported but still developing",
        "Confirmed by strong evidence",
        "Confirmed with measurable consequences",
      ],
    },
    {
      id: "reach",
      label: "How widely do the demonstrated harmful consequences reach?",
      weight: 0.18,
      options: [
        "Not applicable — no demonstrated harmful consequences",
        "An individual or single organization",
        "Multiple people or organizations",
        "Regional, national, or systemic reach",
        "International or global reach",
      ],
    },
    {
      id: "reversibility",
      label: "Is the harm reversible?",
      weight: 0.15,
      options: [
        "Not applicable — no material harm is established",
        "Easily or quickly reversible",
        "Recoverable with substantial effort",
        "Long-lasting or only partially reversible",
        "Irreversible",
      ],
    },
    {
      id: "containment",
      label: "What is the current state of control?",
      weight: 0.18,
      options: [
        "Not applicable — no harmful incident or active threat is established",
        "Prevented or fully contained after limited consequences",
        "Partially contained or still developing",
        "Actively escalating",
        "Control has been substantially or completely lost",
      ],
    },
    {
      id: "recurrence",
      label: "Is this isolated or recurring?",
      weight: 0.12,
      options: [
        "Not applicable — no harmful incident is established",
        "A single isolated incident",
        "Multiple related incidents",
        "A repeated or ongoing pattern",
        "Widespread and continuously occurring",
      ],
    },
    {
      id: "vulnerability",
      label: "Are vulnerable people or essential systems affected?",
      weight: 0.17,
      options: [
        "Not applicable — no demonstrated effect",
        "Possibly",
        "Yes, with limited consequences",
        "Yes, with serious consequences",
        "Essential systems or large vulnerable populations are affected",
      ],
    },
  ];

  const fallbackScale = [
    { minimum: 0, maximum: 19.99, label: "UNEASY" },
    { minimum: 20, maximum: 39.99, label: "OMINOUS" },
    { minimum: 40, maximum: 59.99, label: "ALARMING" },
    { minimum: 60, maximum: 79.99, label: "DIRE" },
    { minimum: 80, maximum: 100, label: "CATASTROPHIC" },
  ];

  function normalizedScale(severityScale) {
    return Array.isArray(severityScale) && severityScale.length
      ? severityScale
      : fallbackScale;
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function completeLevels(levels) {
    return factors.every((factor) => {
      const supplied = levels?.[factor.id];
      if (supplied === "" || supplied === null || supplied === undefined) {
        return false;
      }
      const level = Number(supplied);
      return Number.isInteger(level) && level >= 0 && level <= 4;
    });
  }

  function bandFor(score, severityScale) {
    const scale = normalizedScale(severityScale);
    return (
      scale.find(
        (band) =>
          score >= Number(band.minimum) && score <= Number(band.maximum),
      ) || scale[0]
    );
  }

  function selectedOption(factor, level) {
    return {
      level,
      label: factor.options[level],
    };
  }

  function recommendation(levels, severityScale) {
    if (!completeLevels(levels)) return null;

    const selected = Object.fromEntries(
      factors.map((factor) => [
        factor.id,
        selectedOption(factor, Number(levels[factor.id])),
      ]),
    );
    const supportFactors = factors.filter((factor) => factor.id !== "harm");
    const supportIntensity = supportFactors.reduce(
      (total, factor) =>
        total + (selected[factor.id].level / 4) * factor.weight,
      0,
    );
    const aggravatingFactors = [
      "reach",
      "reversibility",
      "containment",
      "recurrence",
      "vulnerability",
    ].filter((id) => selected[id].level >= 3).length;
    const direEligible =
      selected.harm.level >= 3 &&
      selected.certainty.level >= 3 &&
      aggravatingFactors >= 2;
    const catastrophicEligible =
      selected.harm.level === 4 &&
      selected.certainty.level === 4 &&
      selected.reach.level >= 3 &&
      ["reversibility", "containment", "recurrence", "vulnerability"].filter(
        (id) => selected[id].level === 4,
      ).length >= 2;
    const scale = normalizedScale(severityScale);
    const requestedBandLevel = selected.harm.level;
    let effectiveBandLevel = requestedBandLevel;
    const constraints = [];
    if (requestedBandLevel === 0) {
      constraints.push(
        "No material harm anchors the recommendation in Uneasy; incident factors cannot move it into a higher band.",
      );
    }
    if (requestedBandLevel === 3 && !direEligible) {
      effectiveBandLevel = 2;
      constraints.push(
        "The compound Dire gate requires strongly confirmed severe harm and at least two aggravating conditions.",
      );
    }
    if (requestedBandLevel === 4 && !catastrophicEligible) {
      effectiveBandLevel = direEligible ? 3 : 2;
      constraints.push(
        "The compound Catastrophic gate requires confirmed exceptional harm, widespread or systemic reach, and at least two extreme conditions.",
      );
      if (!direEligible) {
        constraints.push(
          "The compound Dire conditions are also not established.",
        );
      }
    }

    function scoreWithinBand(level) {
      const band = scale[level] || scale[0];
      const minimum = Math.ceil(Number(band.minimum));
      const maximum = Math.floor(Number(band.maximum));
      if (level === 0) {
        return clamp(5 + Math.round(supportIntensity * 5), minimum, maximum);
      }
      const innerMinimum = Math.min(maximum, minimum + 4);
      const innerMaximum = Math.max(innerMinimum, maximum - 4);
      return clamp(
        Math.round(
          innerMinimum + supportIntensity * (innerMaximum - innerMinimum),
        ),
        minimum,
        maximum,
      );
    }

    const rawScore = scoreWithinBand(requestedBandLevel);
    const score = scoreWithinBand(effectiveBandLevel);
    const band = bandFor(score, severityScale);
    const bandMinimum = Math.ceil(Number(band.minimum));
    const bandMaximum = Math.floor(Number(band.maximum));
    const lower = clamp(score - 3, bandMinimum, bandMaximum);
    const upper = clamp(score + 3, bandMinimum, bandMaximum);
    const middle = Math.round((lower + upper) / 2);
    const reasoning = [
      `${selected.harm.label}.`,
      `Evidence: ${selected.certainty.label.toLowerCase()}.`,
      `Reach: ${selected.reach.label.toLowerCase()}.`,
      `Reversibility: ${selected.reversibility.label.toLowerCase()}.`,
      `Containment: ${selected.containment.label.toLowerCase()}.`,
      `Pattern: ${selected.recurrence.label.toLowerCase()}.`,
      `Vulnerability: ${selected.vulnerability.label.toLowerCase()}.`,
    ].join(" ");

    return {
      rubricVersion: "guided-human-rating-v1.1",
      rawScore,
      score,
      band: String(band.label || "UNCLASSIFIED"),
      requestedBand: String(
        (scale[requestedBandLevel] || scale[0]).label || "UNCLASSIFIED",
      ),
      effectiveBand: String(band.label || "UNCLASSIFIED"),
      supportIntensity: Number(supportIntensity.toFixed(4)),
      range: { lower, middle, upper },
      direEligible,
      catastrophicEligible,
      constraints,
      selected,
      reasoning,
    };
  }

  global.DAILY_DOOMSAYER_CALIBRATION_GUIDANCE = Object.freeze({
    version: "guided-human-rating-v1.1",
    factors,
    recommendation,
  });
})(globalThis);
