#!/usr/bin/env node

import fs from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { request as apiRequest, writableEntity } from "../metafusion-api.mjs";

function authFailure(response) {
  const codes = {
    401: ["invalid_token", "authentication_required"],
    403: ["forbidden"],
    503: ["auth_unavailable"],
  };
  const code = response?.body?.error;
  return codes[response?.status]?.includes(code) ? { errorCode: code } : {};
}

const READ_ONLY = new Set(["created_by", "redirect_id", "updated_at"]);
const IMMUTABLE = new Set(["id", "kind", "version"]);
const OWNERSHIP = new Set(["work_id", "content_unit_id", "release_id", "medium_id", "parent_id"]);
const PLAN_KEYS = new Set(["id", "expected_version", "patch", "edit_note", "sources", "verification"]);
const VERIFY_KEYS = new Set(["tocReleaseIds", "occurrenceEntityIds", "relationEntityIds"]);
const TRACK_STATUS_PATH = "/api/catalog/tracks/{id}/status";
const TRACK_STATUSES = new Set(["draft", "pending_review", "published"]);

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isRevisionId = (value) => (typeof value === "string" && value.trim().length > 0)
  || (Number.isSafeInteger(value) && value > 0);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function same(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function cloneJson(value) {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError("non_json_value");
  return JSON.parse(text);
}

// Objects merge recursively; arrays and primitives replace; null is an explicit clear.
// Object keys absent from the patch are never removed.
function mergePatch(current, patch) {
  if (patch === null || Array.isArray(patch) || !isRecord(patch)) return cloneJson(patch);
  const merged = Object.fromEntries(Object.entries(isRecord(current) ? current : {}).map(([key, value]) => [key, cloneJson(value)]));
  for (const [key, value] of Object.entries(patch)) {
    Object.defineProperty(merged, key, {
      value: mergePatch(has(merged, key) ? merged[key] : undefined, value),
      enumerable: true, writable: true, configurable: true,
    });
  }
  return merged;
}

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validSources(sources, patchKeys) {
  if (!Array.isArray(sources) || sources.length === 0) return false;
  const covered = new Set();
  for (const source of sources) {
    if (!isRecord(source) || Object.keys(source).some((key) => !["kind", "citation", "url"].includes(key))) return false;
    if (!["url", "publication", "self"].includes(source.kind) || typeof source.citation !== "string" || !source.citation.trim()) return false;
    if (source.kind === "url" && !validHttpUrl(source.url)) return false;
    if (source.url !== undefined && !validHttpUrl(source.url)) return false;
    // A self source may be retained as maintenance history, but it cannot
    // support a newly patched fact. Each patched field still needs a source
    // that makes an external assertion.
    if (source.kind !== "self") {
      const citation = source.citation.toLocaleLowerCase();
      for (const key of patchKeys) if (citation.includes(key.toLocaleLowerCase())) covered.add(key);
    }
  }
  return patchKeys.every((key) => covered.has(key));
}

function validatePlan(plan) {
  if (!isRecord(plan) || Object.keys(plan).some((key) => !PLAN_KEYS.has(key))) return "invalid_plan";
  if (typeof plan.id !== "string" || !plan.id.trim() || !Number.isSafeInteger(plan.expected_version) || plan.expected_version < 1) return "invalid_plan";
  if (!isRecord(plan.patch)) return "invalid_patch";
  const keys = Object.keys(plan.patch);
  if (keys.some((key) => !key || key.includes(".") || key.includes("/") || key.startsWith("/"))) return "patch_must_use_top_level_fields";
  if (keys.some((key) => READ_ONLY.has(key) || IMMUTABLE.has(key))) return "read_only_field";
  if (keys.some((key) => OWNERSHIP.has(key))) return "ownership_field_forbidden";
  if (plan.patch.status === "deleted" || plan.patch.status === "merged") return "lifecycle_requires_dedicated_endpoint";
  if (typeof plan.edit_note !== "string" || !plan.edit_note.trim()) return "edit_note_required";
  if (!validSources(plan.sources, keys)) return "invalid_or_insufficient_evidence_envelope";

  if (plan.verification !== undefined) {
    if (!isRecord(plan.verification) || Object.keys(plan.verification).some((key) => !VERIFY_KEYS.has(key))) return "invalid_verification_plan";
    for (const key of VERIFY_KEYS) {
      const ids = plan.verification[key];
      if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id.trim()))) return "invalid_verification_plan";
    }
  }
  try {
    cloneJson(plan.patch);
    cloneJson(plan.sources);
  } catch {
    return "invalid_json_value";
  }
  return null;
}

function safeStatus(response) {
  return Number.isInteger(response?.status) ? response.status : 0;
}

async function get(requestFn, pathname) {
  try {
    const response = await requestFn(pathname, { method: "GET" });
    return { response, status: safeStatus(response) };
  } catch {
    return { response: null, status: 0 };
  }
}

function entityPath(id) {
  return `/api/catalog/entities/${encodeURIComponent(id)}`;
}

function revisionPath(id) {
  return `${entityPath(id)}/revisions`;
}

function writable(value) {
  if (!isRecord(value)) return null;
  const result = writableEntity(value);
  // GET and revision projections represent an empty Track inclusion set as
  // [] or null. Only this known empty projection difference is equivalent.
  if (value.kind === "track" && has(result, "contents") && result.contents === null) result.contents = [];
  return result;
}

function trackStatusOperation(contract, status) {
  if (typeof contract?.openapi !== "string" || !contract.openapi.startsWith("3.")) return null;
  for (const path of [TRACK_STATUS_PATH, TRACK_STATUS_PATH.slice(4)]) {
    const operation = contract?.paths?.[path]?.patch;
    const schemaRef = operation?.requestBody?.content?.["application/json"]?.schema?.$ref;
    if (schemaRef !== "#/components/schemas/TrackStatusEdit") continue;
    const schema = contract?.components?.schemas?.TrackStatusEdit;
    const keys = ["status", "expected_version", "edit_note", "sources"];
    if (!isRecord(schema?.properties) || schema.type !== "object" || schema.additionalProperties !== false
      || !Array.isArray(schema.required) || schema.required.length !== keys.length
      || Object.keys(schema.properties).some((key) => !keys.includes(key))
      || !keys.every((key) => isRecord(schema.properties[key]) && schema.required.includes(key))
      || schema.properties.status.type !== "string" || schema.properties.expected_version.type !== "integer"
      || schema.properties.edit_note.type !== "string" || schema.properties.sources.type !== "array"
      || !Array.isArray(schema.properties.status.enum) || !schema.properties.status.enum.includes(status)) continue;
    return { path, method: "patch", requestSchema: "TrackStatusEdit" };
  }
  return null;
}

function fieldDiff(expected, actual, { patched = new Set(), preserveFrom = null } = {}) {
  const fields = [];
  for (const key of Object.keys(expected)) {
    const role = key === "version" ? "version" : patched.has(key) ? "patched" : "preserved";
    const target = role === "version" || role === "patched" ? expected[key] : preserveFrom?.[key];
    if (!patched.has(key) && !preserveFrom) continue;
    fields.push({ field: key, role, ok: same(target, actual?.[key]) && has(actual ?? {}, key) });
  }
  for (const key of Object.keys(actual ?? {})) {
    if (!has(expected, key)) fields.push({ field: key, role: "unexpected", ok: false });
  }
  return fields;
}

function extractVersion(response) {
  const body = response?.body;
  const version = body?.version ?? body?.entity?.version;
  return Number.isSafeInteger(version) ? version : null;
}

async function readonlyRecheck(requestFn, plan, expectedAfter, writeStatus) {
  const entityResult = await get(requestFn, entityPath(plan.id));
  const body = entityResult.response?.body;
  const entity = entityResult.status === 200 && isRecord(body) && body.id === plan.id ? body : null;
  const currentWritable = writable(entity);
  const expectedStateVisible = currentWritable ? same(currentWritable, expectedAfter) : null;
  let revisionState = "unavailable";
  let revisionIdPresent = false;
  if (entity) {
    const revResult = await get(requestFn, revisionPath(plan.id));
    const items = revResult.response?.body?.items;
    if (revResult.status === 200 && Array.isArray(items)) {
      const revision = items.find((item) => item?.version === entity.version);
      revisionState = revision ? "current_revision_found" : "current_revision_missing";
      revisionIdPresent = !!revision?.id;
    }
  }
  return {
    state: entity ? (expectedStateVisible ? "expected_state_visible" : "entity_read") : "entity_unavailable",
    entityReadStatus: entityResult.status,
    currentVersion: entity?.version ?? null,
    expectedStateVisible,
    revisionState,
    revisionIdPresent,
    writeResponseStatus: writeStatus,
  };
}

function changeDetails(before, after, keys) {
  const changes = [];
  const visit = (oldValue, newValue, field, oldPresent = true, newPresent = true) => {
    if (oldPresent && newPresent && same(oldValue, newValue)) return;
    if (oldPresent && newPresent && isRecord(oldValue) && isRecord(newValue)) {
      const nestedKeys = new Set([...Object.keys(oldValue), ...Object.keys(newValue)]);
      for (const key of nestedKeys) {
        visit(oldValue[key], newValue[key], `${field}.${key}`, has(oldValue, key), has(newValue, key));
      }
      return;
    }
    changes.push({
      field,
      before: oldPresent ? cloneJson(oldValue) : null,
      after: newPresent ? cloneJson(newValue) : null,
      beforePresent: oldPresent,
      afterPresent: newPresent,
    });
  };
  for (const key of keys) visit(before[key], after[key], key, has(before, key), has(after, key));
  return changes;
}

function entityInToc(toc, entity) {
  const id = entity.id;
  if (entity.kind === "release") return toc.release?.id === id ? toc.release : null;
  if (!Array.isArray(toc.media) || !isRecord(toc.expressions)) return null;
  if (entity.kind === "medium") {
    for (const group of toc.media) if (group?.medium?.id === id) return group.medium;
  }
  if (entity.kind === "track") {
    for (const group of toc.media) for (const track of group?.tracks ?? []) if (track?.id === id) return track;
  }
  if (entity.kind === "expression") return toc.expressions[id] ?? null;
  return undefined;
}

async function verifyTocs(requestFn, ids, entity, expectedWritable) {
  const checks = [];
  for (const id of ids) {
    const result = await get(requestFn, `/api/catalog/releases/${encodeURIComponent(id)}/toc`);
    const body = result.response?.body;
    if (result.status !== 200) {
      checks.push({ kind: "toc", id, state: "failed", httpStatus: result.status });
      continue;
    }
    if (!isRecord(body) || body.release?.id !== id || !Array.isArray(body.media) || !isRecord(body.expressions)) {
      checks.push({ kind: "toc", id, state: "unverified", reason: "response_shape_incomplete" });
      continue;
    }
    const found = entityInToc(body, entity);
    if (found === undefined) {
      checks.push({ kind: "toc", id, state: "unverified", reason: "entity_kind_not_projected" });
    } else if (!found) {
      checks.push({ kind: "toc", id, state: "failed", reason: "planned_entity_not_found" });
    } else {
      const matches = same(writable(found), expectedWritable);
      checks.push({ kind: "toc", id, state: matches ? "verified" : "failed", entityMatches: matches });
    }
  }
  return checks;
}

function occurrenceTuple(item) {
  return {
    expression_id: item?.expression_id,
    position: item?.position,
    locator: item?.locator ?? {},
    attributes: item?.attributes ?? {},
    sources: item?.sources ?? [],
  };
}

function sameUnordered(a, b) {
  const key = (value) => JSON.stringify(canonical(value));
  return same([...a].map(key).sort(), [...b].map(key).sort());
}

async function verifyOccurrences(requestFn, ids, entity) {
  const checks = [];
  for (const id of ids) {
    const result = await get(requestFn, `${entityPath(id)}/occurrences`);
    const items = result.response?.body?.items;
    if (result.status !== 200 || !Array.isArray(items)) {
      checks.push({ kind: "occurrences", id, state: "failed", httpStatus: result.status });
      continue;
    }
    if (entity.kind !== "track" || !Array.isArray(entity.contents)) {
      checks.push({ kind: "occurrences", id, state: "unverified", reason: "no_track_inclusion_expectation" });
      continue;
    }
    const expected = entity.contents.filter((item) => item?.expression_id === id).map(occurrenceTuple);
    const observed = items.filter((item) => item?.track?.id === entity.id && item?.expression_id === id).map(occurrenceTuple);
    const matches = sameUnordered(expected, observed);
    checks.push({ kind: "occurrences", id, state: matches ? "verified" : "failed", trackOccurrencesMatch: matches });
  }
  return checks;
}

async function verifyRelations(requestFn, ids) {
  const checks = [];
  for (const id of ids) {
    const result = await get(requestFn, `${entityPath(id)}/relations`);
    const body = result.response?.body;
    if (result.status !== 200 || !isRecord(body) || !Array.isArray(body.items) || body.subject_id !== id) {
      checks.push({ kind: "relations", id, state: "failed", httpStatus: result.status });
    } else {
      checks.push({ kind: "relations", id, state: "unverified", reason: "no_expected_edges_in_plan", itemCount: body.items.length });
    }
  }
  return checks;
}

async function verifyRequested(requestFn, plan, entity, expectedWritable) {
  const spec = plan.verification ?? {};
  const groups = await Promise.all([
    verifyTocs(requestFn, spec.tocReleaseIds ?? [], entity, expectedWritable),
    verifyOccurrences(requestFn, spec.occurrenceEntityIds ?? [], entity),
    verifyRelations(requestFn, spec.relationEntityIds ?? []),
  ]);
  return groups.flat();
}

/**
 * Version-guarded update; Track status uses a dedicated PATCH, never entity PUT.
 * A plan only names top-level fields; all HTTP paths and methods are fixed here.
 */
export async function guardedUpdate(plan, { apply = false, requestFn = apiRequest, contract = null } = {}) {
  const invalid = validatePlan(plan);
  if (invalid) return { ok: false, outcome: "rejected", reason: invalid, applied: false };
  if (typeof requestFn !== "function") return { ok: false, outcome: "rejected", reason: "invalid_request_function", applied: false };

  const first = await get(requestFn, entityPath(plan.id));
  const current = first.response?.body;
  if (first.status !== 200 || !isRecord(current) || current.id !== plan.id || !Number.isSafeInteger(current.version)) {
    return { ok: false, outcome: "preflight_failed", reason: "current_entity_unavailable", httpStatus: first.status, applied: false, ...authFailure(first.response) };
  }
  const trackStatus = current.kind === "track";
  if (trackStatus && (Object.keys(plan.patch).length !== 1 || !has(plan.patch, "status"))) {
    return { ok: false, outcome: "rejected", reason: "track_requires_dedicated_endpoint", applied: false };
  }
  if (trackStatus && !TRACK_STATUSES.has(plan.patch.status)) {
    return { ok: false, outcome: "rejected", reason: "invalid_status", applied: false };
  }
  if (trackStatus && current.status === "published" && plan.patch.status !== "published") {
    return { ok: false, outcome: "rejected", reason: "use_lifecycle_endpoint", applied: false };
  }
  if (has(plan.patch, "contents")) {
    return { ok: false, outcome: "rejected", reason: "contents_not_patchable", applied: false };
  }
  if (current.version !== plan.expected_version) {
    return { ok: false, outcome: "version_mismatch", expectedVersion: plan.expected_version, currentVersion: current.version, applied: false };
  }

  const before = writable(current);
  if (!before) return { ok: false, outcome: "preflight_failed", reason: "invalid_entity_shape", applied: false };
  for (const key of Object.keys(plan.patch)) {
    if (!has(before, key)) return { ok: false, outcome: "rejected", reason: "field_not_writable_for_entity", applied: false };
  }
  const next = { ...before };
  for (const key of Object.keys(plan.patch)) next[key] = mergePatch(before[key], plan.patch[key]);
  const changed = Object.keys(plan.patch).filter((key) => !same(before[key], next[key]));
  if (changed.length === 0) {
    return { ok: true, outcome: "skipped", reason: "no_change", applied: false, version: current.version, changedFields: [], changes: [] };
  }

  const changes = changeDetails(before, next, changed);
  const expectedAfter = { ...next, version: current.version + 1 };
  const preservedFields = Object.keys(before).filter((key) => !changed.includes(key));
  let operation;
  if (trackStatus) {
    let loaded = contract;
    if (loaded === null) {
      const result = await get(requestFn, "/api/openapi.json");
      if (result.status === 200) loaded = result.response?.body;
    }
    operation = trackStatusOperation(loaded, plan.patch.status);
    if (!operation) return {
      ok: false, outcome: "preflight_failed", reason: "track_status_endpoint_not_confirmed_by_openapi", applied: false,
    };
  }
  if (!apply) {
    return { ok: true, outcome: "dry_run", applied: false, version: current.version, changedFields: changed, changes, preservedFieldCount: preservedFields.length, ...(operation ? { operation } : {}) };
  }

  let put;
  try {
    put = await requestFn(trackStatus ? TRACK_STATUS_PATH.replace("{id}", encodeURIComponent(plan.id)) : entityPath(plan.id), {
      method: trackStatus ? "PATCH" : "PUT",
      tries: 1,
      body: {
        ...(trackStatus ? { status: next.status } : { entity: next }),
        expected_version: current.version,
        edit_note: plan.edit_note.trim(),
        sources: cloneJson(plan.sources),
      },
    });
  } catch {
    const recheck = await readonlyRecheck(requestFn, plan, expectedAfter, 0);
    return { ok: false, outcome: "unknown", reason: "write_result_unknown", applied: null, changedFields: changed, changes, recheck };
  }

  const putStatus = safeStatus(put);
  if (putStatus === 409) {
    const recheck = await readonlyRecheck(requestFn, plan, expectedAfter, putStatus);
    return { ok: false, outcome: "conflict", reason: "version_conflict_no_replay", httpStatus: putStatus, applied: false, changedFields: changed, changes, recheck };
  }
  if (putStatus === 0 || putStatus >= 500) {
    const recheck = await readonlyRecheck(requestFn, plan, expectedAfter, putStatus);
    return { ok: false, outcome: "unknown", reason: "write_result_unknown", httpStatus: putStatus, applied: null, changedFields: changed, changes, recheck, ...authFailure(put) };
  }
  if (putStatus < 200 || putStatus >= 300) {
    return { ok: false, outcome: "rejected", reason: "write_rejected", httpStatus: putStatus, applied: false, changedFields: changed, changes, ...authFailure(put) };
  }

  const [afterResult, revisionCheck] = await Promise.all([
    get(requestFn, entityPath(plan.id)),
    get(requestFn, revisionPath(plan.id)),
  ]);
  const after = afterResult.status === 200 && isRecord(afterResult.response?.body) && afterResult.response.body.id === plan.id
    ? afterResult.response.body : null;
  if (!after) {
    return {
      ok: false, outcome: "partial", reason: "entity_readback_unavailable", httpStatus: putStatus,
      applied: true, changedFields: changed, changes, readbackStatus: afterResult.status,
    };
  }
  const afterWritable = writable(after);
  const fieldChecks = fieldDiff(expectedAfter, afterWritable, { patched: new Set(changed), preserveFrom: before });
  const entityDeepMatches = same(expectedAfter, afterWritable);
  const versionMatches = after.version === expectedAfter.version && (extractVersion(put) === null || extractVersion(put) === after.version);
  const revision = await verifyRevisionFromResult(revisionCheck, after, expectedAfter, plan.sources);
  const coreOk = entityDeepMatches && versionMatches && fieldChecks.every((field) => field.ok) && revision.ok;
  if (!coreOk) {
    return {
      ok: false, outcome: "partial", reason: "write_not_fully_verified", httpStatus: putStatus, applied: true,
      versionCheck: { ok: versionMatches, expected: current.version + 1, actual: after.version, responseVersion: extractVersion(put) },
      entityDeepMatches, fieldChecks, revisionCheck: revision, changedFields: changed, changes,
    };
  }

  const requestedChecks = await verifyRequested(requestFn, plan, after, expectedAfter);
  const failedCheck = requestedChecks.some((check) => check.state === "failed");
  const unverifiedCheck = requestedChecks.some((check) => check.state === "unverified");
  if (failedCheck || unverifiedCheck) {
    return {
      ok: false, outcome: failedCheck ? "partial" : "unverified",
      reason: failedCheck ? "requested_readback_check_failed" : "requested_readback_check_unverified",
      httpStatus: putStatus, applied: true,
      versionCheck: { ok: versionMatches, expected: current.version + 1, actual: after.version, responseVersion: extractVersion(put) },
      entityDeepMatches, fieldChecks, revisionCheck: revision, verificationChecks: requestedChecks, changedFields: changed, changes,
    };
  }
  return {
    ok: true, outcome: "verified", applied: true, httpStatus: putStatus, version: after.version,
    versionCheck: { ok: true, expected: current.version + 1, actual: after.version, responseVersion: extractVersion(put) },
    entityDeepMatches, fieldChecks, revisionCheck: revision, verificationChecks: requestedChecks, changedFields: changed, changes,
  };
}

async function verifyRevisionFromResult(result, entity, expectedWritable, expectedSources) {
  if (result.status !== 200 || !Array.isArray(result.response?.body?.items)) {
    return { ok: false, state: "unavailable", httpStatus: result.status };
  }
  const revision = result.response.body.items.find((item) => item?.version === entity.version);
  if (!revision) return { ok: false, state: "current_revision_missing", version: entity.version };
  if (!isRevisionId(revision.id)) {
    return { ok: false, state: "current_revision_id_missing", version: entity.version };
  }
  const snapshot = writable(revision.snapshot);
  const snapshotMatches = !!snapshot && same(snapshot, expectedWritable);
  const sourcesMatch = same(revision.sources, expectedSources);
  return {
    ok: snapshotMatches && sourcesMatch,
    state: snapshotMatches && sourcesMatch ? "verified" : "mismatch",
    version: revision.version,
    idPresent: true,
    snapshotMatches,
    sourcesMatch,
  };
}

function usage() {
  return [
    "用法: node mf-guarded-update.mjs --plan <JSON文件> [--apply] [--out <结果JSON文件>]",
    "默认仅预览；只有 --apply 才会发出一次受控写入。--apply 只是执行开关，不代表授权证明。",
    "--out 保存完整结构化结果，含目标字段 before/after 与逐项核验，不含原始 API 响应体。",
    "patch 对象递归合并；未列出的对象键保留。数组按整数组替换，null 表示显式清空；不支持隐式删除键。",
    "Track 禁止 whole-entity PUT；仅 status patch 经运行时 OpenAPI 确认后走专用 PATCH，contents 仍用 mf-track-content。",
    "不提供全部可见范围猜测开关；非 Track 的 contents patch 也拒绝。",
  ].join("\n");
}

function parseArgs(args) {
  const options = { apply: false, plan: null, out: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--plan" || arg === "--out") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error("invalid_cli_arguments");
      options[arg === "--plan" ? "plan" : "out"] = value;
    } else throw new Error("invalid_cli_arguments");
  }
  if (!options.plan) throw new Error("invalid_cli_arguments");
  if (options.out && resolve(options.out) === resolve(options.plan)) throw new Error("output_must_not_overwrite_plan");
  return options;
}

function compact(result, plan) {
  return {
    ok: result.ok,
    outcome: result.outcome,
    reason: result.reason,
    id: plan.id,
    version: result.version ?? result.versionCheck?.actual ?? result.currentVersion,
    changedFields: result.changedFields ?? result.fieldChecks?.filter((item) => item.role === "patched").map((item) => item.field) ?? [],
    verificationStates: result.verificationChecks?.map(({ kind, id, state }) => ({ kind, id, state })) ?? [],
  };
}

async function runCli() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  try {
    const options = parseArgs(args);
    const plan = JSON.parse(fs.readFileSync(options.plan, "utf8"));
    const result = await guardedUpdate(plan, { apply: options.apply });
    if (options.out) fs.writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify(compact(result, plan))}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch {
    process.stderr.write(`${JSON.stringify({ ok: false, outcome: "rejected", reason: "cli_error" })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli();
}
