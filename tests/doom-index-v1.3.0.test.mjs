import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {
  analyzeDreadV130Evidence,
  calculateDoomIndexV130FromAssessment,
  createDoomIndexV130Fingerprint,
  createDoomIndexV130InputFingerprint,
} from "../scripts/doom-index-v1.3.0.mjs";
import {
  applyBodyAwareCacheToArticles,
  bodyAwareStoryId,
} from "../scripts/dread-body-aware-store.mjs";
import { extractArticleEvidence } from "../scripts/update-dread-body-aware.mjs";

const guidanceSource = await readFile(
  new URL("../calibration-guidance.js", import.meta.url),
  "utf8",
);
const guidanceContext = vm.createContext({});
vm.runInContext(guidanceSource, guidanceContext);
const guidance = guidanceContext.DAILY_DOOMSAYER_CALIBRATION_GUIDANCE;

const fixtures = [
  {
    harm: 0,
    certainty: 3,
    reach: 0,
    reversibility: 0,
    containment: 0,
    recurrence: 0,
    vulnerability: 0,
  },
  {
    harm: 2,
    certainty: 3,
    reach: 2,
    reversibility: 2,
    containment: 2,
    recurrence: 3,
    vulnerability: 2,
  },
  {
    harm: 3,
    certainty: 3,
    reach: 3,
    reversibility: 3,
    containment: 3,
    recurrence: 2,
    vulnerability: 3,
  },
  {
    harm: 4,
    certainty: 4,
    reach: 4,
    reversibility: 4,
    containment: 4,
    recurrence: 4,
    vulnerability: 4,
  },
];

test("DREAD 1.3 uses the guided calibration score and severity gates", () => {
  for (const fixture of fixtures) {
    const expected = guidance.recommendation(fixture);
    const actual = calculateDoomIndexV130FromAssessment(fixture);
    assert.ok(Math.abs(actual.value - expected.score) < 1);
    assert.equal(actual.band, expected.band);
    assert.equal(actual.direEligible, expected.direEligible);
    assert.equal(actual.catastrophicEligible, expected.catastrophicEligible);
  }
});

test("no established harm disables incident dimensions before scoring", () => {
  const result = calculateDoomIndexV130FromAssessment({
    ...fixtures[0],
    reach: 4,
    reversibility: 4,
    containment: 4,
    recurrence: 4,
    vulnerability: 4,
  });
  assert.equal(result.band, "UNEASY");
  assert.deepEqual(
    {
      reach: result.factors.reach,
      reversibility: result.factors.reversibility,
      containment: result.factors.containment,
      recurrence: result.factors.recurrence,
      vulnerability: result.factors.vulnerability,
    },
    { reach: 0, reversibility: 0, containment: 0, recurrence: 0, vulnerability: 0 },
  );
});

test("body-aware fingerprints are stable and change with article evidence", () => {
  const formula = createDoomIndexV130Fingerprint();
  const first = createDoomIndexV130InputFingerprint({
    title: "A story",
    summary: "A summary",
    bodyFingerprint: "body-a",
    source: "Publisher",
    analyzerVersion: "1.3.0-context-rules.1",
  });
  const second = createDoomIndexV130InputFingerprint({
    title: "A story",
    summary: "A summary",
    bodyFingerprint: "body-b",
    source: "Publisher",
    analyzerVersion: "1.3.0-context-rules.1",
  });
  assert.equal(formula.length, 20);
  assert.notEqual(first, second);
});

test("article extraction prefers substantial article evidence and removes navigation", () => {
  const html = `<!doctype html><html><body>
    <nav>Subscribe Sign in Menu</nav>
    <script type="application/ld+json">${JSON.stringify({
      "@type": "NewsArticle",
      articleBody:
        "Confirmed reporting describes a material disruption affecting several organizations. " +
        "Investigators documented the consequences and said recovery would require substantial effort. ".repeat(4),
    })}</script>
    <article><p>Short visible article.</p></article>
  </body></html>`;
  const extracted = extractArticleEvidence(html);
  assert.match(extracted, /Confirmed reporting/);
  assert.doesNotMatch(extracted, /Subscribe Sign in Menu/);
  assert.ok(extracted.length > 300);
});

test("deterministic context rules keep routine and protective news Uneasy", () => {
  const assessment = analyzeDreadV130Evidence({
    title: "Apple could help users prove photos are not deepfakes",
    summary: "A new feature may authenticate photographs at capture.",
    body: "Apple is developing a protective feature. It could help users verify images, but it is not currently live.",
  });
  const result = calculateDoomIndexV130FromAssessment(assessment);

  assert.equal(assessment.harm, 0);
  assert.equal(result.band, "UNEASY");
  assert.equal(assessment.diagnostics.routineOrProtective, true);
});

test("deterministic context rules recognize confirmed bounded cyber harm", () => {
  const assessment = analyzeDreadV130Evidence({
    title: "Attackers hacked three organizations using an AI agent",
    summary: "Investigators confirmed unauthorized access to production systems.",
    body: "The investigation confirmed that the agent breached three organizations. The attacks exposed credentials and remained under investigation. Teams later blocked access and began remediation.",
  });
  const result = calculateDoomIndexV130FromAssessment(assessment);

  assert.ok(assessment.harm >= 2);
  assert.ok(assessment.certainty >= 3);
  assert.ok(assessment.recurrence >= 2);
  assert.ok(result.value >= 40);
  assert.notEqual(result.band, "CATASTROPHIC");
});

test("catastrophic warning language alone cannot pass the realized-harm gate", () => {
  const assessment = analyzeDreadV130Evidence({
    title: "Experts warn AI could pose an existential threat",
    summary: "A theoretical scenario could cause global catastrophe if control is lost.",
    body: "The opinion argues that future systems might become uncontrollable. No harmful incident has occurred, and the authors propose preventive regulation.",
  });
  const result = calculateDoomIndexV130FromAssessment(assessment);

  assert.ok(assessment.harm <= 1);
  assert.ok(assessment.certainty <= 1);
  assert.equal(result.direEligible, false);
  assert.equal(result.catastrophicEligible, false);
  assert.ok(result.value < 40);
});

test("cached DREAD 1.3 records attach only for the active formula", () => {
  const article = { url: "https://example.com/story?utm_source=test" };
  const storyId = bodyAwareStoryId(article.url);
  const cache = {
    records: {
      [storyId]: {
        version: "1.3.0",
        formulaVersion: "1.3.0-body-context.1",
        score: { value: 57, factors: fixtures[1], constraints: [] },
        assessment: { rationale: "Material disruption is documented." },
        assessedAt: "2026-08-12T00:00:00.000Z",
      },
    },
  };

  assert.equal(
    applyBodyAwareCacheToArticles([article], cache, {
      formulaVersion: "1.3.0-body-context.1",
    }),
    1,
  );
  assert.equal(article.doomIndexV130BodyAware, 57);
  assert.equal(
    applyBodyAwareCacheToArticles([{ url: article.url }], cache, {
      formulaVersion: "different",
    }),
    0,
  );
});

test("body-aware workflow is separated from the hourly feed workflow", async () => {
  const [workflow, packageFile, config] = await Promise.all([
    readFile(
      new URL("../.github/workflows/update-dread-body-aware.yml", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../news-sources.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  assert.match(workflow, /workflow_run:/);
  assert.doesNotMatch(workflow, /OPENAI_API_KEY|api\.openai\.com/);
  assert.match(workflow, /npm run update-dread-body-aware/);
  assert.equal(JSON.parse(packageFile).scripts["update-dread-body-aware"], "node scripts/update-dread-body-aware.mjs");
  assert.equal(config.doomIndex.bodyAware.version, "1.3.0");
  assert.equal(
    config.doomIndex.bodyAware.analyzerVersion,
    "1.3.0-context-rules.1",
  );
  assert.equal(config.doomIndex.bodyAware.model, undefined);
  assert.equal(config.doomIndex.bodyAware.maxNewPerRun, 200);
  assert.equal(config.doomIndex.bodyAware.articleConcurrency, 4);
  assert.equal(config.doomIndex.bodyAware.articleTimeoutMs, 12000);
});

test("DREAD 1.3 contains no external AI model or API dependency", async () => {
  const [implementation, config, cache] = await Promise.all([
    readFile(
      new URL("../scripts/update-dread-body-aware.mjs", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../news-sources.json", import.meta.url), "utf8"),
    readFile(
      new URL(
        "../data/dread-body-aware/dread-1.3.0-cache.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ]);

  for (const text of [implementation, config, cache]) {
    assert.doesNotMatch(
      text,
      /OPENAI_API_KEY|api\.openai\.com|gpt-5\.6-luna|callOpenAI/,
    );
  }
  assert.match(implementation, /analyzeDreadV130Evidence/);
  assert.match(implementation, /mapWithConcurrency\(\s*candidates,\s*articleConcurrency/s);
  assert.match(implementation, /requestText\(article\.url, articleTimeoutMs\)/);
});
