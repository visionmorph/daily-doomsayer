import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyzeCalibrationReview,
  loadBlindReviewExports,
} from "./analyze-calibration-review.mjs";

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
const DEFAULT_ADJUDICATION_DIRECTORY = path.join(
  PROJECT_DIRECTORY,
  "data",
  "human-calibration",
  "reviews",
  "adjudicated",
);
const DEFAULT_OUTPUT_FILE = path.join(
  PROJECT_DIRECTORY,
  "data",
  "human-calibration",
  "calibration-benchmark.v2.json",
);

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

async function loadAdjudications(directory) {
  const adjudications = new Map();
  for (const file of await filesIn(directory)) {
    const payload = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(payload.records)) {
      throw new Error(`Adjudication file has no records array: ${file}`);
    }
    for (const record of payload.records) {
      if (!record.benchmarkId || !record.decision || !record.reasoning) continue;
      adjudications.set(String(record.benchmarkId), record);
    }
  }
  return adjudications;
}

function latestReviewRecords(reviewExports) {
  const records = new Map();
  for (const payload of reviewExports) {
    for (const record of payload.records) {
      if (record.status !== "rated") continue;
      const id = String(record.article?.benchmarkId || record.benchmarkId || "");
      if (!id) continue;
      const current = records.get(id);
      const time = Date.parse(record.completedAt || record.updatedAt || 0) || 0;
      const currentTime =
        Date.parse(current?.completedAt || current?.updatedAt || 0) || 0;
      if (!current || time >= currentTime) records.set(id, record);
    }
  }
  return records;
}

function resolvedRecord(original, review, comparison, adjudication) {
  let selected = review;
  let selectedScore = Number(review.articleRating.score);
  let resolution = "stable-review";

  if (adjudication) {
    resolution = adjudication.decision;
    if (adjudication.decision === "accept-original") {
      selected = original;
      selectedScore = Number(original.articleRating.score);
    } else if (adjudication.decision === "custom") {
      selectedScore = Number(adjudication.score);
      if (!Number.isFinite(selectedScore) || selectedScore < 0 || selectedScore > 100) {
        throw new Error(`Invalid custom adjudication score for ${original.benchmarkId}`);
      }
    } else if (adjudication.decision !== "accept-review") {
      throw new Error(`Unknown adjudication decision: ${adjudication.decision}`);
    }
  } else if (comparison.status !== "stable") {
    return null;
  }

  return {
    ...original,
    status: "rated",
    feedRating: selected.feedRating,
    articleRating: {
      ...selected.articleRating,
      score: selectedScore,
    },
    contextAdjustment:
      selectedScore - Number(selected.feedRating?.score || selectedScore),
    review: {
      status: adjudication ? "adjudicated" : "stable",
      resolution,
      originalScore: Number(original.articleRating.score),
      blindReviewScore: Number(review.articleRating.score),
      finalScore: selectedScore,
      absoluteDifference: comparison.absoluteDifference,
      bandChanged: comparison.bandChanged,
      factorChanges: comparison.factorChanges,
      reasoning: adjudication?.reasoning || "Blind review agreed within 5 points and the same severity band.",
      reviewedAt: review.completedAt || null,
      adjudicatedAt: adjudication?.adjudicatedAt || null,
    },
  };
}

export function buildCalibrationBenchmarkV2(
  benchmark,
  reviewExports,
  adjudications = new Map(),
) {
  const report = analyzeCalibrationReview(benchmark, reviewExports);
  const originals = new Map(
    benchmark.records.map((record) => [String(record.benchmarkId), record]),
  );
  const reviews = latestReviewRecords(reviewExports);
  const records = [];
  const unresolved = [];

  for (const comparison of report.comparisons) {
    const original = originals.get(comparison.benchmarkId);
    const review = reviews.get(comparison.benchmarkId);
    const resolved = resolvedRecord(
      original,
      review,
      comparison,
      adjudications.get(comparison.benchmarkId),
    );
    if (resolved) records.push(resolved);
    else {
      unresolved.push({
        benchmarkId: comparison.benchmarkId,
        title: comparison.title,
        status: comparison.status,
        originalScore: comparison.originalScore,
        reviewScore: comparison.reviewScore,
        absoluteDifference: comparison.absoluteDifference,
        bandChanged: comparison.bandChanged,
      });
    }
  }

  records.sort((left, right) =>
    String(left.article?.title).localeCompare(String(right.article?.title)),
  );
  unresolved.sort((left, right) =>
    right.absoluteDifference - left.absoluteDifference,
  );
  const pendingReviewRecords = report.totals.missingFromReview;
  const status = unresolved.length || pendingReviewRecords ? "draft" : "ready";

  return {
    schemaVersion: "2.0",
    benchmarkVersion: "calibration-benchmark.v2",
    status,
    asOf: new Date().toISOString(),
    sourceBenchmarkVersion: benchmark.benchmarkVersion,
    sourceBenchmarkAsOf: benchmark.asOf || null,
    calibrationMethod: benchmark.calibrationMethod,
    severityScale: benchmark.severityScale,
    modelConfiguration: benchmark.modelConfiguration || null,
    eligibility:
      "Real stories reviewed with guided-human-rating-v1.1; stable blind reviews or explicitly adjudicated outcomes only. Legacy slider and synthetic records are excluded.",
    totals: {
      reviewed: report.totals.reviewed,
      eligibleRecords: records.length,
      stableRecords: records.filter((record) => record.review.status === "stable").length,
      adjudicatedRecords: records.filter(
        (record) => record.review.status === "adjudicated",
      ).length,
      pendingReviewRecords,
      unresolvedRecords: unresolved.length,
      legacySliderRecordsExcluded: benchmark.records.filter(
        (record) => !record.articleRating?.assessment?.rubricVersion,
      ).length,
      syntheticRecords: 0,
    },
    unresolved,
    records,
  };
}

function parseArguments(argumentsList) {
  const options = {
    benchmark: DEFAULT_BENCHMARK_FILE,
    reviews: DEFAULT_REVIEWS_DIRECTORY,
    adjudications: DEFAULT_ADJUDICATION_DIRECTORY,
    output: DEFAULT_OUTPUT_FILE,
  };
  for (let index = 0; index < argumentsList.length; index += 2) {
    const argument = argumentsList[index];
    const next = argumentsList[index + 1];
    if (argument === "--benchmark") options.benchmark = path.resolve(next);
    else if (argument === "--reviews") options.reviews = path.resolve(next);
    else if (argument === "--adjudications") {
      options.adjudications = path.resolve(next);
    } else if (argument === "--output") options.output = path.resolve(next);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [benchmark, reviewExports, adjudications] = await Promise.all([
    readFile(options.benchmark, "utf8").then(JSON.parse),
    loadBlindReviewExports([options.reviews]),
    loadAdjudications(options.adjudications),
  ]);
  const benchmarkV2 = buildCalibrationBenchmarkV2(
    benchmark,
    reviewExports,
    adjudications,
  );
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(benchmarkV2, null, 2)}\n`);
  console.log(
    `Built ${benchmarkV2.benchmarkVersion} (${benchmarkV2.status}): ${benchmarkV2.totals.eligibleRecords} eligible, ${benchmarkV2.totals.pendingReviewRecords} pending review, ${benchmarkV2.totals.unresolvedRecords} unresolved`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
