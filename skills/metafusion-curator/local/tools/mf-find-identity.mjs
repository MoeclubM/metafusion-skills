import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { request as apiRequest } from "../metafusion-api.mjs";

const KINDS = new Set([
  "agent", "collection", "work", "content_unit", "expression", "release", "medium", "track",
]);
const DEFAULT_LIMIT = 100;
const RESOLVE_CONCURRENCY = 4;

function cleanText(value) {
  return String(value ?? "").trim();
}

function normalizeTitle(value) {
  return cleanText(value).replace(/\s+/gu, " ").toLowerCase();
}

function isScalar(value) {
  return ["string", "number", "boolean"].includes(typeof value);
}

function safeError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/mfp_[A-Za-z0-9._~-]+/gu, "[REDACTED]").slice(0, 500);
}

function validateInput({ kind = "work", titles = [], externalIds = [], attributes = [], workId, limit = DEFAULT_LIMIT }) {
  if (!KINDS.has(kind)) throw new Error("kind 必须是八种实体 kind 之一");
  const normalizedWorkId = cleanText(workId);
  if (workId !== undefined && workId !== null && !normalizedWorkId) throw new Error("--work-id 不能为空");
  if (normalizedWorkId && kind !== "expression") throw new Error("--work-id 仅适用于 expression");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit 必须是 1–100 的整数");

  const titleValues = [...titles].map(cleanText).filter(Boolean);
  const externalValues = [...externalIds].map((item) => ({
    provider: cleanText(item?.provider),
    value: cleanText(item?.value),
  }));
  const attributeValues = [...attributes].map((item) => ({
    key: cleanText(item?.key),
    value: cleanText(item?.value),
  }));

  if (externalValues.some((item) => !item.provider || !item.value)) {
    throw new Error("外部标识格式为 provider=value，且两侧都不能为空");
  }
  if (attributeValues.some((item) => !item.key || !item.value)) {
    throw new Error("属性格式为 key=value，且两侧都不能为空");
  }
  if (!titleValues.length && !externalValues.length && !attributeValues.length) {
    throw new Error("至少提供一个 --title、--external 或 --attribute 查询条件");
  }

  return { kind, titles: titleValues, externalIds: externalValues, attributes: attributeValues,
    workId: normalizedWorkId || null, limit };
}

function entityTitleValues(entity) {
  const values = [];
  if (typeof entity.title === "string") values.push({ field: "title", value: entity.title });
  if (Array.isArray(entity.aliases)) {
    entity.aliases.forEach((value, index) => {
      if (typeof value === "string") values.push({ field: "aliases[" + index + "]", value });
    });
  }
  for (const [locale, translation] of Object.entries(entity.translations || {})) {
    if (typeof translation?.title === "string") {
      values.push({ field: "translations." + locale + ".title", value: translation.title });
    }
    if (Array.isArray(translation?.aliases)) {
      translation.aliases.forEach((value, index) => {
        if (typeof value === "string") {
          values.push({ field: "translations." + locale + ".aliases[" + index + "]", value });
        }
      });
    }
  }
  return values;
}

function addReason(reasons, reason) {
  const key = JSON.stringify(reason);
  if (!reasons.some((item) => JSON.stringify(item) === key)) reasons.push(reason);
}

function matchReasons(entity, query) {
  const reasons = [];
  const wantedTitles = query.titles.map(normalizeTitle);
  for (const title of entityTitleValues(entity)) {
    const normalized = normalizeTitle(title.value);
    if (!normalized) continue;
    query.titles.forEach((value, index) => {
      if (normalized === wantedTitles[index]) {
        addReason(reasons, {
          query_mode: "title_normalized_equality",
          query_value: value,
          matched_field: title.field,
          matched_value: title.value,
          match_method: "case_and_whitespace_normalized",
          strength: "weak_title_candidate",
        });
      }
    });
  }

  for (const criterion of query.externalIds) {
    const actual = entity.external_ids?.[criterion.provider];
    if (typeof actual === "string" && actual === criterion.value) {
      addReason(reasons, {
        query_mode: "external_id_exact",
        provider: criterion.provider,
        query_value: criterion.value,
        matched_field: "external_ids." + criterion.provider,
        matched_value: actual,
        match_method: "exact_value",
        strength: "identifier_candidate",
      });
    }
  }

  for (const criterion of query.attributes) {
    const actual = entity.attributes?.[criterion.key];
    const values = Array.isArray(actual) ? actual : [actual];
    for (const value of values) {
      if (isScalar(value) && String(value) === criterion.value) {
        addReason(reasons, {
          query_mode: "attribute_exact",
          attribute: criterion.key,
          query_value: criterion.value,
          matched_field: "attributes." + criterion.key,
          matched_value: value,
          match_method: "exact_value",
          strength: "attribute_candidate",
        });
      }
    }
  }
  return reasons;
}

function coverageIsComplete(coverage) {
  if (!coverage || typeof coverage !== "object" || coverage.complete !== true) return false;
  if (!Number.isInteger(coverage.pages) || coverage.pages < 1) return false;
  if (!Number.isInteger(coverage.total) || !Number.isInteger(coverage.rawCount)
    || !Number.isInteger(coverage.uniqueCount)) return false;
  if (!Array.isArray(coverage.failures) || coverage.failures.length > 0) return false;
  if (!Array.isArray(coverage.duplicateIds) || coverage.duplicateIds.length > 0) return false;
  if (coverage.rawCount !== coverage.total || coverage.uniqueCount !== coverage.total) return false;
  return true;
}

function candidateEntity(entity) {
  return {
    id: entity.id || null,
    kind: entity.kind || null,
    title: entity.title || "",
    status: entity.status || null,
    work_id: entity.work_id || null,
    content_unit_id: entity.content_unit_id || null,
    release_id: entity.release_id || null,
    medium_id: entity.medium_id || null,
    parent_id: entity.parent_id || null,
    position: entity.position ?? null,
    number: entity.number ?? null,
    attributes: entity.attributes && typeof entity.attributes === "object" ? entity.attributes : {},
    external_ids: entity.external_ids && typeof entity.external_ids === "object" ? entity.external_ids : {},
  };
}

async function defaultCollectEntities(options) {
  const snapshot = await import("./mf-catalog-snapshot.mjs");
  if (typeof snapshot.collectEntities !== "function") {
    throw new Error("mf-catalog-snapshot.mjs 未导出 collectEntities");
  }
  return snapshot.collectEntities(options);
}

async function resolveOriginal(id, kind, requestFn) {
  try {
    const result = await requestFn("/api/catalog/entities/" + encodeURIComponent(id) + "/resolve");
    const body = result?.body;
    const canonicalId = typeof body?.id === "string" ? body.id : "";
    if (result?.status !== 200 || !canonicalId || body.kind !== kind || body.status === "merged" || body.redirect_id) {
      return { id, canonical: null, status: result?.status ?? 0,
        code: body?.error || body?.code || (result?.status === 200 ? "invalid_canonical_response" : "resolve_failed") };
    }
    return { id, canonical: body, status: 200, code: null };
  } catch (error) {
    return { id, canonical: null, status: 0, code: "request_error", message: safeError(error) };
  }
}

function canonicalCandidate(canonical, originals, reasons) {
  return {
    canonical_id: canonical.id,
    canonical_verified: true,
    matched_original_ids: originals,
    matched_reasons: reasons,
    entity: candidateEntity(canonical),
  };
}

function unresolvedCandidate(original, reasons, status, code) {
  return {
    canonical_id: null,
    canonical_verified: false,
    matched_original_ids: [original.id],
    matched_reasons: reasons,
    entity: candidateEntity(original),
    canonical_verification: { status, code },
  };
}

export async function findIdentity({
  kind = "work", titles = [], externalIds = [], attributes = [], workId, limit = DEFAULT_LIMIT,
  requestFn = apiRequest, collectEntitiesFn = defaultCollectEntities,
} = {}) {
  const query = validateInput({ kind, titles, externalIds, attributes, workId, limit });
  const queryModes = [];
  if (query.titles.length) queryModes.push({ mode: "title_normalized_equality", values: query.titles });
  if (query.externalIds.length) queryModes.push({ mode: "external_id_exact", values: query.externalIds });
  if (query.attributes.length) queryModes.push({ mode: "attribute_exact", values: query.attributes });

  const params = query.workId ? { work_id: query.workId } : {};
  const errors = [];
  const unknown = [];
  let coverage = { complete: false, reason: "collection_not_started" };
  let items = [];
  try {
    const snapshot = await collectEntitiesFn({ kind: query.kind, params, limit: query.limit, requestFn });
    if (!snapshot || !Array.isArray(snapshot.items)) {
      throw new Error("collectEntities 返回值缺少 items 数组");
    }
    items = snapshot.items;
    coverage = snapshot.coverage ?? { complete: false, reason: "coverage_missing" };
  } catch (error) {
    coverage = error?.coverage && typeof error.coverage === "object"
      ? error.coverage
      : { complete: false, reason: "collection_failed" };
    errors.push({ stage: "collection", code: "snapshot_failed", message: safeError(error) });
    unknown.push({ stage: "collection", reason: "pagination_or_snapshot_unverified" });
  }

  if (!coverageIsComplete(coverage) && !unknown.some((item) => item.stage === "collection")) {
    unknown.push({ stage: "collection", reason: "coverage_incomplete" });
  }

  const matches = new Map();
  items.forEach((entity, index) => {
    if (!entity || entity.kind !== query.kind) {
      unknown.push({ stage: "collection", reason: "invalid_or_wrong_kind_item", index });
      return;
    }
    if (query.workId && entity.work_id !== query.workId) return;
    if (typeof entity.id !== "string" || !entity.id) {
      unknown.push({ stage: "collection", reason: "candidate_missing_id", index });
      return;
    }
    const reasons = matchReasons(entity, query);
    if (!reasons.length) return;
    if (!matches.has(entity.id)) matches.set(entity.id, { entity, reasons: [] });
    const match = matches.get(entity.id);
    for (const reason of reasons) addReason(match.reasons, { ...reason, original_id: entity.id });
  });

  const matched = [...matches.entries()].sort(([left], [right]) => left.localeCompare(right));
  const resolutions = [];
  for (let offset = 0; offset < matched.length; offset += RESOLVE_CONCURRENCY) {
    const batch = matched.slice(offset, offset + RESOLVE_CONCURRENCY);
    resolutions.push(...await Promise.all(batch.map(([id]) => resolveOriginal(id, query.kind, requestFn))));
  }

  const canonicalGroups = new Map();
  const candidates = [];
  for (const resolution of resolutions) {
    const match = matches.get(resolution.id);
    if (!resolution.canonical) {
      const candidate = unresolvedCandidate(match.entity, match.reasons, resolution.status, resolution.code);
      candidates.push(candidate);
      const unknownItem = { stage: "resolve", reason: "canonical_identity_unverified", original_id: resolution.id,
        status: resolution.status, code: resolution.code };
      if (resolution.message) unknownItem.message = resolution.message;
      unknown.push(unknownItem);
      errors.push({ stage: "resolve", original_id: resolution.id, status: resolution.status, code: resolution.code });
      continue;
    }
    const canonicalId = resolution.canonical.id;
    if (!canonicalGroups.has(canonicalId)) {
      canonicalGroups.set(canonicalId, { canonical: resolution.canonical, originals: [], reasons: [] });
    }
    const group = canonicalGroups.get(canonicalId);
    if (!group.originals.includes(resolution.id)) group.originals.push(resolution.id);
    for (const reason of match.reasons) addReason(group.reasons, reason);
  }
  for (const group of canonicalGroups.values()) {
    candidates.push(canonicalCandidate(group.canonical, group.originals.sort(), group.reasons));
  }
  candidates.sort((left, right) => String(left.canonical_id || left.matched_original_ids[0])
    .localeCompare(String(right.canonical_id || right.matched_original_ids[0])));

  const complete = coverageIsComplete(coverage) && unknown.length === 0;
  const decision = candidates.length || !complete || errors.length ? "needs_evidence" : "no_visible_candidate";
  return {
    kind: query.kind,
    scope: { work_id: query.workId },
    query_modes: queryModes,
    coverage,
    candidates,
    unknown,
    errors,
    decision,
    identity_confirmed: false,
    decision_note: decision === "no_visible_candidate"
      ? "本次可见范围无候选；不证明真实实例中不存在重复实体。"
      : "候选匹配仅用于定位；身份仍需依据内容与来源人工核验。",
  };
}

function parsePair(value, label) {
  const index = value.indexOf("=");
  if (index <= 0 || index === value.length - 1) throw new Error(label + " 格式为 key=value，且两侧都不能为空");
  return [value.slice(0, index), value.slice(index + 1)];
}

export function parseArgs(argv) {
  const options = { kind: "work", titles: [], externalIds: [], attributes: [], workId: null,
    limit: DEFAULT_LIMIT, out: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length || argv[index].startsWith("--")) throw new Error(flag + " 缺少参数");
      return argv[index];
    };
    switch (flag) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--kind":
        options.kind = value();
        break;
      case "--title":
        options.titles.push(value());
        break;
      case "--external": {
        const [provider, externalValue] = parsePair(value(), "--external");
        options.externalIds.push({ provider, value: externalValue });
        break;
      }
      case "--attribute": {
        const [key, attributeValue] = parsePair(value(), "--attribute");
        options.attributes.push({ key, value: attributeValue });
        break;
      }
      case "--work-id":
        options.workId = value();
        break;
      case "--limit": {
        const parsed = Number(value());
        if (!Number.isInteger(parsed)) throw new Error("--limit 必须是整数");
        options.limit = parsed;
        break;
      }
      case "--out":
        options.out = value();
        break;
      default:
        throw new Error("未知参数：" + flag);
    }
  }
  return options;
}

export function usage() {
  return [
    "用法：node mf-find-identity.mjs [选项]",
    "  --kind <kind>             实体类型，默认 work",
    "  --title <题名>            可重复；比较基础题名、translations.title 与 aliases",
    "  --external <provider=id>  可重复；外部标识精确匹配",
    "  --attribute <key=value>   可重复；attributes 字段精确匹配",
    "  --work-id <id>            限定 expression 所属 Work",
    "  --limit <1-100>           每页大小，默认 100",
    "  --out <file.json>         将完整结果写入 JSON 文件",
    "  --help                    显示帮助，不读取凭据或请求 API",
    "",
    "只读候选查找；不会合并、新建实体或修改题名。候选命中不等于身份确认。",
  ].join("\n");
}

export async function runCli(argv = process.argv.slice(2), { stdout, stderr, requestFn = apiRequest,
  collectEntitiesFn = defaultCollectEntities } = {}) {
  const writeOut = stdout || ((text) => process.stdout.write(String(text) + "\n"));
  const writeErr = stderr || ((text) => process.stderr.write(String(text) + "\n"));
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    writeErr(safeError(error));
    writeErr(usage());
    return 2;
  }
  if (options.help) {
    writeOut(usage());
    return 0;
  }

  let report;
  try {
    report = await findIdentity({ ...options, requestFn, collectEntitiesFn });
  } catch (error) {
    writeErr(safeError(error));
    return 2;
  }
  if (options.out) {
    try {
      await writeFile(resolve(process.cwd(), options.out), JSON.stringify(report, null, 2) + "\n", "utf8");
    } catch (error) {
      writeErr("无法写入 JSON：" + safeError(error));
      return 2;
    }
  }
  writeOut("decision=" + report.decision + " candidates=" + report.candidates.length
    + " unknown=" + report.unknown.length + " errors=" + report.errors.length
    + (options.out ? " json=" + resolve(process.cwd(), options.out) : ""));
  return report.unknown.length || report.errors.length || !coverageIsComplete(report.coverage) ? 2 : 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write("工具执行失败：" + safeError(error) + "\n");
    process.exitCode = 1;
  });
}
