import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  DOOM_INDEX_V12_FACTOR_NAMES,
  calculateDoomIndexV12FromFactors,
  createDoomIndexV12Fingerprint,
  normalizedDoomIndexV12Weights,
} from "./doom-index-v1.2.mjs";

const HISTORY_DIRECTORY = join("data", "doom-history");
const REQUIRED_RANKING_COMPONENTS = [
  "coverage",
  "titleImpact",
  "sourceAuthority",
  "freshness",
  "feedPosition",
  "novelty",
];
const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
]);
const errors = [];

function reportError(message, details = {}) {
  errors.push({ message, ...details });
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readWindowAssignment(filePath, globalName) {
  const text = await readFile(filePath, "utf8");
  const prefix = `window.${globalName} = `;
  const start = text.indexOf(prefix);

  if (start < 0) {
    throw new Error(`${filePath} does not define window.${globalName}`);
  }

  return JSON.parse(
    text.slice(start + prefix.length).replace(/;\s*$/, ""),
  );
}

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

function normalizedWeights(configuredWeights = {}) {
  const weights = Object.fromEntries(
    REQUIRED_RANKING_COMPONENTS.map((name) => [
      name,
      Number(configuredWeights[name]),
    ]),
  );
  const total = Object.values(weights).reduce(
    (sum, weight) => sum + weight,
    0,
  );

  if (
    !Number.isFinite(total) ||
    total <= 0 ||
    Object.values(weights).some((weight) => !Number.isFinite(weight) || weight < 0)
  ) {
    throw new Error("news-sources.json contains invalid ranking weights");
  }

  return Object.fromEntries(
    Object.entries(weights).map(([name, weight]) => [name, weight / total]),
  );
}

function sampleValue(sample) {
  return Number(
    sample && typeof sample === "object" ? sample.value : sample,
  );
}

function sampleFormulaVersion(sample, legacyFormulaVersion) {
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

function calculateSummary(entries, formulaVersion) {
  const samples = entries
    .filter((entry) => entry.formulaVersion === formulaVersion)
    .sort((first, second) => first.key.localeCompare(second.key));
  const values = samples.map((entry) => entry.value);

  if (values.length === 0) {
    return null;
  }

  const scoreTotal = values.reduce((sum, value) => sum + value, 0);
  const peak = samples.reduce((currentPeak, sample) =>
    sample.value > currentPeak.value ? sample : currentPeak,
  );

  return {
    formulaVersion,
    open: values[0],
    high: Math.max(...values),
    low: Math.min(...values),
    close: values.at(-1),
    average: Number((scoreTotal / values.length).toFixed(2)),
    scoreTotal: Number(scoreTotal.toFixed(2)),
    observations: values.length,
    firstObservedAt: samples[0].observedAt,
    lastObservedAt: samples.at(-1).observedAt,
    peakSample: peak.value,
    peakSampleHour: peak.key,
  };
}

function compareSummary(actual, expected, context) {
  const fields = [
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
  ];

  for (const field of fields) {
    if (
      (field === "scoreTotal" || field === "formulaVersion") &&
      actual[field] === undefined
    ) {
      continue;
    }

    if (actual[field] !== expected[field]) {
      reportError(`Incorrect daily ${field}`, {
        ...context,
        actual: actual[field],
        expected: expected[field],
      });
    }
  }
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

function rankArchivePeriods(periods, limit) {
  return [...periods.entries()]
    .sort(([first], [second]) => second.localeCompare(first))
    .map(([period, stories]) => ({
      period,
      stories: [...stories.values()]
        .map(({ scoreTotal, ...story }) => ({
          ...story,
          average: Number((scoreTotal / story.observations).toFixed(2)),
        }))
        .sort(
          (first, second) =>
            second.peak - first.peak ||
            second.average - first.average ||
            second.observations - first.observations,
        )
        .slice(0, limit),
    }));
}

function compareArchivePeriods(actualPeriods, expectedPeriods, periodType) {
  if (actualPeriods.length !== expectedPeriods.length) {
    reportError(`Incorrect ${periodType} archive period count`, {
      actual: actualPeriods.length,
      expected: expectedPeriods.length,
    });
  }

  for (
    let periodIndex = 0;
    periodIndex < Math.min(actualPeriods.length, expectedPeriods.length);
    periodIndex += 1
  ) {
    const actualPeriod = actualPeriods[periodIndex];
    const expectedPeriod = expectedPeriods[periodIndex];

    if (actualPeriod.period !== expectedPeriod.period) {
      reportError(`Incorrect ${periodType} archive period`, {
        actual: actualPeriod.period,
        expected: expectedPeriod.period,
      });
      continue;
    }

    const actualStories = actualPeriod.stories || [];
    const expectedStories = expectedPeriod.stories || [];

    if (actualStories.length !== expectedStories.length) {
      reportError(`Incorrect ${periodType} archive story count`, {
        period: actualPeriod.period,
        actual: actualStories.length,
        expected: expectedStories.length,
      });
    }

    for (
      let storyIndex = 0;
      storyIndex < Math.min(actualStories.length, expectedStories.length);
      storyIndex += 1
    ) {
      const actual = actualStories[storyIndex];
      const expected = expectedStories[storyIndex];

      for (const field of [
        "storyId",
        "peak",
        "average",
        "observations",
        "daysTracked",
        "peakDate",
      ]) {
        if (actual[field] !== expected[field]) {
          reportError(`Incorrect ${periodType} archive ${field}`, {
            period: actualPeriod.period,
            position: storyIndex + 1,
            actual: actual[field],
            expected: expected[field],
          });
        }
      }
    }
  }
}

const config = await readJson("news-sources.json");
const articles = await readWindowAssignment(
  "articles.js",
  "DAILY_DOOMSAYER_ARTICLES",
);
const archive = await readWindowAssignment(
  "doom-archive.js",
  "DAILY_DOOMSAYER_ARCHIVE",
);
const catalog = await readJson(join("data", "doom-stories.json"));
const formulaVersion = String(config.doomIndex?.formulaVersion || "1.0");
const schemaVersion = String(config.doomIndex?.version || "1.1.1");
const shadowEnabled = config.doomIndex?.shadow?.enabled !== false;
const shadowVersion = String(
  config.doomIndex?.shadow?.version || "1.2.0",
);
const shadowFormulaVersion = String(
  config.doomIndex?.shadow?.formulaVersion || "1.2-shadow.1",
);
const shadowWeights = normalizedDoomIndexV12Weights(
  config.doomIndex?.shadow?.weights,
);
const expectedShadowFingerprint = createDoomIndexV12Fingerprint({
  formulaVersion: shadowFormulaVersion,
  weights: shadowWeights,
});
const archiveLimit = Math.max(
  1,
  Math.min(Number(config.doomIndex?.archiveLimit) || 10, 100),
);
const weights = normalizedWeights(config.ranking);
const registeredFormula = catalog.formulas?.[formulaVersion];
const registeredShadowFormula = catalog.formulas?.[shadowFormulaVersion];

if (!registeredFormula?.fingerprint) {
  reportError("The story catalog has no registered formula fingerprint", {
    formulaVersion,
  });
}

const formulaFingerprint = registeredFormula?.fingerprint;

if (
  shadowEnabled &&
  registeredShadowFormula?.fingerprint !== expectedShadowFingerprint
) {
  reportError("The story catalog has no valid 1.2 shadow fingerprint", {
    formulaVersion: shadowFormulaVersion,
    actual: registeredShadowFormula?.fingerprint,
    expected: expectedShadowFingerprint,
  });
}
const seenStoryIds = new Set();

for (const article of articles) {
  const context = { storyId: article.storyId, title: article.title };

  if (seenStoryIds.has(article.storyId)) {
    reportError("Duplicate story ID", context);
  }

  seenStoryIds.add(article.storyId);

  if (article.storyId !== storyIdForUrl(article.url)) {
    reportError("Story ID does not match the canonical URL", context);
  }

  if (!catalog.stories?.[article.storyId]) {
    reportError("Story is missing from the catalog", context);
  }

  if (article.doomIndexVersion !== schemaVersion) {
    reportError("Story uses the wrong Doom Index schema version", context);
  }

  if (article.doomIndexFormulaVersion !== formulaVersion) {
    reportError("Story uses the wrong formula version", context);
  }

  if (article.doomIndexFormulaFingerprint !== formulaFingerprint) {
    reportError("Story uses an unregistered formula fingerprint", context);
  }

  const expectedDoomIndex = Number(
    (Math.max(0, Math.min(Number(article.score) || 0, 1)) * 100).toFixed(2),
  );

  if (article.doomIndex !== expectedDoomIndex) {
    reportError("Doom Index does not match score × 100", {
      ...context,
      actual: article.doomIndex,
      expected: expectedDoomIndex,
    });
  }

  if (shadowEnabled) {
    if (article.doomIndexV12ShadowVersion !== shadowVersion) {
      reportError("Story uses the wrong 1.2 shadow version", context);
    }

    if (
      article.doomIndexV12ShadowFormulaVersion !== shadowFormulaVersion ||
      article.doomIndexV12ShadowFormulaFingerprint !==
        expectedShadowFingerprint
    ) {
      reportError("Story uses an unregistered 1.2 shadow formula", context);
    }

    for (const factor of [
      ...DOOM_INDEX_V12_FACTOR_NAMES,
      "evidence",
      "routinePenalty",
    ]) {
      const value = Number(article.doomIndexV12Factors?.[factor]);

      if (!Number.isFinite(value) || value < 0 || value > 1) {
        reportError("1.2 shadow factor is outside 0-1", {
          ...context,
          factor,
          value: article.doomIndexV12Factors?.[factor],
        });
      }
    }

    const reconstructedShadow = calculateDoomIndexV12FromFactors(
      article.doomIndexV12Factors || {},
      shadowWeights,
    );

    if (article.doomIndexV12Shadow !== reconstructedShadow.value) {
      reportError("Stored 1.2 shadow value does not match its factors", {
        ...context,
        actual: article.doomIndexV12Shadow,
        expected: reconstructedShadow.value,
      });
    }

    if (!Array.isArray(article.doomIndexV12Reasons)) {
      reportError("Story is missing its 1.2 shadow reasons", context);
    }
  }

  let reconstructedScore = 0;

  for (const component of REQUIRED_RANKING_COMPONENTS) {
    const value = Number(article.ranking?.[component]);

    if (!Number.isFinite(value) || value < 0 || value > 1) {
      reportError("Ranking component is outside 0–1", {
        ...context,
        component,
        value: article.ranking?.[component],
      });
      continue;
    }

    reconstructedScore += value * weights[component];
  }

  if (Math.abs(reconstructedScore - article.score) > 0.00011) {
    reportError("Stored score does not match its ranking components", {
      ...context,
      actual: article.score,
      reconstructed: Number(reconstructedScore.toFixed(6)),
    });
  }
}

const expectedArticleOrder = [...articles].sort(
  (first, second) =>
    second.score - first.score ||
    (Date.parse(second.published) || 0) -
      (Date.parse(first.published) || 0),
);

for (const [index, article] of articles.entries()) {
  if (article.storyId !== expectedArticleOrder[index]?.storyId) {
    reportError("Articles are not sorted by score", {
      position: index + 1,
      actual: article.title,
      expected: expectedArticleOrder[index]?.title,
    });
    break;
  }
}

const featuredArticle = articles.find((article) => article.featured);
const highestAiArticle = expectedArticleOrder.find(
  (article) => article.group === "ai",
);

if (featuredArticle?.storyId !== highestAiArticle?.storyId) {
  reportError("Featured story is not the highest-scoring AI story", {
    actual: featuredArticle?.title,
    expected: highestAiArticle?.title,
  });
}

if (archive.version !== schemaVersion) {
  reportError("Archive uses the wrong Doom Index schema version", {
    actual: archive.version,
    expected: schemaVersion,
  });
}

if (
  archive.formulaVersion !== formulaVersion ||
  archive.formulaFingerprint !== formulaFingerprint
) {
  reportError("Archive uses an unregistered formula", {
    formulaVersion: archive.formulaVersion,
    formulaFingerprint: archive.formulaFingerprint,
  });
}

const dailyPeriods = new Map();
const weeklyPeriods = new Map();
const monthlyPeriods = new Map();
const historyFiles = (await readdir(HISTORY_DIRECTORY))
  .filter((fileName) => /^\d{4}-\d{2}\.json$/.test(fileName))
  .sort();
let observationCount = 0;
let storyDayCount = 0;

for (const fileName of historyFiles) {
  const history = await readJson(join(HISTORY_DIRECTORY, fileName));
  const legacyFormulaVersion = String(
    history.legacyFormulaVersion || history.formulaVersion || "1.0",
  );

  for (const [registeredVersion, formula] of Object.entries(
    history.formulas || {},
  )) {
    if (
      catalog.formulas?.[registeredVersion]?.fingerprint !== formula.fingerprint
    ) {
      reportError("History contains an unregistered formula fingerprint", {
        fileName,
        formulaVersion: registeredVersion,
        fingerprint: formula.fingerprint,
      });
    }
  }

  for (const story of Object.values(history.stories || {})) {
    for (const [dateKey, day] of Object.entries(story.days || {})) {
      storyDayCount += 1;
      const entries = Object.entries(day.samples || {}).map(
        ([sampleKey, sample]) => ({
          key: sampleKey,
          value: sampleValue(sample),
          formulaVersion: sampleFormulaVersion(
            sample,
            legacyFormulaVersion,
          ),
          formulaFingerprint:
            sample && typeof sample === "object"
              ? sample.formulaFingerprint
              : undefined,
          observedAt: observedAtForSample(sampleKey, sample),
          factors:
            sample && typeof sample === "object" ? sample.factors : undefined,
          reasons:
            sample && typeof sample === "object" ? sample.reasons : undefined,
          isLegacy: !sample || typeof sample !== "object",
        }),
      );
      observationCount += entries.length;

      for (const entry of entries) {
        if (!Number.isFinite(entry.value) || entry.value < 0 || entry.value > 100) {
          reportError("History sample is outside 0–100", {
            storyId: story.storyId,
            dateKey,
            sampleKey: entry.key,
            value: entry.value,
          });
        }

        if (
          !entry.isLegacy &&
          entry.formulaFingerprint !==
            catalog.formulas?.[entry.formulaVersion]?.fingerprint
        ) {
          reportError("History sample uses an unregistered formula fingerprint", {
            storyId: story.storyId,
            dateKey,
            sampleKey: entry.key,
          });
        }

        if (entry.formulaVersion === shadowFormulaVersion) {
          const reconstructedShadow = calculateDoomIndexV12FromFactors(
            entry.factors || {},
            shadowWeights,
          );

          if (entry.value !== reconstructedShadow.value) {
            reportError("History 1.2 shadow sample does not match its factors", {
              storyId: story.storyId,
              dateKey,
              sampleKey: entry.key,
              actual: entry.value,
              expected: reconstructedShadow.value,
            });
          }

          if (!Array.isArray(entry.reasons)) {
            reportError("History 1.2 shadow sample is missing reasons", {
              storyId: story.storyId,
              dateKey,
              sampleKey: entry.key,
            });
          }
        }
      }

      const versions = new Set(entries.map((entry) => entry.formulaVersion));

      for (const version of versions) {
        const expectedSummary = calculateSummary(entries, version);
        const actualSummary =
          day.formulaSummaries?.[version] ||
          (version === legacyFormulaVersion ? day : null);

        if (!actualSummary) {
          reportError("Daily formula summary is missing", {
            storyId: story.storyId,
            dateKey,
            formulaVersion: version,
          });
          continue;
        }

        compareSummary(actualSummary, expectedSummary, {
          storyId: story.storyId,
          dateKey,
          formulaVersion: version,
        });
      }

      const activeSummary =
        day.formulaSummaries?.[formulaVersion] ||
        (legacyFormulaVersion === formulaVersion ? day : null);

      if (!activeSummary?.observations) {
        continue;
      }

      const candidate = {
        storyId: story.storyId,
        title: story.title,
        url: story.url,
        source: story.source,
        image: story.image || "",
        peak: activeSummary.high,
        scoreTotal:
          activeSummary.scoreTotal ??
          activeSummary.average * activeSummary.observations,
        observations: activeSummary.observations,
        daysTracked: 1,
        peakDate: dateKey,
        firstObservedAt: activeSummary.firstObservedAt,
        lastObservedAt: activeSummary.lastObservedAt,
      };

      addArchiveCandidate(dailyPeriods, dateKey, candidate);
      addArchiveCandidate(weeklyPeriods, isoWeekKey(dateKey), candidate);
      addArchiveCandidate(monthlyPeriods, dateKey.slice(0, 7), candidate);
    }
  }
}

compareArchivePeriods(
  archive.daily || [],
  rankArchivePeriods(dailyPeriods, archiveLimit),
  "daily",
);
compareArchivePeriods(
  archive.weekly || [],
  rankArchivePeriods(weeklyPeriods, archiveLimit),
  "weekly",
);
compareArchivePeriods(
  archive.monthly || [],
  rankArchivePeriods(monthlyPeriods, archiveLimit),
  "monthly",
);

if (errors.length > 0) {
  console.error(
    `[doom-index] Verification failed with ${errors.length} error${errors.length === 1 ? "" : "s"}.`,
  );
  console.error(JSON.stringify(errors.slice(0, 25), null, 2));

  if (errors.length > 25) {
    console.error(`[doom-index] ${errors.length - 25} additional errors omitted.`);
  }

  process.exit(1);
}

if (shadowEnabled && articles.length > 0) {
  const comparisons = articles
    .map((article) => ({
      title: article.title,
      publicValue: article.doomIndex,
      shadowValue: article.doomIndexV12Shadow,
      difference: Number(
        (article.doomIndexV12Shadow - article.doomIndex).toFixed(2),
      ),
    }))
    .sort((first, second) => second.difference - first.difference);
  const publicMean =
    comparisons.reduce((sum, item) => sum + item.publicValue, 0) /
    comparisons.length;
  const shadowMean =
    comparisons.reduce((sum, item) => sum + item.shadowValue, 0) /
    comparisons.length;
  const largestIncrease = comparisons[0];
  const largestDecrease = comparisons.at(-1);

  console.log(
    `[doom-index] 1.2 shadow: mean ${shadowMean.toFixed(2)} versus public ${publicMean.toFixed(2)} (${(shadowMean - publicMean).toFixed(2)}); range ${Math.min(...comparisons.map((item) => item.shadowValue)).toFixed(2)}-${Math.max(...comparisons.map((item) => item.shadowValue)).toFixed(2)}.`,
  );
  console.log(
    `[doom-index] Largest shadow increase: ${largestIncrease.difference >= 0 ? "+" : ""}${largestIncrease.difference.toFixed(2)} — ${largestIncrease.title}`,
  );
  console.log(
    `[doom-index] Largest shadow decrease: ${largestDecrease.difference >= 0 ? "+" : ""}${largestDecrease.difference.toFixed(2)} — ${largestDecrease.title}`,
  );
}

console.log(
  `[doom-index] Verification passed: ${articles.length} articles, ${observationCount} observations, ${storyDayCount} story-day records, formula ${formulaVersion} (${formulaFingerprint}).`,
);
