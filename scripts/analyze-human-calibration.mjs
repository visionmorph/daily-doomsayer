import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BENCHMARK_FILE = path.resolve(
  SCRIPT_DIRECTORY,
  "..",
  "data",
  "human-calibration",
  "calibration-benchmark.v1.json",
);

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

function modelScore(record, model) {
  const value = Number(record.models?.[model]?.score);
  return Number.isFinite(value) ? value : null;
}

function humanScore(record, target) {
  const value = Number(record[target]?.score);
  return Number.isFinite(value) ? value : null;
}

function modelMetrics(records, model, target, severityScale) {
  const pairs = records
    .map((record) => ({
      model: modelScore(record, model),
      human: humanScore(record, target),
    }))
    .filter(({ model: modelValue, human }) => modelValue !== null && human !== null);
  const errors = pairs.map(({ model: modelValue, human }) => modelValue - human);
  const absoluteErrors = errors.map(Math.abs);
  const modelValues = pairs.map((pair) => pair.model);
  const humanValues = pairs.map((pair) => pair.human);

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
          ({ model: modelValue, human }) =>
            severityBand(modelValue, severityScale) ===
            severityBand(human, severityScale),
        ).length) /
        pairs.length,
      1,
    ),
    within10PointsPercent: round(
      (100 * absoluteErrors.filter((error) => error <= 10).length) /
        absoluteErrors.length,
      1,
    ),
    within20PointsPercent: round(
      (100 * absoluteErrors.filter((error) => error <= 20).length) /
        absoluteErrors.length,
      1,
    ),
    pearsonCorrelation: round(correlation(modelValues, humanValues), 3),
    spearmanCorrelation: round(
      correlation(rank(modelValues), rank(humanValues)),
      3,
    ),
  };
}

function distribution(records, getScore, severityScale) {
  return Object.fromEntries(
    severityScale.map((band) => [
      band.label,
      records.filter(
        (record) => severityBand(getScore(record), severityScale) === band.label,
      ).length,
    ]),
  );
}

function largestMisses(records, model, limit, severityScale) {
  return records
    .map((record) => {
      const human = humanScore(record, "articleRating");
      const modelValue = modelScore(record, model);
      return {
        title: record.article?.title || "Untitled",
        source: record.article?.source || "",
        confidence: record.articleRating?.confidence || null,
        humanArticleScore: human,
        modelScore: modelValue,
        error: round(modelValue - human),
        humanBand: severityBand(human, severityScale),
        modelBand: severityBand(modelValue, severityScale),
      };
    })
    .filter((record) => record.modelScore !== null && record.humanArticleScore !== null)
    .sort((left, right) => Math.abs(right.error) - Math.abs(left.error))
    .slice(0, limit);
}

function confidenceMetrics(records, severityScale) {
  return Object.fromEntries(
    [1, 2, 3].map((confidence) => {
      const matching = records.filter(
        (record) => Number(record.articleRating?.confidence) === confidence,
      );
      return [
        confidence,
        {
          records: matching.length,
          publicArticle: modelMetrics(
            matching,
            "public",
            "articleRating",
            severityScale,
          ),
          shadowArticle: modelMetrics(
            matching,
            "shadow",
            "articleRating",
            severityScale,
          ),
        },
      ];
    }),
  );
}

export function analyzeCalibrationBenchmark(benchmark, { limit = 10 } = {}) {
  if (!Array.isArray(benchmark.records) || !Array.isArray(benchmark.severityScale)) {
    throw new Error("The calibration benchmark is missing records or severityScale.");
  }

  const records = benchmark.records.filter((record) => record.status === "rated");
  const severityScale = benchmark.severityScale;
  const contextAdjustments = records
    .map((record) => Number(record.contextAdjustment))
    .filter(Number.isFinite);

  return {
    benchmarkVersion: benchmark.benchmarkVersion,
    asOf: benchmark.asOf,
    records: records.length,
    benchmarkTotals: benchmark.totals,
    metrics: {
      publicFeed: modelMetrics(records, "public", "feedRating", severityScale),
      shadowFeed: modelMetrics(records, "shadow", "feedRating", severityScale),
      publicArticle: modelMetrics(
        records,
        "public",
        "articleRating",
        severityScale,
      ),
      shadowArticle: modelMetrics(
        records,
        "shadow",
        "articleRating",
        severityScale,
      ),
    },
    distributions: {
      humanFeed: distribution(
        records,
        (record) => humanScore(record, "feedRating"),
        severityScale,
      ),
      humanArticle: distribution(
        records,
        (record) => humanScore(record, "articleRating"),
        severityScale,
      ),
      public: distribution(
        records,
        (record) => modelScore(record, "public"),
        severityScale,
      ),
      shadow: distribution(
        records,
        (record) => modelScore(record, "shadow"),
        severityScale,
      ),
    },
    confidence: confidenceMetrics(records, severityScale),
    contextAdjustment: {
      raised: contextAdjustments.filter((value) => value > 0).length,
      lowered: contextAdjustments.filter((value) => value < 0).length,
      unchanged: contextAdjustments.filter((value) => value === 0).length,
      mean: round(mean(contextAdjustments)),
      meanAbsolute: round(mean(contextAdjustments.map(Math.abs))),
    },
    modelComparison: {
      identical: records.filter(
        (record) => modelScore(record, "public") === modelScore(record, "shadow"),
      ).length,
      shadowHigher: records.filter(
        (record) => modelScore(record, "shadow") > modelScore(record, "public"),
      ).length,
      shadowLower: records.filter(
        (record) => modelScore(record, "shadow") < modelScore(record, "public"),
      ).length,
      meanShadowDelta: round(
        mean(
          records.map(
            (record) =>
              modelScore(record, "shadow") - modelScore(record, "public"),
          ),
        ),
      ),
    },
    largestMisses: {
      public: largestMisses(records, "public", limit, severityScale),
      shadow: largestMisses(records, "shadow", limit, severityScale),
    },
  };
}

function metricRow(label, metric) {
  return `| ${label} | ${metric.meanAbsoluteError.toFixed(2)} | ${metric.bias.toFixed(2)} | ${metric.severityBandMatchPercent.toFixed(1)}% | ${metric.within20PointsPercent.toFixed(1)}% |`;
}

function markdownReport(analysis) {
  const lines = [
    `# ${analysis.benchmarkVersion}`,
    "",
    `Records: ${analysis.records}`,
    `As of: ${analysis.asOf}`,
    "",
    "## Model agreement",
    "",
    "| Target | Mean absolute error | Bias | Band match | Within 20 points |",
    "|---|---:|---:|---:|---:|",
    metricRow("DREAD public / feed", analysis.metrics.publicFeed),
    metricRow("DREAD shadow / feed", analysis.metrics.shadowFeed),
    metricRow("DREAD public / article", analysis.metrics.publicArticle),
    metricRow("DREAD shadow / article", analysis.metrics.shadowArticle),
    "",
    "## Severity distribution",
    "",
    "| Severity | Human article | Public | Shadow |",
    "|---|---:|---:|---:|",
  ];

  for (const severity of Object.keys(analysis.distributions.humanArticle)) {
    lines.push(
      `| ${severity} | ${analysis.distributions.humanArticle[severity]} | ${analysis.distributions.public[severity]} | ${analysis.distributions.shadow[severity]} |`,
    );
  }

  lines.push(
    "",
    "## Model comparison",
    "",
    `Identical scores: ${analysis.modelComparison.identical}`,
    `Shadow higher: ${analysis.modelComparison.shadowHigher}`,
    `Shadow lower: ${analysis.modelComparison.shadowLower}`,
    `Mean shadow delta: ${analysis.modelComparison.meanShadowDelta.toFixed(2)}`,
    "",
    "## Largest public-model misses",
    "",
    "| Story | Human | Model | Error | Human band | Model band |",
    "|---|---:|---:|---:|---|---|",
  );

  for (const miss of analysis.largestMisses.public) {
    lines.push(
      `| ${miss.title.replaceAll("|", "\\|")} | ${miss.humanArticleScore.toFixed(2)} | ${miss.modelScore.toFixed(2)} | ${miss.error.toFixed(2)} | ${miss.humanBand} | ${miss.modelBand} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function parseArguments(argumentsList) {
  let input = DEFAULT_BENCHMARK_FILE;
  let json = false;
  let limit = 10;

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--json") {
      json = true;
    } else if (argument === "--limit") {
      limit = Math.max(1, Number.parseInt(argumentsList[index + 1], 10) || 10);
      index += 1;
    } else {
      input = path.resolve(argument);
    }
  }

  return { input, json, limit };
}

async function main() {
  const { input, json, limit } = parseArguments(process.argv.slice(2));
  const benchmark = JSON.parse(await readFile(input, "utf8"));
  const analysis = analyzeCalibrationBenchmark(benchmark, { limit });
  console.log(json ? JSON.stringify(analysis, null, 2) : markdownReport(analysis));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
