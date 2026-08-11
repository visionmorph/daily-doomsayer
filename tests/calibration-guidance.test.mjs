import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../calibration-guidance.js", import.meta.url),
  "utf8",
);
const context = vm.createContext({});
vm.runInContext(source, context);
const guidance = context.DAILY_DOOMSAYER_CALIBRATION_GUIDANCE;

function levels(value) {
  return Object.fromEntries(
    guidance.factors.map((factor) => [factor.id, value]),
  );
}

test("guided calibration defines seven complete evidence factors", () => {
  assert.equal(guidance.version, "guided-human-rating-v1");
  assert.equal(guidance.factors.length, 7);
  assert.equal(new Set(guidance.factors.map((factor) => factor.id)).size, 7);
  assert.ok(
    guidance.factors.every((factor) => factor.options.length === 5),
  );
  assert.equal(
    Number(
      guidance.factors
        .reduce((total, factor) => total + factor.weight, 0)
        .toFixed(2),
    ),
    1,
  );
});

test("no established harm remains Uneasy", () => {
  const result = guidance.recommendation(levels(0));

  assert.equal(result.band, "UNEASY");
  assert.ok(result.score <= 19);
  assert.equal(result.direEligible, false);
  assert.equal(result.catastrophicEligible, false);
});

test("compound confirmed severe consequences can produce a Dire recommendation", () => {
  const result = guidance.recommendation({
    harm: 3,
    certainty: 3,
    reach: 3,
    reversibility: 3,
    containment: 3,
    recurrence: 2,
    vulnerability: 3,
  });

  assert.equal(result.band, "DIRE");
  assert.equal(result.direEligible, true);
  assert.equal(result.catastrophicEligible, false);
  assert.ok(result.range.lower >= 60);
  assert.ok(result.range.upper <= 79);
});

test("Catastrophic requires compound confirmed extreme conditions", () => {
  const extreme = guidance.recommendation(levels(4));
  const speculative = guidance.recommendation({
    ...levels(4),
    certainty: 0,
  });

  assert.equal(extreme.band, "CATASTROPHIC");
  assert.equal(extreme.catastrophicEligible, true);
  assert.ok(extreme.score >= 80);
  assert.equal(speculative.catastrophicEligible, false);
  assert.ok(speculative.score <= 59);
});

test("incomplete evidence choices do not produce a suggested rating", () => {
  assert.equal(guidance.recommendation({ harm: 2 }), null);
  assert.equal(
    guidance.recommendation(
      Object.fromEntries(guidance.factors.map((factor) => [factor.id, ""])),
    ),
    null,
  );
});

test("rate-stories page uses guided groups with a conditional manual override", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../rate-stories.html", import.meta.url), "utf8"),
    readFile(new URL("../rate-stories.js", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="feed-evidence-groups"/);
  assert.match(html, /id="article-evidence-groups"/);
  assert.match(html, /name="feed-rating-choice" value="manual"/);
  assert.match(html, /name="article-rating-choice" value="manual"/);
  assert.match(html, /id="feed-manual-rating"[^>]*hidden/);
  assert.match(html, /id="article-manual-rating"[^>]*hidden/);
  assert.match(html, /How likely is additional information to change this rating\?/);
  assert.ok(
    html.indexOf("calibration-guidance.js") < html.indexOf("rate-stories.js"),
  );
  assert.match(script, /assessment:/);
  assert.match(script, /structuredFactors:/);
});
