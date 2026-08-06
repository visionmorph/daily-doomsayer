import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSourceDirectory,
  calculateIntradayDoom,
  normalizeArticleText,
  normalizedSeverityScale,
} from "../scripts/site-data.mjs";

test("article text decodes numeric, named, and double-encoded entities", () => {
  assert.equal(
    normalizeArticleText(
      "Elon Musk&amp;#8217;s &quot;AI&quot; plan &amp; its consequences",
    ),
    "Elon Musk’s \"AI\" plan & its consequences",
  );
  assert.equal(normalizeArticleText("A <em>marked-up</em> title"), "A marked-up title");
});

test("source directory is deduplicated and alphabetized without leading The", () => {
  const sources = [
    { name: "The Verge AI", displayName: "The Verge", indexUrl: "https://example.com/verge" },
    { name: "404 Media AI", displayName: "404 Media", indexUrl: "https://example.com/404" },
    { name: "The Guardian AI", displayName: "The Guardian", indexUrl: "https://example.com/guardian" },
    { name: "The Verge second feed", displayName: "The Verge", indexUrl: "https://example.com/verge" },
  ];

  assert.deepEqual(
    buildSourceDirectory(sources).map((source) => source.name),
    ["404 Media", "The Guardian", "The Verge"],
  );
});

test("severity scale must be contiguous and cover the complete index", () => {
  const scale = normalizedSeverityScale([
    { minimum: 0, maximum: 49.99, label: "LOW", description: "Lower concern." },
    { minimum: 50, maximum: 100, label: "HIGH", description: "Higher concern." },
  ]);

  assert.equal(scale[0].label, "LOW");
  assert.throws(
    () =>
      normalizedSeverityScale([
        { minimum: 0, maximum: 40, label: "LOW", description: "Lower concern." },
        { minimum: 50, maximum: 100, label: "HIGH", description: "Higher concern." },
      ]),
    /gap or overlap/,
  );
});

test("intraday Doom uses the highest public story score in each hour", () => {
  const publicSample = (value, observedAt) => ({
    value,
    observedAt,
    formulaVersion: "1.0",
  });
  const history = {
    stories: {
      first: {
        storyId: "first",
        title: "First story",
        url: "https://example.com/first",
        days: {
          "2026-08-06": {
            samples: {
              "2026-08-06T05Z|1.0": publicSample(30, "2026-08-06T05:00:00.000Z"),
              "2026-08-06T06Z|1.0": publicSample(35, "2026-08-06T06:00:00.000Z"),
            },
          },
        },
      },
      second: {
        storyId: "second",
        title: "Second story",
        url: "https://example.com/second",
        days: {
          "2026-08-06": {
            samples: {
              "2026-08-06T05Z|1.0": publicSample(40, "2026-08-06T05:00:00.000Z"),
              "2026-08-06T06Z|1.0": publicSample(46.18, "2026-08-06T06:00:00.000Z"),
            },
          },
        },
      },
    },
  };

  assert.deepEqual(
    calculateIntradayDoom(history, {
      date: "2026-08-06",
      formulaVersion: "1.0",
      legacyFormulaVersion: "1.0",
    }),
    {
      date: "2026-08-06",
      formulaVersion: "1.0",
      observedAt: "2026-08-06T06:00:00.000Z",
      current: 46.18,
      currentStory: {
        storyId: "second",
        title: "Second story",
        url: "https://example.com/second",
      },
      lastHourChange: 6.18,
      open: 40,
      openingStory: {
        storyId: "second",
        title: "Second story",
        url: "https://example.com/second",
      },
      dayChange: 6.18,
      peak: 46.18,
      peakStory: {
        storyId: "second",
        title: "Second story",
        url: "https://example.com/second",
      },
      observations: 2,
    },
  );
});
