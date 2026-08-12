import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
const DEFAULT_JSON_OUTPUT = path.join(
  PROJECT_DIRECTORY,
  "data",
  "human-calibration",
  "review-queues",
  "guided-v1.1-live-review.json",
);
const DEFAULT_JAVASCRIPT_OUTPUT = path.join(
  PROJECT_DIRECTORY,
  "review-queue.js",
);
const DEFAULT_RUBRIC_VERSION = "guided-human-rating-v1.1";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function clean(value) {
  return String(value || "").trim();
}

function sanitizedRecord(record) {
  return {
    benchmarkId: String(record.benchmarkId),
    article: {
      benchmarkId: String(record.benchmarkId),
      storyId: record.article?.storyId || null,
      title: clean(record.article?.title),
      url: clean(record.article?.url),
      source: clean(record.article?.source),
      published: clean(record.article?.published),
    },
    feedSummary: clean(record.feedEvidence?.summary),
  };
}

function deterministicOrder(record, salt) {
  return sha256(`${salt}\n${record.benchmarkId}`);
}

export function buildCalibrationReviewQueue(
  benchmark,
  baseline,
  { rubricVersion = DEFAULT_RUBRIC_VERSION } = {},
) {
  if (!Array.isArray(benchmark?.records)) {
    throw new Error("The calibration benchmark has no records array.");
  }
  if (!Array.isArray(benchmark?.severityScale)) {
    throw new Error("The calibration benchmark has no severity scale.");
  }
  if (!Array.isArray(baseline?.benchmarkIds)) {
    throw new Error("The frozen live baseline has no benchmark IDs.");
  }

  const baselineIds = new Set(baseline.benchmarkIds.map(String));
  const salt = [
    "blind-calibration-review.v1",
    benchmark.benchmarkVersion,
    benchmark.asOf,
    rubricVersion,
  ].join("\n");
  const records = benchmark.records
    .filter(
      (record) =>
        record.status === "rated" &&
        !baselineIds.has(String(record.benchmarkId)) &&
        record.articleRating?.assessment?.rubricVersion === rubricVersion,
    )
    .map(sanitizedRecord)
    .filter((record) => record.article.title && record.article.url)
    .sort((left, right) =>
      deterministicOrder(left, salt).localeCompare(
        deterministicOrder(right, salt),
      ),
    );
  const fingerprint = sha256(
    JSON.stringify({
      sourceBenchmarkVersion: benchmark.benchmarkVersion,
      sourceBenchmarkAsOf: benchmark.asOf,
      rubricVersion,
      records,
    }),
  ).slice(0, 20);

  return {
    schemaVersion: "1.0",
    queueVersion: "blind-calibration-review.v1",
    queueFingerprint: fingerprint,
    generatedAt: new Date().toISOString(),
    sourceBenchmarkVersion: benchmark.benchmarkVersion,
    sourceBenchmarkAsOf: benchmark.asOf || null,
    sourceBaselineFrozenAt: baseline.frozenAt || null,
    humanRubricVersion: rubricVersion,
    blindness: {
      excludedFields: [
        "previous human ratings",
        "previous questionnaire selections and recommendations",
        "public DREAD scores",
        "experimental DREAD scores",
        "model-error rankings",
      ],
      order: "deterministically-shuffled",
    },
    severityScale: benchmark.severityScale,
    totals: {
      records: records.length,
      frozenBaselineRecords: baselineIds.size,
    },
    records,
  };
}

function parseArguments(argumentsList) {
  const options = {
    benchmark: DEFAULT_BENCHMARK_FILE,
    baseline: DEFAULT_BASELINE_FILE,
    jsonOutput: DEFAULT_JSON_OUTPUT,
    javascriptOutput: DEFAULT_JAVASCRIPT_OUTPUT,
    rubricVersion: DEFAULT_RUBRIC_VERSION,
  };

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const next = argumentsList[index + 1];
    if (argument === "--benchmark") options.benchmark = path.resolve(next);
    else if (argument === "--baseline") options.baseline = path.resolve(next);
    else if (argument === "--json-output") options.jsonOutput = path.resolve(next);
    else if (argument === "--javascript-output") {
      options.javascriptOutput = path.resolve(next);
    } else if (argument === "--rubric-version") options.rubricVersion = next;
    else throw new Error(`Unknown argument: ${argument}`);
    index += 1;
  }

  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [benchmark, baseline] = await Promise.all([
    readFile(options.benchmark, "utf8").then(JSON.parse),
    readFile(options.baseline, "utf8").then(JSON.parse),
  ]);
  const queue = buildCalibrationReviewQueue(benchmark, baseline, options);
  const serialized = `${JSON.stringify(queue, null, 2)}\n`;
  const javascript =
    "// Generated by scripts/build-calibration-review-queue.mjs. Do not edit by hand.\n" +
    `window.DAILY_DOOMSAYER_REVIEW_QUEUE = ${JSON.stringify(queue, null, 2)};\n`;

  await Promise.all([
    mkdir(path.dirname(options.jsonOutput), { recursive: true }).then(() =>
      writeFile(options.jsonOutput, serialized, "utf8"),
    ),
    mkdir(path.dirname(options.javascriptOutput), { recursive: true }).then(() =>
      writeFile(options.javascriptOutput, javascript, "utf8"),
    ),
  ]);
  console.log(
    `Built ${queue.queueVersion}: ${queue.totals.records} sanitized records (${queue.queueFingerprint})`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
