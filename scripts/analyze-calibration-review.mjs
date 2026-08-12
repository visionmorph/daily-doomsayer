import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
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
const DEFAULT_REVIEWS_DIRECTORY = path.join(
  PROJECT_DIRECTORY,
  "data",
  "human-calibration",
  "reviews",
  "raw",
);
const DEFAULT_OUTPUT_FILE = path.join(
  PROJECT_DIRECTORY,
  "data",
  "human-calibration",
  "reviews",
  "review-comparison.json",
);

function numericScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? score : null;
}

function severityBand(score, scale) {
  return (
    scale.find(
      (band) =>
        score >= Number(band.minimum) && score <= Number(band.maximum),
    )?.label || "UNCLASSIFIED"
  );
}

function timestamp(record) {
  return Date.parse(
    record.completedAt || record.updatedAt || record.articleRating?.ratedAt || 0,
  ) || 0;
}

function benchmarkId(record) {
  return String(record.article?.benchmarkId || record.benchmarkId || "");
}

async function jsonFiles(inputPath) {
  const resolved = path.resolve(inputPath);
  const entries = await readdir(resolved, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    return resolved.toLowerCase().endsWith(".json") ? [resolved] : [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(resolved, entry.name))
    .sort();
}

export async function loadBlindReviewExports(inputPaths) {
  const files = (await Promise.all(inputPaths.map(jsonFiles))).flat();
  const exports = [];

  for (const file of files) {
    const review = JSON.parse(await readFile(file, "utf8"));
    if (review.exportType !== "blind-calibration-review") {
      throw new Error(`Not a blind calibration review export: ${file}`);
    }
    if (!Array.isArray(review.records)) {
      throw new Error(`Review export has no records array: ${file}`);
    }
    exports.push(review);
  }

  return exports;
}

function newestReviewedRecords(reviewExports) {
  const records = new Map();

  for (const reviewExport of reviewExports) {
    for (const record of reviewExport.records) {
      if (record.status !== "rated") continue;
      const id = benchmarkId(record);
      if (!id) continue;
      const current = records.get(id);
      if (!current || timestamp(record) >= timestamp(current)) records.set(id, record);
    }
  }

  return records;
}

function factorChanges(original, review) {
  const originalFactors = original.articleRating?.assessment?.factors || {};
  const reviewFactors = review.articleRating?.assessment?.factors || {};

  return Object.keys({ ...originalFactors, ...reviewFactors })
    .filter(
      (factor) =>
        Number(originalFactors[factor]?.level) !== Number(reviewFactors[factor]?.level),
    )
    .map((factor) => ({
      factor,
      original: originalFactors[factor] || null,
      review: reviewFactors[factor] || null,
    }));
}

function classification(originalScore, reviewScore, originalBand, reviewBand) {
  const difference = Math.abs(reviewScore - originalScore);
  if (originalScore >= 60 || reviewScore >= 60) return "mandatory-adjudication";
  if (originalBand !== reviewBand || difference >= 15) return "needs-adjudication";
  if (difference >= 6) return "needs-inspection";
  return "stable";
}

export function analyzeCalibrationReview(benchmark, reviewExports) {
  const queueFingerprints = new Set(
    reviewExports
      .map((reviewExport) => reviewExport.reviewQueue?.fingerprint)
      .filter(Boolean),
  );
  if (queueFingerprints.size > 1) {
    throw new Error("Blind review exports belong to different review queues.");
  }
  const eligibleBenchmarkIds = new Set(
    reviewExports.flatMap((reviewExport) =>
      Array.isArray(reviewExport.reviewQueue?.eligibleBenchmarkIds)
        ? reviewExport.reviewQueue.eligibleBenchmarkIds.map(String)
        : [],
    ),
  );
  const originals = new Map(
    benchmark.records.map((record) => [String(record.benchmarkId), record]),
  );
  const reviews = newestReviewedRecords(reviewExports);
  const comparisons = [];

  for (const [id, review] of reviews) {
    const original = originals.get(id);
    if (!original) continue;
    const originalScore = numericScore(original.articleRating?.score);
    const reviewScore = numericScore(review.articleRating?.score);
    if (originalScore === null || reviewScore === null) continue;
    const originalBand = severityBand(originalScore, benchmark.severityScale);
    const reviewBand = severityBand(reviewScore, benchmark.severityScale);
    const status = classification(
      originalScore,
      reviewScore,
      originalBand,
      reviewBand,
    );
    comparisons.push({
      benchmarkId: id,
      title: original.article?.title || review.article?.title || "",
      source: original.article?.source || review.article?.source || "",
      originalScore,
      reviewScore,
      signedDifference: reviewScore - originalScore,
      absoluteDifference: Math.abs(reviewScore - originalScore),
      originalBand,
      reviewBand,
      bandChanged: originalBand !== reviewBand,
      status,
      factorChanges: factorChanges(original, review),
      reviewSelection: review.articleRating?.assessment?.selection || null,
      reviewConfidence: review.articleRating?.confidence || null,
      reviewCompletedAt: review.completedAt || null,
    });
  }

  comparisons.sort(
    (left, right) =>
      right.absoluteDifference - left.absoluteDifference ||
      left.title.localeCompare(right.title),
  );
  const count = (status) =>
    comparisons.filter((comparison) => comparison.status === status).length;

  return {
    schemaVersion: "1.0",
    reportVersion: "blind-calibration-review-comparison.v1",
    generatedAt: new Date().toISOString(),
    sourceBenchmarkVersion: benchmark.benchmarkVersion,
    sourceBenchmarkAsOf: benchmark.asOf || null,
    reviewQueueFingerprint: [...queueFingerprints][0] || null,
    totals: {
      expected: eligibleBenchmarkIds.size || null,
      reviewed: comparisons.length,
      stable: count("stable"),
      needsInspection: count("needs-inspection"),
      needsAdjudication: count("needs-adjudication"),
      mandatoryAdjudication: count("mandatory-adjudication"),
      missingFromReview: eligibleBenchmarkIds.size
        ? [...eligibleBenchmarkIds].filter((id) => !reviews.has(id)).length
        : benchmark.records.filter(
            (record) =>
              record.articleRating?.assessment?.rubricVersion ===
                "guided-human-rating-v1.1" &&
              !reviews.has(String(record.benchmarkId)),
          ).length,
    },
    rules: {
      stable: "Same severity band and within 5 points.",
      needsInspection: "Same severity band and 6–14 points apart.",
      needsAdjudication: "Different severity bands or at least 15 points apart.",
      mandatoryAdjudication:
        "Either judgment is Dire or Catastrophic, regardless of agreement.",
    },
    comparisons,
  };
}

export function markdownCalibrationReviewReport(report) {
  const lines = [
    "# DREAD blind calibration review",
    "",
    `Reviewed records: ${report.totals.reviewed}`,
    `Stable: ${report.totals.stable}`,
    `Needs inspection: ${report.totals.needsInspection}`,
    `Needs adjudication: ${report.totals.needsAdjudication}`,
    `Mandatory severe adjudication: ${report.totals.mandatoryAdjudication}`,
    `Not yet reviewed: ${report.totals.missingFromReview}`,
    "",
    "| Story | Original | Review | Difference | Status |",
    "|---|---:|---:|---:|---|",
  ];

  for (const comparison of report.comparisons) {
    lines.push(
      `| ${comparison.title.replaceAll("|", "\\|")} | ${comparison.originalScore} ${comparison.originalBand} | ${comparison.reviewScore} ${comparison.reviewBand} | ${comparison.signedDifference >= 0 ? "+" : ""}${comparison.signedDifference} | ${comparison.status} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function parseArguments(argumentsList) {
  const options = {
    benchmark: DEFAULT_BENCHMARK_FILE,
    inputs: [],
    output: DEFAULT_OUTPUT_FILE,
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const next = argumentsList[index + 1];
    if (argument === "--benchmark") options.benchmark = path.resolve(next);
    else if (argument === "--output") options.output = path.resolve(next);
    else if (argument.startsWith("--")) throw new Error(`Unknown argument: ${argument}`);
    else {
      options.inputs.push(path.resolve(argument));
      continue;
    }
    index += 1;
  }
  if (!options.inputs.length) options.inputs = [DEFAULT_REVIEWS_DIRECTORY];
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [benchmark, reviews] = await Promise.all([
    readFile(options.benchmark, "utf8").then(JSON.parse),
    loadBlindReviewExports(options.inputs),
  ]);
  const report = analyzeCalibrationReview(benchmark, reviews);
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(markdownCalibrationReviewReport(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
