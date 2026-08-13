import { createHash } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DREAD_V130_ANALYZER_VERSION,
  DREAD_V130_FORMULA_VERSION,
  DREAD_V130_VERSION,
  analyzeDreadV130Evidence,
  calculateDoomIndexV130FromAssessment,
  createDoomIndexV130Fingerprint,
  createDoomIndexV130InputFingerprint,
} from "./doom-index-v1.3.0.mjs";
import {
  applyBodyAwareCacheToArticles,
  bodyAwareStoryId,
  canonicalBodyAwareUrl,
  readBodyAwareCache,
  writeBodyAwareCache,
} from "./dread-body-aware-store.mjs";

const DEFAULT_ARTICLE_TIMEOUT_MS = 12_000;
const DEFAULT_ARTICLE_CONCURRENCY = 4;
const DEFAULT_MAX_NEW_PER_RUN = 200;
const DEFAULT_ARTICLE_CHARACTER_LIMIT = 18_000;
const ARTICLE_HEADERS = {
  "User-Agent": "Daily Doomsayer body-aware research bot/1.0",
  Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
};

function decodeHtml(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    ldquo: "“",
    lsquo: "‘",
    lt: "<",
    mdash: "—",
    nbsp: " ",
    ndash: "–",
    quot: '"',
    rdquo: "”",
    rsquo: "’",
  };

  return String(value || "").replace(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z][\da-z]+));/gi,
    (match, decimal, hexadecimal, name) => {
      if (decimal) return String.fromCodePoint(Number(decimal));
      if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
      return named[String(name).toLowerCase()] ?? match;
    },
  );
}

function normalizeText(value) {
  return decodeHtml(value)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlToText(html) {
  return normalizeText(
    String(html || "")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(
        /<(script|style|noscript|svg|canvas|form|nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi,
        " ",
      )
      .replace(
        /<(?:br|\/p|\/div|\/li|\/h[1-6]|\/section|\/blockquote)>/gi,
        "\n",
      )
      .replace(/<[^>]+>/g, " "),
  );
}

function jsonLdArticleBodies(html) {
  const bodies = [];
  const expression =
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  function visit(value) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (typeof value.articleBody === "string") {
      bodies.push(normalizeText(value.articleBody));
    }
    Object.values(value).forEach(visit);
  }

  while ((match = expression.exec(html))) {
    try {
      visit(JSON.parse(match[1].trim()));
    } catch {
      // Invalid publisher metadata is ignored in favor of visible article text.
    }
  }

  return bodies;
}

export function extractArticleEvidence(
  html,
  characterLimit = DEFAULT_ARTICLE_CHARACTER_LIMIT,
) {
  const candidates = [...jsonLdArticleBodies(html)];

  for (const tag of ["article", "main"]) {
    const expression = new RegExp(
      `<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`,
      "gi",
    );
    let match;
    while ((match = expression.exec(html))) candidates.push(htmlToText(match[1]));
  }

  const text =
    candidates
      .filter((candidate) => candidate.length >= 300)
      .sort((first, second) => second.length - first.length)[0] || "";

  if (text.length <= characterLimit) return text;
  const endingLength = Math.min(2_000, Math.floor(characterLimit * 0.15));
  const beginningLength = characterLimit - endingLength;
  return `${text.slice(0, beginningLength).trimEnd()}\n\n[ARTICLE TRUNCATED]\n\n${text
    .slice(-endingLength)
    .trimStart()}`;
}

async function requestText(url, timeoutMs = DEFAULT_ARTICLE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: ARTICLE_HEADERS,
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Request returned ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
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

function readWindowAssignment(text, globalName) {
  const prefix = `window.${globalName} = `;
  const start = text.indexOf(prefix);
  if (start < 0) throw new Error(`articles.js does not define window.${globalName}`);
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

function articlesFile(site, articles) {
  return [
    "// Generated by scripts/fetch-news.mjs and scripts/update-dread-body-aware.mjs. Do not edit by hand.",
    `window.DAILY_DOOMSAYER_SITE = ${JSON.stringify(site, null, 2)};`,
    `window.DAILY_DOOMSAYER_ARTICLES = ${JSON.stringify(articles, null, 2)};`,
    "",
  ].join("\n");
}

async function writeArticles(site, articles) {
  const temporaryPath = `articles.js.${process.pid}.tmp`;
  await writeFile(temporaryPath, articlesFile(site, articles), "utf8");
  await rename(temporaryPath, "articles.js");
}

function bodyFingerprint(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

export async function updateDreadBodyAware() {
  const [config, generatedText, cache] = await Promise.all([
    readFile("news-sources.json", "utf8").then(JSON.parse),
    readFile("articles.js", "utf8"),
    readBodyAwareCache(),
  ]);
  const site = readWindowAssignment(generatedText, "DAILY_DOOMSAYER_SITE");
  const articles = readWindowAssignment(
    generatedText,
    "DAILY_DOOMSAYER_ARTICLES",
  );
  const bodyConfig = config.doomIndex?.bodyAware || {};
  const version = String(bodyConfig.version || DREAD_V130_VERSION);
  const formulaVersion = String(
    bodyConfig.formulaVersion || DREAD_V130_FORMULA_VERSION,
  );
  const analyzerVersion = String(
    bodyConfig.analyzerVersion || DREAD_V130_ANALYZER_VERSION,
  );
  const valueField = String(
    bodyConfig.valueField || "doomIndexV130BodyAware",
  );
  const maximum = Math.max(
    1,
    Math.min(Number(bodyConfig.maxNewPerRun) || DEFAULT_MAX_NEW_PER_RUN, 500),
  );
  const articleConcurrency = Math.max(
    1,
    Math.min(
      Number(bodyConfig.articleConcurrency) || DEFAULT_ARTICLE_CONCURRENCY,
      8,
    ),
  );
  const articleTimeoutMs = Math.max(
    5_000,
    Math.min(
      Number(bodyConfig.articleTimeoutMs) || DEFAULT_ARTICLE_TIMEOUT_MS,
      30_000,
    ),
  );
  const characterLimit = Math.max(
    2_000,
    Math.min(
      Number(bodyConfig.articleCharacterLimit) ||
        DEFAULT_ARTICLE_CHARACTER_LIMIT,
      50_000,
    ),
  );
  const formulaFingerprint = createDoomIndexV130Fingerprint({ formulaVersion });
  const candidates = articles
    .filter((article) => article.group === "ai")
    .filter((article) => {
      const record = cache.records?.[bodyAwareStoryId(article.url)];
      return (
        !record ||
        record.formulaVersion !== formulaVersion ||
        record.analyzerVersion !== analyzerVersion
      );
    })
    .sort(
      (first, second) =>
        Number(Boolean(second.featured)) - Number(Boolean(first.featured)) ||
        Number(second.doomIndex || 0) - Number(first.doomIndex || 0) ||
        (Date.parse(second.published) || 0) -
          (Date.parse(first.published) || 0),
    )
    .slice(0, maximum);
  let completed = 0;

  await mapWithConcurrency(
    candidates,
    articleConcurrency,
    async (article, index) => {
      const storyId = bodyAwareStoryId(article.url);
      let articleBody = "";
      let evidenceScope = "article-body";

      try {
        articleBody = extractArticleEvidence(
          await requestText(article.url, articleTimeoutMs),
          characterLimit,
        );
      } catch (error) {
        console.warn(
          `[dread-1.3] Article unavailable for ${article.url}: ${error.message}`,
        );
      }

      if (articleBody.length < 300) {
        evidenceScope = "feed-only";
        articleBody = normalizeText(
          article.feedSummary || article.doomIndexInputSummary || "",
        );
      }

      if (!articleBody) {
        console.warn(
          `[dread-1.3] Skipping ${article.url}: no usable article or feed text`,
        );
        return;
      }

      const fingerprint = bodyFingerprint(articleBody);
      const inputFingerprint = createDoomIndexV130InputFingerprint({
        title: article.title,
        summary: article.feedSummary || article.doomIndexInputSummary,
        bodyFingerprint: fingerprint,
        source: article.source,
        formulaVersion,
        analyzerVersion,
      });
      const existing = cache.records?.[storyId];

      if (existing?.inputFingerprint === inputFingerprint) return;

      const assessment = analyzeDreadV130Evidence({
        title: article.title,
        summary: article.feedSummary || article.doomIndexInputSummary,
        body: articleBody,
        evidenceScope,
      });
      const score = calculateDoomIndexV130FromAssessment(assessment, {
        severityScale: config.doomIndex?.severityScale,
      });

      cache.records[storyId] = {
        storyId,
        url: canonicalBodyAwareUrl(article.url),
        title: article.title,
        source: article.source,
        published: article.published,
        version,
        formulaVersion,
        formulaFingerprint,
        analyzerVersion,
        inputFingerprint,
        bodyFingerprint: fingerprint,
        bodyCharacterCount: articleBody.length,
        evidenceScope,
        assessedAt: new Date().toISOString(),
        assessment: {
          centralEvent: assessment.centralEvent,
          confidence: assessment.confidence,
          evidence: assessment.evidence,
          constraints: assessment.constraints,
          rationale: assessment.rationale,
          diagnostics: assessment.diagnostics,
        },
        score,
      };
      completed += 1;
      console.log(
        `[dread-1.3] ${index + 1}/${candidates.length} ${score.value.toFixed(2)} ${score.band}: ${article.title}`,
      );
    },
  );

  cache.schemaVersion = "1.0";
  cache.version = version;
  cache.formulaVersion = formulaVersion;
  cache.formulaFingerprint = formulaFingerprint;
  cache.analyzerVersion = analyzerVersion;
  cache.updatedAt = new Date().toISOString();

  applyBodyAwareCacheToArticles(articles, cache, { formulaVersion, valueField });
  await writeBodyAwareCache(cache);
  await writeArticles(site, articles);

  console.log(
    `[dread-1.3] Added ${completed} deterministic assessments with ${articleConcurrency} concurrent article requests; ${Object.keys(cache.records).length} cached stories are available.`,
  );

  return { completed, cached: Object.keys(cache.records).length };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  updateDreadBodyAware().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
