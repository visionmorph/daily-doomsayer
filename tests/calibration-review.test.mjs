import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildCalibrationReviewQueue,
} from "../scripts/build-calibration-review-queue.mjs";
import {
  analyzeCalibrationReview,
} from "../scripts/analyze-calibration-review.mjs";
import {
  buildCalibrationBenchmarkV2,
} from "../scripts/build-calibration-benchmark-v2.mjs";

const severityScale = [
  { minimum: 0, maximum: 19.99, label: "UNEASY" },
  { minimum: 20, maximum: 39.99, label: "OMINOUS" },
  { minimum: 40, maximum: 59.99, label: "ALARMING" },
  { minimum: 60, maximum: 79.99, label: "DIRE" },
  { minimum: 80, maximum: 100, label: "CATASTROPHIC" },
];

function rating(score, rubricVersion = "guided-human-rating-v1.1") {
  return {
    score,
    confidence: 3,
    assessment: {
      rubricVersion,
      selection: "middle",
      factors: {
        harm: { level: score >= 40 ? 2 : 1, label: "Test harm" },
      },
      recommendation: {
        score,
        effectiveBand:
          severityScale.find(
            (band) => score >= band.minimum && score <= band.maximum,
          )?.label || "UNCLASSIFIED",
      },
    },
  };
}

function record(id, score, rubricVersion = "guided-human-rating-v1.1") {
  return {
    benchmarkId: id,
    status: "rated",
    article: {
      storyId: `story-${id}`,
      title: `Story ${id}`,
      url: `https://example.com/${id}`,
      source: "Example",
      published: "2026-08-12T00:00:00.000Z",
    },
    feedEvidence: { summary: `Summary ${id}` },
    scoringInput: { summary: `Private scoring input ${id}` },
    feedRating: rating(score, rubricVersion),
    articleRating: rating(score, rubricVersion),
    models: {
      public: { score: 1 },
      shadow: { score: 2 },
    },
    completedAt: "2026-08-12T01:00:00.000Z",
  };
}

function reviewExport(queue, reviewedScores) {
  return {
    exportType: "blind-calibration-review",
    reviewQueue: {
      fingerprint: queue.queueFingerprint,
      totalRecords: queue.records.length,
      eligibleBenchmarkIds: queue.records.map((record) => record.benchmarkId),
    },
    records: queue.records.map((queued) => ({
      status: "rated",
      article: queued.article,
      feedRating: rating(reviewedScores[queued.benchmarkId]),
      articleRating: rating(reviewedScores[queued.benchmarkId]),
      completedAt: "2026-08-13T01:00:00.000Z",
    })),
  };
}

test("review queue includes only new guided records and removes all prior judgments", () => {
  const benchmark = {
    benchmarkVersion: "calibration-benchmark.v1",
    asOf: "2026-08-12T00:00:00.000Z",
    severityScale,
    records: [
      record("baseline", 10, null),
      record("legacy-live", 20, null),
      record("guided-a", 30),
      record("guided-b", 50),
    ],
  };
  const baseline = { benchmarkIds: ["baseline"], frozenAt: "2026-08-10" };
  const queue = buildCalibrationReviewQueue(benchmark, baseline);

  assert.equal(queue.records.length, 2);
  assert.deepEqual(
    new Set(queue.records.map((entry) => entry.benchmarkId)),
    new Set(["guided-a", "guided-b"]),
  );
  const serialized = JSON.stringify(queue.records);
  assert.doesNotMatch(serialized, /articleRating|feedRating|models|scoringInput/);
  assert.doesNotMatch(serialized, /Private scoring input/);
});

test("review comparison applies stability and mandatory severe rules", () => {
  const benchmark = {
    benchmarkVersion: "calibration-benchmark.v1",
    asOf: "2026-08-12T00:00:00.000Z",
    severityScale,
    records: [record("stable", 25), record("inspect", 25), record("band", 38), record("severe", 65)],
  };
  const queue = buildCalibrationReviewQueue(benchmark, { benchmarkIds: [] });
  const report = analyzeCalibrationReview(benchmark, [
    reviewExport(queue, {
      stable: 28,
      inspect: 34,
      band: 42,
      severe: 66,
    }),
  ]);

  const statuses = Object.fromEntries(
    report.comparisons.map((comparison) => [comparison.benchmarkId, comparison.status]),
  );
  assert.equal(statuses.stable, "stable");
  assert.equal(statuses.inspect, "needs-inspection");
  assert.equal(statuses.band, "needs-adjudication");
  assert.equal(statuses.severe, "mandatory-adjudication");
});

test("benchmark v2 accepts stable reviews and explicit adjudications only", () => {
  const benchmark = {
    benchmarkVersion: "calibration-benchmark.v1",
    asOf: "2026-08-12T00:00:00.000Z",
    calibrationMethod: { humanRatingMethod: "guided-human-rating-v1.1" },
    severityScale,
    records: [record("stable", 25), record("band", 38), record("severe", 65), record("legacy", 10, null)],
  };
  const queue = buildCalibrationReviewQueue(benchmark, { benchmarkIds: [] });
  const reviews = [
    reviewExport(queue, { stable: 28, band: 42, severe: 66 }),
  ];
  const adjudications = new Map([
    [
      "band",
      {
        benchmarkId: "band",
        decision: "accept-review",
        reasoning: "The reviewed band is supported by the complete article.",
        adjudicatedAt: "2026-08-14T00:00:00.000Z",
      },
    ],
  ]);
  const v2 = buildCalibrationBenchmarkV2(benchmark, reviews, adjudications);

  assert.equal(v2.benchmarkVersion, "calibration-benchmark.v2");
  assert.equal(v2.totals.eligibleRecords, 2);
  assert.equal(v2.totals.unresolvedRecords, 1);
  assert.equal(v2.totals.pendingReviewRecords, 0);
  assert.equal(v2.status, "draft");
  assert.deepEqual(
    new Set(v2.records.map((entry) => entry.benchmarkId)),
    new Set(["stable", "band"]),
  );
  assert.equal(v2.unresolved[0].benchmarkId, "severe");
  assert.equal(v2.totals.syntheticRecords, 0);
});

test("blind review page uses isolated storage and does not load articles.js", async () => {
  const [html, script, packageText, workflow] = await Promise.all([
    readFile(new URL("../rate-stories.html", import.meta.url), "utf8"),
    readFile(new URL("../rate-stories.js", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(
      new URL("../.github/workflows/update-calibration-review.yml", import.meta.url),
      "utf8",
    ),
  ]);
  const packageJson = JSON.parse(packageText);

  assert.match(html, /reviewMode \? "\.\/review-queue\.js" : "\.\/articles\.js"/);
  assert.match(script, /daily-doomsayer-blind-review-/);
  assert.match(script, /Previous ratings and DREAD scores remain hidden/);
  assert.match(script, /previousHumanRatingsHidden: true/);
  assert.ok(packageJson.scripts["build-calibration-review-queue"]);
  assert.ok(packageJson.scripts["analyze-calibration-review"]);
  assert.ok(packageJson.scripts["build-calibration-benchmark:v2"]);
  assert.match(workflow, /data\/human-calibration\/reviews\/raw/);
});
