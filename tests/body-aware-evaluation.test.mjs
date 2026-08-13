import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  evaluateDreadV130Comparison,
  markdownDreadV130Report,
} from "../scripts/evaluate-dread-v1.3.mjs";
import { bodyAwareStoryId } from "../scripts/dread-body-aware-store.mjs";

const severityScale = [
  { minimum: 0, maximum: 19.99, label: "UNEASY" },
  { minimum: 20, maximum: 39.99, label: "OMINOUS" },
  { minimum: 40, maximum: 59.99, label: "ALARMING" },
  { minimum: 60, maximum: 79.99, label: "DIRE" },
  { minimum: 80, maximum: 100, label: "CATASTROPHIC" },
];

function article(id, { publicScore, experimentalScore, bodyAwareScore }) {
  const url = `https://example.com/story-${id}?utm_source=feed`;
  return {
    storyId: `story-${id}`,
    title: `Story ${id}`,
    url,
    source: id === "two" ? "Second Publisher" : "Publisher",
    doomIndex: publicScore,
    doomIndexVersion: "1.2.2",
    doomIndexFormulaVersion: "1.2.2-shadow.1",
    doomIndexInputSummary: `Production summary ${id}`,
    doomIndexCoverageSources: 1,
    doomIndexV124Shadow: experimentalScore,
    doomIndexV124ShadowVersion: "1.2.4",
    doomIndexV124ShadowFormulaVersion: "1.2.4-offline.1",
    doomIndexV130BodyAware: bodyAwareScore,
    doomIndexV130BodyAwareVersion: "1.3.0",
    doomIndexV130BodyAwareFormulaVersion: "1.3.0-body-context.1",
    doomIndexV130BodyAwareInputFingerprint: `input-${id}`,
  };
}

function humanRecord(id, score, options = {}) {
  return {
    benchmarkId: `benchmark-${id}`,
    status: "rated",
    article: {
      storyId: `story-${id}`,
      title: `Story ${id}`,
      url: `https://example.com/story-${id}`,
      source: id === "two" ? "Second Publisher" : "Publisher",
    },
    scoringInput: {
      title: `Story ${id}`,
      summary: options.summary || `Production summary ${id}`,
      coverageSources: 1,
      provenance: "production",
    },
    articleRating: {
      score,
      confidence: options.confidence || 3,
      assessment: {
        rubricVersion:
          options.rubricVersion || "guided-human-rating-v1.1",
      },
    },
  };
}

function cacheFor(articles) {
  return {
    records: Object.fromEntries(
      articles.map((item, index) => [
        bodyAwareStoryId(item.url),
        {
          version: "1.3.0",
          formulaVersion: "1.3.0-body-context.1",
          inputFingerprint: item.doomIndexV130BodyAwareInputFingerprint,
          evidenceScope: index === 1 ? "feed-only" : "article-body",
          assessment: {
            confidence: "high",
            evidence: [
              {
                factor: "harm",
                level: 2,
                excerpt: "Confirmed material disruption was documented.",
              },
            ],
          },
          score: {
            value: item.doomIndexV130BodyAware,
            factors: {
              harm: 2,
              certainty: 3,
              reach: 2,
              reversibility: 1,
              containment: 1,
              recurrence: 1,
              vulnerability: 2,
            },
          },
        },
      ]),
    ),
  };
}

test("DREAD 1.3 comparison uses only exact guided production records", () => {
  const articles = [
    article("one", { publicScore: 20, experimentalScore: 30, bodyAwareScore: 39 }),
    article("two", { publicScore: 70, experimentalScore: 60, bodyAwareScore: 52 }),
    article("legacy", { publicScore: 10, experimentalScore: 10, bodyAwareScore: 10 }),
    article("changed", { publicScore: 10, experimentalScore: 10, bodyAwareScore: 10 }),
  ];
  const benchmark = {
    benchmarkVersion: "calibration-benchmark.v1",
    severityScale,
    records: [
      humanRecord("one", 40),
      humanRecord("two", 50),
      humanRecord("legacy", 10, { rubricVersion: "legacy-slider" }),
      humanRecord("changed", 10, { summary: "Different production summary" }),
    ],
  };
  const result = evaluateDreadV130Comparison(
    benchmark,
    articles,
    cacheFor(articles),
    { minimumRecords: 2 },
  );

  assert.equal(result.status, "EVALUATION_READY");
  assert.equal(result.coverage.eligibleRecords, 2);
  assert.equal(result.coverage.legacyOrDifferentHumanRubric, undefined);
  assert.equal(result.coverage.excluded.legacyOrDifferentHumanRubric, 1);
  assert.equal(result.coverage.excluded.productionInputMismatch, 1);
  assert.equal(result.coverage.bodyEvidenceRecords, 1);
  assert.equal(result.coverage.feedOnlyRecords, 1);
  assert.equal(result.metrics.bodyAware.all.meanAbsoluteError, 1.5);
  assert.ok(
    result.metrics.bodyAware.all.meanAbsoluteError <
      result.metrics.experimental.all.meanAbsoluteError,
  );
  assert.ok(
    result.metrics.bodyAware.all.meanAbsoluteError <
      result.metrics.public.all.meanAbsoluteError,
  );
});

test("comparison remains insufficient when exact guided overlap is too small", () => {
  const articles = [
    article("one", { publicScore: 20, experimentalScore: 30, bodyAwareScore: 39 }),
  ];
  const result = evaluateDreadV130Comparison(
    {
      benchmarkVersion: "calibration-benchmark.v1",
      severityScale,
      records: [humanRecord("one", 40)],
    },
    articles,
    cacheFor(articles),
    { minimumRecords: 25 },
  );

  assert.equal(result.status, "INSUFFICIENT_DATA");
  assert.equal(result.coverage.eligibleRecords, 1);
});

test("markdown report exposes safety, evidence, publisher, and rule diagnostics", () => {
  const articles = [
    article("one", { publicScore: 20, experimentalScore: 30, bodyAwareScore: 39 }),
  ];
  const result = evaluateDreadV130Comparison(
    {
      benchmarkVersion: "calibration-benchmark.v1",
      severityScale,
      records: [humanRecord("one", 40)],
    },
    articles,
    cacheFor(articles),
    { minimumRecords: 1 },
  );
  const markdown = markdownDreadV130Report(result);

  assert.match(markdown, /Model agreement with guided human ratings/);
  assert.match(markdown, /Safety errors/);
  assert.match(markdown, /Results by DREAD 1\.3 evidence source/);
  assert.match(markdown, /Results by publisher/);
  assert.match(markdown, /Factors: harm 2, certainty 3/);
  assert.match(markdown, /Confirmed material disruption was documented/);
});

test("package and workflow expose the DREAD 1.3 comparison", async () => {
  const [packageFile, workflow] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(
      new URL("../.github/workflows/evaluate-dread-1.3.yml", import.meta.url),
      "utf8",
    ),
  ]);

  assert.equal(
    packageFile.scripts["evaluate-body-aware:1.3"],
    "node scripts/evaluate-dread-v1.3.mjs",
  );
  assert.match(workflow, /Evaluate DREAD 1\.3 body awareness/);
  assert.match(workflow, /npm run --silent evaluate-body-aware:1\.3/);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
});
