import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_BENCHMARK_FILE = path.join(
  PROJECT_DIRECTORY,
  "data",
  "human-calibration",
  "calibration-benchmark.v1.json",
);
const DEFAULT_COHORT_FILE = path.join(
  PROJECT_DIRECTORY,
  "data",
  "human-calibration",
  "cohorts",
  "dread-1.2.4-development.json",
);
const DEFAULT_CONFIG_FILE = path.join(PROJECT_DIRECTORY, "news-sources.json");
const DEFAULT_MINIMUM_HOLDOUT_RECORDS = 25;
const DEFAULT_MINIMUM_HIGH_CONFIDENCE_RECORDS = 10;
const DEFAULT_MINIMUM_HOLDOUT_SOURCES = 5;

function mean(values) {
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null;
}

function round(value, decimalPlaces = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(decimalPlaces)) : null;
}

function rank(values) {
  return values.map((value) => {
    let lower = 0;
    let equal = 0;
    for (const candidate of values) {
      if (candidate < value) lower += 1;
      if (candidate === value) equal += 1;
    }
    return lower + (equal + 1) / 2;
  });
}

function correlation(left, right) {
  if (left.length !== right.length || left.length < 2) return null;
  const leftMean = mean(left);
  const rightMean = mean(right);
  const numerator = left.reduce(
    (total, value, index) =>
      total + (value - leftMean) * (right[index] - rightMean),
    0,
  );
  const denominator = Math.sqrt(
    left.reduce((total, value) => total + (value - leftMean) ** 2, 0) *
      right.reduce((total, value) => total + (value - rightMean) ** 2, 0),
  );
  return denominator ? numerator / denominator : null;
}

function severityBand(value, severityScale) {
  return (
    severityScale.find(
      (band) => value >= Number(band.minimum) && value <= Number(band.maximum),
    )?.label || "UNCLASSIFIED"
  );
}

function numericScore(value) {
  if (value === null || value === undefined || value === "") return null;
  const candidate = Number(
    typeof value === "object" && value !== null
      ? value.value ?? value.score
      : value,
  );
  return Number.isFinite(candidate)
    ? Math.max(0, Math.min(100, candidate))
    : null;
}

function storedScore(record, model) {
  return numericScore(record.models?.[model]?.score);
}

function humanScore(record, target) {
  return numericScore(record[target]?.score);
}

function scoringInput(record) {
  const exactSummary = String(record.scoringInput?.summary || "").trim();
  const feedSummary = String(record.feedEvidence?.summary || "").trim();
  const exactCoverage = Number(record.scoringInput?.coverageSources);

  return {
    title: String(record.scoringInput?.title || record.article?.title || ""),
    summary: exactSummary || feedSummary,
    coverageSources:
      Number.isFinite(exactCoverage) && exactCoverage > 0 ? exactCoverage : 1,
    provenance: exactSummary ? "production" : "feed-fallback",
  };
}

function metrics(records, getModelScore, target, severityScale) {
  const pairs = records
    .map((record) => ({
      model: numericScore(getModelScore(record)),
      human: humanScore(record, target),
    }))
    .filter(({ model, human }) => model !== null && human !== null);

  if (!pairs.length) {
    return {
      records: 0,
      meanAbsoluteError: null,
      rootMeanSquareError: null,
      bias: null,
      severityBandMatchPercent: null,
      within10PointsPercent: null,
      within20PointsPercent: null,
      pearsonCorrelation: null,
      spearmanCorrelation: null,
    };
  }

  const errors = pairs.map(({ model, human }) => model - human);
  const absoluteErrors = errors.map(Math.abs);
  const modelValues = pairs.map(({ model }) => model);
  const humanValues = pairs.map(({ human }) => human);

  return {
    records: pairs.length,
    meanAbsoluteError: round(mean(absoluteErrors)),
    rootMeanSquareError: round(
      Math.sqrt(mean(errors.map((error) => error ** 2))),
    ),
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
    within10PointsPercent: round(
      (100 * absoluteErrors.filter((error) => error <= 10).length) /
        pairs.length,
      1,
    ),
    within20PointsPercent: round(
      (100 * absoluteErrors.filter((error) => error <= 20).length) /
        pairs.length,
      1,
    ),
    pearsonCorrelation: round(correlation(modelValues, humanValues), 3),
    spearmanCorrelation: round(
      correlation(rank(modelValues), rank(humanValues)),
      3,
    ),
  };
}

function riskCounts(records, getModelScore) {
  const scored = records
    .map((record) => ({
      human: humanScore(record, "articleRating"),
      model: numericScore(getModelScore(record)),
    }))
    .filter(({ human, model }) => human !== null && model !== null);
  const direEligible = scored.filter(({ human }) => human >= 60);
  const extremeFalsePositiveEligible = scored.filter(({ human }) => human < 40);
  const catastrophicFalsePositiveEligible = scored.filter(
    ({ human }) => human < 80,
  );

  return {
    eligibleRecords: scored.length,
    direHumanRecords: direEligible.length,
    belowAlarmingHumanRecords: extremeFalsePositiveEligible.length,
    belowCatastrophicHumanRecords: catastrophicFalsePositiveEligible.length,
    severeUnderCalls: direEligible.filter(({ model }) => model < 40).length,
    extremeFalsePositives: extremeFalsePositiveEligible.filter(
      ({ model }) => model >= 60,
    ).length,
    catastrophicFalsePositives: catastrophicFalsePositiveEligible.filter(
      ({ model }) => model >= 80,
    ).length,
    largeMisses: scored.filter(
      ({ human, model }) => Math.abs(model - human) >= 30,
    ).length,
  };
}

function distribution(records, getModelScore, severityScale) {
  return Object.fromEntries(
    severityScale.map((band) => [
      band.label,
      records.filter(
        (record) =>
          severityBand(numericScore(getModelScore(record)), severityScale) ===
          band.label,
      ).length,
    ]),
  );
}

function largestCandidateMisses(records, candidateScores, severityScale, limit) {
  return records
    .map((record) => {
      const human = humanScore(record, "articleRating");
      const candidate = candidateScores.get(record.benchmarkId);
      return {
        title: record.article?.title || "Untitled",
        source: record.article?.source || "",
        confidence: record.articleRating?.confidence || null,
        humanArticleScore: human,
        candidateScore: candidate,
        error: round(candidate - human),
        humanBand: severityBand(human, severityScale),
        candidateBand: severityBand(candidate, severityScale),
      };
    })
    .filter(
      ({ humanArticleScore, candidateScore }) =>
        humanArticleScore !== null && candidateScore !== null,
    )
    .sort((left, right) => Math.abs(right.error) - Math.abs(left.error))
    .slice(0, limit);
}

function inputAudit(records, provenanceById) {
  const exactProductionInputs = records.filter(
    (record) => provenanceById.get(record.benchmarkId) === "production",
  ).length;
  const feedFallbackInputs = records.length - exactProductionInputs;

  return {
    exactProductionInputs,
    feedFallbackInputs,
    exactProductionPercent: records.length
      ? round((100 * exactProductionInputs) / records.length, 1)
      : null,
  };
}

function coverage(records, severityScale) {
  const highConfidenceRecords = records.filter(
    (record) => Number(record.articleRating?.confidence) === 3,
  ).length;

  return {
    records: records.length,
    highConfidenceRecords,
    sources: new Set(records.map((record) => record.article?.source).filter(Boolean))
      .size,
    humanSeverity: distribution(
      records,
      (record) => humanScore(record, "articleRating"),
      severityScale,
    ),
  };
}

function evaluateCohort(
  records,
  {
    severityScale,
    candidateScores,
    provenanceById,
    publicGetter,
    shadowGetter,
    candidateGetter,
    limit,
  },
) {
  const highConfidence = records.filter(
    (record) => Number(record.articleRating?.confidence) === 3,
  );
  const modelMetrics = (getter) => ({
    feed: metrics(records, getter, "feedRating", severityScale),
    article: metrics(records, getter, "articleRating", severityScale),
    highConfidence: metrics(
      highConfidence,
      getter,
      "articleRating",
      severityScale,
    ),
  });

  return {
    records: records.length,
    inputAudit: inputAudit(records, provenanceById),
    coverage: coverage(records, severityScale),
    metrics: {
      public: modelMetrics(publicGetter),
      shadow: modelMetrics(shadowGetter),
      candidate: modelMetrics(candidateGetter),
    },
    risk: {
      public: riskCounts(records, publicGetter),
      shadow: riskCounts(records, shadowGetter),
      candidate: riskCounts(records, candidateGetter),
    },
    distributions: {
      humanArticle: distribution(
        records,
        (record) => humanScore(record, "articleRating"),
        severityScale,
      ),
      public: distribution(records, publicGetter, severityScale),
      shadow: distribution(records, shadowGetter, severityScale),
      candidate: distribution(records, candidateGetter, severityScale),
    },
    largestCandidateMisses: largestCandidateMisses(
      records,
      candidateScores,
      severityScale,
      limit,
    ),
  };
}

function makeGate(
  id,
  label,
  status,
  candidate,
  publicBaseline,
  shadowBaseline,
  direction,
) {
  return {
    id,
    label,
    status,
    passed: status === "pass" ? true : status === "fail" ? false : null,
    candidate,
    publicBaseline,
    shadowBaseline,
    direction,
  };
}

function comparisonStatus(candidate, publicBaseline, shadowBaseline, compare) {
  if (
    !Number.isFinite(candidate) ||
    !Number.isFinite(publicBaseline) ||
    !Number.isFinite(shadowBaseline)
  ) {
    return "not-enough-data";
  }
  return compare(candidate, publicBaseline, shadowBaseline) ? "pass" : "fail";
}

function promotionGates(holdout, minimumHoldoutRecords) {
  const publicMetrics = holdout.metrics.public;
  const shadowMetrics = holdout.metrics.shadow;
  const candidateMetrics = holdout.metrics.candidate;
  const publicRisk = holdout.risk.public;
  const shadowRisk = holdout.risk.shadow;
  const candidateRisk = holdout.risk.candidate;
  const lowerThanBoth = (candidate, publicBaseline, shadowBaseline) =>
    candidate < publicBaseline && candidate < shadowBaseline;
  const noHigherThanBoth = (candidate, publicBaseline, shadowBaseline) =>
    candidate <= publicBaseline && candidate <= shadowBaseline;
  const noLowerThanBoth = (candidate, publicBaseline, shadowBaseline) =>
    candidate >= publicBaseline && candidate >= shadowBaseline;

  return [
    makeGate(
      "minimum-holdout-records",
      `Holdout contains at least ${minimumHoldoutRecords} rated stories`,
      holdout.records >= minimumHoldoutRecords ? "pass" : "fail",
      holdout.records,
      minimumHoldoutRecords,
      minimumHoldoutRecords,
      "higher",
    ),
    makeGate(
      "feed-mae",
      "Candidate feed error is lower than both deployed models",
      comparisonStatus(
        candidateMetrics.feed.meanAbsoluteError,
        publicMetrics.feed.meanAbsoluteError,
        shadowMetrics.feed.meanAbsoluteError,
        lowerThanBoth,
      ),
      candidateMetrics.feed.meanAbsoluteError,
      publicMetrics.feed.meanAbsoluteError,
      shadowMetrics.feed.meanAbsoluteError,
      "lower",
    ),
    makeGate(
      "article-mae",
      "Candidate article error is lower than both deployed models",
      comparisonStatus(
        candidateMetrics.article.meanAbsoluteError,
        publicMetrics.article.meanAbsoluteError,
        shadowMetrics.article.meanAbsoluteError,
        lowerThanBoth,
      ),
      candidateMetrics.article.meanAbsoluteError,
      publicMetrics.article.meanAbsoluteError,
      shadowMetrics.article.meanAbsoluteError,
      "lower",
    ),
    makeGate(
      "article-band-match",
      "Candidate article band match is not lower than either deployed model",
      comparisonStatus(
        candidateMetrics.article.severityBandMatchPercent,
        publicMetrics.article.severityBandMatchPercent,
        shadowMetrics.article.severityBandMatchPercent,
        noLowerThanBoth,
      ),
      candidateMetrics.article.severityBandMatchPercent,
      publicMetrics.article.severityBandMatchPercent,
      shadowMetrics.article.severityBandMatchPercent,
      "higher",
    ),
    makeGate(
      "high-confidence-mae",
      "Candidate high-confidence error is not higher than either deployed model",
      comparisonStatus(
        candidateMetrics.highConfidence.meanAbsoluteError,
        publicMetrics.highConfidence.meanAbsoluteError,
        shadowMetrics.highConfidence.meanAbsoluteError,
        noHigherThanBoth,
      ),
      candidateMetrics.highConfidence.meanAbsoluteError,
      publicMetrics.highConfidence.meanAbsoluteError,
      shadowMetrics.highConfidence.meanAbsoluteError,
      "lower",
    ),
    makeGate(
      "severe-undercalls",
      "Candidate does not increase severe under-calls",
      candidateRisk.direHumanRecords === 0
        ? "not-enough-data"
        : noHigherThanBoth(
              candidateRisk.severeUnderCalls,
              publicRisk.severeUnderCalls,
              shadowRisk.severeUnderCalls,
            )
          ? "pass"
          : "fail",
      candidateRisk.severeUnderCalls,
      publicRisk.severeUnderCalls,
      shadowRisk.severeUnderCalls,
      "lower",
    ),
    makeGate(
      "extreme-false-positives",
      "Candidate adds no extreme false positives",
      candidateRisk.belowAlarmingHumanRecords === 0
        ? "not-enough-data"
        : noHigherThanBoth(
              candidateRisk.extremeFalsePositives,
              publicRisk.extremeFalsePositives,
              shadowRisk.extremeFalsePositives,
            )
          ? "pass"
          : "fail",
      candidateRisk.extremeFalsePositives,
      publicRisk.extremeFalsePositives,
      shadowRisk.extremeFalsePositives,
      "lower",
    ),
    makeGate(
      "catastrophic-false-positives",
      "Candidate produces no catastrophic false positives",
      candidateRisk.belowCatastrophicHumanRecords === 0
        ? "not-enough-data"
        : candidateRisk.catastrophicFalsePositives === 0
          ? "pass"
          : "fail",
      candidateRisk.catastrophicFalsePositives,
      publicRisk.catastrophicFalsePositives,
      shadowRisk.catastrophicFalsePositives,
      "lower",
    ),
    makeGate(
      "large-misses",
      "Candidate does not exceed either model's large misses",
      comparisonStatus(
        candidateRisk.largeMisses,
        publicRisk.largeMisses,
        shadowRisk.largeMisses,
        noHigherThanBoth,
      ),
      candidateRisk.largeMisses,
      publicRisk.largeMisses,
      shadowRisk.largeMisses,
      "lower",
    ),
  ];
}

function coverageWarnings(
  holdout,
  {
    minimumHoldoutRecords,
    minimumHighConfidenceRecords,
    minimumHoldoutSources,
  },
) {
  const warnings = [];
  const humanSeverity = holdout.coverage.humanSeverity;

  if (holdout.records < minimumHoldoutRecords) {
    warnings.push(
      `Holdout has ${holdout.records} of ${minimumHoldoutRecords} required stories.`,
    );
  }
  if (holdout.coverage.highConfidenceRecords < minimumHighConfidenceRecords) {
    warnings.push(
      `Holdout has ${holdout.coverage.highConfidenceRecords} of ${minimumHighConfidenceRecords} recommended high-confidence ratings.`,
    );
  }
  if (holdout.coverage.sources < minimumHoldoutSources) {
    warnings.push(
      `Holdout represents ${holdout.coverage.sources} of ${minimumHoldoutSources} recommended publishers.`,
    );
  }
  if (holdout.inputAudit.feedFallbackInputs > 0) {
    warnings.push(
      `${holdout.inputAudit.feedFallbackInputs} holdout stories lack exact production scoring inputs.`,
    );
  }
  if (!humanSeverity.DIRE) {
    warnings.push("Holdout contains no human-rated Dire stories.");
  }
  if (!humanSeverity.CATASTROPHIC) {
    warnings.push("Holdout contains no human-rated Catastrophic stories.");
  }

  return warnings;
}

export async function evaluateDreadCandidate(
  benchmark,
  scoreCandidate,
  {
    candidateVersion = "candidate",
    candidateFormulaVersion = null,
    weights = {},
    limit = 10,
    developmentBenchmarkIds = [],
    cohortMetadata = null,
    minimumHoldoutRecords = DEFAULT_MINIMUM_HOLDOUT_RECORDS,
    minimumHighConfidenceRecords = DEFAULT_MINIMUM_HIGH_CONFIDENCE_RECORDS,
    minimumHoldoutSources = DEFAULT_MINIMUM_HOLDOUT_SOURCES,
  } = {},
) {
  if (!Array.isArray(benchmark.records) || !Array.isArray(benchmark.severityScale)) {
    throw new Error("The candidate benchmark is missing records or severityScale.");
  }
  if (typeof scoreCandidate !== "function") {
    throw new Error("A candidate scoring function is required.");
  }

  const records = benchmark.records.filter((record) => record.status === "rated");
  const severityScale = benchmark.severityScale;
  const developmentIds = new Set(developmentBenchmarkIds.map(String));
  const developmentRecords = records.filter((record) =>
    developmentIds.has(String(record.benchmarkId)),
  );
  const holdoutRecords = records.filter(
    (record) => !developmentIds.has(String(record.benchmarkId)),
  );
  const currentIds = new Set(records.map((record) => String(record.benchmarkId)));
  const missingDevelopmentIds = [...developmentIds].filter(
    (benchmarkId) => !currentIds.has(benchmarkId),
  );
  const candidateScores = new Map();
  const provenanceById = new Map();

  for (const record of records) {
    const input = scoringInput(record);
    provenanceById.set(record.benchmarkId, input.provenance);
    const result = await scoreCandidate({ ...input, weights });
    const score = numericScore(result);
    if (score === null) {
      throw new Error(
        `Candidate returned an invalid score for: ${record.article?.title || record.benchmarkId}`,
      );
    }
    candidateScores.set(record.benchmarkId, score);
  }

  const publicGetter = (record) => storedScore(record, "public");
  const shadowGetter = (record) => storedScore(record, "shadow");
  const candidateGetter = (record) => candidateScores.get(record.benchmarkId);
  const cohortContext = {
    severityScale,
    candidateScores,
    provenanceById,
    publicGetter,
    shadowGetter,
    candidateGetter,
    limit,
  };
  const cohorts = {
    development: evaluateCohort(developmentRecords, cohortContext),
    holdout: evaluateCohort(holdoutRecords, cohortContext),
    combined: evaluateCohort(records, cohortContext),
  };
  const gates = promotionGates(cohorts.holdout, minimumHoldoutRecords);
  const warnings = coverageWarnings(cohorts.holdout, {
    minimumHoldoutRecords,
    minimumHighConfidenceRecords,
    minimumHoldoutSources,
  });
  if (missingDevelopmentIds.length) {
    warnings.push(
      `${missingDevelopmentIds.length} frozen development IDs are absent from the current benchmark.`,
    );
  }
  const minimumGate = gates.find(
    (gate) => gate.id === "minimum-holdout-records",
  );
  const failedGates = gates.filter((gate) => gate.status === "fail");
  const status =
    minimumGate?.status !== "pass"
      ? "INSUFFICIENT_DATA"
      : failedGates.length
        ? "FAIL"
        : "PASS";

  return {
    benchmarkVersion: benchmark.benchmarkVersion,
    benchmarkAsOf: benchmark.asOf,
    candidate: {
      version: candidateVersion,
      formulaVersion: candidateFormulaVersion,
    },
    cohort: {
      ...cohortMetadata,
      frozenDevelopmentRecords: developmentIds.size,
      matchedDevelopmentRecords: developmentRecords.length,
      missingDevelopmentIds,
      holdoutRule: "Any rated benchmark ID not present in the frozen development cohort",
    },
    thresholds: {
      minimumHoldoutRecords,
      minimumHighConfidenceRecords,
      minimumHoldoutSources,
    },
    cohorts,
    gates,
    warnings,
    status,
    passed: status === "PASS",
    promotionReady: status === "PASS",
  };
}

function formatNumber(value, decimalPlaces = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(decimalPlaces) : "—";
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${Number(value).toFixed(1)}%` : "—";
}

function metricRow(label, metric) {
  return `| ${label} | ${formatNumber(metric.meanAbsoluteError)} | ${formatNumber(metric.bias)} | ${formatPercent(metric.severityBandMatchPercent)} | ${formatPercent(metric.within20PointsPercent)} |`;
}

function appendMetricTable(lines, cohort, includeFeed = false) {
  lines.push(
    "| Model / target | Mean absolute error | Bias | Band match | Within 20 points |",
    "|---|---:|---:|---:|---:|",
  );
  if (includeFeed) {
    lines.push(
      metricRow("Public / feed", cohort.metrics.public.feed),
      metricRow("Experimental / feed", cohort.metrics.shadow.feed),
      metricRow("Candidate / feed", cohort.metrics.candidate.feed),
    );
  }
  lines.push(
    metricRow("Public / article", cohort.metrics.public.article),
    metricRow("Experimental / article", cohort.metrics.shadow.article),
    metricRow("Candidate / article", cohort.metrics.candidate.article),
    "",
  );
}

function markdownReport(evaluation) {
  const holdout = evaluation.cohorts.holdout;
  const lines = [
    `# DREAD ${evaluation.candidate.version} cohort-aware candidate evaluation`,
    "",
    `Benchmark: ${evaluation.benchmarkVersion}`,
    `Development records: ${evaluation.cohorts.development.records}`,
    `Holdout records: ${holdout.records}`,
    `Combined records: ${evaluation.cohorts.combined.records}`,
    `Promotion result: ${evaluation.status}`,
    "",
    "Only holdout records determine promotion readiness. Development and combined results are diagnostic.",
    "",
    "## Holdout coverage",
    "",
    `Exact production inputs: ${holdout.inputAudit.exactProductionInputs}/${holdout.records}`,
    `High-confidence ratings: ${holdout.coverage.highConfidenceRecords}`,
    `Publishers represented: ${holdout.coverage.sources}`,
    `Human severity distribution: ${Object.entries(holdout.coverage.humanSeverity)
      .map(([label, count]) => `${label} ${count}`)
      .join(", ")}`,
    "",
  ];

  if (evaluation.warnings.length) {
    lines.push("### Coverage warnings", "");
    for (const warning of evaluation.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }

  lines.push("## Holdout model agreement", "");
  appendMetricTable(lines, holdout, true);
  lines.push(
    "## Holdout promotion gates",
    "",
    "| Gate | Result | Candidate | Public 1.2.2 | Experimental 1.2.3 |",
    "|---|---|---:|---:|---:|",
  );

  for (const gate of evaluation.gates) {
    const result =
      gate.status === "pass"
        ? "PASS"
        : gate.status === "fail"
          ? "FAIL"
          : "NOT ENOUGH DATA";
    lines.push(
      `| ${gate.label} | ${result} | ${formatNumber(gate.candidate)} | ${formatNumber(gate.publicBaseline)} | ${formatNumber(gate.shadowBaseline)} |`,
    );
  }

  lines.push("", "## Largest holdout candidate misses", "");
  if (!holdout.largestCandidateMisses.length) {
    lines.push("No holdout stories are available yet.", "");
  } else {
    lines.push(
      "| Story | Human | Candidate | Error | Human band | Candidate band |",
      "|---|---:|---:|---:|---|---|",
    );
    for (const miss of holdout.largestCandidateMisses) {
      lines.push(
        `| ${miss.title.replaceAll("|", "\\|")} | ${formatNumber(miss.humanArticleScore)} | ${formatNumber(miss.candidateScore)} | ${formatNumber(miss.error)} | ${miss.humanBand} | ${miss.candidateBand} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Development diagnostics", "");
  appendMetricTable(lines, evaluation.cohorts.development);
  lines.push("## Combined diagnostics", "");
  appendMetricTable(lines, evaluation.cohorts.combined);

  return `${lines.join("\n")}\n`;
}

function parseArguments(argumentsList) {
  const options = {
    benchmark: DEFAULT_BENCHMARK_FILE,
    cohort: DEFAULT_COHORT_FILE,
    config: DEFAULT_CONFIG_FILE,
    module: null,
    functionName: null,
    version: "candidate",
    formulaVersion: null,
    json: false,
    enforce: false,
    limit: 10,
    minimumHoldoutRecords: DEFAULT_MINIMUM_HOLDOUT_RECORDS,
    minimumHighConfidenceRecords: DEFAULT_MINIMUM_HIGH_CONFIDENCE_RECORDS,
    minimumHoldoutSources: DEFAULT_MINIMUM_HOLDOUT_SOURCES,
  };

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const next = argumentsList[index + 1];
    if (argument === "--json") options.json = true;
    else if (argument === "--enforce") options.enforce = true;
    else if (argument === "--benchmark") options.benchmark = path.resolve(next);
    else if (argument === "--cohort") options.cohort = path.resolve(next);
    else if (argument === "--config") options.config = path.resolve(next);
    else if (argument === "--module") options.module = path.resolve(next);
    else if (argument === "--function") options.functionName = next;
    else if (argument === "--version") options.version = next;
    else if (argument === "--formula-version") options.formulaVersion = next;
    else if (argument === "--limit") {
      options.limit = Math.max(1, Number.parseInt(next, 10) || 10);
    } else if (argument === "--minimum-holdout") {
      options.minimumHoldoutRecords = Math.max(
        1,
        Number.parseInt(next, 10) || DEFAULT_MINIMUM_HOLDOUT_RECORDS,
      );
    } else if (argument === "--minimum-high-confidence") {
      options.minimumHighConfidenceRecords = Math.max(
        0,
        Number.parseInt(next, 10) || 0,
      );
    } else if (argument === "--minimum-sources") {
      options.minimumHoldoutSources = Math.max(
        1,
        Number.parseInt(next, 10) || DEFAULT_MINIMUM_HOLDOUT_SOURCES,
      );
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }

    if (!["--json", "--enforce"].includes(argument)) index += 1;
  }

  if (!options.module) {
    throw new Error("Provide a candidate model with --module.");
  }
  return options;
}

function selectScoringFunction(candidateModule, requestedName) {
  if (requestedName) {
    if (typeof candidateModule[requestedName] !== "function") {
      throw new Error(`Candidate export is not a function: ${requestedName}`);
    }
    return { name: requestedName, score: candidateModule[requestedName] };
  }

  const matches = Object.entries(candidateModule).filter(
    ([name, value]) =>
      typeof value === "function" &&
      /^calculateDoomIndexV\d+$/u.test(name) &&
      !name.includes("FromFactors"),
  );
  if (matches.length !== 1) {
    throw new Error(
      "Could not select one candidate scorer automatically. Use --function.",
    );
  }
  return { name: matches[0][0], score: matches[0][1] };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const benchmark = JSON.parse(await readFile(options.benchmark, "utf8"));
  const cohort = JSON.parse(await readFile(options.cohort, "utf8"));
  const config = JSON.parse(await readFile(options.config, "utf8"));
  const candidateModule = await import(pathToFileURL(options.module));
  const scorer = selectScoringFunction(candidateModule, options.functionName);
  const evaluation = await evaluateDreadCandidate(benchmark, scorer.score, {
    candidateVersion: options.version,
    candidateFormulaVersion: options.formulaVersion,
    weights: config.doomIndex?.weights || {},
    limit: options.limit,
    developmentBenchmarkIds: cohort.benchmarkIds || [],
    cohortMetadata: {
      schemaVersion: cohort.schemaVersion || null,
      candidateVersion: cohort.candidateVersion || null,
      benchmarkVersion: cohort.benchmarkVersion || null,
      frozenAt: cohort.frozenAt || null,
      description: cohort.description || "",
    },
    minimumHoldoutRecords: options.minimumHoldoutRecords,
    minimumHighConfidenceRecords: options.minimumHighConfidenceRecords,
    minimumHoldoutSources: options.minimumHoldoutSources,
  });

  console.log(
    options.json
      ? JSON.stringify({ ...evaluation, candidateExport: scorer.name }, null, 2)
      : markdownReport(evaluation),
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
