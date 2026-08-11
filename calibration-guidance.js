(function exposeCalibrationGuidance(global) {
  "use strict";

  const factors = [
    {
      id: "harm",
      label: "What level of harm is established?",
      weight: 0.28,
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
      label: "How certain is the event?",
      weight: 0.16,
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
      label: "How widely does it reach?",
      weight: 0.15,
      options: [
        "No demonstrated victims",
        "An individual or single organization",
        "Multiple people or organizations",
        "Regional, national, or systemic reach",
        "International or global reach",
      ],
    },
    {
      id: "reversibility",
      label: "Is the harm reversible?",
      weight: 0.12,
      options: [
        "No meaningful harm occurred",
        "Easily or quickly reversible",
        "Recoverable with substantial effort",
        "Long-lasting or only partially reversible",
        "Irreversible",
      ],
    },
    {
      id: "containment",
      label: "Is it contained?",
      weight: 0.12,
      options: [
        "Prevented or fully contained",
        "Contained after limited consequences",
        "Partially contained or still developing",
        "Actively escalating",
        "Control has been substantially or completely lost",
      ],
    },
    {
      id: "recurrence",
      label: "Is this isolated or recurring?",
      weight: 0.08,
      options: [
        "No demonstrated incident",
        "A single isolated incident",
        "Multiple related incidents",
        "A repeated or ongoing pattern",
        "Widespread and continuously occurring",
      ],
    },
    {
      id: "vulnerability",
      label: "Are vulnerable people or essential systems affected?",
      weight: 0.09,
      options: [
        "No",
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
    const weightedLevel = factors.reduce(
      (total, factor) => total + selected[factor.id].level * factor.weight,
      0,
    );
    const rawScore = Math.round((weightedLevel / 4) * 100);
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
      selected.reach.level === 4 &&
      ["reversibility", "containment", "vulnerability"].filter(
        (id) => selected[id].level === 4,
      ).length >= 2;

    let ceiling = 100;
    const constraints = [];
    if (selected.harm.level === 0) {
      ceiling = 19;
      constraints.push("No material harm was established.");
    } else if (selected.harm.level === 1) {
      ceiling = 39;
      constraints.push("Established harm remains limited.");
    } else if (selected.harm.level === 2) {
      ceiling = 59;
      constraints.push("Established harm does not meet the severe-harm gate.");
    }
    if (selected.certainty.level < 3 && ceiling > 59) {
      ceiling = 59;
      constraints.push("The event is not strongly confirmed.");
    }
    if (!direEligible && ceiling > 59) {
      ceiling = 59;
      constraints.push("The compound Dire conditions are not established.");
    }
    if (!catastrophicEligible && ceiling > 79) {
      ceiling = 79;
      constraints.push("The compound Catastrophic conditions are not established.");
    }

    const score = clamp(rawScore, 0, ceiling);
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
      rubricVersion: "guided-human-rating-v1",
      rawScore,
      score,
      band: String(band.label || "UNCLASSIFIED"),
      range: { lower, middle, upper },
      direEligible,
      catastrophicEligible,
      constraints,
      selected,
      reasoning,
    };
  }

  global.DAILY_DOOMSAYER_CALIBRATION_GUIDANCE = Object.freeze({
    version: "guided-human-rating-v1",
    factors,
    recommendation,
  });
})(globalThis);
