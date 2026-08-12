import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Parser from "rss-parser";
import {
  calculateDoomIndexV122,
  createDoomIndexV122Fingerprint,
  createDoomIndexV122InputFingerprint,
  normalizedDoomIndexV122Weights,
} from "./doom-index-v1.2.2.mjs";
import {
  calculateDoomIndexV124,
  createDoomIndexV124Fingerprint,
  createDoomIndexV124InputFingerprint,
  normalizedDoomIndexV124Weights,
} from "./doom-index-v1.2.4.mjs";
import {
  buildSourceDirectory,
  calculateIntradayDoom,
  normalizeArticleText,
  normalizedSeverityScale,
} from "./site-data.mjs";

const FEED_TIMEOUT_MS = 20_000;
const ARTICLE_TIMEOUT_MS = 15_000;
const SOURCE_CONCURRENCY = 4;
const FEED_HEADERS = {
  "User-Agent": "Daily Doomsayer RSS aggregator/1.0",
  Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
};

const parser = new Parser({
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
const doomIndexConfig = {
  modelName: String(config.doomIndex?.modelName || "DREAD"),
  version: String(config.doomIndex?.version || "1.2.2"),
  formulaVersion: String(
    config.doomIndex?.formulaVersion || "1.2.2-shadow.1",
  ),
  weights: normalizedDoomIndexV122Weights(config.doomIndex?.weights),
  timeZone: String(config.doomIndex?.timeZone || "America/Chicago"),
  trackingStartedOn: String(config.doomIndex?.trackingStartedOn || ""),
  severityScale: normalizedSeverityScale(config.doomIndex?.severityScale),
  weekStartsOn: "Monday",
  archiveLimit: Math.max(
    1,
    Math.min(Number(config.doomIndex?.archiveLimit) || 10, 100),
  ),
};
const sourceDirectory = buildSourceDirectory(config.sources);

if (!/^\d{4}-\d{2}-\d{2}$/.test(doomIndexConfig.trackingStartedOn)) {
  throw new Error("doomIndex.trackingStartedOn must use YYYY-MM-DD format");
}
const doomIndexShadowConfig = {
  enabled: config.doomIndex?.shadow?.enabled !== false,
  version: String(config.doomIndex?.shadow?.version || "1.2.4"),
  formulaVersion: String(
    config.doomIndex?.shadow?.formulaVersion || "1.2.4-offline.1",
  ),
  weights: normalizedDoomIndexV124Weights(
    config.doomIndex?.shadow?.weights || config.doomIndex?.weights,
  ),
};

if (
  doomIndexShadowConfig.enabled &&
  doomIndexConfig.formulaVersion === doomIndexShadowConfig.formulaVersion
) {
  throw new Error(
    "Public and active-shadow formula versions must be distinct",
  );
}
const DOOM_DATA_DIRECTORY = "data";
const DOOM_HISTORY_DIRECTORY = join(DOOM_DATA_DIRECTORY, "doom-history");
const DOOM_STORIES_FILE = join(DOOM_DATA_DIRECTORY, "doom-stories.json");
const DOOM_ARCHIVE_FILE = "doom-archive.js";
const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
]);

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

const RELATED_STORY_SIMILARITY_THRESHOLD = 0.5;

function coverageScoreForSources(sourceCount) {
  return Math.min((sourceCount - 1) / 3, 1);
}

function sourceAuthorityScore(sourceWeight) {
  return Math.min(sourceWeight / 2, 1);
}

function freshnessScoreForAge(ageHours) {
  return Number.isFinite(ageHours) ? Math.exp(-ageHours / 36) : 0;
}

function feedPositionScore(feedPosition, candidateCount) {
  return candidateCount > 1
    ? 1 - feedPosition / (candidateCount - 1)
    : 1;
}

function articleAgeHours(published, currentTime) {
  const publishedTime = Date.parse(published);

  return Number.isFinite(publishedTime)
    ? Math.max(0, (currentTime - publishedTime) / 3_600_000)
    : Number.POSITIVE_INFINITY;
}

function relatedSourceNames(article, articleList) {
  const relatedSources = new Set([article.source]);

  for (const candidate of articleList) {
    if (
      candidate.group === article.group &&
      candidate.source !== article.source &&
      titleSimilarity(article.title, candidate.title) >=
        RELATED_STORY_SIMILARITY_THRESHOLD
    ) {
      relatedSources.add(candidate.source);
    }
  }

  return relatedSources;
}

function relatedArticleClusters(articleList) {
  const parents = articleList.map((_, index) => index);

  function root(index) {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }

    return index;
  }

  function union(first, second) {
    const firstRoot = root(first);
    const secondRoot = root(second);

    if (firstRoot !== secondRoot) parents[secondRoot] = firstRoot;
  }

  for (let first = 0; first < articleList.length; first += 1) {
    for (let second = first + 1; second < articleList.length; second += 1) {
      if (
        articleList[first].group === articleList[second].group &&
        titleSimilarity(articleList[first].title, articleList[second].title) >=
          RELATED_STORY_SIMILARITY_THRESHOLD
      ) {
        union(first, second);
      }
    }
  }

  const clusters = new Map();

  for (const [index, article] of articleList.entries()) {
    const clusterRoot = root(index);
    const cluster = clusters.get(clusterRoot) || [];
    cluster.push(article);
    clusters.set(clusterRoot, cluster);
  }

  return new Map(
    articleList.map((article, index) => [article, clusters.get(root(index))]),
  );
}

function weightedArticleScore(factors) {
  return (
    factors.coverage * rankingWeights.coverage +
    factors.titleImpact * rankingWeights.titleImpact +
    factors.sourceAuthority * rankingWeights.sourceAuthority +
    factors.freshness * rankingWeights.freshness +
    factors.feedPosition * rankingWeights.feedPosition +
    factors.novelty * rankingWeights.novelty
  );
}

const formulaFingerprint = createDoomIndexV122Fingerprint({
  formulaVersion: doomIndexConfig.formulaVersion,
  weights: doomIndexConfig.weights,
});
const shadowFormulaFingerprint = createDoomIndexV124Fingerprint({
  formulaVersion: doomIndexShadowConfig.formulaVersion,
  weights: doomIndexShadowConfig.weights,
});

function canonicalStoryUrl(value) {
  try {
    const url = new URL(value);

    url.hash = "";
    url.hostname = url.hostname.toLowerCase();

    for (const parameter of [...url.searchParams.keys()]) {
      if (
        parameter.toLowerCase().startsWith("utm_") ||
        TRACKING_PARAMETERS.has(parameter.toLowerCase())
      ) {
        url.searchParams.delete(parameter);
      }
    }

    url.searchParams.sort();

    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }

    return url.href;
  } catch {
    return String(value || "").trim();
  }
}

function storyIdForUrl(value) {
  return createHash("sha256")
    .update(canonicalStoryUrl(value))
    .digest("hex")
    .slice(0, 20);
}

function zonedDateParts(value = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: doomIndexConfig.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parts.hour,
  };
}

function isoWeekKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;

  date.setUTCDate(date.getUTCDate() + 4 - weekday);

  const weekYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil(((date - yearStart) / 86_400_000 + 1) / 7);

  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

async function writeTextFile(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;

  await writeFile(temporaryPath, value, "utf8");
  await rename(temporaryPath, filePath);
}

async function writeJsonFile(filePath, value) {
  await writeTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function doomSampleValue(sample) {
  return Number(
    sample && typeof sample === "object" ? sample.value : sample,
  );
}

function doomSampleFormulaVersion(sample, legacyFormulaVersion) {
  return sample && typeof sample === "object" && sample.formulaVersion
    ? String(sample.formulaVersion)
    : String(legacyFormulaVersion || "1.0");
}

function observedAtForSample(sampleKey, sample) {
  if (sample && typeof sample === "object" && sample.observedAt) {
    return sample.observedAt;
  }

  return `${sampleKey.slice(0, 13)}:00:00.000Z`;
}

function calculateDaySummary(day, formulaVersion, legacyFormulaVersion) {
  const samples = Object.entries(day.samples || {}).sort(([first], [second]) =>
    first.localeCompare(second),
  ).filter(([, sample]) =>
    doomSampleFormulaVersion(sample, legacyFormulaVersion) === formulaVersion,
  );
  const values = samples.map(([, sample]) => doomSampleValue(sample));

  if (values.length === 0) {
    return null;
  }

  const peakEntry = samples.reduce((peak, entry) =>
    doomSampleValue(entry[1]) > doomSampleValue(peak[1]) ? entry : peak,
  );

  const scoreTotal = values.reduce((sum, value) => sum + value, 0);

  return {
    formulaVersion,
    open: values[0],
    high: Math.max(...values),
    low: Math.min(...values),
    close: values.at(-1),
    average: Number((scoreTotal / values.length).toFixed(2)),
    scoreTotal: Number(scoreTotal.toFixed(2)),
    observations: values.length,
    firstObservedAt: observedAtForSample(samples[0][0], samples[0][1]),
    lastObservedAt: observedAtForSample(
      samples.at(-1)[0],
      samples.at(-1)[1],
    ),
    peakSample: doomSampleValue(peakEntry[1]),
    peakSampleHour: peakEntry[0],
  };
}

function copyFormulaSummaryToDay(day, summary) {
  const summaryFields = [
    "formulaVersion",
    "open",
    "high",
    "low",
    "close",
    "average",
    "scoreTotal",
    "observations",
    "firstObservedAt",
    "lastObservedAt",
    "peakSample",
    "peakSampleHour",
    "peakReasons",
    "peakRanking",
    "peakFactors",
  ];

  for (const field of summaryFields) {
    day[field] = summary[field];
  }
}

function archiveStory(article, summary, dateKey) {
  return {
    storyId: article.storyId,
    title: normalizeArticleText(article.title),
    url: article.url,
    source: article.source,
    image: article.image || "",
    date: dateKey,
    peak: summary.high,
    scoreTotal:
      summary.scoreTotal ?? summary.average * summary.observations,
    observations: summary.observations,
    daysTracked: 1,
    peakDate: dateKey,
    firstObservedAt: summary.firstObservedAt,
    lastObservedAt: summary.lastObservedAt,
  };
}

function mergeArchiveStory(existing, incoming) {
  if (!existing) {
    return { ...incoming };
  }

  const incomingHasHigherPeak = incoming.peak > existing.peak;

  return {
    ...existing,
    title: incoming.title,
    url: incoming.url,
    source: incoming.source,
    image: incoming.image || existing.image,
    peak: Math.max(existing.peak, incoming.peak),
    peakDate: incomingHasHigherPeak ? incoming.peakDate : existing.peakDate,
    scoreTotal: existing.scoreTotal + incoming.scoreTotal,
    observations: existing.observations + incoming.observations,
    daysTracked: existing.daysTracked + incoming.daysTracked,
    firstObservedAt:
      existing.firstObservedAt < incoming.firstObservedAt
        ? existing.firstObservedAt
        : incoming.firstObservedAt,
    lastObservedAt:
      existing.lastObservedAt > incoming.lastObservedAt
        ? existing.lastObservedAt
        : incoming.lastObservedAt,
  };
}

function addArchiveCandidate(periods, periodKey, candidate) {
  if (!periods.has(periodKey)) {
    periods.set(periodKey, new Map());
  }

  const stories = periods.get(periodKey);
  stories.set(
    candidate.storyId,
    mergeArchiveStory(stories.get(candidate.storyId), candidate),
  );
}

function rankedArchivePeriods(periods) {
  return [...periods.entries()]
    .sort(([first], [second]) => second.localeCompare(first))
    .map(([period, stories]) => ({
      period,
      stories: [...stories.values()]
        .map(({ scoreTotal, date, ...story }) => ({
          ...story,
          average: Number((scoreTotal / story.observations).toFixed(2)),
        }))
        .sort(
          (first, second) =>
            second.peak - first.peak ||
            second.average - first.average ||
            second.observations - first.observations,
        )
        .slice(0, doomIndexConfig.archiveLimit),
    }));
}

async function buildDoomArchive(generatedAt) {
  const dailyPeriods = new Map();
  const weeklyPeriods = new Map();
  const monthlyPeriods = new Map();
  const historyFiles = (await readdir(DOOM_HISTORY_DIRECTORY))
    .filter((fileName) => /^\d{4}-\d{2}\.json$/.test(fileName))
    .sort();

  for (const fileName of historyFiles) {
    const history = await readJsonFile(join(DOOM_HISTORY_DIRECTORY, fileName), null);

    if (!history?.stories) {
      continue;
    }

    for (const story of Object.values(history.stories)) {
      for (const [dateKey, day] of Object.entries(story.days || {})) {
        const summary =
          day.formulaSummaries?.[doomIndexConfig.formulaVersion] ||
          (String(
            history.legacyFormulaVersion || history.formulaVersion || "1.0",
          ) ===
          doomIndexConfig.formulaVersion
            ? day
            : null);

        if (!summary?.observations) {
          continue;
        }

        const candidate = archiveStory(story, summary, dateKey);
        addArchiveCandidate(dailyPeriods, dateKey, candidate);
        addArchiveCandidate(weeklyPeriods, isoWeekKey(dateKey), candidate);
        addArchiveCandidate(monthlyPeriods, dateKey.slice(0, 7), candidate);
      }
    }
  }

  const archive = {
    version: doomIndexConfig.version,
    formulaVersion: doomIndexConfig.formulaVersion,
    formulaFingerprint,
    timeZone: doomIndexConfig.timeZone,
    weekStartsOn: doomIndexConfig.weekStartsOn,
    generatedAt,
    daily: rankedArchivePeriods(dailyPeriods),
    weekly: rankedArchivePeriods(weeklyPeriods),
    monthly: rankedArchivePeriods(monthlyPeriods),
  };
  const output = [
    "// Generated by scripts/fetch-news.mjs. Do not edit by hand.",
    `window.DAILY_DOOMSAYER_ARCHIVE = ${JSON.stringify(archive, null, 2)};`,
    "",
  ].join("\n");

  await writeTextFile(DOOM_ARCHIVE_FILE, output);
}

function registerFormula(container, observedAt, label, formula) {
  container.formulas ||= {};

  const existingFormula = container.formulas[formula.formulaVersion];

  if (
    existingFormula?.fingerprint &&
    existingFormula.fingerprint !== formula.fingerprint
  ) {
    throw new Error(
      `[doom-index] ${label} already associates formula version ${formula.formulaVersion} with fingerprint ${existingFormula.fingerprint}. Increment the formula version before changing its scoring rules.`,
    );
  }

  container.formulas[formula.formulaVersion] = {
    fingerprint: formula.fingerprint,
    kind: formula.kind,
    status: formula.status,
    weights: formula.weights,
    firstObservedAt: existingFormula?.firstObservedAt || observedAt,
    lastObservedAt: observedAt,
  };
}

function retireInactiveShadowFormulas(container, activeFormulaVersion) {
  for (const [formulaVersion, formula] of Object.entries(
    container.formulas || {},
  )) {
    if (
      formulaVersion !== activeFormulaVersion &&
      String(formula.kind || "").includes("consequence-severity") &&
      formula.status === "shadow"
    ) {
      formula.status = "retired-shadow";
    }
  }
}

async function updateDoomIndexHistory(articleList, observedAt) {
  await mkdir(DOOM_HISTORY_DIRECTORY, { recursive: true });

  const zoned = zonedDateParts(new Date(observedAt));
  const monthKey = zoned.date.slice(0, 7);
  const localHourKey = `${zoned.date}T${zoned.hour}`;
  const legacySampleKey = `${observedAt.slice(0, 13)}Z`;
  const sampleKey = `${legacySampleKey}|${doomIndexConfig.formulaVersion}`;
  const shadowSampleKey = `${legacySampleKey}|${doomIndexShadowConfig.formulaVersion}`;
  const historyFile = join(DOOM_HISTORY_DIRECTORY, `${monthKey}.json`);
  const catalog = await readJsonFile(DOOM_STORIES_FILE, {
    version: doomIndexConfig.version,
    updatedAt: observedAt,
    stories: {},
  });
  const history = await readJsonFile(historyFile, {
    version: doomIndexConfig.version,
    formulaVersion: doomIndexConfig.formulaVersion,
    month: monthKey,
    timeZone: doomIndexConfig.timeZone,
    updatedAt: observedAt,
    stories: {},
  });
  const legacyHistoryFormulaVersion = String(
    history.formulaVersion || doomIndexConfig.formulaVersion,
  );

  catalog.version = doomIndexConfig.version;
  catalog.updatedAt = observedAt;
  catalog.stories ||= {};

  for (const story of Object.values(catalog.stories)) {
    story.currentTitle = normalizeArticleText(story.currentTitle);
    story.originalTitle = normalizeArticleText(
      story.originalTitle || story.currentTitle,
    );
  }
  const publicFormula = {
    formulaVersion: doomIndexConfig.formulaVersion,
    fingerprint: formulaFingerprint,
    kind: "contextual-consequence-severity-v1.2.2",
    status: "public",
    weights: doomIndexConfig.weights,
  };
  const shadowFormula = {
    formulaVersion: doomIndexShadowConfig.formulaVersion,
    fingerprint: shadowFormulaFingerprint,
    kind: "contextual-consequence-severity-v1.2.4",
    status: "shadow",
    weights: doomIndexShadowConfig.weights,
  };

  retireInactiveShadowFormulas(
    catalog,
    doomIndexShadowConfig.formulaVersion,
  );
  registerFormula(catalog, observedAt, DOOM_STORIES_FILE, publicFormula);
  if (doomIndexShadowConfig.enabled) {
    registerFormula(catalog, observedAt, DOOM_STORIES_FILE, shadowFormula);
  }
  history.version = doomIndexConfig.version;
  history.legacyFormulaVersion ||= legacyHistoryFormulaVersion;
  history.formulaVersion = doomIndexConfig.formulaVersion;
  history.formulaFingerprint = formulaFingerprint;
  history.month = monthKey;
  history.timeZone = doomIndexConfig.timeZone;
  history.updatedAt = observedAt;
  history.stories ||= {};

  for (const story of Object.values(history.stories)) {
    story.title = normalizeArticleText(story.title);
  }
  retireInactiveShadowFormulas(
    history,
    doomIndexShadowConfig.formulaVersion,
  );
  registerFormula(history, observedAt, historyFile, publicFormula);
  if (doomIndexShadowConfig.enabled) {
    registerFormula(history, observedAt, historyFile, shadowFormula);
  }

  for (const article of articleList) {
    const canonicalUrl = canonicalStoryUrl(article.url);
    const storyId = storyIdForUrl(article.url);
    const previousCatalogEntry = catalog.stories[storyId];
    const firstSeen = previousCatalogEntry?.firstSeen || observedAt;
    const doomIndex = article.doomIndex;

    article.storyId = storyId;
    article.firstSeen = firstSeen;
    article.lastSeen = observedAt;

    catalog.stories[storyId] = {
      storyId,
      currentTitle: article.title,
      originalTitle: normalizeArticleText(
        previousCatalogEntry?.originalTitle || article.title,
      ),
      url: article.url,
      canonicalUrl,
      source: article.source,
      image: article.image || previousCatalogEntry?.image || "",
      published: article.published,
      firstSeen,
      lastSeen: observedAt,
    };

    const historyStory = history.stories[storyId] || {
      storyId,
      title: article.title,
      url: article.url,
      source: article.source,
      image: article.image || "",
      published: article.published,
      firstSeen,
      lastSeen: observedAt,
      days: {},
    };

    historyStory.title = article.title;
    historyStory.url = article.url;
    historyStory.source = article.source;
    historyStory.image = article.image || historyStory.image;
    historyStory.published = article.published;
    historyStory.firstSeen = historyStory.firstSeen || firstSeen;
    historyStory.lastSeen = observedAt;
    historyStory.days ||= {};

    const day = historyStory.days[zoned.date] || { samples: {} };
    day.samples ||= {};
    day.formulaSummaries ||= {};

    const previousSummary =
      day.formulaSummaries[doomIndexConfig.formulaVersion] ||
      (legacyHistoryFormulaVersion === doomIndexConfig.formulaVersion
        ? day
        : undefined);

    if (
      Object.hasOwn(day.samples, legacySampleKey) &&
      doomSampleFormulaVersion(
        day.samples[legacySampleKey],
        legacyHistoryFormulaVersion,
      ) === doomIndexConfig.formulaVersion
    ) {
      delete day.samples[legacySampleKey];
    }

    historyStory.shadowInputs ||= {};
    historyStory.shadowInputs[doomIndexConfig.formulaVersion] ||= {};
    const publicInputFingerprint = article.doomIndexInputFingerprint;
    const publicFormulaInputs =
      historyStory.shadowInputs[doomIndexConfig.formulaVersion];

    publicFormulaInputs[publicInputFingerprint] ||= {
      title: article.title,
      summary: article.doomIndexInputSummary || "",
      summaryFingerprint: article.doomIndexSummaryFingerprint,
      coverageSources: article.doomIndexCoverageSources,
      factors: article.doomIndexFactors || {},
      reasons: article.doomIndexReasons || [],
      actuality: article.doomIndexActuality,
      polarity: article.doomIndexPolarity,
    };

    day.samples[sampleKey] = {
      value: doomIndex,
      observedAt,
      formulaVersion: doomIndexConfig.formulaVersion,
      formulaFingerprint,
      inputFingerprint: publicInputFingerprint,
    };

    const summary = calculateDaySummary(
      day,
      doomIndexConfig.formulaVersion,
      legacyHistoryFormulaVersion,
    );
    const previousPeakSampleHour = previousSummary?.peakSampleHour;

    if (summary.peakSampleHour === sampleKey) {
      summary.peakReasons = article.doomIndexReasons || [];
      summary.peakFactors = article.doomIndexFactors || {};
    } else if (summary.peakSampleHour === previousPeakSampleHour) {
      summary.peakReasons = previousSummary?.peakReasons || [];
      summary.peakFactors = previousSummary?.peakFactors || {};
    } else {
      summary.peakReasons = [];
      summary.peakFactors = {};
    }

    day.formulaSummaries[doomIndexConfig.formulaVersion] = summary;
    day.activeFormulaVersion = doomIndexConfig.formulaVersion;
    copyFormulaSummaryToDay(day, summary);

    if (doomIndexShadowConfig.enabled) {
      const existingShadowSummary =
        day.formulaSummaries[doomIndexShadowConfig.formulaVersion];

      historyStory.shadowInputs ||= {};
      historyStory.shadowInputs[doomIndexShadowConfig.formulaVersion] ||= {};
      const inputFingerprint = article.doomIndexV124InputFingerprint;
      const formulaInputs =
        historyStory.shadowInputs[doomIndexShadowConfig.formulaVersion];

      formulaInputs[inputFingerprint] ||= {
        title: article.title,
        summary: article.doomIndexV124InputSummary || "",
        summaryFingerprint: article.doomIndexV124SummaryFingerprint,
        coverageSources: article.doomIndexV124CoverageSources,
        factors: article.doomIndexV124Factors || {},
        reasons: article.doomIndexV124Reasons || [],
        actuality: article.doomIndexV124Actuality,
        polarity: article.doomIndexV124Polarity,
      };

      day.samples[shadowSampleKey] = {
        value: article.doomIndexV124Shadow,
        observedAt,
        formulaVersion: doomIndexShadowConfig.formulaVersion,
        formulaFingerprint: shadowFormulaFingerprint,
        inputFingerprint,
      };

      const shadowSummary = calculateDaySummary(
        day,
        doomIndexShadowConfig.formulaVersion,
        legacyHistoryFormulaVersion,
      );
      const existingShadowPeakSampleHour =
        existingShadowSummary?.peakSampleHour;

      if (shadowSummary.peakSampleHour === shadowSampleKey) {
        shadowSummary.peakReasons = article.doomIndexV124Reasons || [];
        shadowSummary.peakFactors = article.doomIndexV124Factors || {};
      } else if (
        shadowSummary.peakSampleHour === existingShadowPeakSampleHour
      ) {
        shadowSummary.peakReasons = existingShadowSummary?.peakReasons || [];
        shadowSummary.peakFactors = existingShadowSummary?.peakFactors || {};
      } else {
        shadowSummary.peakReasons = [];
        shadowSummary.peakFactors = {};
      }

      day.formulaSummaries[doomIndexShadowConfig.formulaVersion] = shadowSummary;
      day.shadowFormulaVersion = doomIndexShadowConfig.formulaVersion;
    }

    historyStory.days[zoned.date] = day;
    history.stories[storyId] = historyStory;
  }

  await writeJsonFile(DOOM_STORIES_FILE, catalog);
  await writeJsonFile(historyFile, history);
  await buildDoomArchive(observedAt);

  const intradayDoom = calculateIntradayDoom(history, {
    date: zoned.date,
    formulaVersion: doomIndexConfig.formulaVersion,
    legacyFormulaVersion: legacyHistoryFormulaVersion,
  });

  console.log(
    `[doom-index] Recorded ${articleList.length} stories for ${localHourKey} (${doomIndexConfig.timeZone})`,
  );

  return intradayDoom;
}

async function requestText(url, { headers, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers,
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Request returned ${response.status}`);
    }

    return {
      text: await response.text(),
      url: response.url || url,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${timeoutMs / 1000} seconds`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function repairInvalidXmlEntities(xml) {
  return xml.replace(
    /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/gi,
    "&amp;",
  );
}

async function parseFeedXml(xml, sourceName) {
  try {
    return await parser.parseString(xml);
  } catch (error) {
    const repairedXml = repairInvalidXmlEntities(xml);

    if (repairedXml === xml) {
      throw error;
    }

    console.warn(`[feed] ${sourceName}: retrying malformed XML safely`);
    return parser.parseString(repairedXml);
  }
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(values[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
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
  return normalizeArticleText(value)
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

function itemAnalysisText(item) {
  return normalizeArticleText([
    ...textValues(item.contentSnippet),
    ...textValues(item.summary),
    ...textValues(item.description),
    ...itemCategories(item),
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 4_000));
}

function sourceIncludeKeywords(source) {
  const keywordSetNames = [
    ...textValues(source.includeKeywordSet),
    ...textValues(source.includeKeywordSets),
  ];
  const keywords = [...textValues(source.includeKeywords)];

  for (const keywordSetName of keywordSetNames) {
    const keywordSet = config.keywordSets?.[keywordSetName];

    if (!Array.isArray(keywordSet)) {
      throw new Error(
        `Unknown include keyword set "${keywordSetName}" for ${source.name || source.feed}`,
      );
    }

    keywords.push(...textValues(keywordSet));
  }

  return [...new Set(keywords.map((keyword) => keyword.trim()).filter(Boolean))];
}

function sourceAcceptsItem(source, item) {
  const categories = itemCategories(item);
  const articleTypes = itemArticleTypes(item);
  const title = normalizeArticleText(item.title);
  const searchableText = [
    title,
    item.contentSnippet,
    item.description,
    item.summary,
  ]
    .filter(Boolean)
    .join(" ");
  const link = String(item.link || "").toLowerCase();
  const includeKeywords = sourceIncludeKeywords(source);

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

  if (includeKeywords.length) {
    inclusionRules.push(
      containsConfiguredTerm(searchableText, includeKeywords),
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

const PROMOTIONAL_ASSET_PATTERN =
  /(?:advert(?:isement|ising)?|sponsored?|newsletter|(?:expo|summit|conference|webinar)[-_/.\s]*banner|banner[-_/.\s]*(?:ad|promo|event|20\d{2}))/i;
const NON_STORY_ASSET_PATTERN =
  /(?:^|[-_/])(logo|icon|avatar|favicon|pixel|tracking)(?:[-_.?/]|$)/i;

function safelyDecodeUri(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function isLikelyPromotionalImage(value, attributes = {}) {
  const searchable = safelyDecodeUri(value).toLowerCase();
  const width = Number(attributes.width) || 0;
  const height = Number(attributes.height) || 0;
  const extremeBannerRatio = width > 0 && height > 0 && width / height >= 4;
  const trackingPixel = width > 0 && height > 0 && width <= 2 && height <= 2;

  return (
    PROMOTIONAL_ASSET_PATTERN.test(searchable) ||
    NON_STORY_ASSET_PATTERN.test(searchable) ||
    extremeBannerRatio ||
    trackingPixel
  );
}

function largestSrcsetImage(srcset, baseUrl) {
  const candidates = String(srcset || "")
    .split(",")
    .map((entry) => {
      const [value, descriptor = ""] = entry.trim().split(/\s+/, 2);
      return {
        url: cleanImageUrl(value, baseUrl),
        size: Number.parseFloat(descriptor) || 0,
      };
    })
    .filter((candidate) => candidate.url);

  candidates.sort((first, second) => second.size - first.size);
  return candidates[0]?.url || "";
}

function imageTitleTokens(title) {
  const ignoredTokens = new Set([
    "about",
    "after",
    "from",
    "into",
    "that",
    "their",
    "these",
    "this",
    "with",
  ]);

  return new Set(
    (String(title || "").toLowerCase().match(/[a-z0-9]{4,}/g) || []).filter(
      (token) => !ignoredTokens.has(token),
    ),
  );
}

function embeddedImageScore(candidate, title) {
  const searchable = safelyDecodeUri(candidate.url).toLowerCase();
  let score = 100 - candidate.index;

  for (const token of imageTitleTokens(title)) {
    if (searchable.includes(token)) {
      score += 8;
    }
  }

  if (/\/uploads\/20\d{2}\/\d{2}\//i.test(searchable)) {
    score += 8;
  }

  if (/\.(?:jpe?g|webp)(?:[?#]|$)/i.test(searchable)) {
    score += 3;
  }

  return score;
}

function bestImageFromHtml(html, { baseUrl, title } = {}) {
  if (typeof html !== "string") {
    return "";
  }

  const tags = html.match(/<img\b[^>]*>/gi) || [];
  const candidates = tags.flatMap((tag, index) => {
    const attributes = {
      width: tagAttribute(tag, "width"),
      height: tagAttribute(tag, "height"),
    };
    const values = [
      largestSrcsetImage(tagAttribute(tag, "srcset"), baseUrl),
      tagAttribute(tag, "data-lazy-src"),
      tagAttribute(tag, "data-src"),
      tagAttribute(tag, "src"),
    ];

    return values
      .map((value) => cleanImageUrl(value, baseUrl))
      .filter(
        (url, valueIndex, urls) =>
          url &&
          urls.indexOf(url) === valueIndex &&
          !isLikelyPromotionalImage(url, attributes),
      )
      .map((url) => ({ url, index }));
  });

  candidates.sort(
    (first, second) =>
      embeddedImageScore(second, title) - embeddedImageScore(first, title),
  );
  return candidates[0]?.url || "";
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

function guardianImageAtWidth(value, width) {
  const imageUrl = cleanImageUrl(value);

  if (!imageUrl) {
    return "";
  }

  try {
    const url = new URL(imageUrl);

    if (url.hostname === "i.guim.co.uk") {
      url.search = "";
      url.searchParams.set("width", String(width));
      url.searchParams.set("dpr", "2");
      url.searchParams.set("s", "none");
      url.searchParams.set("crop", "none");
    }

    return url.href;
  } catch {
    return imageUrl;
  }
}

function politicoImageAtWidth(value, width) {
  const imageUrl = cleanImageUrl(value);

  if (!imageUrl) {
    return "";
  }

  try {
    const url = new URL(imageUrl);

    if (
      url.hostname === "www.politico.com" &&
      url.pathname.startsWith("/dims4/") &&
      /\/resize\/\d+\//.test(url.pathname)
    ) {
      url.pathname = url.pathname.replace(
        /\/resize\/\d+\//,
        `/resize/${width}/`,
      );
    }

    return url.href;
  } catch {
    return imageUrl;
  }
}

function highResolutionStoryImage(value) {
  return politicoImageAtWidth(guardianImageAtWidth(value, 800), 800);
}

function highResolutionHeadlineImage(value) {
  return politicoImageAtWidth(guardianImageAtWidth(value, 1900), 1900);
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

        if (imageUrl && !isLikelyPromotionalImage(imageUrl)) {
          return imageUrl;
        }
      }
    }
  }

  return "";
}

async function fetchArticleImage(articleUrl) {
  const canonicalArticleUrl = canonicalStoryUrl(articleUrl);
  let articleOrigin = "";

  try {
    articleOrigin = `${new URL(canonicalArticleUrl).origin}/`;
  } catch {
    articleOrigin = "";
  }

  const page = await requestText(canonicalArticleUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif," +
        "image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      ...(articleOrigin ? { Referer: articleOrigin } : {}),
    },
    timeoutMs: ARTICLE_TIMEOUT_MS,
  });

  return socialImageFromHtml(page.text, page.url);
}

function wordpressFeaturedImageFromPost(post, baseUrl) {
  const media = post?._embedded?.["wp:featuredmedia"]?.[0];

  if (!media || typeof media !== "object") {
    return "";
  }

  const originalWidth = Number(media.media_details?.width) || 0;
  const originalHeight = Number(media.media_details?.height) || 0;
  const candidates = [
    {
      url: media.source_url,
      width: originalWidth,
      height: originalHeight,
    },
    ...Object.values(media.media_details?.sizes || {}).map((size) => ({
      url: size?.source_url,
      width: Number(size?.width) || 0,
      height: Number(size?.height) || 0,
    })),
  ]
    .map((candidate) => ({
      ...candidate,
      url: cleanImageUrl(candidate.url, baseUrl),
    }))
    .filter(
      (candidate) =>
        candidate.url &&
        !isLikelyPromotionalImage(candidate.url, {
          width: candidate.width,
          height: candidate.height,
        }),
    );

  candidates.sort(
    (first, second) =>
      second.width * second.height - first.width * first.height,
  );

  return candidates[0]?.url || "";
}

async function fetchWordPressFeaturedImage(articleUrl) {
  const canonicalArticleUrl = canonicalStoryUrl(articleUrl);
  const article = new URL(canonicalArticleUrl);
  const slug = article.pathname.split("/").filter(Boolean).at(-1);

  if (!slug) {
    return "";
  }

  const endpoint = new URL("/wp-json/wp/v2/posts", article.origin);
  endpoint.searchParams.set("slug", slug);
  endpoint.searchParams.set("_embed", "wp:featuredmedia");

  const response = await requestText(endpoint.href, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
      Accept: "application/json,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: `${article.origin}/`,
    },
    timeoutMs: ARTICLE_TIMEOUT_MS,
  });
  const posts = JSON.parse(response.text);

  if (!Array.isArray(posts) || posts.length === 0) {
    return "";
  }

  return highResolutionStoryImage(
    wordpressFeaturedImageFromPost(posts[0], article.origin),
  );
}

function highResolutionBlueskyImage(value) {
  const imageUrl = cleanImageUrl(value);

  if (!imageUrl) {
    return "";
  }

  return imageUrl.replace("/feed_thumbnail/", "/feed_fullsize/");
}

function blueskyExternalCard(feedEntry) {
  const external = feedEntry?.post?.embed?.external;

  if (!external?.uri || !external?.thumb) {
    return null;
  }

  return {
    articleUrl: canonicalStoryUrl(external.uri),
    title: normalizeArticleText(external.title || ""),
    image: highResolutionBlueskyImage(external.thumb),
  };
}

async function fetchBlueskyArticleImages(actor, articles) {
  const requestedArticles = articles
    .map((article) => ({
      articleUrl: canonicalStoryUrl(article.url),
      title: normalizeArticleText(article.title || ""),
    }))
    .filter((article) => article.articleUrl);
  const requestedUrls = new Set(
    requestedArticles.map((article) => article.articleUrl),
  );
  const images = new Map();
  let cursor = "";

  for (let page = 0; page < 10 && requestedUrls.size > images.size; page += 1) {
    const endpoint = new URL(
      "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed",
    );
    endpoint.searchParams.set("actor", actor);
    endpoint.searchParams.set("limit", "100");
    endpoint.searchParams.set("filter", "posts_with_links");
    if (cursor) endpoint.searchParams.set("cursor", cursor);

    const response = await requestText(endpoint.href, {
      headers: {
        "User-Agent": "Daily Doomsayer RSS aggregator/1.0",
        Accept: "application/json",
      },
      timeoutMs: ARTICLE_TIMEOUT_MS,
    });
    const payload = JSON.parse(response.text);

    for (const feedEntry of Array.isArray(payload.feed) ? payload.feed : []) {
      const card = blueskyExternalCard(feedEntry);
      let matchedUrl = card?.articleUrl;

      if (card?.image && !requestedUrls.has(matchedUrl) && card.title) {
        const titleMatches = requestedArticles
          .filter((article) => !images.has(article.articleUrl))
          .map((article) => ({
            ...article,
            similarity: titleSimilarity(article.title, card.title),
          }))
          .filter((article) => article.similarity >= 0.8)
          .sort((first, second) => second.similarity - first.similarity);

        if (
          titleMatches.length > 0 &&
          (titleMatches.length === 1 ||
            titleMatches[0].similarity > titleMatches[1].similarity)
        ) {
          matchedUrl = titleMatches[0].articleUrl;
        }
      }

      if (
        card?.image &&
        requestedUrls.has(matchedUrl) &&
        !isLikelyPromotionalImage(card.image)
      ) {
        images.set(matchedUrl, card.image);
      }
    }

    const nextCursor = String(payload.cursor || "");
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }

  return images;
}

function extractImage(item) {
  const enclosureImage =
    item.enclosure?.url &&
    (!item.enclosure.type || item.enclosure.type.startsWith("image/"))
      ? item.enclosure.url
      : "";

  const structuredCandidates = [
    enclosureImage,
    mediaUrl(item.mediaContent),
    mediaUrl(item.mediaThumbnail),
  ];
  const structuredImage = structuredCandidates
    .map((value) => cleanImageUrl(value))
    .find((value) => value && !isLikelyPromotionalImage(value));
  const embeddedImage = [
    item.contentEncoded,
    item.content,
    item.description,
  ]
    .map((html) => bestImageFromHtml(html, { title: item.title }))
    .find(Boolean);

  return highResolutionStoryImage(structuredImage || embeddedImage || "");
}

function metaContentFromHtml(html, names) {
  const acceptedNames = new Set(names.map((name) => name.toLowerCase()));

  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const name = (
      tagAttribute(tag, "property") || tagAttribute(tag, "name")
    ).toLowerCase();

    if (acceptedNames.has(name)) {
      const content = normalizeArticleText(tagAttribute(tag, "content"));
      if (content) return content;
    }
  }

  return "";
}

function pageArticleLinks(html, pageUrl, configuredPatterns = []) {
  const patterns = textValues(configuredPatterns)
    .map((pattern) => String(pattern).toLowerCase())
    .filter(Boolean);
  const page = new URL(pageUrl);
  const seen = new Set();
  const links = [];
  const anchorPattern = /<a\b([^>]*\bhref\s*=\s*(["'])(.*?)\2[^>]*)>([\s\S]*?)<\/a>/gi;

  for (const match of html.matchAll(anchorPattern)) {
    const attributes = match[1];
    const href = match[3];
    let url;

    try {
      url = new URL(href, pageUrl);
    } catch {
      continue;
    }

    if (!/^https?:$/i.test(url.protocol) || url.hostname !== page.hostname) {
      continue;
    }

    const normalizedUrl = canonicalStoryUrl(url.href);
    const normalizedPageUrl = canonicalStoryUrl(pageUrl);
    const searchableUrl = normalizedUrl.toLowerCase();

    if (
      !normalizedUrl ||
      normalizedUrl === normalizedPageUrl ||
      seen.has(normalizedUrl) ||
      (patterns.length && !patterns.some((pattern) => searchableUrl.includes(pattern)))
    ) {
      continue;
    }

    const title = normalizeArticleText(
      tagAttribute(attributes, "aria-label") ||
        tagAttribute(attributes, "title") ||
        match[4],
    );

    if (title.length < 12) continue;
    seen.add(normalizedUrl);
    links.push({ url: normalizedUrl, title });
  }

  return links;
}

function articleMetadataFromHtml(html, pageUrl, fallbackTitle = "") {
  const title =
    metaContentFromHtml(html, ["og:title", "twitter:title"]) ||
    normalizeArticleText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]) ||
    normalizeArticleText(fallbackTitle);
  const description = metaContentFromHtml(html, [
    "og:description",
    "twitter:description",
    "description",
  ]);
  const published =
    metaContentFromHtml(html, [
      "article:published_time",
      "datepublished",
      "date",
    ]) ||
    normalizeArticleText(
      html.match(/["']datePublished["']\s*:\s*["']([^"']+)["']/i)?.[1],
    );

  return {
    title,
    link: pageUrl,
    isoDate: published,
    description,
    summary: description,
    image: highResolutionStoryImage(socialImageFromHtml(html, pageUrl)),
  };
}

async function fetchSourcePageArticles(source) {
  const group = String(source.group ?? "").trim();
  const sourceName = source.name || source.pageUrl;

  if (!group) {
    throw new Error(`Invalid group for source: ${sourceName}`);
  }

  const startedAt = Date.now();
  console.log(`[page] Fetching ${sourceName}`);

  try {
    const response = await requestText(source.pageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Daily Doomsayer/1.0; news aggregator)",
        Accept: "text/html,application/xhtml+xml",
      },
      timeoutMs: FEED_TIMEOUT_MS,
    });
    const limit = Math.max(1, Math.min(Number(source.limit) || 10, 10));
    const sourceWeight = Math.max(0.1, Math.min(Number(source.weight) || 1, 2));
    const candidates = pageArticleLinks(
      response.text,
      response.url,
      source.pageArticleUrlPatterns,
    ).slice(0, limit);
    const fetchedItems = await mapWithConcurrency(
      candidates,
      3,
      async (candidate) => {
        try {
          const articlePage = await requestText(candidate.url, {
            headers: {
              "User-Agent": "Mozilla/5.0 (compatible; Daily Doomsayer/1.0; news aggregator)",
              Accept: "text/html,application/xhtml+xml",
            },
            timeoutMs: ARTICLE_TIMEOUT_MS,
          });
          return articleMetadataFromHtml(
            articlePage.text,
            articlePage.url,
            candidate.title,
          );
        } catch (error) {
          console.error(
            `[page] Could not inspect ${candidate.url}: ${error.message}`,
          );
          return null;
        }
      },
    );
    const acceptedItems = fetchedItems
      .filter((item) => item?.title && item?.link)
      .filter((item) => sourceAcceptsItem(source, item));
    const sourceArticles = acceptedItems.map((item, feedPosition) => ({
      group,
      title: normalizeArticleText(item.title),
      url: item.link,
      source: normalizeArticleText(source.name),
      published: item.isoDate || "",
      image: item.image || "",
      analysisText: itemAnalysisText(item),
      feedPosition,
      sourceWeight,
      candidateCount: acceptedItems.length,
    }));

    console.log(
      `[page] Finished ${sourceName}: ${sourceArticles.length} articles in ${Date.now() - startedAt}ms`,
    );
    return sourceArticles;
  } catch (error) {
    console.error(
      `[page] Skipped ${sourceName} after ${Date.now() - startedAt}ms: ${error.message}`,
    );
    return [];
  }
}

async function fetchSourceArticles(source) {
  const group = String(source.group ?? "").trim();
  const sourceName = source.name || source.feed;

  if (!group) {
    throw new Error(`Invalid group for source: ${sourceName}`);
  }

  const startedAt = Date.now();
  console.log(`[feed] Fetching ${sourceName}`);

  try {
    const response = await requestText(source.feed, {
      headers: FEED_HEADERS,
      timeoutMs: FEED_TIMEOUT_MS,
    });
    const feed = await parseFeedXml(response.text, sourceName);
    const limit = Math.max(1, Math.min(Number(source.limit) || 10, 10));
    const sourceWeight = Math.max(0.1, Math.min(Number(source.weight) || 1, 2));
    const acceptedItems = feed.items
      .filter((item) => sourceAcceptsItem(source, item))
      .slice(0, limit);
    const sourceArticles = [];

    for (const [feedPosition, item] of acceptedItems.entries()) {
      if (!item.title || !item.link) {
        continue;
      }

      sourceArticles.push({
        group,
        title: normalizeArticleText(item.title),
        url: item.link,
        source: normalizeArticleText(source.name || feed.title || ""),
        published: item.isoDate || item.pubDate || "",
        image: extractImage(item),
        analysisText: itemAnalysisText(item),
        feedPosition,
        sourceWeight,
        candidateCount: acceptedItems.length,
      });
    }

    if (source.resolveMissingArticleImages === true) {
      let blueskyImages = new Map();

      if (source.blueskyImageFallbackActor) {
        try {
          blueskyImages = await fetchBlueskyArticleImages(
            source.blueskyImageFallbackActor,
            sourceArticles.filter((article) => !article.image),
          );
        } catch (error) {
          console.error(
            `[image] Could not inspect Bluesky cards for ${sourceName}: ${error.message}`,
          );
        }
      }

      await mapWithConcurrency(sourceArticles, 3, async (article) => {
        if (article.image) {
          return;
        }

        article.image = blueskyImages.get(canonicalStoryUrl(article.url)) || "";

        if (article.image) {
          return;
        }

        if (source.wordpressFeaturedImageFallback === true) {
          try {
            article.image = await fetchWordPressFeaturedImage(article.url);
          } catch (error) {
            console.error(
              `[image] Could not inspect WordPress metadata for ${article.url}: ${error.message}`,
            );
          }
        }

        if (article.image) {
          return;
        }

        if (source.articlePageImageFallback === false) {
          return;
        }

        try {
          article.image = highResolutionStoryImage(
            await fetchArticleImage(article.url),
          );
        } catch (error) {
          console.error(
            `[image] Could not inspect ${article.url}: ${error.message}`,
          );
        }
      });
    }

    console.log(
      `[feed] Finished ${sourceName}: ${sourceArticles.length} articles in ${Date.now() - startedAt}ms`,
    );
    return sourceArticles;
  } catch (error) {
    console.error(
      `[feed] Skipped ${sourceName} after ${Date.now() - startedAt}ms: ${error.message}`,
    );
    return [];
  }
}

const configuredFeeds = config.sources.flatMap((source) => {
  const feeds = Array.isArray(source.feeds) ? source.feeds : [source.feed];

  return feeds
    .filter((feed) => typeof feed === "string" && feed.trim())
    .map((feed) => ({ ...source, feed: feed.trim() }));
});

const configuredPages = config.sources
  .filter(
    (source) =>
      typeof source.pageUrl === "string" && source.pageUrl.trim(),
  )
  .map((source) => ({ ...source, pageUrl: source.pageUrl.trim() }));

const configuredSources = [
  ...configuredFeeds.map((source) => ({ type: "feed", source })),
  ...configuredPages.map((source) => ({ type: "page", source })),
];

const sourceBatches = await mapWithConcurrency(
  configuredSources,
  SOURCE_CONCURRENCY,
  ({ type, source }) =>
    type === "page"
      ? fetchSourcePageArticles(source)
      : fetchSourceArticles(source),
);
articles.push(...sourceBatches.flat());

const uniqueArticles = Array.from(
  new Map(
    articles.map((article) => [canonicalStoryUrl(article.url), article]),
  ).values(),
);

if (uniqueArticles.length === 0) {
  throw new Error(
    "No articles were fetched; existing generated site data was left unchanged",
  );
}

const now = Date.now();
const noveltyScores = calculateNoveltyScores(uniqueArticles);
const severityClusters = relatedArticleClusters(uniqueArticles);

for (const [articleIndex, article] of uniqueArticles.entries()) {
  const relatedSources = relatedSourceNames(article, uniqueArticles);
  const ageHours = articleAgeHours(article.published, now);
  const coverageScore = coverageScoreForSources(relatedSources.size);
  const sourceScore = sourceAuthorityScore(article.sourceWeight);
  const freshnessScore = freshnessScoreForAge(ageHours);
  const positionScore = feedPositionScore(
    article.feedPosition,
    article.candidateCount,
  );
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
    weightedArticleScore({
      coverage: coverageScore,
      titleImpact: titleImpact.score,
      sourceAuthority: sourceScore,
      freshness: freshnessScore,
      feedPosition: positionScore,
      novelty: noveltyScore,
    }),
  );

  const severityCluster = severityClusters.get(article) || [article];
  const severityCoverageSources = new Set(
    severityCluster.map((candidate) => candidate.source),
  ).size;
  const severitySummary = severityCluster
    .map((candidate) => `${candidate.title}. ${candidate.analysisText || ""}`)
    .join(" ");
  const publicDoomIndex = calculateDoomIndexV122({
    title: article.title,
    summary: severitySummary,
    coverageSources: severityCoverageSources,
    weights: doomIndexConfig.weights,
  });
  const summaryFingerprint = createHash("sha256")
    .update(normalizeArticleText(severitySummary))
    .digest("hex")
    .slice(0, 20);

  article.doomIndex = publicDoomIndex.value;
  article.doomIndexVersion = doomIndexConfig.version;
  article.doomIndexFormulaVersion = doomIndexConfig.formulaVersion;
  article.doomIndexFormulaFingerprint = formulaFingerprint;
  article.doomIndexActuality = publicDoomIndex.actuality;
  article.doomIndexPolarity = publicDoomIndex.polarity;
  article.doomIndexFactors = publicDoomIndex.factors;
  article.doomIndexReasons = publicDoomIndex.reasons;
  article.doomIndexCoverageSources = severityCoverageSources;
  article.doomIndexInputSummary = severitySummary;
  article.doomIndexSummaryFingerprint = summaryFingerprint;
  article.doomIndexInputFingerprint = createDoomIndexV122InputFingerprint({
    title: article.title,
    summary: severitySummary,
    coverageSources: severityCoverageSources,
    formulaVersion: doomIndexConfig.formulaVersion,
  });

  if (doomIndexShadowConfig.enabled) {
    const shadow = calculateDoomIndexV124({
      title: article.title,
      summary: severitySummary,
      coverageSources: severityCoverageSources,
      weights: doomIndexShadowConfig.weights,
    });

    article.doomIndexV124Shadow = shadow.value;
    article.doomIndexV124ShadowVersion = doomIndexShadowConfig.version;
    article.doomIndexV124ShadowFormulaVersion =
      doomIndexShadowConfig.formulaVersion;
    article.doomIndexV124ShadowFormulaFingerprint =
      shadowFormulaFingerprint;
    article.doomIndexV124Actuality = shadow.actuality;
    article.doomIndexV124Polarity = shadow.polarity;
    article.doomIndexV124Factors = shadow.factors;
    article.doomIndexV124Reasons = shadow.reasons;
    article.doomIndexV124CoverageSources = severityCoverageSources;
    article.doomIndexV124InputSummary = severitySummary;
    article.doomIndexV124SummaryFingerprint = summaryFingerprint;
    article.doomIndexV124InputFingerprint =
      createDoomIndexV124InputFingerprint({
        title: article.title,
        summary: severitySummary,
        coverageSources: severityCoverageSources,
        formulaVersion: doomIndexShadowConfig.formulaVersion,
      });
  }
}

uniqueArticles.sort((first, second) => {
  if (second.doomIndex !== first.doomIndex) {
    return second.doomIndex - first.doomIndex;
  }

  if (second.score !== first.score) {
    return second.score - first.score;
  }

  return (Date.parse(second.published) || 0) - (Date.parse(first.published) || 0);
});

const featuredArticle = uniqueArticles.find((article) => article.group === "ai");

if (featuredArticle) {
  featuredArticle.featured = true;
  const featuredSource = config.sources.find(
    (source) => source.name === featuredArticle.source,
  );

  if (featuredSource?.articlePageImageFallback === false) {
    featuredArticle.image = highResolutionHeadlineImage(featuredArticle.image);
  } else {
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
}

const observationTime = new Date();
observationTime.setUTCMinutes(0, 0, 0);
const intradayDoom = await updateDoomIndexHistory(
  uniqueArticles,
  observationTime.toISOString(),
);

const publishedArticles = uniqueArticles.map(
  ({
    analysisText,
    candidateCount,
    feedPosition,
    sourceWeight,
    doomIndexInputSummary,
    doomIndexV124InputSummary,
    ...article
  }) => ({
    ...article,
    feedSummary: normalizeArticleText(analysisText),
    doomIndexInputSummary: normalizeArticleText(doomIndexInputSummary),
  }),
);

const output = [
  "// Generated by scripts/fetch-news.mjs. Do not edit by hand.",
  `window.DAILY_DOOMSAYER_SITE = ${JSON.stringify(
    {
      chronicle: {
        trackingStartedOn: doomIndexConfig.trackingStartedOn,
        timeZone: doomIndexConfig.timeZone,
      },
      doomIndex: {
        modelName: doomIndexConfig.modelName,
        version: doomIndexConfig.version,
        formulaVersion: doomIndexConfig.formulaVersion,
        severityScale: doomIndexConfig.severityScale,
        shadow: doomIndexShadowConfig.enabled
          ? {
              version: doomIndexShadowConfig.version,
              formulaVersion: doomIndexShadowConfig.formulaVersion,
            }
          : null,
      },
      intradayDoom: {
        ...intradayDoom,
        definition: "Highest public Doom Index story observed during each hourly update.",
      },
      sources: sourceDirectory,
    },
    null,
    2,
  )};`,
  `window.DAILY_DOOMSAYER_ARTICLES = ${JSON.stringify(publishedArticles, null, 2)};`,
  "",
].join("\n");

await writeTextFile("articles.js", output);
await new Promise((resolve) =>
  process.stdout.write(
    `Wrote ${publishedArticles.length} ranked articles from ${config.sources.length} configured sources across ${configuredFeeds.length} feeds.\n`,
    resolve,
  ),
);
process.exit(0);
