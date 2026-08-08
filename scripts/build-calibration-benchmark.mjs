import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_RAW_DIRECTORY = path.join(
  PROJECT_DIRECTORY,
  "data",
  "human-calibration",
  "raw",
);
const DEFAULT_OUTPUT_FILE = path.join(
  PROJECT_DIRECTORY,
  "data",
  "human-calibration",
  "calibration-benchmark.v1.json",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function recordTimestamp(record) {
  const timestamp =
    record.completedAt ||
    record.updatedAt ||
    record.articleRating?.ratedAt ||
    record.feedRating?.ratedAt ||
    "";
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

function scoringInputQuality(record) {
  if (record.scoringInput?.provenance === "production") return 2;
  if (String(record.scoringInput?.summary || "").trim()) return 1;
  return 0;
}

function storyIdentity(record) {
  return String(
    record.article?.storyId ||
      record.article?.url ||
      normalizedTitle(record.article?.title),
  );
}

function aliasFor(record) {
  return {
    storyId: record.article?.storyId || null,
    title: record.article?.title || "",
    url: record.article?.url || "",
    source: record.article?.source || "",
    published: record.article?.published || "",
  };
}

function uniqueAliases(records) {
  const aliases = new Map();

  for (const record of records) {
    const alias = aliasFor(record);
    const key = `${alias.storyId || ""}\n${alias.url}\n${alias.title}`;
    aliases.set(key, alias);
  }

  return [...aliases.values()].sort((left, right) =>
    `${left.title}\n${left.url}`.localeCompare(`${right.title}\n${right.url}`),
  );
}

function newestRecord(records) {
  return [...records].sort((left, right) => {
    const timestampDifference = recordTimestamp(right) - recordTimestamp(left);
    if (timestampDifference) return timestampDifference;
    const inputQualityDifference =
      scoringInputQuality(right) - scoringInputQuality(left);
    if (inputQualityDifference) return inputQualityDifference;
    return storyIdentity(left).localeCompare(storyIdentity(right));
  })[0];
}

function benchmarkId(record) {
  return sha256(
    `${normalizedTitle(record.article?.title)}\n${record.article?.url || ""}`,
  ).slice(0, 20);
}

function validateExport(calibrationExport, source) {
  if (!calibrationExport || typeof calibrationExport !== "object") {
    throw new Error(`Calibration export is not an object: ${source}`);
  }

  if (!Array.isArray(calibrationExport.records)) {
    throw new Error(`Calibration export has no records array: ${source}`);
  }

  if (!Array.isArray(calibrationExport.severityScale)) {
    throw new Error(`Calibration export has no severity scale: ${source}`);
  }
}

async function filesFromPath(inputPath) {
  const resolved = path.resolve(inputPath);
  const entries = await readdir(resolved, { withFileTypes: true }).catch(() => null);

  if (!entries) return [resolved];

  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .map((entry) => path.join(resolved, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

async function loadExports(inputPaths) {
  const files = (
    await Promise.all(inputPaths.map((inputPath) => filesFromPath(inputPath)))
  ).flat();

  if (!files.length) {
    throw new Error("No calibration export files were found.");
  }

  const exports = [];

  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const calibrationExport = JSON.parse(raw);
    validateExport(calibrationExport, file);
    exports.push({
      calibrationExport,
      fingerprint: sha256(raw),
    });
  }

  return exports.sort((left, right) => {
    const dateDifference =
      Date.parse(left.calibrationExport.exportedAt || 0) -
      Date.parse(right.calibrationExport.exportedAt || 0);
    return dateDifference || left.fingerprint.localeCompare(right.fingerprint);
  });
}

function titleRatingConflict(records) {
  const scores = new Set(
    records.map((record) => Number(record.articleRating?.score)).filter(Number.isFinite),
  );
  return scores.size > 1;
}

export function buildCalibrationBenchmark(calibrationExports) {
  if (!Array.isArray(calibrationExports) || !calibrationExports.length) {
    throw new Error("At least one calibration export is required.");
  }

  const rawRatedRecords = calibrationExports.flatMap(({ calibrationExport }) =>
    calibrationExport.records.filter((record) => record.status === "rated"),
  );
  const recordsByStory = new Map();

  for (const record of rawRatedRecords) {
    const key = storyIdentity(record);
    const existing = recordsByStory.get(key);
    recordsByStory.set(
      key,
      existing ? newestRecord([existing, record]) : record,
    );
  }

  const storyRecords = [...recordsByStory.values()];
  const recordsByTitle = new Map();

  for (const record of storyRecords) {
    const key = normalizedTitle(record.article?.title) || storyIdentity(record);
    const records = recordsByTitle.get(key) || [];
    records.push(record);
    recordsByTitle.set(key, records);
  }

  let titleRatingConflicts = 0;
  const benchmarkRecords = [];

  for (const records of recordsByTitle.values()) {
    const selected = newestRecord(records);
    if (titleRatingConflict(records)) titleRatingConflicts += 1;
    benchmarkRecords.push({
      benchmarkId: benchmarkId(selected),
      aliases: uniqueAliases(records),
      ...selected,
    });
  }

  benchmarkRecords.sort((left, right) =>
    normalizedTitle(left.article?.title).localeCompare(
      normalizedTitle(right.article?.title),
    ),
  );

  const latestExport = calibrationExports.at(-1).calibrationExport;
  const exportedTimes = calibrationExports
    .map(({ calibrationExport }) => calibrationExport.exportedAt)
    .filter(Boolean)
    .sort();

  return {
    schemaVersion: "1.0",
    benchmarkVersion: "calibration-benchmark.v1",
    asOf: exportedTimes.at(-1) || null,
    calibrationMethod: latestExport.calibrationMethod || null,
    severityScale: latestExport.severityScale,
    modelConfiguration: latestExport.modelConfiguration || null,
    sourceExports: calibrationExports.map(
      ({ calibrationExport, fingerprint }) => ({
        fingerprint,
        exportedAt: calibrationExport.exportedAt || null,
        rated: calibrationExport.records.filter(
          (record) => record.status === "rated",
        ).length,
        skipped: calibrationExport.records.filter(
          (record) => record.status === "skipped",
        ).length,
      }),
    ),
    deduplication: {
      snapshotIdentity: "article.storyId, then article.url, then normalized title",
      articleIdentity: "normalized exact title",
      retainedRecord: "newest completedAt or updatedAt",
      eventCoverageCollapsed: false,
    },
    totals: {
      sourceExports: calibrationExports.length,
      rawRatedRecords: rawRatedRecords.length,
      storyRecords: storyRecords.length,
      benchmarkRecords: benchmarkRecords.length,
      snapshotDuplicatesRemoved: rawRatedRecords.length - storyRecords.length,
      exactTitleDuplicatesRemoved: storyRecords.length - benchmarkRecords.length,
      titleRatingConflicts,
    },
    records: benchmarkRecords,
  };
}

function parseArguments(argumentsList) {
  const inputs = [];
  let output = DEFAULT_OUTPUT_FILE;

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--output") {
      output = path.resolve(argumentsList[index + 1]);
      index += 1;
    } else {
      inputs.push(path.resolve(argument));
    }
  }

  return {
    inputs: inputs.length ? inputs : [DEFAULT_RAW_DIRECTORY],
    output,
  };
}

async function main() {
  const { inputs, output } = parseArguments(process.argv.slice(2));
  const calibrationExports = await loadExports(inputs);
  const benchmark = buildCalibrationBenchmark(calibrationExports);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(benchmark, null, 2)}\n`, "utf8");
  console.log(
    `Built ${benchmark.benchmarkVersion}: ${benchmark.totals.benchmarkRecords} records ` +
      `(${benchmark.totals.snapshotDuplicatesRemoved} snapshot duplicates and ` +
      `${benchmark.totals.exactTitleDuplicatesRemoved} exact-title duplicates removed).`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
