import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DREAD_BODY_AWARE_CACHE_FILE =
  "data/dread-body-aware/dread-1.3.0-cache.json";

const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
]);

export function canonicalBodyAwareUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();

    for (const parameter of [...url.searchParams.keys()]) {
      const normalized = parameter.toLowerCase();
      if (normalized.startsWith("utm_") || TRACKING_PARAMETERS.has(normalized)) {
        url.searchParams.delete(parameter);
      }
    }

    url.searchParams.sort();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.href;
  } catch {
    return String(value || "").trim();
  }
}

export function bodyAwareStoryId(value) {
  return createHash("sha256")
    .update(canonicalBodyAwareUrl(value))
    .digest("hex")
    .slice(0, 20);
}

export async function readBodyAwareCache(filePath = DREAD_BODY_AWARE_CACHE_FILE) {
  try {
    const cache = JSON.parse(await readFile(filePath, "utf8"));
    return {
      schemaVersion: "1.0",
      ...cache,
      records: cache.records && typeof cache.records === "object" ? cache.records : {},
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { schemaVersion: "1.0", records: {} };
    }
    throw error;
  }
}

export async function writeBodyAwareCache(cache, filePath = DREAD_BODY_AWARE_CACHE_FILE) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

export function bodyAwareArticleFields(record, valueField = "doomIndexV130BodyAware") {
  if (!record?.score || !Number.isFinite(Number(record.score.value))) return {};

  return {
    [valueField]: Number(record.score.value),
    doomIndexV130BodyAwareVersion: record.version,
    doomIndexV130BodyAwareFormulaVersion: record.formulaVersion,
    doomIndexV130BodyAwareFormulaFingerprint: record.formulaFingerprint,
    doomIndexV130BodyAwareAnalyzerVersion: record.analyzerVersion,
    doomIndexV130BodyAwareInputFingerprint: record.inputFingerprint,
    doomIndexV130BodyAwareBodyFingerprint: record.bodyFingerprint,
    doomIndexV130BodyAwareEvidenceScope: record.evidenceScope,
    doomIndexV130BodyAwareFactors: record.score.factors,
    doomIndexV130BodyAwareReasons: [
      record.assessment?.rationale,
      ...(record.score.constraints || []),
    ].filter(Boolean),
    doomIndexV130BodyAwareAssessedAt: record.assessedAt,
  };
}

export function applyBodyAwareCacheToArticles(
  articles,
  cache,
  { formulaVersion, valueField = "doomIndexV130BodyAware" } = {},
) {
  let applied = 0;

  for (const article of articles) {
    const record = cache.records?.[bodyAwareStoryId(article.url)];
    if (!record || (formulaVersion && record.formulaVersion !== formulaVersion)) continue;
    Object.assign(article, bodyAwareArticleFields(record, valueField));
    applied += 1;
  }

  return applied;
}
