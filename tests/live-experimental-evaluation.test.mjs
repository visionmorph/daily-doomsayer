import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  evaluateDreadExperiment,
  markdownLiveExperimentReport,
} from "../scripts/evaluate-dread-experimental.mjs";

const severityScale = [
  { minimum: 0, maximum: 19.99, label: "UNEASY" },
  { minimum: 20, maximum: 39.99, label: "OMINOUS" },
  { minimum: 40, maximum: 59.99, label: "ALARMING" },
  { minimum: 60, maximum: 79.99, label: "DIRE" },
  { minimum: 80, maximum: 100, label: "CATASTROPHIC" },
];

const evaluationOptions = {
  minimumLiveRecords: 50,
  recommendedHighConfidenceRecords: 30,
  recommendedSources: 10,
  bootstrapSamples: 500,
  bootstrapSeed: 1204,
};

function record({
  id,
  human,
  publicScore,
  experimentalScore,
  confidence = 3,
  source = "Publisher",
  publicVersion = "1.2.2",
  publicFormulaVersion = "1.2.2-shadow.1",
  experimentalVersion = "1.2.4",
  experimentalFormulaVersion = "1.2.4-offline.1",
  humanRubricVersion = "guided-human-rating-v1.1",
}) {
  return {
    benchmarkId: id,
    status: "rated",
    article: {
      title: `Story ${id}`,
      url: `https://example.com/${id}`,
      source,
    },
    feedRating: {
      score: human,
      confidence,
      assessment: { rubricVersion: humanRubricVersion },
    },
    articleRating: {
      score: human,
      confidence,
      assessment: { rubricVersion: humanRubricVersion },
    },
    models: {
      public: {
        version: publicVersion,
        formulaVersion: publicFormulaVersion,
        score: publicScore,
      },
      shadow: {
        version: experimentalVersion,
        formulaVersion: experimentalFormulaVersion,
        score: experimentalScore,
      },
    },
  };
}

function benchmark(records) {
  return {
    benchmarkVersion: "calibration-benchmark.v1",
    asOf: "2026-08-11T00:00:00.000Z",
    severityScale,
    records,
  };
}

function baseline(ids = []) {
  return {
    benchmarkVersion: "calibration-benchmark.v1",
    frozenAt: "2026-08-10T21:11:56.689Z",
    benchmarkIds: ids,
  };
}

test("live DREAD baseline freezes exactly 112 unique stories", async () => {
  const frozen = JSON.parse(
    await readFile(
      new URL(
        "../data/human-calibration/cohorts/dread-1.2.4-live-baseline.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );

  assert.equal(frozen.publicVersion, "1.2.2");
  assert.equal(frozen.experimentalVersion, "1.2.4");
  assert.equal(frozen.experimentalFormulaVersion, "1.2.4-offline.1");
  assert.equal(frozen.benchmarkIds.length, 112);
  assert.equal(new Set(frozen.benchmarkIds).size, 112);
});

test("evaluator separates the frozen baseline and rejects mixed model versions", () => {
  const records = [
    record({
      id: "frozen",
      human: 20,
      publicScore: 10,
      experimentalScore: 12,
      experimentalVersion: "1.2.3",
      experimentalFormulaVersion: "1.2.3-shadow.1",
    }),
    record({
      id: "live-valid",
      human: 20,
      publicScore: 30,
      experimentalScore: 22,
    }),
    record({
      id: "live-old-model",
      human: 20,
      publicScore: 30,
      experimentalScore: 22,
      experimentalVersion: "1.2.3",
      experimentalFormulaVersion: "1.2.3-shadow.1",
    }),
  ];
  const result = evaluateDreadExperiment(
    benchmark(records),
    baseline(["frozen"]),
    { ...evaluationOptions, minimumLiveRecords: 2 },
  );

  assert.equal(result.baseline.matchedRecords, 1);
  assert.equal(result.coverage.liveRecords, 2);
  assert.equal(result.coverage.eligibleRecords, 1);
  assert.equal(result.coverage.excluded.experimentalVersionMismatch, 1);
  assert.equal(result.status, "INSUFFICIENT_DATA");
});

test("evaluator reports insufficient data before 50 new eligible ratings", () => {
  const records = Array.from({ length: 49 }, (_, index) =>
    record({
      id: `live-${index}`,
      human: 30,
      publicScore: 40,
      experimentalScore: 32,
      source: `Publisher ${index % 10}`,
    }),
  );
  const result = evaluateDreadExperiment(
    benchmark(records),
    baseline(),
    evaluationOptions,
  );

  assert.equal(result.coverage.eligibleRecords, 49);
  assert.equal(result.status, "INSUFFICIENT_DATA");
  assert.equal(result.promotionReady, false);
});

test("evaluator excludes live ratings made with a superseded questionnaire", () => {
  const result = evaluateDreadExperiment(
    benchmark([
      record({
        id: "old-rubric",
        human: 30,
        publicScore: 40,
        experimentalScore: 32,
        humanRubricVersion: "guided-human-rating-v1",
      }),
    ]),
    baseline(),
    { ...evaluationOptions, minimumLiveRecords: 1 },
  );

  assert.equal(result.coverage.liveRecords, 1);
  assert.equal(result.coverage.eligibleRecords, 0);
  assert.equal(result.coverage.excluded.humanRubricVersionMismatch, 1);
  assert.equal(result.status, "INSUFFICIENT_DATA");
});

test("evaluator passes a clearly better experimental model on 50 live pairs", () => {
  const records = Array.from({ length: 50 }, (_, index) =>
    record({
      id: `live-${index}`,
      human: 30,
      publicScore: 40,
      experimentalScore: 32,
      source: `Publisher ${index % 10}`,
    }),
  );
  const result = evaluateDreadExperiment(
    benchmark(records),
    baseline(),
    evaluationOptions,
  );

  assert.equal(result.status, "PASS");
  assert.equal(result.promotionReady, true);
  assert.equal(result.paired.meanAbsoluteErrorImprovement, 8);
  assert.ok(result.paired.confidenceInterval95.lower > 0);
  assert.equal(result.paired.experimentalWins, 50);
  assert.equal(
    result.gates.find((item) => item.id === "paired-confidence").status,
    "pass",
  );
});

test("evaluator remains inconclusive when paired evidence does not separate models", () => {
  const records = Array.from({ length: 50 }, (_, index) =>
    index % 2 === 0
      ? record({
          id: `live-${index}`,
          human: 30,
          publicScore: 30,
          experimentalScore: 32,
          source: `Publisher ${index % 10}`,
        })
      : record({
          id: `live-${index}`,
          human: 30,
          publicScore: 32,
          experimentalScore: 30,
          source: `Publisher ${index % 10}`,
        }),
  );
  const first = evaluateDreadExperiment(
    benchmark(records),
    baseline(),
    evaluationOptions,
  );
  const second = evaluateDreadExperiment(
    benchmark(records),
    baseline(),
    evaluationOptions,
  );

  assert.equal(first.status, "INCONCLUSIVE");
  assert.ok(first.paired.confidenceInterval95.lower < 0);
  assert.ok(first.paired.confidenceInterval95.upper > 0);
  assert.deepEqual(first.paired, second.paired);
});

test("a safety regression blocks promotion even when average error improves", () => {
  const records = Array.from({ length: 50 }, (_, index) =>
    index === 0
      ? record({
          id: "severe",
          human: 70,
          publicScore: 70,
          experimentalScore: 30,
          source: "Publisher 0",
        })
      : record({
          id: `live-${index}`,
          human: 30,
          publicScore: 40,
          experimentalScore: 30,
          source: `Publisher ${index % 10}`,
        }),
  );
  const result = evaluateDreadExperiment(
    benchmark(records),
    baseline(),
    evaluationOptions,
  );

  assert.equal(result.metrics.experimental.article.meanAbsoluteError, 0.8);
  assert.equal(result.metrics.public.article.meanAbsoluteError, 9.8);
  assert.equal(result.risks.experimental.twoBandUnderCalls, 1);
  assert.equal(result.risks.public.twoBandUnderCalls, 0);
  assert.equal(result.status, "FAIL");
  assert.equal(result.promotionReady, false);
});

test("markdown report explains the frozen/live split and confidence interval", () => {
  const result = evaluateDreadExperiment(benchmark([]), baseline(), {
    ...evaluationOptions,
    minimumLiveRecords: 1,
  });
  const report = markdownLiveExperimentReport(result);

  assert.match(report, /Frozen baseline:/);
  assert.match(report, /New live holdout:/);
  assert.match(report, /95% confidence interval:/);
  assert.match(report, /INSUFFICIENT_DATA/);
});

test("package scripts and workflows expose the live evaluator", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const manualWorkflow = await readFile(
    new URL("../.github/workflows/evaluate-dread-experimental.yml", import.meta.url),
    "utf8",
  );
  const calibrationWorkflow = await readFile(
    new URL("../.github/workflows/update-calibration.yml", import.meta.url),
    "utf8",
  );

  assert.match(
    packageJson.scripts["evaluate-experimental:1.2.4"],
    /dread-1\.2\.4-live-baseline\.json/,
  );
  assert.match(
    packageJson.scripts["evaluate-experimental:1.2.4"],
    /guided-human-rating-v1\.1/,
  );
  assert.match(manualWorkflow, /evaluate-experimental:1\.2\.4/);
  assert.match(manualWorkflow, /--enforce/);
  assert.match(calibrationWorkflow, /evaluate-experimental:1\.2\.4/);
});
