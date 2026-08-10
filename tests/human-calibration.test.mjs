import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("DREAD 1.2.4 development cohort freezes 81 unique benchmark records", async () => {
  const cohort = JSON.parse(
    await readFile(
      new URL(
        "../data/human-calibration/cohorts/dread-1.2.4-development.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );

  assert.equal(cohort.candidateVersion, "1.2.4");
  assert.equal(cohort.benchmarkIds.length, 81);
  assert.equal(new Set(cohort.benchmarkIds).size, 81);
});

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
    {
      candidateVersion: "1.2.4",
      minimumHoldoutRecords: 2,
      minimumHighConfidenceRecords: 1,
      minimumHoldoutSources: 1,
    },
  );

  assert.equal(evaluation.passed, true);
  assert.equal(evaluation.status, "PASS");
  assert.equal(evaluation.cohorts.development.records, 0);
  assert.equal(evaluation.cohorts.holdout.records, 2);
  assert.equal(
    evaluation.cohorts.holdout.metrics.candidate.article.meanAbsoluteError,
    0,
  );
  assert.equal(evaluation.cohorts.holdout.risk.candidate.severeUnderCalls, 0);
  assert.equal(evaluation.cohorts.holdout.inputAudit.exactProductionInputs, 2);
  assert.equal(first.models.public.score, 20);
});

test("candidate harness separates frozen development records from future holdout records", async () => {
  const development = record({
    storyId: "development",
    title: "Development",
    updatedAt: "2026-08-08T00:00:00.000Z",
    human: 30,
    publicScore: 10,
    shadowScore: 15,
  });
  const routine = record({
    storyId: "holdout-routine",
    title: "Holdout routine",
    updatedAt: "2026-08-09T00:00:00.000Z",
    human: 10,
    publicScore: 20,
    shadowScore: 25,
  });
  const concerning = record({
    storyId: "holdout-concerning",
    title: "Holdout concerning",
    updatedAt: "2026-08-09T01:00:00.000Z",
    human: 45,
    publicScore: 15,
    shadowScore: 20,
  });
  const dire = record({
    storyId: "holdout-dire",
    title: "Holdout dire",
    updatedAt: "2026-08-09T02:00:00.000Z",
    human: 70,
    publicScore: 30,
    shadowScore: 35,
  });
  for (const item of [development, routine, concerning, dire]) {
    item.benchmarkId = item.article.storyId;
    item.scoringInput = {
      title: item.article.title,
      summary: "Exact production input",
      coverageSources: 1,
      provenance: "production",
    };
  }
  const benchmark = {
    benchmarkVersion: "calibration-benchmark.v1",
    asOf: "2026-08-09T03:00:00.000Z",
    severityScale,
    records: [development, routine, concerning, dire],
  };
  const scores = new Map([
    ["Holdout routine", 10],
    ["Holdout concerning", 45],
    ["Holdout dire", 70],
    ["Development", 30],
  ]);

  const evaluation = await evaluateDreadCandidate(
    benchmark,
    ({ title }) => scores.get(title),
    {
      developmentBenchmarkIds: ["development"],
      minimumHoldoutRecords: 3,
      minimumHighConfidenceRecords: 1,
      minimumHoldoutSources: 1,
    },
  );

  assert.equal(evaluation.cohorts.development.records, 1);
  assert.equal(evaluation.cohorts.holdout.records, 3);
  assert.equal(evaluation.cohorts.combined.records, 4);
  assert.equal(evaluation.status, "PASS");
  assert.equal(evaluation.promotionReady, true);
  assert.equal(
    evaluation.cohorts.holdout.metrics.candidate.article.meanAbsoluteError,
    0,
  );
});

test("candidate harness reports insufficient data before the holdout minimum", async () => {
  const development = record({
    storyId: "development",
    title: "Development",
    updatedAt: "2026-08-08T00:00:00.000Z",
    human: 20,
    publicScore: 10,
    shadowScore: 12,
  });
  const holdout = record({
    storyId: "holdout",
    title: "Holdout",
    updatedAt: "2026-08-09T00:00:00.000Z",
    human: 20,
    publicScore: 10,
    shadowScore: 12,
  });
  development.benchmarkId = "development";
  holdout.benchmarkId = "holdout";
  const benchmark = {
    benchmarkVersion: "calibration-benchmark.v1",
    asOf: "2026-08-09T00:00:00.000Z",
    severityScale,
    records: [development, holdout],
  };

  const evaluation = await evaluateDreadCandidate(benchmark, () => 20, {
    developmentBenchmarkIds: ["development"],
    minimumHoldoutRecords: 2,
    minimumHighConfidenceRecords: 1,
    minimumHoldoutSources: 1,
  });

  assert.equal(evaluation.status, "INSUFFICIENT_DATA");
  assert.equal(evaluation.promotionReady, false);
  assert.equal(
    evaluation.gates.find((gate) => gate.id === "minimum-holdout-records")
      .status,
    "fail",
  );
});

test("candidate promotion must beat both public and experimental models", async () => {
  const holdout = record({
    storyId: "holdout",
    title: "Holdout",
    updatedAt: "2026-08-09T00:00:00.000Z",
    human: 10,
    publicScore: 20,
    shadowScore: 10,
  });
  holdout.benchmarkId = "holdout";
  holdout.scoringInput = {
    title: "Holdout",
    summary: "Exact production input",
    coverageSources: 1,
    provenance: "production",
  };
  const benchmark = {
    benchmarkVersion: "calibration-benchmark.v1",
    asOf: "2026-08-09T00:00:00.000Z",
    severityScale,
    records: [holdout],
  };

  const evaluation = await evaluateDreadCandidate(benchmark, () => 15, {
    minimumHoldoutRecords: 1,
    minimumHighConfidenceRecords: 1,
    minimumHoldoutSources: 1,
  });
  const articleGate = evaluation.gates.find(
    (gate) => gate.id === "article-mae",
  );

  assert.equal(articleGate.status, "fail");
  assert.equal(evaluation.status, "FAIL");
  assert.equal(evaluation.promotionReady, false);
});
