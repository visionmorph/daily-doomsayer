import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildSourceDirectory,
  calculateIntradayDoom,
  normalizeArticleText,
  normalizedSeverityScale,
} from "../scripts/site-data.mjs";

test("Chronicle interaction covers the rendered label without a tooltip", async () => {
  const [indexHtml, styles, newsScript] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
    readFile(new URL("../news.js", import.meta.url), "utf8"),
  ]);

  assert.match(
    indexHtml,
    /id="chronicle-control"[^>]*tabindex="0"[^>]*>\s*Chronicle\s+<span id="chronicle-number"/,
  );
  assert.doesNotMatch(indexHtml, /id="chronicle-number"[^>]*tabindex=/);
  assert.match(styles, /\.chronicle-control\s*{[^}]*display:\s*inline-block;[^}]*width:\s*max-content;/s);
  assert.doesNotMatch(styles, /\.chronicle-number\s*{[^}]*min-width:/s);
  assert.match(newsScript, /controlElement\.addEventListener\("mouseenter", showNumerical\)/);
  assert.doesNotMatch(newsScript, /\.title\s*=\s*numerical/);
});

test("DREAD 1.2.4 is the configured experimental model throughout the site", async () => {
  const [
    configText,
    indexHtml,
    newsScript,
    calibrationScript,
    fetchScript,
    verificationScript,
  ] = await Promise.all([
    readFile(new URL("../news-sources.json", import.meta.url), "utf8"),
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../news.js", import.meta.url), "utf8"),
    readFile(new URL("../rate-stories.js", import.meta.url), "utf8"),
    readFile(new URL("../scripts/fetch-news.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/verify-doom-index.mjs", import.meta.url), "utf8"),
  ]);
  const config = JSON.parse(configText);

  assert.equal(config.doomIndex.version, "1.2.2");
  assert.equal(config.doomIndex.shadow.version, "1.2.4");
  assert.equal(config.doomIndex.shadow.formulaVersion, "1.2.4-offline.1");
  assert.match(indexHtml, /data-model-version>1\.2\.4</);
  assert.match(newsScript, /doomIndexV124Shadow/);
  assert.match(calibrationScript, /doomIndexV124Shadow/);
  assert.match(fetchScript, /calculateDoomIndexV124/);
  assert.match(verificationScript, /calculateDoomIndexV124FromFactors/);
  assert.doesNotMatch(newsScript, /doomIndexV123Shadow/);
  assert.doesNotMatch(calibrationScript, /doomIndexV123Shadow/);
  assert.doesNotMatch(fetchScript, /doomIndexV123Shadow/);
  assert.doesNotMatch(verificationScript, /doomIndexV123Shadow/);
});

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

test("news sources include scoped publisher feeds, pages, and image collection paths", async () => {
  const [configText, fetchScript] = await Promise.all([
    readFile(new URL("../news-sources.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/fetch-news.mjs", import.meta.url), "utf8"),
  ]);
  const config = JSON.parse(configText);
  const sources = Object.fromEntries(
    config.sources.map((source) => [source.name, source]),
  );

  assert.equal(sources["AI News"].wordpressFeaturedImageFallback, true);

  assert.equal(
    sources["POLITICO AI"].feed,
    "https://rss.politico.com/technology.xml",
  );
  assert.equal(sources["POLITICO AI"].includeKeywordSet, "ai");
  assert.equal(sources["POLITICO AI"].blueskyImageFallbackActor, "politico.com");
  assert.equal(sources["POLITICO AI"].articlePageImageFallback, false);
  assert.equal(
    sources["POLITICO Europe AI"].feed,
    "https://www.politico.eu/section/technology/feed/",
  );
  assert.equal(sources["POLITICO Europe AI"].includeKeywordSet, "ai");
  assert.equal(
    sources["POLITICO Europe AI"].blueskyImageFallbackActor,
    "politico.eu",
  );
  assert.equal(sources["POLITICO Europe AI"].articlePageImageFallback, false);
  assert.equal(
    sources["The Dispatch AI"].feed,
    "https://thedispatch.com/feed/",
  );
  assert.equal(sources["The Dispatch AI"].includeKeywordSet, "ai");
  assert.equal(sources["The Dispatch AI"].resolveMissingArticleImages, true);
  assert.equal(
    sources["The Dispatch AI"].pageUrl,
    "https://thedispatch.com/?s=artificial%20intelligence&order=newest",
  );
  assert.deepEqual(sources["The Dispatch AI"].pageArticleUrlPatterns, [
    "/article/",
    "/newsletter/",
  ]);
  assert.deepEqual(sources["The Dispatch AI"].excludeUrlPatterns, [
    "/newsletter/morning/",
  ]);
  assert.deepEqual(sources["The Guardian AI"].displaySummaryStopTerms, [
    "Get our breaking news email",
    "Sign up for a weekly email",
    "Sign up to our",
  ]);
  assert.equal(
    sources["Mashable AI"].feed,
    "https://mashable.com/feeds/rss/tech",
  );
  assert.equal(sources["Mashable AI"].includeKeywordSet, "ai");
  assert.equal(
    sources["Inc. AI"].feed,
    "http://www.inc.com/rss/homepage.xml",
  );
  assert.equal(sources["Inc. AI"].includeKeywordSet, "ai");
  assert.equal(
    sources["AP News AI"].pageUrl,
    "https://apnews.com/hub/artificial-intelligence",
  );
  assert.deepEqual(sources["AP News AI"].pageArticleUrlPatterns, ["/article/"]);
  assert.equal(
    sources["Reuters AI"].pageUrl,
    "https://www.reuters.com/technology/artificial-intelligence/",
  );
  assert.deepEqual(sources["Reuters AI"].pageArticleUrlPatterns, [
    "/technology/artificial-intelligence/",
  ]);
  assert.match(
    fetchScript,
    /async function fetchArticleImage\(articleUrl\)\s*\{[\s\S]*?canonicalStoryUrl\(articleUrl\)[\s\S]*?Mozilla\/5\.0[\s\S]*?Accept-Language[\s\S]*?Referer:/,
  );
  assert.match(
    fetchScript,
    /async function fetchWordPressFeaturedImage\(articleUrl\)\s*\{[\s\S]*?\/wp-json\/wp\/v2\/posts[\s\S]*?_embed[\s\S]*?wp:featuredmedia/,
  );
  assert.match(
    fetchScript,
    /source\.wordpressFeaturedImageFallback === true[\s\S]*?fetchWordPressFeaturedImage\(article\.url\)/,
  );
  assert.match(
    fetchScript,
    /async function fetchBlueskyArticleImages\(actor, articles\)[\s\S]*?public\.api\.bsky\.app\/xrpc\/app\.bsky\.feed\.getAuthorFeed[\s\S]*?posts_with_links[\s\S]*?titleSimilarity\(article\.title, card\.title\)/,
  );
  assert.match(
    fetchScript,
    /source\.blueskyImageFallbackActor[\s\S]*?fetchBlueskyArticleImages\(/,
  );
  assert.match(
    fetchScript,
    /source\.articlePageImageFallback === false[\s\S]*?return;[\s\S]*?fetchArticleImage\(article\.url\)/,
  );
  assert.match(
    fetchScript,
    /Array\.isArray\(source\.excludeUrlPatterns\)[\s\S]*?link\.includes\(String\(pattern\)\.toLowerCase\(\)\)/,
  );
  assert.match(fetchScript, /function politicoImageAtWidth\(value, width\)/);
  assert.match(fetchScript, /url\.hostname === "www\.politico\.com"/);
  assert.match(fetchScript, /`\/resize\/\$\{width\}\/`/);
  assert.match(fetchScript, /async function fetchSourcePageArticles\(source\)/);
  assert.match(fetchScript, /const configuredPages = config\.sources/);
  assert.match(fetchScript, /type === "page"\s*\? fetchSourcePageArticles\(source\)/);
  assert.match(
    fetchScript,
    /function itemDisplaySummary\(source, item\)[\s\S]*?item\.contentSnippet[\s\S]*?item\.summary[\s\S]*?item\.description/,
  );
  assert.match(
    fetchScript,
    /function cleanDisplaySummary\(source, value\)[\s\S]*?source\.displaySummaryStopTerms[\s\S]*?summary\.slice\(0, stopIndex\)/,
  );
  assert.match(fetchScript, /feedSummary: itemDisplaySummary\(source, item\)/);
  assert.match(
    fetchScript,
    /feedSummary: normalizeArticleText\(feedSummary\)/,
  );
  assert.doesNotMatch(
    fetchScript,
    /feedSummary: normalizeArticleText\(analysisText\)/,
  );
});

test("severity scale must be contiguous and cover the complete index", () => {
  const scale = normalizedSeverityScale([
    {
      minimum: 0,
      maximum: 49.99,
      label: "LOW",
      description: "Lower concern.",
      qualification: "Qualifies with limited evidence of harm.",
    },
    {
      minimum: 50,
      maximum: 100,
      label: "HIGH",
      description: "Higher concern.",
      qualification: "Qualifies with substantial evidence of harm.",
    },
  ]);

  assert.equal(scale[0].label, "LOW");
  assert.throws(
    () =>
      normalizedSeverityScale([
        {
          minimum: 0,
          maximum: 40,
          label: "LOW",
          description: "Lower concern.",
          qualification: "Qualifies with limited evidence of harm.",
        },
        {
          minimum: 50,
          maximum: 100,
          label: "HIGH",
          description: "Higher concern.",
          qualification: "Qualifies with substantial evidence of harm.",
        },
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
