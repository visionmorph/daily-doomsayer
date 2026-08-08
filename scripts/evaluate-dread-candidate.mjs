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
const DEFAULT_CONFIG_FILE = path.join(PROJECT_DIRECTORY, "news-sources.json");

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
  return Number.isFinite(candidate) ? Math.max(0, Math.min(100, candidate)) : null;
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
      Number.isFinite(exactCoverage) && exactCoverage > 0
        ? exactCoverage
        : 1,
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
  return {
    severeUnderCalls: records.filter(
      (record) =>
        humanScore(record, "articleRating") >= 60 &&
        numericScore(getModelScore(record)) < 40,
    ).length,
    extremeFalsePositives: records.filter(
      (record) =>
        humanScore(record, "articleRating") < 40 &&
        numericScore(getModelScore(record)) >= 60,
    ).length,
    catastrophicFalsePositives: records.filter(
      (record) =>
        humanScore(record, "articleRating") < 80 &&
        numericScore(getModelScore(record)) >= 80,
    ).length,
    largeMisses: records.filter(
      (record) =>
        Math.abs(
          numericScore(getModelScore(record)) -
            humanScore(record, "articleRating"),
        ) >= 30,
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

function makeGate(id, label, passed, candidate, baseline, direction) {
  return { id, label, passed, candidate, baseline, direction };
}

function promotionGates({ baseline, candidate, baselineRisk, candidateRisk }) {
  return [
    makeGate(
      "feed-mae",
      "Candidate feed error is lower than public",
      candidate.feed.meanAbsoluteError < baseline.feed.meanAbsoluteError,
      candidate.feed.meanAbsoluteError,
      baseline.feed.meanAbsoluteError,
      "lower",
    ),
    makeGate(
      "article-mae",
      "Candidate article error is lower than public",
      candidate.article.meanAbsoluteError < baseline.article.meanAbsoluteError,
      candidate.article.meanAbsoluteError,
      baseline.article.meanAbsoluteError,
      "lower",
    ),
    makeGate(
      "article-band-match",
      "Candidate article band match is not lower than public",
      candidate.article.severityBandMatchPercent >=
        baseline.article.severityBandMatchPercent,
      candidate.article.severityBandMatchPercent,
      baseline.article.severityBandMatchPercent,
      "higher",
    ),
    makeGate(
      "high-confidence-mae",
      "Candidate high-confidence error is not higher than public",
      candidate.highConfidence.meanAbsoluteError <=
        baseline.highConfidence.meanAbsoluteError,
      candidate.highConfidence.meanAbsoluteError,
      baseline.highConfidence.meanAbsoluteError,
      "lower",
    ),
    makeGate(
      "severe-undercalls",
      "Candidate reduces severe under-calls",
      candidateRisk.severeUnderCalls < baselineRisk.severeUnderCalls,
      candidateRisk.severeUnderCalls,
      baselineRisk.severeUnderCalls,
      "lower",
    ),
    makeGate(
      "extreme-false-positives",
      "Candidate adds no extreme false positives",
      candidateRisk.extremeFalsePositives <= baselineRisk.extremeFalsePositives,
      candidateRisk.extremeFalsePositives,
      baselineRisk.extremeFalsePositives,
      "lower",
    ),
    makeGate(
      "catastrophic-false-positives",
      "Candidate produces no catastrophic false positives",
      candidateRisk.catastrophicFalsePositives === 0,
      candidateRisk.catastrophicFalsePositives,
      0,
      "lower",
    ),
    makeGate(
      "large-misses",
      "Candidate does not increase large misses",
      candidateRisk.largeMisses <= baselineRisk.largeMisses,
      candidateRisk.largeMisses,
      baselineRisk.largeMisses,
      "lower",
    ),
  ];
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
    .sort((left, right) => Math.abs(right.error) - Math.abs(left.error))
    .slice(0, limit);
}

export async function evaluateDreadCandidate(
  benchmark,
  scoreCandidate,
  {
    candidateVersion = "candidate",
    candidateFormulaVersion = null,
    weights = {},
    limit = 10,
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
  const candidateScores = new Map();
  const provenance = { production: 0, "feed-fallback": 0 };

  for (const record of records) {
    const input = scoringInput(record);
    provenance[input.provenance] += 1;
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
  const publicMetrics = modelMetrics(publicGetter);
  const shadowMetrics = modelMetrics(shadowGetter);
  const candidateMetrics = modelMetrics(candidateGetter);
  const publicRisk = riskCounts(records, publicGetter);
  const shadowRisk = riskCounts(records, shadowGetter);
  const candidateRisk = riskCounts(records, candidateGetter);
  const gates = promotionGates({
    baseline: publicMetrics,
    candidate: candidateMetrics,
    baselineRisk: publicRisk,
    candidateRisk,
  });

  return {
    benchmarkVersion: benchmark.benchmarkVersion,
    benchmarkAsOf: benchmark.asOf,
    records: records.length,
    candidate: {
      version: candidateVersion,
      formulaVersion: candidateFormulaVersion,
    },
    inputAudit: {
      exactProductionInputs: provenance.production,
      feedFallbackInputs: provenance["feed-fallback"],
      note:
        provenance["feed-fallback"] > 0
          ? "Fallback records use the title and feed summary because exact production scoring inputs were not captured in the original export."
          : "Every candidate score used captured production scoring inputs.",
    },
    metrics: {
      public: publicMetrics,
      shadow: shadowMetrics,
      candidate: candidateMetrics,
    },
    risk: {
      public: publicRisk,
      shadow: shadowRisk,
      candidate: candidateRisk,
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
    gates,
    passed: gates.every((gate) => gate.passed),
    largestCandidateMisses: largestCandidateMisses(
      records,
      candidateScores,
      severityScale,
      limit,
    ),
  };
}

function metricRow(label, metric) {
  return `| ${label} | ${metric.meanAbsoluteError.toFixed(2)} | ${metric.bias.toFixed(2)} | ${metric.severityBandMatchPercent.toFixed(1)}% | ${metric.within20PointsPercent.toFixed(1)}% |`;
}

function markdownReport(evaluation) {
  const lines = [
    `# DREAD ${evaluation.candidate.version} candidate evaluation`,
    "",
    `Benchmark: ${evaluation.benchmarkVersion}`,
    `Records: ${evaluation.records}`,
    `Result: ${evaluation.passed ? "PASS" : "FAIL"}`,
    "",
    "## Scoring inputs",
    "",
    `Exact production inputs: ${evaluation.inputAudit.exactProductionInputs}`,
    `Feed-summary fallbacks: ${evaluation.inputAudit.feedFallbackInputs}`,
    "",
    evaluation.inputAudit.note,
    "",
    "## Model agreement",
    "",
    "| Model / target | Mean absolute error | Bias | Band match | Within 20 points |",
    "|---|---:|---:|---:|---:|",
    metricRow("Public / feed", evaluation.metrics.public.feed),
    metricRow("Shadow / feed", evaluation.metrics.shadow.feed),
    metricRow("Candidate / feed", evaluation.metrics.candidate.feed),
    metricRow("Public / article", evaluation.metrics.public.article),
    metricRow("Shadow / article", evaluation.metrics.shadow.article),
    metricRow("Candidate / article", evaluation.metrics.candidate.article),
    "",
    "## Promotion gates",
    "",
    "| Gate | Result | Candidate | Public baseline |",
    "|---|---|---:|---:|",
  ];

  for (const gate of evaluation.gates) {
    lines.push(
      `| ${gate.label} | ${gate.passed ? "PASS" : "FAIL"} | ${gate.candidate} | ${gate.baseline} |`,
    );
  }

  lines.push(
    "",
    "## Largest candidate misses",
    "",
    "| Story | Human | Candidate | Error | Human band | Candidate band |",
    "|---|---:|---:|---:|---|---|",
  );

  for (const miss of evaluation.largestCandidateMisses) {
    lines.push(
      `| ${miss.title.replaceAll("|", "\\|")} | ${miss.humanArticleScore.toFixed(2)} | ${miss.candidateScore.toFixed(2)} | ${miss.error.toFixed(2)} | ${miss.humanBand} | ${miss.candidateBand} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function parseArguments(argumentsList) {
  const options = {
    benchmark: DEFAULT_BENCHMARK_FILE,
    config: DEFAULT_CONFIG_FILE,
    module: null,
    functionName: null,
    version: "candidate",
    formulaVersion: null,
    json: false,
    enforce: false,
    limit: 10,
  };

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const next = argumentsList[index + 1];
    if (argument === "--json") options.json = true;
    else if (argument === "--enforce") options.enforce = true;
    else if (argument === "--benchmark") options.benchmark = path.resolve(next);
    else if (argument === "--config") options.config = path.resolve(next);
    else if (argument === "--module") options.module = path.resolve(next);
    else if (argument === "--function") options.functionName = next;
    else if (argument === "--version") options.version = next;
    else if (argument === "--formula-version") options.formulaVersion = next;
    else if (argument === "--limit") {
      options.limit = Math.max(1, Number.parseInt(next, 10) || 10);
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
  const config = JSON.parse(await readFile(options.config, "utf8"));
  const candidateModule = await import(pathToFileURL(options.module));
  const scorer = selectScoringFunction(candidateModule, options.functionName);
  const evaluation = await evaluateDreadCandidate(benchmark, scorer.score, {
    candidateVersion: options.version,
    candidateFormulaVersion: options.formulaVersion,
    weights: config.doomIndex?.weights || {},
    limit: options.limit,
  });

  console.log(
    options.json
      ? JSON.stringify({ ...evaluation, candidateExport: scorer.name }, null, 2)
      : markdownReport(evaluation),
  );
  if (options.enforce && !evaluation.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
