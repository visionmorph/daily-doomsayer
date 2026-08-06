import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function loadEntityDecoder() {
  try {
    return require("entities").decodeHTML;
  } catch {
    const rssParserRequire = createRequire(require.resolve("rss-parser"));
    return rssParserRequire("entities").decodeHTML;
  }
}

const decodeHTML = loadEntityDecoder();

const ONE_HOUR_MS = 3_600_000;

function roundedHundredth(value) {
  return Number(Number(value).toFixed(2));
}

function sampleValue(sample) {
  return Number(sample && typeof sample === "object" ? sample.value : sample);
}

function sampleFormulaVersion(sample, legacyFormulaVersion) {
  return sample && typeof sample === "object" && sample.formulaVersion
    ? String(sample.formulaVersion)
    : String(legacyFormulaVersion || "1.0");
}

function sampleObservedAt(sampleKey, sample) {
  if (sample && typeof sample === "object" && sample.observedAt) {
    return String(sample.observedAt);
  }

  return `${sampleKey.slice(0, 13)}:00:00.000Z`;
}

export function normalizeArticleText(value) {
  let text = String(value || "");

  for (let pass = 0; pass < 2; pass += 1) {
    const decoded = decodeHTML(text);

    if (decoded === text) {
      break;
    }

    text = decoded;
  }

  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizedSeverityScale(configuredScale) {
  if (!Array.isArray(configuredScale) || configuredScale.length === 0) {
    throw new Error("Doom Index severityScale must contain at least one band");
  }

  const scale = configuredScale.map((band) => ({
    minimum: roundedHundredth(band.minimum),
    maximum: roundedHundredth(band.maximum),
    label: String(band.label || "").trim().toUpperCase(),
    description: normalizeArticleText(band.description),
  }));

  if (scale[0].minimum !== 0 || scale.at(-1).maximum !== 100) {
    throw new Error("Doom Index severityScale must cover 0.00 through 100.00");
  }

  const labels = new Set();

  for (const [index, band] of scale.entries()) {
    if (
      !Number.isFinite(band.minimum) ||
      !Number.isFinite(band.maximum) ||
      band.minimum < 0 ||
      band.maximum > 100 ||
      band.minimum > band.maximum ||
      !band.label ||
      !band.description
    ) {
      throw new Error(`Invalid Doom Index severity band at position ${index + 1}`);
    }

    if (labels.has(band.label)) {
      throw new Error(`Duplicate Doom Index severity label: ${band.label}`);
    }

    labels.add(band.label);

    if (index > 0) {
      const expectedMinimum = roundedHundredth(scale[index - 1].maximum + 0.01);

      if (band.minimum !== expectedMinimum) {
        throw new Error("Doom Index severityScale contains a gap or overlap");
      }
    }
  }

  return scale;
}

function directorySortName(name) {
  return name.replace(/^the\s+/i, "");
}

export function buildSourceDirectory(sources) {
  const directory = new Map();

  for (const source of Array.isArray(sources) ? sources : []) {
    const name = normalizeArticleText(source.displayName || source.name);
    const url = String(source.indexUrl || "").trim();

    if (!name || !/^https?:\/\//i.test(url)) {
      throw new Error(`Source ${source.name || "(unnamed)"} needs a displayName and indexUrl`);
    }

    const key = name.toLocaleLowerCase("en-US");

    if (!directory.has(key)) {
      directory.set(key, { name, url });
    }
  }

  return [...directory.values()].sort((first, second) =>
    directorySortName(first.name).localeCompare(
      directorySortName(second.name),
      "en-US",
      { sensitivity: "base" },
    ),
  );
}

export function calculateIntradayDoom(
  history,
  { date, formulaVersion, legacyFormulaVersion },
) {
  const hourlyValues = new Map();

  for (const story of Object.values(history?.stories || {})) {
    const day = story.days?.[date];

    for (const [sampleKey, sample] of Object.entries(day?.samples || {})) {
      if (sampleFormulaVersion(sample, legacyFormulaVersion) !== formulaVersion) {
        continue;
      }

      const value = sampleValue(sample);
      const observedAt = sampleObservedAt(sampleKey, sample);
      const timestamp = Date.parse(observedAt);

      if (!Number.isFinite(value) || !Number.isFinite(timestamp)) {
        continue;
      }

      const existing = hourlyValues.get(timestamp);

      if (!existing || value > existing.value) {
        hourlyValues.set(timestamp, {
          observedAt,
          timestamp,
          value: roundedHundredth(value),
          storyId: story.storyId || "",
          title: normalizeArticleText(story.title),
          url: String(story.url || ""),
        });
      }
    }
  }

  const observations = [...hourlyValues.values()].sort(
    (first, second) => first.timestamp - second.timestamp,
  );

  if (observations.length === 0) {
    return {
      date,
      formulaVersion,
      observedAt: null,
      current: null,
      lastHourChange: null,
      open: null,
      dayChange: null,
      peak: null,
      observations: 0,
    };
  }

  const opening = observations[0];
  const current = observations.at(-1);
  const previousHour = hourlyValues.get(current.timestamp - ONE_HOUR_MS);
  const peak = observations.reduce((highest, observation) =>
    observation.value > highest.value ? observation : highest,
  );

  return {
    date,
    formulaVersion,
    observedAt: current.observedAt,
    current: current.value,
    currentStory: {
      storyId: current.storyId,
      title: current.title,
      url: current.url,
    },
    lastHourChange: previousHour
      ? roundedHundredth(current.value - previousHour.value)
      : null,
    open: opening.value,
    openingStory: {
      storyId: opening.storyId,
      title: opening.title,
      url: opening.url,
    },
    dayChange: roundedHundredth(current.value - opening.value),
    peak: peak.value,
    peakStory: {
      storyId: peak.storyId,
      title: peak.title,
      url: peak.url,
    },
    observations: observations.length,
  };
}
