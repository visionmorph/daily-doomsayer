import { readFile, writeFile } from "node:fs/promises";
import Parser from "rss-parser";

const parser = new Parser({
  headers: {
    "User-Agent": "Daily Doomsayer RSS aggregator/1.0",
    Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
  },
  customFields: {
    item: [
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail", { keepArray: true }],
      ["content:encoded", "contentEncoded"],
      ["dc:type", "dcType", { keepArray: true }],
      ["prism:section", "prismSection", { keepArray: true }],
    ],
  },
});
const config = JSON.parse(await readFile("news-sources.json", "utf8"));
const articles = [];

const STOP_WORDS = new Set([
  "a",
  "about",
  "after",
  "ai",
  "an",
  "and",
  "are",
  "artificial",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "how",
  "in",
  "intelligence",
  "is",
  "it",
  "its",
  "new",
  "news",
  "of",
  "on",
  "says",
  "tech",
  "that",
  "the",
  "their",
  "this",
  "to",
  "with",
]);

const DEFAULT_RANKING_WEIGHTS = {
  coverage: 0.3,
  titleImpact: 0.2,
  sourceAuthority: 0.15,
  freshness: 0.15,
  feedPosition: 0.1,
  novelty: 0.1,
};

const TITLE_SIGNAL_PATTERNS = {
  urgency: [
    /\b(kill(?:ed|er|ing|s)?|dead|death|fatal)\b/i,
    /\b(crisis|collapse|crash(?:ed|es)?|disaster|emergency)\b/i,
    /\b(danger(?:ous)?|risk(?:s|y)?|threat(?:en|ened|ens|s)?)\b/i,
    /\b(attack(?:ed|s)?|breach(?:ed|es)?|hack(?:ed|er|ers|ing|s)?)\b/i,
    /\b(ban(?:ned|s)?|block(?:ed|s)?|shutdown|outage)\b/i,
    /\b(fail(?:ed|ing|s|ure)?|broken|worse|warning|warns?)\b/i,
    /\b(war|weapon(?:s)?|surveillance|layoffs?|fired)\b/i,
  ],
  consequence: [
    /(?:\$|\b(?:million|billion|trillion|revenue|profit|quarter|market|stock)\b)/i,
    /\b(job(?:s)?|worker(?:s)?|employment|layoffs?|economy|economic)\b/i,
    /\b(health|medical|patient(?:s)?|doctor(?:s)?|hospital(?:s)?|disease)\b/i,
    /\b(privacy|security|safety|data|identity)\b/i,
    /\b(government|congress|court|judge|law|legal|regulator(?:s|y)?)\b/i,
    /\b(ceo|president|minister|agency|company|industry)\b/i,
    /(?:\b\d+(?:\.\d+)?\s*(?:%|percent)\b|%)/i,
  ],
  conflict: [
    /\b(accus(?:e|ed|es|ing)|attack(?:ed|s)?|blame(?:d|s)?|calls?)\b/i,
    /\b(sue(?:d|s)?|lawsuit|probe|investigat(?:e|ed|es|ion))\b/i,
    /\b(ban(?:ned|s)?|block(?:ed|s)?|reject(?:ed|s)?|def(?:y|ied|ies))\b/i,
    /\b(clash(?:ed|es)?|battle(?:d|s)?|fight(?:ing|s)?|versus|vs\.?)\b/i,
    /\b(slam(?:med|s)?|criticiz(?:e|ed|es)|condemn(?:ed|s)?)\b/i,
  ],
  surprise: [
    /\b(secret(?:s)?|hidden|leak(?:ed|s)?|expos(?:e|ed|es))\b/i,
    /\b(shock(?:ed|ing|s)?|surpris(?:e|ed|es|ing)|unexpected(?:ly)?)\b/i,
    /\b(suddenly|quietly|actually|still|already)\b/i,
    /\b(admit(?:s|ted)?|reveal(?:ed|s)?|reverse(?:d|s)?|abandon(?:ed|s)?)\b/i,
    /\b(first|last|never|biggest|smallest|record|historic)\b/i,
    /\b(why|how|what happens|here(?:'|’)?s)\b/i,
  ],
};

function normalizedRankingWeights(configuredWeights = {}) {
  const weights = Object.fromEntries(
    Object.entries(DEFAULT_RANKING_WEIGHTS).map(([name, fallback]) => {
      const configured = Number(configuredWeights[name]);
      return [name, Number.isFinite(configured) && configured >= 0 ? configured : fallback];
    }),
  );
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);

  if (total === 0) {
    return DEFAULT_RANKING_WEIGHTS;
  }

  return Object.fromEntries(
    Object.entries(weights).map(([name, weight]) => [name, weight / total]),
  );
}

const rankingWeights = normalizedRankingWeights(config.ranking);

function normalizedTitleWords(title) {
  return title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function titleTokens(title) {
  return new Set(
    normalizedTitleWords(title).filter(
      (word) => word.length > 2 && !STOP_WORDS.has(word),
    ),
  );
}

function titleSimilarity(firstTitle, secondTitle) {
  const firstTokens = titleTokens(firstTitle);
  const secondTokens = titleTokens(secondTitle);

  if (firstTokens.size === 0 || secondTokens.size === 0) {
    return 0;
  }

  let sharedTokens = 0;

  for (const token of firstTokens) {
    if (secondTokens.has(token)) {
      sharedTokens += 1;
    }
  }

  return sharedTokens / Math.min(firstTokens.size, secondTokens.size);
}

function patternScore(title, patterns) {
  const matches = patterns.filter((pattern) => pattern.test(title)).length;
  return Math.min(matches / 2, 1);
}

function namedEntityScore(title) {
  const words = title.match(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu) || [];
  let entities = 0;

  words.forEach((word, index) => {
    if (index === 0 || STOP_WORDS.has(word.toLowerCase())) {
      return;
    }

    const isAcronym = word.length > 1 && word === word.toUpperCase();
    const beginsWithCapital = /^\p{Lu}/u.test(word);

    if (isAcronym || beginsWithCapital) {
      entities += 1;
    }
  });

  return Math.min(entities / 4, 1);
}

function specificityScore(title, entityScore) {
  let score = entityScore * 0.35;

  if (/(?:\$|€|£|\b\d+(?:\.\d+)?\b|%)/u.test(title)) {
    score += 0.4;
  }

  if (/(?:["“][^"”]+["”]|‘[^’]+’)/u.test(title)) {
    score += 0.25;
  }

  if (/[:—–]/u.test(title)) {
    score += 0.1;
  }

  return Math.min(score, 1);
}

function clickbaitPenalty(title) {
  let penalty = 0;

  if (/[!?]{2,}/u.test(title)) {
    penalty += 0.1;
  }

  if (/\b(you won(?:'|’)t believe|what happens next|this one trick)\b/i.test(title)) {
    penalty += 0.15;
  }

  if (normalizedTitleWords(title).length < 5) {
    penalty += 0.1;
  }

  return Math.min(penalty, 0.25);
}

function calculateTitleImpact(title) {
  const urgency = patternScore(title, TITLE_SIGNAL_PATTERNS.urgency);
  const consequence = patternScore(title, TITLE_SIGNAL_PATTERNS.consequence);
  const conflict = patternScore(title, TITLE_SIGNAL_PATTERNS.conflict);
  const surprise = patternScore(title, TITLE_SIGNAL_PATTERNS.surprise);
  const namedEntities = namedEntityScore(title);
  const specificity = specificityScore(title, namedEntities);
  const penalty = clickbaitPenalty(title);
  const score = Math.max(
    0,
    urgency * 0.24 +
      consequence * 0.22 +
      conflict * 0.18 +
      surprise * 0.14 +
      specificity * 0.12 +
      namedEntities * 0.1 -
      penalty,
  );
  const reasons = [];

  if (urgency > 0) reasons.push("urgency or risk");
  if (consequence > 0) reasons.push("real-world consequences");
  if (conflict > 0) reasons.push("conflict");
  if (surprise > 0) reasons.push("surprise or reversal");
  if (specificity >= 0.35) reasons.push("specific details");
  if (namedEntities >= 0.5) reasons.push("recognizable entities");
  if (penalty > 0) reasons.push("clickbait penalty");

  return { score: Math.min(score, 1), reasons };
}

function calculateNoveltyScores(articleList) {
  const documentFrequency = new Map();

  for (const article of articleList) {
    for (const token of titleTokens(article.title)) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }

  const rawScores = articleList.map((article) => {
    const tokens = [...titleTokens(article.title)];

    if (tokens.length === 0) {
      return 0;
    }

    return (
      tokens.reduce((sum, token) => {
        const frequency = documentFrequency.get(token) || 1;
        return sum + Math.log((articleList.length + 1) / (frequency + 1));
      }, 0) / tokens.length
    );
  });
  const minimum = Math.min(...rawScores);
  const maximum = Math.max(...rawScores);

  return rawScores.map((score) =>
    maximum > minimum ? (score - minimum) / (maximum - minimum) : 0.5,
  );
}

function roundedScore(score) {
  return Number(score.toFixed(4));
}

function textValues(value) {
  if (Array.isArray(value)) {
    return value.flatMap(textValues);
  }

  if (typeof value === "string") {
    return [value];
  }

  if (value && typeof value === "object") {
    return textValues(value._ || value["#text"] || value.value || "");
  }

  return [];
}

function normalizedFilterText(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/<[^>]*>/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function exactValueMatch(values, configuredTerms) {
  if (!Array.isArray(configuredTerms) || configuredTerms.length === 0) {
    return false;
  }

  const normalizedValues = new Set(
    values.map(normalizedFilterText).filter(Boolean),
  );

  return configuredTerms.some((term) =>
    normalizedValues.has(normalizedFilterText(term)),
  );
}

function containsConfiguredTerm(value, configuredTerms) {
  if (!Array.isArray(configuredTerms) || configuredTerms.length === 0) {
    return false;
  }

  const normalizedValue = ` ${normalizedFilterText(value)} `;

  return configuredTerms.some((term) => {
    const normalizedTerm = normalizedFilterText(term);
    return normalizedTerm && normalizedValue.includes(` ${normalizedTerm} `);
  });
}

function itemCategories(item) {
  return [
    ...textValues(item.categories),
    ...textValues(item.category),
  ];
}

function itemArticleTypes(item) {
  return [
    ...textValues(item.dcType),
    ...textValues(item.prismSection),
    ...itemCategories(item),
  ];
}

function sourceAcceptsItem(source, item) {
  const categories = itemCategories(item);
  const articleTypes = itemArticleTypes(item);
  const title = item.title || "";
  const searchableText = [
    title,
    item.contentSnippet,
    item.description,
    item.summary,
  ]
    .filter(Boolean)
    .join(" ");
  const link = String(item.link || "").toLowerCase();

  if (
    exactValueMatch(categories, source.excludeCategories) ||
    containsConfiguredTerm(title, source.excludeTitleTerms)
  ) {
    return false;
  }

  const inclusionRules = [];

  if (Array.isArray(source.includeCategories) && source.includeCategories.length) {
    inclusionRules.push(exactValueMatch(categories, source.includeCategories));
  }

  if (Array.isArray(source.includeKeywords) && source.includeKeywords.length) {
    inclusionRules.push(
      containsConfiguredTerm(searchableText, source.includeKeywords),
    );
  }

  if (
    Array.isArray(source.includeArticleTypes) &&
    source.includeArticleTypes.length
  ) {
    inclusionRules.push(
      exactValueMatch(articleTypes, source.includeArticleTypes),
    );
  }

  if (
    Array.isArray(source.includeUrlPatterns) &&
    source.includeUrlPatterns.length
  ) {
    inclusionRules.push(
      source.includeUrlPatterns.some((pattern) =>
        link.includes(String(pattern).toLowerCase()),
      ),
    );
  }

  return inclusionRules.length === 0 || inclusionRules.some(Boolean);
}

function mediaUrl(value) {
  const entries = Array.isArray(value) ? value : [value];

  for (const entry of entries) {
    if (!entry) {
      continue;
    }

    if (typeof entry === "string" && /^https?:\/\//i.test(entry)) {
      return entry;
    }

    const attributes = entry.$ || entry;
    const url = attributes.url || attributes.href;

    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      return url;
    }
  }

  return "";
}

function imageFromHtml(html) {
  if (typeof html !== "string") {
    return "";
  }

  const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match?.[1] || "";
}

function cleanImageUrl(value, baseUrl) {
  if (typeof value !== "string" || !value.trim()) {
    return "";
  }

  const decodedValue = value
    .trim()
    .replace(/&amp;|&#0*38;/gi, "&")
    .replace(/&quot;|&#0*34;/gi, '"');

  try {
    return new URL(decodedValue, baseUrl).href;
  } catch {
    return "";
  }
}

function highResolutionHeadlineImage(value) {
  const imageUrl = cleanImageUrl(value);

  if (!imageUrl) {
    return "";
  }

  try {
    const url = new URL(imageUrl);

    if (url.hostname === "i.guim.co.uk") {
      url.searchParams.set("width", "1300");
      url.searchParams.set("dpr", "2");
      url.searchParams.set("s", "none");
      url.searchParams.set("crop", "none");
    }

    return url.href;
  } catch {
    return imageUrl;
  }
}

function tagAttribute(tag, attributeName) {
  const pattern = new RegExp(
    `${attributeName}\\s*=\\s*(["'])(.*?)\\1`,
    "i",
  );
  return tag.match(pattern)?.[2] || "";
}

function socialImageFromHtml(html, pageUrl) {
  const metaTags = html.match(/<meta\b[^>]*>/gi) || [];
  const preferredNames = [
    "og:image:secure_url",
    "og:image",
    "twitter:image",
    "twitter:image:src",
  ];

  for (const preferredName of preferredNames) {
    for (const tag of metaTags) {
      const name = (
        tagAttribute(tag, "property") || tagAttribute(tag, "name")
      ).toLowerCase();

      if (name === preferredName) {
        const imageUrl = cleanImageUrl(tagAttribute(tag, "content"), pageUrl);

        if (imageUrl) {
          return imageUrl;
        }
      }
    }
  }

  return "";
}

async function fetchArticleImage(articleUrl) {
  const response = await fetch(articleUrl, {
    headers: {
      "User-Agent": "Daily Doomsayer RSS aggregator",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Article page returned ${response.status}`);
  }

  return socialImageFromHtml(await response.text(), response.url || articleUrl);
}

function extractImage(item) {
  const enclosureImage =
    item.enclosure?.url &&
    (!item.enclosure.type || item.enclosure.type.startsWith("image/"))
      ? item.enclosure.url
      : "";

  return cleanImageUrl(
    enclosureImage ||
      mediaUrl(item.mediaContent) ||
      mediaUrl(item.mediaThumbnail) ||
      imageFromHtml(item.contentEncoded) ||
      imageFromHtml(item.content) ||
      imageFromHtml(item.description) ||
      "",
  );
}

for (const source of config.sources) {
  const group = String(source.group ?? "").trim();

  if (!group) {
    throw new Error(`Invalid group for source: ${source.name || source.feed}`);
  }

  try {
    const feed = await parser.parseURL(source.feed);
    const limit = Math.max(1, Math.min(Number(source.limit) || 10, 10));
    const sourceWeight = Math.max(0.1, Math.min(Number(source.weight) || 1, 2));
    const acceptedItems = feed.items
      .filter((item) => sourceAcceptsItem(source, item))
      .slice(0, limit);

    for (const [feedPosition, item] of acceptedItems.entries()) {
      if (!item.title || !item.link) {
        continue;
      }

      articles.push({
        group,
        title: item.title.trim(),
        url: item.link,
        source: source.name || feed.title || "",
        published: item.isoDate || item.pubDate || "",
        image: extractImage(item),
        feedPosition,
        sourceWeight,
        candidateCount: acceptedItems.length,
      });
    }
  } catch (error) {
    console.error(`Skipped ${source.name || source.feed}: ${error.message}`);
  }
}

const uniqueArticles = Array.from(
  new Map(articles.map((article) => [article.url, article])).values(),
);

const now = Date.now();
const noveltyScores = calculateNoveltyScores(uniqueArticles);

for (const [articleIndex, article] of uniqueArticles.entries()) {
  const relatedSources = new Set([article.source]);

  for (const candidate of uniqueArticles) {
    if (
      candidate.group === article.group &&
      candidate.source !== article.source &&
      titleSimilarity(article.title, candidate.title) >= 0.5
    ) {
      relatedSources.add(candidate.source);
    }
  }

  const publishedTime = Date.parse(article.published);
  const ageHours = Number.isFinite(publishedTime)
    ? Math.max(0, (now - publishedTime) / 3_600_000)
    : Number.POSITIVE_INFINITY;
  const coverageScore = Math.min((relatedSources.size - 1) / 3, 1);
  const sourceScore = Math.min(article.sourceWeight / 2, 1);
  const freshnessScore = Number.isFinite(ageHours) ? Math.exp(-ageHours / 36) : 0;
  const positionScore =
    article.candidateCount > 1
      ? 1 - article.feedPosition / (article.candidateCount - 1)
      : 1;
  const titleImpact = calculateTitleImpact(article.title);
  const noveltyScore = noveltyScores[articleIndex];

  article.coverageSources = relatedSources.size;
  article.ranking = {
    coverage: roundedScore(coverageScore),
    titleImpact: roundedScore(titleImpact.score),
    sourceAuthority: roundedScore(sourceScore),
    freshness: roundedScore(freshnessScore),
    feedPosition: roundedScore(positionScore),
    novelty: roundedScore(noveltyScore),
  };
  article.rankingReasons = [
    ...titleImpact.reasons,
    ...(noveltyScore >= 0.65 ? ["unusual language in the current story batch"] : []),
    ...(relatedSources.size > 1 ? ["covered by multiple sources"] : []),
  ];
  article.score = roundedScore(
    coverageScore * rankingWeights.coverage +
      titleImpact.score * rankingWeights.titleImpact +
      sourceScore * rankingWeights.sourceAuthority +
      freshnessScore * rankingWeights.freshness +
      positionScore * rankingWeights.feedPosition +
      noveltyScore * rankingWeights.novelty,
  );
}

uniqueArticles.sort((first, second) => {
  if (second.score !== first.score) {
    return second.score - first.score;
  }

  return (Date.parse(second.published) || 0) - (Date.parse(first.published) || 0);
});

const featuredArticle = uniqueArticles.find((article) => article.group === "ai");

if (featuredArticle) {
  featuredArticle.featured = true;

  try {
    const articlePageImage = await fetchArticleImage(featuredArticle.url);
    featuredArticle.image = highResolutionHeadlineImage(
      articlePageImage || featuredArticle.image,
    );
  } catch (error) {
    featuredArticle.image = highResolutionHeadlineImage(featuredArticle.image);
    console.error(
      `Could not inspect the headline page for ${featuredArticle.url}: ${error.message}`,
    );
  }
}

const publishedArticles = uniqueArticles.map(
  ({ candidateCount, feedPosition, sourceWeight, ...article }) => article,
);

const output = [
  "// Generated by scripts/fetch-news.mjs. Do not edit by hand.",
  `window.DAILY_DOOMSAYER_ARTICLES = ${JSON.stringify(publishedArticles, null, 2)};`,
  "",
].join("\n");

await writeFile("articles.js", output, "utf8");
console.log(
  `Wrote ${publishedArticles.length} ranked articles from ${config.sources.length} configured sources.`,
);
