import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_BENCHMARK_FILE = path.join(
  PROJECT_DIRECTORY,
  "data",
  "human-calibration",
  "calibration-benchmark.v1.json",
);
const DEFAULT_BASELINE_FILE = path.join(
  PROJECT_DIRECTORY,
  "data",
  "human-calibration",
  "cohorts",
  "dread-1.2.4-live-baseline.json",
);

const DEFAULT_OPTIONS = Object.freeze({
  publicVersion: "1.2.2",
  publicFormulaVersion: "1.2.2-shadow.1",
  experimentalVersion: "1.2.4",
  experimentalFormulaVersion: "1.2.4-offline.1",
  humanRubricVersion: "guided-human-rating-v1.1",
  minimumLiveRecords: 50,
  recommendedHighConfidenceRecords: 30,
  recommendedSources: 10,
  bootstrapSamples: 10_000,
  bootstrapSeed: 1_204,
  limit: 10,
});

function numericScore(value) {
  if (value === null || value === undefined || value === "") return null;
  const score = Number(
    typeof value === "object" ? value.value ?? value.score : value,
  );
  return Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : null;
}

function mean(values) {
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null;
}

function round(value, places = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(places)) : null;
}

function severityBand(score, severityScale) {
  return severityScale.findIndex(
    (band) =>
      score >= Number(band.minimum) && score <= Number(band.maximum),
  );
}

function severityLabel(score, severityScale) {
  const index = severityBand(score, severityScale);
  return index >= 0 ? severityScale[index].label : "UNCLASSIFIED";
}

function modelMatches(record, key, version, formulaVersion) {
  const model = record.models?.[key];
  return (
    model &&
    String(model.version || "") === String(version) &&
    String(model.formulaVersion || "") === String(formulaVersion) &&
    numericScore(model.score) !== null
  );
}

function modelScore(record, key) {
  return numericScore(record.models?.[key]?.score);
}

function humanScore(record, target = "articleRating") {
  return numericScore(record[target]?.score);
}

function metrics(records, key, target, severityScale) {
  const pairs = records
    .map((record) => ({
      model: modelScore(record, key),
      human: humanScore(record, target),
    }))
    .filter(({ model, human }) => model !== null && human !== null);

  if (!pairs.length) {
    return {
      records: 0,
      meanAbsoluteError: null,
      bias: null,
      severityBandMatchPercent: null,
      within20PointsPercent: null,
    };
  }

  const errors = pairs.map(({ model, human }) => model - human);
  const absoluteErrors = errors.map(Math.abs);
  return {
    records: pairs.length,
    meanAbsoluteError: round(mean(absoluteErrors)),
    bias: round(mean(errors)),
    severityBandMatchPercent: round(
      (100 *
        pairs.filter(
          ({ model, human }) =>
            severityBand(model, severityScale) ===
            severityBand(human, severityScale),
        ).length) /
        pairs.length,
      1,
    ),
    within20PointsPercent: round(
      (100 * absoluteErrors.filter((error) => error <= 20).length) /
        pairs.length,
      1,
    ),
  };
}

function riskCounts(records, key, severityScale) {
  const pairs = records.map((record) => ({
    human: humanScore(record),
    model: modelScore(record, key),
  }));
  const severe = pairs.filter(({ human }) => human >= 60);
  const belowAlarming = pairs.filter(({ human }) => human < 40);
  const belowCatastrophic = pairs.filter(({ human }) => human < 80);

  return {
    severeHumanRecords: severe.length,
    belowAlarmingHumanRecords: belowAlarming.length,
    belowCatastrophicHumanRecords: belowCatastrophic.length,
    severeUnderCalls: severe.filter(({ model }) => model < 40).length,
    twoBandUnderCalls: pairs.filter(
      ({ human, model }) =>
        severityBand(human, severityScale) -
          severityBand(model, severityScale) >=
        2,
    ).length,
    extremeFalsePositives: belowAlarming.filter(({ model }) => model >= 60)
      .length,
    catastrophicFalsePositives: belowCatastrophic.filter(
      ({ model }) => model >= 80,
    ).length,
    largeMisses: pairs.filter(
      ({ human, model }) => Math.abs(model - human) >= 30,
    ).length,
  };
}

function seededRandom(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function percentile(sortedValues, probability) {
  if (!sortedValues.length) return null;
  const position = (sortedValues.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const weight = position - lowerIndex;
  return (
    sortedValues[lowerIndex] * (1 - weight) +
    sortedValues[upperIndex] * weight
  );
}

function pairedComparison(records, options) {
  const differences = records.map((record) => {
    const human = humanScore(record);
    const publicError = Math.abs(modelScore(record, "public") - human);
    const experimentalError = Math.abs(modelScore(record, "shadow") - human);
    return publicError - experimentalError;
  });

  if (!differences.length) {
    return {
      records: 0,
      experimentalWins: 0,
      ties: 0,
      publicWins: 0,
      meanAbsoluteErrorImprovement: null,
      confidenceInterval95: {
        lower: null,
        upper: null,
        samples: options.bootstrapSamples,
        method: "paired percentile bootstrap",
      },
    };
  }

  const random = seededRandom(options.bootstrapSeed);
  const estimates = [];
  for (let sample = 0; sample < options.bootstrapSamples; sample += 1) {
    let total = 0;
    for (let index = 0; index < differences.length; index += 1) {
      total += differences[Math.floor(random() * differences.length)];
    }
    estimates.push(total / differences.length);
  }
  estimates.sort((left, right) => left - right);

  return {
    records: differences.length,
    experimentalWins: differences.filter((value) => value > 0).length,
    ties: differences.filter((value) => value === 0).length,
    publicWins: differences.filter((value) => value < 0).length,
    meanAbsoluteErrorImprovement: round(mean(differences)),
    confidenceInterval95: {
      lower: round(percentile(estimates, 0.025)),
      upper: round(percentile(estimates, 0.975)),
      samples: options.bootstrapSamples,
      method: "paired percentile bootstrap",
    },
  };
}

function distribution(records, severityScale) {
  return Object.fromEntries(
    severityScale.map((band) => [
      band.label,
      records.filter(
        (record) => humanScore(record) !== null &&
          severityLabel(humanScore(record), severityScale) === band.label,
      ).length,
    ]),
  );
}

function perBand(records, severityScale) {
  return severityScale.map((band) => {
    const bandRecords = records.filter(
      (record) => severityLabel(humanScore(record), severityScale) === band.label,
    );
    const publicMetrics = metrics(
      bandRecords,
      "public",
      "articleRating",
      severityScale,
    );
    const experimentalMetrics = metrics(
      bandRecords,
      "shadow",
      "articleRating",
      severityScale,
    );
    return {
      label: band.label,
      records: bandRecords.length,
      publicMeanAbsoluteError: publicMetrics.meanAbsoluteError,
      experimentalMeanAbsoluteError: experimentalMetrics.meanAbsoluteError,
      improvement:
        Number.isFinite(publicMetrics.meanAbsoluteError) &&
        Number.isFinite(experimentalMetrics.meanAbsoluteError)
          ? round(
              publicMetrics.meanAbsoluteError -
                experimentalMetrics.meanAbsoluteError,
            )
          : null,
    };
  });
}

function largestMisses(records, severityScale, limit) {
  return records
    .map((record) => {
      const human = humanScore(record);
      const experimental = modelScore(record, "shadow");
      return {
        title: record.article?.title || "Untitled",
        source: record.article?.source || "",
        human,
        experimental,
        error: round(experimental - human),
        humanBand: severityLabel(human, severityScale),
        experimentalBand: severityLabel(experimental, severityScale),
      };
    })
    .sort((left, right) => Math.abs(right.error) - Math.abs(left.error))
    .slice(0, limit);
}

function gate(id, label, status, experimental, publicBaseline) {
  return { id, label, status, experimental, publicBaseline };
}

function comparisonStatus(experimental, publicBaseline, compare) {
  if (!Number.isFinite(experimental) || !Number.isFinite(publicBaseline)) {
    return "not-enough-data";
  }
  return compare(experimental, publicBaseline) ? "pass" : "fail";
}

function promotionGates(evaluation, options) {
  const { metrics: modelMetrics, risks, paired, coverage } = evaluation;
  const publicArticle = modelMetrics.public.article;
  const experimentalArticle = modelMetrics.experimental.article;
  const publicHigh = modelMetrics.public.highConfidence;
  const experimentalHigh = modelMetrics.experimental.highConfidence;
  const publicRisk = risks.public;
  const experimentalRisk = risks.experimental;
  const interval = paired.confidenceInterval95;
  const confidenceStatus =
    !Number.isFinite(interval.lower) || !Number.isFinite(interval.upper)
      ? "not-enough-data"
      : interval.lower > 0
        ? "pass"
        : interval.upper < 0
          ? "fail"
          : "inconclusive";

  return [
    gate(
      "minimum-live-records",
      `At least ${options.minimumLiveRecords} eligible live stories`,
      coverage.eligibleRecords >= options.minimumLiveRecords ? "pass" : "fail",
      coverage.eligibleRecords,
      options.minimumLiveRecords,
    ),
    gate(
      "article-mae",
      "Experimental article error is lower than Public 1.2.2",
      comparisonStatus(
        experimentalArticle.meanAbsoluteError,
        publicArticle.meanAbsoluteError,
        (experimental, publicValue) => experimental < publicValue,
      ),
      experimentalArticle.meanAbsoluteError,
      publicArticle.meanAbsoluteError,
    ),
    gate(
      "paired-confidence",
      "The paired 95% confidence interval is entirely above zero",
      confidenceStatus,
      interval.lower,
      0,
    ),
    gate(
      "article-band-match",
      "Experimental band match is not lower than Public 1.2.2",
      comparisonStatus(
        experimentalArticle.severityBandMatchPercent,
        publicArticle.severityBandMatchPercent,
        (experimental, publicValue) => experimental >= publicValue,
      ),
      experimentalArticle.severityBandMatchPercent,
      publicArticle.severityBandMatchPercent,
    ),
    gate(
      "high-confidence-mae",
      "Experimental high-confidence error is not higher than Public 1.2.2",
      comparisonStatus(
        experimentalHigh.meanAbsoluteError,
        publicHigh.meanAbsoluteError,
        (experimental, publicValue) => experimental <= publicValue,
      ),
      experimentalHigh.meanAbsoluteError,
      publicHigh.meanAbsoluteError,
    ),
    gate(
      "two-band-undercalls",
      "Experimental does not increase two-band under-calls",
      comparisonStatus(
        experimentalRisk.twoBandUnderCalls,
        publicRisk.twoBandUnderCalls,
        (experimental, publicValue) => experimental <= publicValue,
      ),
      experimentalRisk.twoBandUnderCalls,
      publicRisk.twoBandUnderCalls,
    ),
    gate(
      "severe-undercalls",
      "Experimental does not increase severe under-calls",
      experimentalRisk.severeHumanRecords === 0
        ? "not-enough-data"
        : experimentalRisk.severeUnderCalls <= publicRisk.severeUnderCalls
          ? "pass"
          : "fail",
      experimentalRisk.severeUnderCalls,
      publicRisk.severeUnderCalls,
    ),
    gate(
      "extreme-false-positives",
      "Experimental does not increase extreme false positives",
      experimentalRisk.belowAlarmingHumanRecords === 0
        ? "not-enough-data"
        : experimentalRisk.extremeFalsePositives <=
            publicRisk.extremeFalsePositives
          ? "pass"
          : "fail",
      experimentalRisk.extremeFalsePositives,
      publicRisk.extremeFalsePositives,
    ),
    gate(
      "catastrophic-false-positives",
      "Experimental produces no catastrophic false positives",
      experimentalRisk.belowCatastrophicHumanRecords === 0
        ? "not-enough-data"
        : experimentalRisk.catastrophicFalsePositives === 0
          ? "pass"
          : "fail",
      experimentalRisk.catastrophicFalsePositives,
      publicRisk.catastrophicFalsePositives,
    ),
    gate(
      "large-misses",
      "Experimental does not increase misses of 30 points or more",
      comparisonStatus(
        experimentalRisk.largeMisses,
        publicRisk.largeMisses,
        (experimental, publicValue) => experimental <= publicValue,
      ),
      experimentalRisk.largeMisses,
      publicRisk.largeMisses,
    ),
  ];
}

export function evaluateDreadExperiment(
  benchmark,
  baseline,
  suppliedOptions = {},
) {
  const options = { ...DEFAULT_OPTIONS, ...suppliedOptions };
  if (!Array.isArray(benchmark.records) || !Array.isArray(benchmark.severityScale)) {
    throw new Error("The benchmark is missing records or severityScale.");
  }
  if (!Array.isArray(baseline.benchmarkIds)) {
    throw new Error("The live baseline is missing benchmarkIds.");
  }

  const severityScale = benchmark.severityScale;
  const baselineIds = new Set(baseline.benchmarkIds.map(String));
  const ratedRecords = benchmark.records.filter((record) => record.status === "rated");
  const currentIds = new Set(ratedRecords.map((record) => String(record.benchmarkId)));
  const matchedBaselineRecords = ratedRecords.filter((record) =>
    baselineIds.has(String(record.benchmarkId)),
  );
  const liveRecords = ratedRecords.filter(
    (record) => !baselineIds.has(String(record.benchmarkId)),
  );
  const excluded = {
    missingHumanArticleRating: 0,
    humanRubricVersionMismatch: 0,
    publicVersionMismatch: 0,
    experimentalVersionMismatch: 0,
  };
  const eligibleRecords = liveRecords.filter((record) => {
    if (humanScore(record) === null) {
      excluded.missingHumanArticleRating += 1;
      return false;
    }
    if (
      String(record.articleRating?.assessment?.rubricVersion || "") !==
      options.humanRubricVersion
    ) {
      excluded.humanRubricVersionMismatch += 1;
      return false;
    }
    if (
      !modelMatches(
        record,
        "public",
        options.publicVersion,
        options.publicFormulaVersion,
      )
    ) {
      excluded.publicVersionMismatch += 1;
      return false;
    }
    if (
      !modelMatches(
        record,
        "shadow",
        options.experimentalVersion,
        options.experimentalFormulaVersion,
      )
    ) {
      excluded.experimentalVersionMismatch += 1;
      return false;
    }
    return true;
  });
  const highConfidence = eligibleRecords.filter(
    (record) => Number(record.articleRating?.confidence) === 3,
  );
  const sources = new Set(
    eligibleRecords.map((record) => record.article?.source).filter(Boolean),
  );
  const metricSet = (key) => ({
    feed: metrics(eligibleRecords, key, "feedRating", severityScale),
    article: metrics(eligibleRecords, key, "articleRating", severityScale),
    highConfidence: metrics(
      highConfidence,
      key,
      "articleRating",
      severityScale,
    ),
  });
  const paired = pairedComparison(eligibleRecords, options);
  const humanSeverity = distribution(eligibleRecords, severityScale);
  const evaluation = {
    benchmarkVersion: benchmark.benchmarkVersion,
    benchmarkAsOf: benchmark.asOf,
    baseline: {
      frozenAt: baseline.frozenAt || null,
      frozenRecords: baselineIds.size,
      matchedRecords: matchedBaselineRecords.length,
      missingIds: [...baselineIds].filter((id) => !currentIds.has(id)),
      rule: "Every rated benchmark ID absent from the frozen 112-story baseline is live holdout evidence.",
    },
    models: {
      public: {
        version: options.publicVersion,
        formulaVersion: options.publicFormulaVersion,
      },
      experimental: {
        version: options.experimentalVersion,
        formulaVersion: options.experimentalFormulaVersion,
      },
    },
    humanRubricVersion: options.humanRubricVersion,
    thresholds: {
      minimumLiveRecords: options.minimumLiveRecords,
      recommendedHighConfidenceRecords:
        options.recommendedHighConfidenceRecords,
      recommendedSources: options.recommendedSources,
    },
    coverage: {
      totalRatedRecords: ratedRecords.length,
      liveRecords: liveRecords.length,
      eligibleRecords: eligibleRecords.length,
      excludedRecords: liveRecords.length - eligibleRecords.length,
      excluded,
      highConfidenceRecords: highConfidence.length,
      sources: sources.size,
      humanSeverity,
    },
    metrics: {
      public: metricSet("public"),
      experimental: metricSet("shadow"),
    },
    paired,
    risks: {
      public: riskCounts(eligibleRecords, "public", severityScale),
      experimental: riskCounts(eligibleRecords, "shadow", severityScale),
    },
    perBand: perBand(eligibleRecords, severityScale),
    largestExperimentalMisses: largestMisses(
      eligibleRecords,
      severityScale,
      options.limit,
    ),
  };
  evaluation.gates = promotionGates(evaluation, options);
  evaluation.warnings = [];

  if (evaluation.baseline.missingIds.length) {
    evaluation.warnings.push(
      `${evaluation.baseline.missingIds.length} frozen baseline IDs are absent from the current benchmark.`,
    );
  }
  if (evaluation.coverage.liveRecords < options.minimumLiveRecords) {
    evaluation.warnings.push(
      `Live holdout has ${evaluation.coverage.liveRecords} of ${options.minimumLiveRecords} required new stories.`,
    );
  }
  if (evaluation.coverage.excludedRecords) {
    evaluation.warnings.push(
      `${evaluation.coverage.excludedRecords} live records were excluded because their human rating or exact stored model versions do not match this experiment.`,
    );
  }
  if (
    evaluation.coverage.highConfidenceRecords <
    options.recommendedHighConfidenceRecords
  ) {
    evaluation.warnings.push(
      `Live holdout has ${evaluation.coverage.highConfidenceRecords} of ${options.recommendedHighConfidenceRecords} recommended high-confidence ratings.`,
    );
  }
  if (evaluation.coverage.sources < options.recommendedSources) {
    evaluation.warnings.push(
      `Live holdout represents ${evaluation.coverage.sources} of ${options.recommendedSources} recommended publishers.`,
    );
  }
  for (const label of ["ALARMING", "DIRE", "CATASTROPHIC"]) {
    if (!evaluation.coverage.humanSeverity[label]) {
      evaluation.warnings.push(`Live holdout contains no human-rated ${label} stories.`);
    }
  }

  const minimumGate = evaluation.gates.find(
    (item) => item.id === "minimum-live-records",
  );
  const confidenceGate = evaluation.gates.find(
    (item) => item.id === "paired-confidence",
  );
  const regressionGateIds = new Set([
    "article-band-match",
    "high-confidence-mae",
    "two-band-undercalls",
    "severe-undercalls",
    "extreme-false-positives",
    "catastrophic-false-positives",
    "large-misses",
  ]);
  const regression = evaluation.gates.some(
    (item) => regressionGateIds.has(item.id) && item.status === "fail",
  );
  const significantlyWorse = confidenceGate?.status === "fail";
  const performancePass = evaluation.gates
    .filter((item) => ["article-mae", "paired-confidence"].includes(item.id))
    .every((item) => item.status === "pass");

  evaluation.status =
    minimumGate?.status !== "pass"
      ? "INSUFFICIENT_DATA"
      : regression || significantlyWorse
        ? "FAIL"
        : performancePass
          ? "PASS"
          : "INCONCLUSIVE";
  evaluation.promotionReady = evaluation.status === "PASS";
  return evaluation;
}

function formatNumber(value, places = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(places) : "—";
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${Number(value).toFixed(1)}%` : "—";
}

function metricRow(label, metric) {
  return `| ${label} | ${formatNumber(metric.meanAbsoluteError)} | ${formatNumber(metric.bias)} | ${formatPercent(metric.severityBandMatchPercent)} | ${formatPercent(metric.within20PointsPercent)} |`;
}

function gateResult(status) {
  if (status === "pass") return "PASS";
  if (status === "fail") return "FAIL";
  if (status === "inconclusive") return "INCONCLUSIVE";
  return "NOT ENOUGH DATA";
}

export function markdownLiveExperimentReport(evaluation) {
  const lines = [
    `# DREAD ${evaluation.models.experimental.version} live experimental evaluation`,
    "",
    `Benchmark: ${evaluation.benchmarkVersion}`,
    `Frozen baseline: ${evaluation.baseline.frozenRecords} stories`,
    `Matched baseline: ${evaluation.baseline.matchedRecords} stories`,
    `New live holdout: ${evaluation.coverage.liveRecords} stories`,
    `Eligible paired records: ${evaluation.coverage.eligibleRecords}`,
    `Human questionnaire: ${evaluation.humanRubricVersion}`,
    `Promotion result: ${evaluation.status}`,
    "",
    "Only stories collected after the frozen baseline determine promotion readiness. Positive paired improvement means Experimental 1.2.4 is closer to the human rating.",
    "",
    "## Live coverage",
    "",
    `High-confidence ratings: ${evaluation.coverage.highConfidenceRecords}`,
    `Publishers represented: ${evaluation.coverage.sources}`,
    `Human severity distribution: ${Object.entries(evaluation.coverage.humanSeverity)
      .map(([label, count]) => `${label} ${count}`)
      .join(", ")}`,
    "",
  ];

  if (evaluation.warnings.length) {
    lines.push("### Coverage warnings", "");
    for (const warning of evaluation.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }

  lines.push(
    "## Live model agreement",
    "",
    "| Model / target | Mean absolute error | Bias | Band match | Within 20 points |",
    "|---|---:|---:|---:|---:|",
    metricRow("Public 1.2.2 / article", evaluation.metrics.public.article),
    metricRow(
      "Experimental 1.2.4 / article",
      evaluation.metrics.experimental.article,
    ),
    metricRow("Public 1.2.2 / feed", evaluation.metrics.public.feed),
    metricRow(
      "Experimental 1.2.4 / feed",
      evaluation.metrics.experimental.feed,
    ),
    "",
    "## Paired live result",
    "",
    `Mean absolute-error improvement: ${formatNumber(evaluation.paired.meanAbsoluteErrorImprovement)} points`,
    `95% confidence interval: ${formatNumber(evaluation.paired.confidenceInterval95.lower)} to ${formatNumber(evaluation.paired.confidenceInterval95.upper)} points`,
    `Experimental wins / ties / Public wins: ${evaluation.paired.experimentalWins} / ${evaluation.paired.ties} / ${evaluation.paired.publicWins}`,
    `Method: ${evaluation.paired.confidenceInterval95.method}, ${evaluation.paired.confidenceInterval95.samples} samples`,
    "",
    "## Promotion gates",
    "",
    "| Gate | Result | Experimental | Public / threshold |",
    "|---|---|---:|---:|",
  );
  for (const item of evaluation.gates) {
    lines.push(
      `| ${item.label} | ${gateResult(item.status)} | ${formatNumber(item.experimental)} | ${formatNumber(item.publicBaseline)} |`,
    );
  }

  lines.push(
    "",
    "## Results by human severity band",
    "",
    "| Human band | Stories | Public MAE | Experimental MAE | Improvement |",
    "|---|---:|---:|---:|---:|",
  );
  for (const band of evaluation.perBand) {
    lines.push(
      `| ${band.label} | ${band.records} | ${formatNumber(band.publicMeanAbsoluteError)} | ${formatNumber(band.experimentalMeanAbsoluteError)} | ${formatNumber(band.improvement)} |`,
    );
  }

  lines.push("", "## Largest live Experimental misses", "");
  if (!evaluation.largestExperimentalMisses.length) {
    lines.push("No eligible live stories are available yet.", "");
  } else {
    lines.push(
      "| Story | Human | Experimental | Error | Human band | Experimental band |",
      "|---|---:|---:|---:|---|---|",
    );
    for (const miss of evaluation.largestExperimentalMisses) {
      lines.push(
        `| ${miss.title.replaceAll("|", "\\|")} | ${formatNumber(miss.human)} | ${formatNumber(miss.experimental)} | ${formatNumber(miss.error)} | ${miss.humanBand} | ${miss.experimentalBand} |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function parseArguments(argumentsList) {
  const options = {
    benchmark: DEFAULT_BENCHMARK_FILE,
    baseline: DEFAULT_BASELINE_FILE,
    ...DEFAULT_OPTIONS,
    json: false,
    enforce: false,
  };
  const valueOptions = new Map([
    ["--benchmark", ["benchmark", path.resolve]],
    ["--baseline", ["baseline", path.resolve]],
    ["--public-version", ["publicVersion", String]],
    ["--public-formula-version", ["publicFormulaVersion", String]],
    ["--experimental-version", ["experimentalVersion", String]],
    [
      "--experimental-formula-version",
      ["experimentalFormulaVersion", String],
    ],
    ["--human-rubric-version", ["humanRubricVersion", String]],
    ["--minimum-live", ["minimumLiveRecords", Number]],
    [
      "--minimum-high-confidence",
      ["recommendedHighConfidenceRecords", Number],
    ],
    ["--minimum-sources", ["recommendedSources", Number]],
    ["--bootstrap-samples", ["bootstrapSamples", Number]],
    ["--bootstrap-seed", ["bootstrapSeed", Number]],
    ["--limit", ["limit", Number]],
  ]);

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--enforce") options.enforce = true;
    else if (valueOptions.has(argument)) {
      const [key, convert] = valueOptions.get(argument);
      const value = argumentsList[index + 1];
      if (value === undefined) throw new Error(`Missing value for ${argument}.`);
      options[key] = convert(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  for (const key of [
    "minimumLiveRecords",
    "recommendedHighConfidenceRecords",
    "recommendedSources",
    "bootstrapSamples",
    "limit",
  ]) {
    if (!Number.isFinite(options[key]) || options[key] < 0) {
      throw new Error(`Invalid numeric option: ${key}`);
    }
  }
  options.bootstrapSamples = Math.max(100, Math.floor(options.bootstrapSamples));
  options.limit = Math.max(1, Math.floor(options.limit));
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const benchmark = JSON.parse(await readFile(options.benchmark, "utf8"));
  const baseline = JSON.parse(await readFile(options.baseline, "utf8"));
  const evaluation = evaluateDreadExperiment(benchmark, baseline, options);
  console.log(
    options.json
      ? JSON.stringify(evaluation, null, 2)
      : markdownLiveExperimentReport(evaluation),
  );
  if (options.enforce && evaluation.status === "FAIL") process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
