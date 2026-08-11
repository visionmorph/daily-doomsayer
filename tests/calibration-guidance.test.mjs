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
  assert.equal(guidance.version, "guided-human-rating-v1.1");
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
  assert.ok(result.score <= 10);
  assert.equal(result.direEligible, false);
  assert.equal(result.catastrophicEligible, false);
});

test("confirmed publication and global attention cannot inflate a no-harm story", () => {
  const result = guidance.recommendation({
    harm: 0,
    certainty: 3,
    reach: 4,
    reversibility: 0,
    containment: 0,
    recurrence: 0,
    vulnerability: 0,
  });

  assert.equal(result.band, "UNEASY");
  assert.ok(result.score <= 10);
  assert.ok(result.range.upper <= 13);
  assert.equal(result.requestedBand, "UNEASY");
  assert.equal(result.effectiveBand, "UNEASY");
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

test("failed high-severity gates fall back to a lower anchored band", () => {
  const failedDire = guidance.recommendation({
    harm: 3,
    certainty: 2,
    reach: 4,
    reversibility: 2,
    containment: 2,
    recurrence: 2,
    vulnerability: 2,
  });
  const failedCatastrophic = guidance.recommendation({
    harm: 4,
    certainty: 4,
    reach: 4,
    reversibility: 3,
    containment: 3,
    recurrence: 2,
    vulnerability: 2,
  });

  assert.equal(failedDire.requestedBand, "DIRE");
  assert.equal(failedDire.effectiveBand, "ALARMING");
  assert.equal(failedCatastrophic.requestedBand, "CATASTROPHIC");
  assert.equal(failedCatastrophic.effectiveBand, "DIRE");
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
  const [html, script, styles] = await Promise.all([
    readFile(new URL("../rate-stories.html", import.meta.url), "utf8"),
    readFile(new URL("../rate-stories.js", import.meta.url), "utf8"),
    readFile(new URL("../rate-stories.css", import.meta.url), "utf8"),
  ]);

  assert.match(html, /id="feed-evidence-groups"/);
  assert.match(html, /id="article-evidence-groups"/);
  assert.match(html, /name="feed-rating-choice" value="manual"/);
  assert.match(html, /name="article-rating-choice" value="manual"/);
  assert.match(html, /id="feed-manual-rating"[^>]*hidden/);
  assert.match(html, /id="article-manual-rating"[^>]*hidden/);
  assert.match(html, /id="feed-calibration-scale"[^>]*aria-live="polite"/s);
  assert.match(html, /id="article-calibration-scale"[^>]*aria-live="polite"/s);
  assert.doesNotMatch(html, /id="calibration-scale"/);
  assert.match(html, /How likely is additional information to change this rating\?/);
  assert.ok(
    html.indexOf('<form id="feed-rating-form"') <
      html.indexOf('class="calibration-feed-heading"'),
  );
  assert.ok(
    html.indexOf('class="calibration-feed-heading"') <
      html.indexOf('id="feed-evidence-groups"'),
  );
  assert.ok(
    html.indexOf("calibration-guidance.js") < html.indexOf("rate-stories.js"),
  );
  assert.match(script, /assessment:/);
  assert.match(script, /structuredFactors:/);
  assert.doesNotMatch(html, /Funnel Display/);
  assert.doesNotMatch(styles, /Funnel Display/);
  assert.match(styles, /font-family: "Cossette Texte"/);
  assert.match(styles, /#feed-rating-form\s*\{[^}]*gap: 24px/s);
  assert.match(styles, /\.calibration-field textarea\s*\{[^}]*border: 2px solid #000000/s);
  assert.match(
    styles,
    /\.calibration-field \.calibration-radio:has\(input:checked\)[^}]*\{[^}]*font-weight: 700/s,
  );
  assert.match(
    styles,
    /\.calibration-radio\s*\{[^}]*display: inline-block;[^}]*width: fit-content;[^}]*align-self: flex-start;/s,
  );
  assert.match(
    styles,
    /\.calibration-scale-item > span\s*\{[^}]*font-size: 20px;[^}]*font-weight: 700;[^}]*line-height: 24px;/s,
  );
  assert.match(
    styles,
    /\.calibration-scale-qualification\s*\{[^}]*font-size: 20px;[^}]*line-height: 24px;/s,
  );
  assert.match(
    styles,
    /\.calibration-story-context\s*\{[^}]*display: flex;[^}]*flex-direction: column;[^}]*gap: 8px;/s,
  );
  assert.match(
    styles,
    /\.calibration-story-summary\s*\{[^}]*font-size: 32px;[^}]*line-height: 40px;/s,
  );
  assert.match(
    styles,
    /\.calibration-field:has\(> textarea\)\s*\{[^}]*gap: 8px;/s,
  );
  assert.match(styles, /\.calibration-actions\s*\{[^}]*gap: 16px;/s);
  assert.match(
    styles,
    /\.calibration-radio:hover,[^}]*text-underline-offset: 0\.1em;/s,
  );
  assert.match(
    script,
    /stage\.recommendationReasoning\.textContent\s*=\s*severityBandForScore\(recommendation\.score\)\?\.description \|\| "";/s,
  );
  assert.match(
    script,
    /const NO_HARM_DEPENDENT_FACTORS = new Set\(\[[\s\S]*"reach"[\s\S]*"reversibility"[\s\S]*"containment"[\s\S]*"recurrence"[\s\S]*"vulnerability"/,
  );
  assert.match(script, /function applyNoHarmShortcut\(stage\)/);
  assert.match(script, /fieldset\.dataset\.autoSelected = "true";[\s\S]*fieldset\.disabled = true;/);
  assert.match(script, /if \(input\.name === `\$\{stage\.id\}-factor-harm`\)/);
  assert.match(
    script,
    /function selectedValue\(form, name\)[\s\S]*input\[type="radio"\]\[name="\$\{name\}"\]:checked[\s\S]*return checkedRadio\.value;/,
  );
  assert.doesNotMatch(
    script,
    /NO_HARM_DEPENDENT_FACTORS = new Set\(\[[\s\S]*"certainty"/,
  );
  assert.doesNotMatch(
    script,
    /stage\.recommendationReasoning\.textContent = \[\s*recommendation\.reasoning/s,
  );
  assert.match(script, /function severityBandForScore\(value\)/);
  assert.match(script, /renderScaleItem\(stage\.scale, slider\.value\)/);
  assert.match(html, /Additional context \(optional\)/);
  assert.match(html, /Additional context after reading \(optional\)/);
});
