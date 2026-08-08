import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCalibrationBenchmark } from "../scripts/analyze-human-calibration.mjs";
import { buildCalibrationBenchmark } from "../scripts/build-calibration-benchmark.mjs";
import { evaluateDreadCandidate } from "../scripts/evaluate-dread-candidate.mjs";

const severityScale = [
  { minimum: 0, maximum: 19.99, label: "UNEASY" },
  { minimum: 20, maximum: 39.99, label: "OMINOUS" },
  { minimum: 40, maximum: 59.99, label: "ALARMING" },
  { minimum: 60, maximum: 79.99, label: "DIRE" },
  { minimum: 80, maximum: 100, label: "CATASTROPHIC" },
];

function record({ storyId, title, updatedAt, human, publicScore, shadowScore }) {
  return {
    status: "rated",
    article: {
      storyId,
      title,
      url: `https://example.com/${storyId}`,
      source: "Example",
      published: "2026-08-08T00:00:00.000Z",
    },
    feedEvidence: { summary: "Summary", summaryAvailable: true },
    feedRating: { score: human, confidence: 3, reasoning: "Feed evidence" },
    articleRating: { score: human, confidence: 3, reasoning: "Article evidence" },
    models: {
      public: { score: publicScore },
      shadow: { score: shadowScore },
    },
    contextAdjustment: 0,
    updatedAt,
    completedAt: updatedAt,
  };
}

function calibrationExport(exportedAt, records) {
  return {
    calibrationExport: {
      schemaVersion: "1.0",
      exportedAt,
      severityScale,
      records,
    },
    fingerprint: exportedAt,
  };
}

test("benchmark removes overlapping snapshots and exact-title duplicates", () => {
  const oldRecord = record({
    storyId: "one",
    title: "Same story",
    updatedAt: "2026-08-07T00:00:00.000Z",
    human: 20,
    publicScore: 10,
    shadowScore: 12,
  });
  const updatedRecord = {
    ...oldRecord,
    articleRating: { ...oldRecord.articleRating, score: 24 },
    updatedAt: "2026-08-08T00:00:00.000Z",
    completedAt: "2026-08-08T00:00:00.000Z",
  };
  const duplicateTitle = record({
    storyId: "two",
    title: "Same story!",
    updatedAt: "2026-08-08T01:00:00.000Z",
    human: 24,
    publicScore: 10,
    shadowScore: 12,
  });

  const benchmark = buildCalibrationBenchmark([
    calibrationExport("2026-08-07T01:00:00.000Z", [oldRecord]),
    calibrationExport("2026-08-08T02:00:00.000Z", [updatedRecord, duplicateTitle]),
  ]);

  assert.equal(benchmark.totals.rawRatedRecords, 3);
  assert.equal(benchmark.totals.storyRecords, 2);
  assert.equal(benchmark.totals.benchmarkRecords, 1);
  assert.equal(benchmark.totals.snapshotDuplicatesRemoved, 1);
  assert.equal(benchmark.totals.exactTitleDuplicatesRemoved, 1);
  assert.equal(benchmark.records[0].aliases.length, 2);
  assert.equal(benchmark.records[0].articleRating.score, 24);
});

test("benchmark prefers exact scoring inputs when snapshot timestamps tie", () => {
  const original = record({
    storyId: "one",
    title: "One",
    updatedAt: "2026-08-08T00:00:00.000Z",
    human: 20,
    publicScore: 10,
    shadowScore: 12,
  });
  const enriched = {
    ...original,
    scoringInput: {
      title: "One",
      summary: "Exact clustered production summary",
      coverageSources: 2,
      provenance: "production",
    },
  };
  const benchmark = buildCalibrationBenchmark([
    calibrationExport("2026-08-08T01:00:00.000Z", [original]),
    calibrationExport("2026-08-08T02:00:00.000Z", [enriched]),
  ]);

  assert.equal(benchmark.records[0].scoringInput.provenance, "production");
  assert.equal(benchmark.records[0].scoringInput.coverageSources, 2);
});

test("analyzer reports public and shadow agreement separately", () => {
  const benchmark = {
    benchmarkVersion: "calibration-benchmark.v1",
    asOf: "2026-08-08T00:00:00.000Z",
    severityScale,
    totals: { benchmarkRecords: 2 },
    records: [
      record({
        storyId: "one",
        title: "One",
        updatedAt: "2026-08-08T00:00:00.000Z",
        human: 10,
        publicScore: 10,
        shadowScore: 20,
      }),
      record({
        storyId: "two",
        title: "Two",
        updatedAt: "2026-08-08T00:00:00.000Z",
        human: 30,
        publicScore: 20,
        shadowScore: 30,
      }),
    ],
  };

  const analysis = analyzeCalibrationBenchmark(benchmark);

  assert.equal(analysis.records, 2);
  assert.equal(analysis.metrics.publicArticle.meanAbsoluteError, 5);
  assert.equal(analysis.metrics.shadowArticle.meanAbsoluteError, 5);
  assert.equal(analysis.modelComparison.identical, 0);
  assert.equal(analysis.modelComparison.shadowHigher, 2);
});

test("candidate harness evaluates promotion gates without changing stored models", async () => {
  const first = record({
    storyId: "routine",
    title: "Routine",
    updatedAt: "2026-08-08T00:00:00.000Z",
    human: 10,
    publicScore: 20,
    shadowScore: 25,
  });
  const second = record({
    storyId: "severe",
    title: "Severe",
    updatedAt: "2026-08-08T00:00:00.000Z",
    human: 70,
    publicScore: 30,
    shadowScore: 35,
  });
  first.benchmarkId = "routine";
  second.benchmarkId = "severe";
  first.scoringInput = {
    title: "Routine",
    summary: "Routine story",
    coverageSources: 1,
  };
  second.scoringInput = {
    title: "Severe",
    summary: "Severe story",
    coverageSources: 1,
  };
  const benchmark = {
    benchmarkVersion: "calibration-benchmark.v1",
    asOf: "2026-08-08T00:00:00.000Z",
    severityScale,
    records: [first, second],
  };

  const evaluation = await evaluateDreadCandidate(
    benchmark,
    ({ title }) => (title === "Severe" ? 70 : 10),
    { candidateVersion: "1.2.4" },
  );

  assert.equal(evaluation.passed, true);
  assert.equal(evaluation.metrics.candidate.article.meanAbsoluteError, 0);
  assert.equal(evaluation.risk.candidate.severeUnderCalls, 0);
  assert.equal(evaluation.inputAudit.exactProductionInputs, 2);
  assert.equal(first.models.public.score, 20);
});
