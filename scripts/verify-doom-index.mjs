import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  DOOM_INDEX_V122_AUXILIARY_FACTOR_NAMES,
  DOOM_INDEX_V122_FACTOR_NAMES,
  calculateDoomIndexV122FromFactors,
  createDoomIndexV122Fingerprint,
  createDoomIndexV122InputFingerprint,
  normalizedDoomIndexV122Weights,
} from "./doom-index-v1.2.2.mjs";
import {
  DOOM_INDEX_V124_AUXILIARY_FACTOR_NAMES,
  DOOM_INDEX_V124_FACTOR_NAMES,
  calculateDoomIndexV124FromFactors,
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

  const jsonStart = start + prefix.length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let began = false;

  for (let index = jsonStart; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }

      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === "{" || character === "[") {
      depth += 1;
      began = true;
    } else if (character === "}" || character === "]") {
      depth -= 1;

      if (began && depth === 0) {
        return JSON.parse(text.slice(jsonStart, index + 1));
      }
    }
  }

  throw new Error(`${filePath} contains an incomplete window.${globalName} assignment`);
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
const site = await readWindowAssignment(
  "articles.js",
  "DAILY_DOOMSAYER_SITE",
);
const archive = await readWindowAssignment(
  "doom-archive.js",
  "DAILY_DOOMSAYER_ARCHIVE",
);
const catalog = await readJson(join("data", "doom-stories.json"));
const formulaVersion = String(
  config.doomIndex?.formulaVersion || "1.2.2-shadow.1",
);
const schemaVersion = String(config.doomIndex?.version || "1.2.2");
const expectedSeverityScale = normalizedSeverityScale(
  config.doomIndex?.severityScale,
);
const expectedSourceDirectory = buildSourceDirectory(config.sources);
const shadowEnabled = config.doomIndex?.shadow?.enabled !== false;
const shadowVersion = String(
  config.doomIndex?.shadow?.version || "1.2.4",
);
const shadowFormulaVersion = String(
  config.doomIndex?.shadow?.formulaVersion || "1.2.4-offline.1",
);
const publicWeights = normalizedDoomIndexV122Weights(
  config.doomIndex?.weights,
);
const shadowWeights = normalizedDoomIndexV124Weights(
  config.doomIndex?.shadow?.weights || config.doomIndex?.weights,
);
const expectedFormulaFingerprint = createDoomIndexV122Fingerprint({
  formulaVersion,
  weights: publicWeights,
});
const expectedShadowFingerprint = createDoomIndexV124Fingerprint({
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

if (
  site.chronicle?.trackingStartedOn !== config.doomIndex?.trackingStartedOn ||
  site.chronicle?.timeZone !== config.doomIndex?.timeZone
) {
  reportError("Generated Chronicle configuration does not match news-sources.json");
}

if (
  site.doomIndex?.modelName !== String(config.doomIndex?.modelName || "DREAD") ||
  site.doomIndex?.version !== schemaVersion ||
  site.doomIndex?.formulaVersion !== formulaVersion ||
  site.doomIndex?.shadow?.version !== shadowVersion ||
  site.doomIndex?.shadow?.formulaVersion !== shadowFormulaVersion ||
  JSON.stringify(site.doomIndex?.severityScale) !==
    JSON.stringify(expectedSeverityScale)
) {
  reportError("Generated Doom Index legend configuration is out of date");
}

if (JSON.stringify(site.sources) !== JSON.stringify(expectedSourceDirectory)) {
  reportError("Generated source directory is not canonical and alphabetical");
}

if (registeredFormula?.fingerprint !== expectedFormulaFingerprint) {
  reportError("The story catalog has no valid public 1.2.2 fingerprint", {
    formulaVersion,
    actual: registeredFormula?.fingerprint,
    expected: expectedFormulaFingerprint,
  });
}

const formulaFingerprint = expectedFormulaFingerprint;

if (
  shadowEnabled &&
  registeredShadowFormula?.fingerprint !== expectedShadowFingerprint
) {
  reportError("The story catalog has no valid 1.2.4 experimental fingerprint", {
    formulaVersion: shadowFormulaVersion,
    actual: registeredShadowFormula?.fingerprint,
    expected: expectedShadowFingerprint,
  });
}
const seenStoryIds = new Set();

for (const article of articles) {
  const context = { storyId: article.storyId, title: article.title };

  if (normalizeArticleText(article.title) !== article.title) {
    reportError("Story title contains undecoded or unnormalized text", context);
  }

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

  for (const factor of [
    ...DOOM_INDEX_V122_FACTOR_NAMES,
    ...DOOM_INDEX_V122_AUXILIARY_FACTOR_NAMES,
  ]) {
    const value = Number(article.doomIndexFactors?.[factor]);

    if (!Number.isFinite(value) || value < 0 || value > 1) {
      reportError("Public 1.2.2 factor is outside 0-1", {
        ...context,
        factor,
        value: article.doomIndexFactors?.[factor],
      });
    }
  }

  const reconstructedPublic = calculateDoomIndexV122FromFactors(
    article.doomIndexFactors || {},
    publicWeights,
  );

  if (article.doomIndex !== reconstructedPublic.value) {
    reportError("Stored public 1.2.2 value does not match its factors", {
      ...context,
      actual: article.doomIndex,
      expected: reconstructedPublic.value,
    });
  }

  if (
    !Array.isArray(article.doomIndexReasons) ||
    typeof article.doomIndexActuality !== "string" ||
    typeof article.doomIndexPolarity !== "string" ||
    typeof article.doomIndexInputFingerprint !== "string"
  ) {
    reportError("Story is missing public 1.2.2 explanatory metadata", context);
  }

  if (shadowEnabled) {
    if (article.doomIndexV124ShadowVersion !== shadowVersion) {
      reportError("Story uses the wrong 1.2.4 experimental version", context);
    }

    if (
      article.doomIndexV124ShadowFormulaVersion !== shadowFormulaVersion ||
      article.doomIndexV124ShadowFormulaFingerprint !==
        expectedShadowFingerprint
    ) {
      reportError("Story uses an unregistered 1.2.4 experimental formula", context);
    }

    for (const factor of [
      ...DOOM_INDEX_V124_FACTOR_NAMES,
      ...DOOM_INDEX_V124_AUXILIARY_FACTOR_NAMES,
    ]) {
      const value = Number(article.doomIndexV124Factors?.[factor]);

      if (!Number.isFinite(value) || value < 0 || value > 1) {
        reportError("1.2.4 experimental factor is outside 0-1", {
          ...context,
          factor,
          value: article.doomIndexV124Factors?.[factor],
        });
      }
    }

    const reconstructedShadow = calculateDoomIndexV124FromFactors(
      article.doomIndexV124Factors || {},
      shadowWeights,
    );

    if (article.doomIndexV124Shadow !== reconstructedShadow.value) {
      reportError("Stored 1.2.4 experimental value does not match its factors", {
        ...context,
        actual: article.doomIndexV124Shadow,
        expected: reconstructedShadow.value,
      });
    }

    if (
      !Array.isArray(article.doomIndexV124Reasons) ||
      typeof article.doomIndexV124Actuality !== "string" ||
      typeof article.doomIndexV124Polarity !== "string" ||
      typeof article.doomIndexV124InputFingerprint !== "string"
    ) {
      reportError("Story is missing 1.2.4 experimental metadata", context);
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
    second.doomIndex - first.doomIndex ||
    second.score - first.score ||
    (Date.parse(second.published) || 0) -
      (Date.parse(first.published) || 0),
);

for (const [index, article] of articles.entries()) {
  if (article.storyId !== expectedArticleOrder[index]?.storyId) {
    reportError("Articles are not sorted by public Doom Index", {
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
  reportError("Featured story is not the highest-Doom AI story", {
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
const historiesByMonth = new Map();
let observationCount = 0;
let storyDayCount = 0;

for (const fileName of historyFiles) {
  const history = await readJson(join(HISTORY_DIRECTORY, fileName));
  historiesByMonth.set(fileName.slice(0, 7), history);
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
        ([sampleKey, sample]) => {
          const entryFormulaVersion = sampleFormulaVersion(
            sample,
            legacyFormulaVersion,
          );
          const inputFingerprint =
            sample && typeof sample === "object"
              ? sample.inputFingerprint
              : undefined;
          const input = inputFingerprint
            ? story.shadowInputs?.[entryFormulaVersion]?.[inputFingerprint]
            : undefined;

          return {
            key: sampleKey,
            value: sampleValue(sample),
            formulaVersion: entryFormulaVersion,
            formulaFingerprint:
              sample && typeof sample === "object"
                ? sample.formulaFingerprint
                : undefined,
            observedAt: observedAtForSample(sampleKey, sample),
            inputFingerprint,
            input,
            factors:
              sample && typeof sample === "object"
                ? sample.factors || input?.factors
                : undefined,
            reasons:
              sample && typeof sample === "object"
                ? sample.reasons || input?.reasons
                : undefined,
            actuality:
              sample && typeof sample === "object"
                ? sample.actuality || input?.actuality
                : undefined,
            polarity:
              sample && typeof sample === "object"
                ? sample.polarity || input?.polarity
                : undefined,
            isLegacy: !sample || typeof sample !== "object",
          };
        },
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

        if (
          entry.formulaVersion === formulaVersion ||
          entry.formulaVersion === shadowFormulaVersion
        ) {
          const isShadow = entry.formulaVersion === shadowFormulaVersion;
          const versionLabel = isShadow ? "experimental 1.2.4" : "public 1.2.2";
          const reconstructed = isShadow
            ? calculateDoomIndexV124FromFactors(
                entry.factors || {},
                shadowWeights,
              )
            : calculateDoomIndexV122FromFactors(
                entry.factors || {},
                publicWeights,
              );

          if (entry.value !== reconstructed.value) {
            reportError(`History ${versionLabel} sample does not match its factors`, {
              storyId: story.storyId,
              dateKey,
              sampleKey: entry.key,
              actual: entry.value,
              expected: reconstructed.value,
            });
          }

          if (
            !Array.isArray(entry.reasons) ||
            typeof entry.actuality !== "string" ||
            typeof entry.polarity !== "string"
          ) {
            reportError(`History ${versionLabel} sample lacks explanatory metadata`, {
              storyId: story.storyId,
              dateKey,
              sampleKey: entry.key,
            });
          }

          if (!entry.input) {
            reportError(`History ${versionLabel} sample lacks its compact input record`, {
              storyId: story.storyId,
              dateKey,
              sampleKey: entry.key,
            });
          } else {
            const expectedInputFingerprint = isShadow
              ? createDoomIndexV124InputFingerprint({
                  title: entry.input.title,
                  summary: entry.input.summary,
                  coverageSources: entry.input.coverageSources,
                  formulaVersion: entry.formulaVersion,
                })
              : createDoomIndexV122InputFingerprint({
                  title: entry.input.title,
                  summary: entry.input.summary,
                  coverageSources: entry.input.coverageSources,
                  formulaVersion: entry.formulaVersion,
                });

            if (entry.inputFingerprint !== expectedInputFingerprint) {
              reportError(`History ${versionLabel} input fingerprint is invalid`, {
                storyId: story.storyId,
                dateKey,
                sampleKey: entry.key,
              });
            }

            const expectedSummaryFingerprint = createHash("sha256")
              .update(normalizeArticleText(entry.input.summary || ""))
              .digest("hex")
              .slice(0, 20);

            if (
              entry.input.summaryFingerprint !== expectedSummaryFingerprint
            ) {
              reportError(`History ${versionLabel} summary fingerprint is invalid`, {
                storyId: story.storyId,
                dateKey,
                sampleKey: entry.key,
              });
            }
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

const intradayDate = String(site.intradayDoom?.date || "");
const intradayHistory = historiesByMonth.get(intradayDate.slice(0, 7));

if (!intradayHistory) {
  reportError("Generated intraday Doom data has no corresponding history file", {
    date: intradayDate,
  });
} else {
  const expectedIntradayDoom = calculateIntradayDoom(intradayHistory, {
    date: intradayDate,
    formulaVersion,
    legacyFormulaVersion: String(
      intradayHistory.legacyFormulaVersion ||
        intradayHistory.formulaVersion ||
        "1.0",
    ),
  });
  const actualComparable = { ...site.intradayDoom };

  delete actualComparable.definition;

  if (JSON.stringify(actualComparable) !== JSON.stringify(expectedIntradayDoom)) {
    reportError("Generated intraday Doom values do not match hourly history", {
      actual: actualComparable,
      expected: expectedIntradayDoom,
    });
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
  const mean = (values) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const comparisons = articles
    .map((article) => ({
      title: article.title,
      source: article.source,
      publicValue: article.doomIndex,
      shadowValue: article.doomIndexV124Shadow,
      difference: Number(
        (article.doomIndexV124Shadow - article.doomIndex).toFixed(2),
      ),
    }))
    .sort((first, second) => second.difference - first.difference);
  const publicMean = mean(comparisons.map((item) => item.publicValue));
  const shadowMean = mean(comparisons.map((item) => item.shadowValue));
  const largestIncrease = comparisons[0];
  const largestDecrease = comparisons.at(-1);
  const floorCount = comparisons.filter(
    (item) => item.shadowValue === 5,
  ).length;
  const topTwentySources = [...comparisons]
    .sort((first, second) => second.shadowValue - first.shadowValue)
    .slice(0, 20)
    .reduce((counts, item) => {
      counts[item.source] = (counts[item.source] || 0) + 1;
      return counts;
    }, {});
  const [mostCommonTopSource, mostCommonTopSourceCount] = Object.entries(
    topTwentySources,
  ).sort((first, second) => second[1] - first[1])[0];

  console.log(
    `[doom-index] Means: public 1.2.2 ${publicMean.toFixed(2)}, experimental 1.2.4 ${shadowMean.toFixed(2)}; 1.2.4 range ${Math.min(...comparisons.map((item) => item.shadowValue)).toFixed(2)}-${Math.max(...comparisons.map((item) => item.shadowValue)).toFixed(2)}.`,
  );
  console.log(
    `[doom-index] 1.2.4 exact-floor stories: ${floorCount}/${comparisons.length}; largest difference above production: ${largestIncrease.difference >= 0 ? "+" : ""}${largestIncrease.difference.toFixed(2)} - ${largestIncrease.title}`,
  );
  console.log(
    `[doom-index] Largest difference below production: ${largestDecrease.difference >= 0 ? "+" : ""}${largestDecrease.difference.toFixed(2)} - ${largestDecrease.title}; most common 1.2.4 top-20 source: ${mostCommonTopSource} (${mostCommonTopSourceCount}).`,
  );
}

console.log(
  `[doom-index] Verification passed: ${articles.length} articles, ${observationCount} observations, ${storyDayCount} story-day records, formula ${formulaVersion} (${formulaFingerprint}).`,
);
