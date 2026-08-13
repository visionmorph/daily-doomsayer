import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bodyAwareStoryId,
  canonicalBodyAwareUrl,
} from "./dread-body-aware-store.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_OPTIONS = Object.freeze({
  benchmark: path.join(
    PROJECT_DIRECTORY,
    "data",
    "human-calibration",
    "calibration-benchmark.v1.json",
  ),
  articles: path.join(PROJECT_DIRECTORY, "articles.js"),
  cache: path.join(
    PROJECT_DIRECTORY,
    "data",
    "dread-body-aware",
    "dread-1.3.0-cache.json",
  ),
  humanRubricVersion: "guided-human-rating-v1.1",
  publicVersion: "1.2.2",
  publicFormulaVersion: "1.2.2-shadow.1",
  experimentalVersion: "1.2.4",
  experimentalFormulaVersion: "1.2.4-offline.1",
  bodyAwareVersion: "1.3.0",
  bodyAwareFormulaVersion: "1.3.0-body-context.1",
  minimumRecords: 25,
  limit: 10,
});

function numericScore(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(
    typeof value === "object" ? value.value ?? value.score : value,
  );
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

function mean(values) {
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null;
}

function round(value, places = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(places)) : null;
}

function severityBand(score, severityScale) {
  return severityScale.findIndex(
    (band) =>
      score >= Number(band.minimum) && score <= Number(band.maximum),
  );
}

function severityLabel(score, severityScale) {
  const index = severityBand(score, severityScale);
  return index >= 0 ? severityScale[index].label : "UNCLASSIFIED";
}

function readWindowAssignment(text, globalName) {
  const prefix = `window.${globalName} = `;
  const start = text.indexOf(prefix);
  if (start < 0) throw new Error(`Missing window.${globalName}`);
  const jsonStart = start + prefix.length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let began = false;

  for (let index = jsonStart; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      began = true;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (began && depth === 0) {
        return JSON.parse(text.slice(jsonStart, index + 1));
      }
    }
  }
  throw new Error(`Could not parse window.${globalName}`);
}

function recordAliases(record) {
  return [record.article, ...(record.aliases || [])].filter(Boolean);
}

function articleIndex(articles) {
  const byStoryId = new Map();
  const byUrl = new Map();

  for (const article of articles) {
    if (article.storyId) byStoryId.set(String(article.storyId), article);
    if (article.url) byUrl.set(canonicalBodyAwareUrl(article.url), article);
  }

  return { byStoryId, byUrl };
}

function matchedArticle(record, index) {
  for (const alias of recordAliases(record)) {
    const storyMatch = alias.storyId
      ? index.byStoryId.get(String(alias.storyId))
      : null;
    if (storyMatch) return storyMatch;
    const urlMatch = alias.url
      ? index.byUrl.get(canonicalBodyAwareUrl(alias.url))
      : null;
    if (urlMatch) return urlMatch;
  }
  return null;
}

function exactProductionInput(record, article) {
  const input = record.scoringInput;
  if (input?.provenance !== "production") return false;
  return (
    normalizeText(input.title) === normalizeText(article.title) &&
    normalizeText(input.summary) ===
      normalizeText(article.doomIndexInputSummary) &&
    Number(input.coverageSources || 1) ===
      Number(article.doomIndexCoverageSources || 1)
  );
}

function validModels(article, cacheRecord, options) {
  return (
    article.doomIndexVersion === options.publicVersion &&
    article.doomIndexFormulaVersion === options.publicFormulaVersion &&
    numericScore(article.doomIndex) !== null &&
    article.doomIndexV124ShadowVersion === options.experimentalVersion &&
    article.doomIndexV124ShadowFormulaVersion ===
      options.experimentalFormulaVersion &&
    numericScore(article.doomIndexV124Shadow) !== null &&
    article.doomIndexV130BodyAwareVersion === options.bodyAwareVersion &&
    article.doomIndexV130BodyAwareFormulaVersion ===
      options.bodyAwareFormulaVersion &&
    numericScore(article.doomIndexV130BodyAware) !== null &&
    cacheRecord?.version === options.bodyAwareVersion &&
    cacheRecord?.formulaVersion === options.bodyAwareFormulaVersion &&
    cacheRecord?.inputFingerprint ===
      article.doomIndexV130BodyAwareInputFingerprint
  );
}

function scoredRecord(record, article, cacheRecord) {
  return {
    benchmarkId: String(record.benchmarkId || ""),
    title: article.title,
    url: article.url,
    source: article.source || record.article?.source || "",
    human: numericScore(record.articleRating?.score),
    confidence: Number(record.articleRating?.confidence) || 0,
    scores: {
      public: numericScore(article.doomIndex),
      experimental: numericScore(article.doomIndexV124Shadow),
      bodyAware: numericScore(article.doomIndexV130BodyAware),
    },
    evidenceScope: cacheRecord.evidenceScope || "unknown",
    factors: cacheRecord.score?.factors || {},
    evidence: cacheRecord.assessment?.evidence || [],
    bodyConfidence: cacheRecord.assessment?.confidence || "unknown",
  };
}

function metrics(records, model, severityScale) {
  const pairs = records
    .map((record) => ({ human: record.human, model: record.scores[model] }))
    .filter(
      ({ human, model: modelScore }) =>
        numericScore(human) !== null && numericScore(modelScore) !== null,
    );

  if (!pairs.length) {
    return {
      records: 0,
      meanAbsoluteError: null,
      bias: null,
      severityBandMatchPercent: null,
      within10PointsPercent: null,
      within20PointsPercent: null,
    };
  }

  const errors = pairs.map(({ human, model: modelScore }) => modelScore - human);
  const absoluteErrors = errors.map(Math.abs);
  return {
    records: pairs.length,
    meanAbsoluteError: round(mean(absoluteErrors)),
    bias: round(mean(errors)),
    severityBandMatchPercent: round(
      (100 *
        pairs.filter(
          ({ human, model: modelScore }) =>
            severityBand(human, severityScale) ===
            severityBand(modelScore, severityScale),
        ).length) /
        pairs.length,
      1,
    ),
    within10PointsPercent: round(
      (100 * absoluteErrors.filter((error) => error <= 10).length) /
        pairs.length,
      1,
    ),
    within20PointsPercent: round(
      (100 * absoluteErrors.filter((error) => error <= 20).length) /
        pairs.length,
      1,
    ),
  };
}

function riskCounts(records, model, severityScale) {
  const pairs = records.map((record) => ({
    human: record.human,
    model: record.scores[model],
  }));

  return {
    severeHumanRecords: pairs.filter(({ human }) => human >= 60).length,
    severeUnderCalls: pairs.filter(
      ({ human, model: modelScore }) => human >= 60 && modelScore < 40,
    ).length,
    twoBandUnderCalls: pairs.filter(
      ({ human, model: modelScore }) =>
        severityBand(human, severityScale) -
          severityBand(modelScore, severityScale) >=
        2,
    ).length,
    extremeFalsePositives: pairs.filter(
      ({ human, model: modelScore }) => human < 40 && modelScore >= 60,
    ).length,
    catastrophicFalsePositives: pairs.filter(
      ({ human, model: modelScore }) => human < 80 && modelScore >= 80,
    ).length,
    largeMisses: pairs.filter(
      ({ human, model: modelScore }) => Math.abs(modelScore - human) >= 30,
    ).length,
  };
}

function pairedComparison(records, first, second) {
  const differences = records.map((record) => {
    const firstError = Math.abs(record.scores[first] - record.human);
    const secondError = Math.abs(record.scores[second] - record.human);
    return firstError - secondError;
  });

  return {
    records: differences.length,
    secondModelImprovement: round(mean(differences)),
    secondModelWins: differences.filter((difference) => difference > 0).length,
    ties: differences.filter((difference) => difference === 0).length,
    firstModelWins: differences.filter((difference) => difference < 0).length,
  };
}

function perBand(records, severityScale) {
  return severityScale.map((band) => {
    const selected = records.filter(
      (record) => severityLabel(record.human, severityScale) === band.label,
    );
    return {
      label: band.label,
      records: selected.length,
      public: metrics(selected, "public", severityScale),
      experimental: metrics(selected, "experimental", severityScale),
      bodyAware: metrics(selected, "bodyAware", severityScale),
    };
  });
}

function groupedMetrics(records, field, severityScale) {
  const groups = new Map();
  for (const record of records) {
    const key = String(record[field] || "unknown");
    const values = groups.get(key) || [];
    values.push(record);
    groups.set(key, values);
  }
  return [...groups.entries()]
    .map(([name, values]) => ({
      name,
      records: values.length,
      public: metrics(values, "public", severityScale),
      experimental: metrics(values, "experimental", severityScale),
      bodyAware: metrics(values, "bodyAware", severityScale),
    }))
    .sort(
      (left, right) =>
        right.records - left.records || left.name.localeCompare(right.name),
    );
}

function largestBodyAwareMisses(records, severityScale, limit) {
  return records
    .map((record) => ({
      ...record,
      error: round(record.scores.bodyAware - record.human),
      humanBand: severityLabel(record.human, severityScale),
      bodyAwareBand: severityLabel(record.scores.bodyAware, severityScale),
    }))
    .sort((left, right) => Math.abs(right.error) - Math.abs(left.error))
    .slice(0, limit);
}

export function evaluateDreadV130Comparison(
  benchmark,
  articles,
  cache,
  suppliedOptions = {},
) {
  const options = { ...DEFAULT_OPTIONS, ...suppliedOptions };
  if (!Array.isArray(benchmark.records) || !Array.isArray(benchmark.severityScale)) {
    throw new Error("The calibration benchmark is missing records or severityScale.");
  }
  if (!Array.isArray(articles) || !cache?.records) {
    throw new Error("Current articles or the DREAD 1.3 cache are unavailable.");
  }

  const index = articleIndex(articles);
  const excluded = {
    notRated: 0,
    legacyOrDifferentHumanRubric: 0,
    missingHumanArticleRating: 0,
    noCurrentStoryMatch: 0,
    productionInputMismatch: 0,
    modelVersionOrScoreMismatch: 0,
  };
  const eligibleRecords = [];

  for (const record of benchmark.records) {
    if (record.status !== "rated") {
      excluded.notRated += 1;
      continue;
    }
    if (
      record.articleRating?.assessment?.rubricVersion !==
      options.humanRubricVersion
    ) {
      excluded.legacyOrDifferentHumanRubric += 1;
      continue;
    }
    if (numericScore(record.articleRating?.score) === null) {
      excluded.missingHumanArticleRating += 1;
      continue;
    }
    const article = matchedArticle(record, index);
    if (!article) {
      excluded.noCurrentStoryMatch += 1;
      continue;
    }
    if (!exactProductionInput(record, article)) {
      excluded.productionInputMismatch += 1;
      continue;
    }
    const cacheRecord = cache.records[bodyAwareStoryId(article.url)];
    if (!validModels(article, cacheRecord, options)) {
      excluded.modelVersionOrScoreMismatch += 1;
      continue;
    }
    eligibleRecords.push(scoredRecord(record, article, cacheRecord));
  }

  const severityScale = benchmark.severityScale;
  const highConfidenceRecords = eligibleRecords.filter(
    (record) => record.confidence === 3,
  );
  const modelMetrics = (model) => ({
    all: metrics(eligibleRecords, model, severityScale),
    highConfidence: metrics(highConfidenceRecords, model, severityScale),
  });
  const result = {
    benchmarkVersion: benchmark.benchmarkVersion,
    benchmarkAsOf: benchmark.asOf || null,
    humanRubricVersion: options.humanRubricVersion,
    status:
      eligibleRecords.length >= options.minimumRecords
        ? "EVALUATION_READY"
        : "INSUFFICIENT_DATA",
    minimumRecords: options.minimumRecords,
    coverage: {
      benchmarkRecords: benchmark.records.length,
      eligibleRecords: eligibleRecords.length,
      highConfidenceRecords: highConfidenceRecords.length,
      publishers: new Set(eligibleRecords.map((record) => record.source)).size,
      bodyEvidenceRecords: eligibleRecords.filter(
        (record) => record.evidenceScope === "article-body",
      ).length,
      feedOnlyRecords: eligibleRecords.filter(
        (record) => record.evidenceScope === "feed-only",
      ).length,
      excluded,
    },
    metrics: {
      public: modelMetrics("public"),
      experimental: modelMetrics("experimental"),
      bodyAware: modelMetrics("bodyAware"),
    },
    risks: {
      public: riskCounts(eligibleRecords, "public", severityScale),
      experimental: riskCounts(eligibleRecords, "experimental", severityScale),
      bodyAware: riskCounts(eligibleRecords, "bodyAware", severityScale),
    },
    paired: {
      bodyAwareVersusPublic: pairedComparison(
        eligibleRecords,
        "public",
        "bodyAware",
      ),
      bodyAwareVersusExperimental: pairedComparison(
        eligibleRecords,
        "experimental",
        "bodyAware",
      ),
    },
    perBand: perBand(eligibleRecords, severityScale),
    perEvidenceScope: groupedMetrics(
      eligibleRecords,
      "evidenceScope",
      severityScale,
    ),
    perPublisher: groupedMetrics(eligibleRecords, "source", severityScale),
    largestBodyAwareMisses: largestBodyAwareMisses(
      eligibleRecords,
      severityScale,
      options.limit,
    ),
  };

  return result;
}

function format(value, suffix = "") {
  return Number.isFinite(value) ? `${value.toFixed(2)}${suffix}` : "—";
}

function metricRow(label, value) {
  return `| ${label} | ${format(value.meanAbsoluteError)} | ${format(value.bias)} | ${format(value.severityBandMatchPercent, "%")} | ${format(value.within10PointsPercent, "%")} | ${format(value.within20PointsPercent, "%")} |`;
}

function factorSummary(factors) {
  return [
    "harm",
    "certainty",
    "reach",
    "reversibility",
    "containment",
    "recurrence",
    "vulnerability",
  ]
    .map((factor) => `${factor} ${Number(factors?.[factor] || 0)}`)
    .join(", ");
}

export function markdownDreadV130Report(result) {
  const lines = [
    "# DREAD 1.3 body-aware comparison",
    "",
    `Benchmark: ${result.benchmarkVersion}`,
    `Human questionnaire: ${result.humanRubricVersion}`,
    `Evaluation result: **${result.status}**`,
    "",
    "Only guided questionnaire ratings with an exact current production title, summary, coverage count, and valid scores from all three models are included. Legacy slider ratings are excluded.",
    "",
    "## Coverage",
    "",
    `Eligible records: ${result.coverage.eligibleRecords}/${result.minimumRecords} required`,
    `High-confidence ratings: ${result.coverage.highConfidenceRecords}`,
    `Publishers represented: ${result.coverage.publishers}`,
    `Article-body evidence: ${result.coverage.bodyEvidenceRecords}`,
    `Feed-only evidence: ${result.coverage.feedOnlyRecords}`,
    "",
    "### Excluded records",
    "",
    ...Object.entries(result.coverage.excluded).map(
      ([reason, count]) => `- ${reason}: ${count}`,
    ),
    "",
    "## Model agreement with guided human ratings",
    "",
    "| Model | Mean absolute error | Bias | Band match | Within 10 | Within 20 |",
    "|---|---:|---:|---:|---:|---:|",
    metricRow("Public 1.2.2", result.metrics.public.all),
    metricRow("Experimental 1.2.4", result.metrics.experimental.all),
    metricRow("Body-aware 1.3", result.metrics.bodyAware.all),
    "",
    "## High-confidence human ratings",
    "",
    "| Model | Mean absolute error | Bias | Band match | Within 10 | Within 20 |",
    "|---|---:|---:|---:|---:|---:|",
    metricRow("Public 1.2.2", result.metrics.public.highConfidence),
    metricRow(
      "Experimental 1.2.4",
      result.metrics.experimental.highConfidence,
    ),
    metricRow("Body-aware 1.3", result.metrics.bodyAware.highConfidence),
    "",
    "## Paired comparisons",
    "",
    `Body-aware improvement over Public: ${format(result.paired.bodyAwareVersusPublic.secondModelImprovement)} points; wins/ties/losses ${result.paired.bodyAwareVersusPublic.secondModelWins}/${result.paired.bodyAwareVersusPublic.ties}/${result.paired.bodyAwareVersusPublic.firstModelWins}.`,
    `Body-aware improvement over Experimental 1.2.4: ${format(result.paired.bodyAwareVersusExperimental.secondModelImprovement)} points; wins/ties/losses ${result.paired.bodyAwareVersusExperimental.secondModelWins}/${result.paired.bodyAwareVersusExperimental.ties}/${result.paired.bodyAwareVersusExperimental.firstModelWins}.`,
    "",
    "Positive improvement means DREAD 1.3 is closer to the guided human rating.",
    "",
    "## Safety errors",
    "",
    "| Model | Severe under-calls | Two-band under-calls | Extreme false positives | Catastrophic false positives | Misses ≥30 |",
    "|---|---:|---:|---:|---:|---:|",
    ...[
      ["Public 1.2.2", result.risks.public],
      ["Experimental 1.2.4", result.risks.experimental],
      ["Body-aware 1.3", result.risks.bodyAware],
    ].map(
      ([label, risk]) =>
        `| ${label} | ${risk.severeUnderCalls} | ${risk.twoBandUnderCalls} | ${risk.extremeFalsePositives} | ${risk.catastrophicFalsePositives} | ${risk.largeMisses} |`,
    ),
    "",
    "## Results by human severity band",
    "",
    "| Band | Stories | Public MAE | Experimental MAE | Body-aware MAE |",
    "|---|---:|---:|---:|---:|",
    ...result.perBand.map(
      (band) =>
        `| ${band.label} | ${band.records} | ${format(band.public.meanAbsoluteError)} | ${format(band.experimental.meanAbsoluteError)} | ${format(band.bodyAware.meanAbsoluteError)} |`,
    ),
    "",
    "## Results by DREAD 1.3 evidence source",
    "",
    "| Evidence | Stories | Public MAE | Experimental MAE | Body-aware MAE |",
    "|---|---:|---:|---:|---:|",
    ...result.perEvidenceScope.map(
      (group) =>
        `| ${group.name} | ${group.records} | ${format(group.public.meanAbsoluteError)} | ${format(group.experimental.meanAbsoluteError)} | ${format(group.bodyAware.meanAbsoluteError)} |`,
    ),
    "",
    "## Results by publisher",
    "",
    "| Publisher | Stories | Public MAE | Experimental MAE | Body-aware MAE |",
    "|---|---:|---:|---:|---:|",
    ...result.perPublisher.map(
      (group) =>
        `| ${group.name.replaceAll("|", "\\|")} | ${group.records} | ${format(group.public.meanAbsoluteError)} | ${format(group.experimental.meanAbsoluteError)} | ${format(group.bodyAware.meanAbsoluteError)} |`,
    ),
    "",
    "## Largest DREAD 1.3 misses",
    "",
  ];

  if (!result.largestBodyAwareMisses.length) {
    lines.push("No eligible guided records are available yet.");
  } else {
    for (const miss of result.largestBodyAwareMisses) {
      lines.push(
        `### ${miss.title}`,
        "",
        `- Publisher: ${miss.source}`,
        `- Human: ${format(miss.human)} ${miss.humanBand}`,
        `- DREAD 1.3: ${format(miss.scores.bodyAware)} ${miss.bodyAwareBand}`,
        `- Error: ${format(miss.error)}`,
        `- Evidence source: ${miss.evidenceScope}`,
        `- Factors: ${factorSummary(miss.factors)}`,
        `- Matched evidence: ${
          miss.evidence.length
            ? miss.evidence
                .slice(0, 4)
                .map(
                  (item) =>
                    `${item.factor}=${item.level}: “${String(item.excerpt || "").replaceAll("\n", " ")}”`,
                )
                .join("; ")
            : "none"
        }`,
        "",
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function parseArguments(argumentsList) {
  const options = { ...DEFAULT_OPTIONS };
  const fields = {
    "--benchmark": ["benchmark", String],
    "--articles": ["articles", String],
    "--cache": ["cache", String],
    "--minimum": ["minimumRecords", Number],
    "--limit": ["limit", Number],
  };

  for (let index = 0; index < argumentsList.length; index += 2) {
    const argument = argumentsList[index];
    const definition = fields[argument];
    if (!definition) throw new Error(`Unknown argument: ${argument}`);
    const [field, convert] = definition;
    const value = argumentsList[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${argument}`);
    options[field] = convert(value);
  }

  options.benchmark = path.resolve(options.benchmark);
  options.articles = path.resolve(options.articles);
  options.cache = path.resolve(options.cache);
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [benchmark, generatedArticles, cache] = await Promise.all([
    readFile(options.benchmark, "utf8").then(JSON.parse),
    readFile(options.articles, "utf8"),
    readFile(options.cache, "utf8").then(JSON.parse),
  ]);
  const articles = readWindowAssignment(
    generatedArticles,
    "DAILY_DOOMSAYER_ARTICLES",
  );
  const result = evaluateDreadV130Comparison(
    benchmark,
    articles,
    cache,
    options,
  );
  process.stdout.write(markdownDreadV130Report(result));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
