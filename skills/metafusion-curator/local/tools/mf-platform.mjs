#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { request as apiRequest, collectPages, writableEntity } from "../metafusion-api.mjs";
import { IDENTITY_ATTRS, KINDS } from "./mf-lib.mjs";
import { findIdentity } from "./mf-find-identity.mjs";
import { guardedUpdate } from "./mf-guarded-update.mjs";
import { addTrackContent } from "./mf-track-content.mjs";

const API = "/api";
const ENTITY_LIST = `${API}/catalog/entities`;
const DEFINITIONS = `${API}/catalog/definitions`;
const OPENAPI = `${API}/openapi.json`;
const ENTITY_PLAN_KEYS = ["action", "entity", "edit_note", "sources", "idempotency_key", "duplicate_check"];
const ENTITY_KEYS = new Set([
  "id", "kind", "title", "original_language", "translations", "attributes", "external_ids", "pictures",
  "status", "work_id", "content_unit_id", "release_id", "medium_id", "parent_id", "position", "number",
  "contents", "subjects", "version", "created_by", "redirect_id", "updated_at",
]);
const LIST_FILTERS = new Set([
  "kind", "kinds", "q", "status", "work_id", "content_unit_id", "release_id", "medium_id", "parent_id",
  "field", "value", "tags", "original_language", "has_pictures", "sort", "order", "locale",
]);
const READ_ACTIONS = [
  "entity.get", "entity.list", "entity.resolve", "entity.current-revision", "entity.relations",
  "entity.occurrences", "release.toc", "definitions", "contract",
];

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
const isRevisionId = (value) => isNonEmptyString(value) || (Number.isSafeInteger(value) && value > 0);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function cloneJson(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError("invalid_json_value");
  return JSON.parse(serialized);
}

function strictObject(properties, required = []) {
  return { type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}) };
}

const stringSchema = { type: "string", minLength: 1 };
const idempotencySchema = { type: "string", minLength: 1, maxLength: 200 };
const sourceSchema = strictObject({
  kind: { type: "string", enum: ["url", "publication", "self"] },
  citation: stringSchema,
  url: { type: "string", format: "uri" },
}, ["kind", "citation"]);
const sourcesSchema = { type: "array", minItems: 1, items: sourceSchema };
sourcesSchema.contains = { not: { type: "object", properties: { kind: { const: "self" } }, required: ["kind"] } };
sourcesSchema.minContains = 1;

const updatePlanSchema = strictObject({
  id: stringSchema,
  expected_version: { type: "integer", minimum: 1 },
  patch: { type: "object" },
  edit_note: stringSchema,
  sources: sourcesSchema,
  verification: strictObject({
    tocReleaseIds: { type: "array", items: stringSchema },
    occurrenceEntityIds: { type: "array", items: stringSchema },
    relationEntityIds: { type: "array", items: stringSchema },
  }),
}, ["id", "expected_version", "patch", "edit_note", "sources"]);

const trackContentPlanSchema = strictObject({
  track_id: stringSchema,
  expected_version: { type: "integer", minimum: 1 },
  inclusion: strictObject({
    expression_id: stringSchema,
    position: { type: "integer", minimum: 0 },
    locator: { type: "object" },
    attributes: { type: "object" },
    sources: sourcesSchema,
  }, ["expression_id", "position"]),
  edit_note: stringSchema,
  sources: sourcesSchema,
}, ["track_id", "expected_version", "inclusion", "edit_note", "sources"]);

const entityCreateSchema = strictObject({
  action: { const: "entity.create" },
  entity: { type: "object", description: "单个实体 DTO；kind 与 attributes 依当前 definitions 预检" },
  edit_note: stringSchema,
  sources: sourcesSchema,
  idempotency_key: idempotencySchema,
  duplicate_check: strictObject({
    visibility: { const: "caller_visible_only" },
    reviewed_candidate_ids: { type: "array", uniqueItems: true, items: stringSchema },
    candidate_decision: { const: "distinct", description: "仅在非空候选集逐项人工核对后填写" },
  }, ["visibility", "reviewed_candidate_ids"]),
}, ["action", "entity", "edit_note", "sources", "idempotency_key", "duplicate_check"]);

const relationCreateSchema = strictObject({
  action: { const: "relation.create" },
  relation: strictObject({
    id: { type: "string", maxLength: 0 },
    type: stringSchema,
    source_id: stringSchema,
    target_id: stringSchema,
    position: { type: "integer", minimum: 0 },
    attributes: { type: "object" },
  }, ["type", "source_id", "target_id"]),
  edit_note: stringSchema,
  sources: sourcesSchema,
  idempotency_key: idempotencySchema,
}, ["action", "relation", "edit_note", "sources", "idempotency_key"]);

function planSchema(action) {
  const readId = (name, constant) => strictObject({ action: { const: constant }, id: stringSchema }, ["action", "id"]);
  const schemas = {
    "entity.get": readId("entity", "entity.get"),
    "entity.resolve": readId("entity", "entity.resolve"),
    "entity.current-revision": readId("entity", "entity.current-revision"),
    "entity.relations": readId("entity", "entity.relations"),
    "entity.occurrences": readId("entity", "entity.occurrences"),
    "release.toc": readId("release", "release.toc"),
    "entity.list": strictObject({
      action: { const: "entity.list" }, params: { type: "object" }, limit: { type: "integer", minimum: 1, maximum: 100 },
    }, ["action"]),
    definitions: strictObject({ action: { const: "definitions" } }, ["action"]),
    contract: strictObject({ action: { const: "contract" } }, ["action"]),
    "entity.create": entityCreateSchema,
    "entity.update": strictObject({ action: { const: "entity.update" }, plan: updatePlanSchema }, ["action", "plan"]),
    "track-content.add": strictObject({ action: { const: "track-content.add" }, plan: trackContentPlanSchema }, ["action", "plan"]),
    "relation.create": relationCreateSchema,
  };
  if (action === undefined) return schemas;
  return schemas[action] ?? null;
}

export const PLAN_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "MetaFusion platform operation plan",
  description: "白名单动作；写动作默认预览，--apply 只执行计划，不代表授权。",
  oneOf: Object.values(planSchema()),
});

export function schemaFor(action) {
  if (action === undefined) return PLAN_SCHEMA;
  return planSchema(action);
}

export function listOperations() {
  return [
    ...READ_ACTIONS.map((action) => ({ action, mode: "read", paginated: action === "entity.list" })),
    { action: "entity.create", mode: "write", default: "preview", helper: "mf-platform", idempotent: true },
    { action: "entity.update", mode: "write", default: "preview", helper: "mf-guarded-update" },
    { action: "track-content.add", mode: "write", default: "preview", helper: "mf-track-content" },
    { action: "relation.create", mode: "write", default: "preview", helper: "mf-platform", idempotent: true },
  ];
}

function sourceIsValid(source) {
  if (!isRecord(source) || Object.keys(source).some((key) => !["kind", "citation", "url"].includes(key))) return false;
  if (!["url", "publication", "self"].includes(source.kind) || !isNonEmptyString(source.citation)) return false;
  if (source.kind === "url" && !validHttpUrl(source.url)) return false;
  if (source.url !== undefined && !validHttpUrl(source.url)) return false;
  return true;
}

function validSources(sources, { requireNonSelf = true } = {}) {
  return Array.isArray(sources) && sources.length > 0 && sources.every(sourceIsValid)
    && (!requireNonSelf || sources.some((source) => source.kind !== "self"));
}

function validHttpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validIdempotencyKey(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200
    && !/[\r\n]/.test(value);
}

function planKeysValid(plan, allowed, required) {
  return isRecord(plan) && Object.keys(plan).every((key) => allowed.includes(key))
    && required.every((key) => has(plan, key));
}

export function validatePlan(plan) {
  if (!isRecord(plan) || !isNonEmptyString(plan.action)) return "invalid_plan";
  const action = plan.action;
  const simpleIdActions = new Set([
    "entity.get", "entity.resolve", "entity.current-revision", "entity.relations", "entity.occurrences", "release.toc",
  ]);
  if (simpleIdActions.has(action)) {
    return planKeysValid(plan, ["action", "id"], ["id"]) && isNonEmptyString(plan.id) ? null : "invalid_plan";
  }
  if (action === "entity.list") {
    if (!planKeysValid(plan, ["action", "params", "limit"], ["action"])) return "invalid_plan";
    if (plan.params !== undefined) {
      if (!isRecord(plan.params) || Object.keys(plan.params).some((key) => !LIST_FILTERS.has(key)
        || ["page", "offset", "limit"].includes(key.toLowerCase()))) return "invalid_list_params";
      if (Object.values(plan.params).some((value) => !(typeof value === "string" || typeof value === "number"
        || typeof value === "boolean" || (Array.isArray(value) && value.every((item) => typeof item === "string"))))) {
        return "invalid_list_params";
      }
    }
    if (plan.limit !== undefined && (!Number.isSafeInteger(plan.limit) || plan.limit < 1 || plan.limit > 100)) return "invalid_limit";
    return null;
  }
  if (action === "definitions" || action === "contract") {
    return planKeysValid(plan, ["action"], ["action"]) ? null : "invalid_plan";
  }
  if (action === "entity.create") {
    if (!planKeysValid(plan, ENTITY_PLAN_KEYS, ENTITY_PLAN_KEYS)) return "invalid_plan";
    if (!isRecord(plan.entity) || Object.keys(plan.entity).some((key) => !ENTITY_KEYS.has(key))) return "invalid_entity";
    if (!isNonEmptyString(plan.edit_note)) return "edit_note_required";
    if (["created_by", "redirect_id", "updated_at", "version"].some((key) => has(plan.entity, key))) return "server_managed_entity_field";
    if (plan.entity.id !== undefined && plan.entity.id !== "") return "entity_id_must_be_empty";
    if (plan.entity.status !== undefined && plan.entity.status !== "draft") return "create_status_must_be_draft";
    if (!isNonEmptyString(plan.entity.kind) || !isNonEmptyString(plan.entity.title)) return "invalid_entity";
    if (!isRecord(plan.entity.attributes ?? {})) return "invalid_attributes";
    if (plan.entity.external_ids !== undefined && (!isRecord(plan.entity.external_ids)
      || Object.values(plan.entity.external_ids).some((value) => typeof value !== "string"))) return "invalid_external_ids";
    if (!validSources(plan.sources)) return "invalid_sources";
    if (!validIdempotencyKey(plan.idempotency_key)) return "idempotency_key_required";
    const duplicate = plan.duplicate_check;
    if (!isRecord(duplicate) || Object.keys(duplicate).some((key) => !["visibility", "reviewed_candidate_ids", "candidate_decision"].includes(key))
      || duplicate.visibility !== "caller_visible_only" || !Array.isArray(duplicate.reviewed_candidate_ids)
      || duplicate.reviewed_candidate_ids.some((id) => !isNonEmptyString(id))
      || new Set(duplicate.reviewed_candidate_ids).size !== duplicate.reviewed_candidate_ids.length
      || (duplicate.candidate_decision !== undefined && duplicate.candidate_decision !== "distinct")) return "invalid_duplicate_check";
    if (duplicate.reviewed_candidate_ids.length > 0 && duplicate.candidate_decision !== "distinct") return "candidate_review_required";
    try { cloneJson(plan.entity); cloneJson(plan.sources); } catch { return "invalid_json_value"; }
    return null;
  }
  if (action === "entity.update") {
    if (!planKeysValid(plan, ["action", "plan"], ["action", "plan"]) || !isRecord(plan.plan)) return "invalid_plan";
    return null; // The guarded-update helper owns its closed schema and validation.
  }
  if (action === "track-content.add") {
    if (!planKeysValid(plan, ["action", "plan"], ["action", "plan"]) || !isRecord(plan.plan)) return "invalid_plan";
    return null; // The track-content helper owns its closed schema and validation.
  }
  if (action === "relation.create") {
    if (!planKeysValid(plan, ["action", "relation", "edit_note", "sources", "idempotency_key"],
      ["action", "relation", "edit_note", "sources", "idempotency_key"])) return "invalid_plan";
    const relation = plan.relation;
    if (!isRecord(relation) || Object.keys(relation).some((key) => !["id", "type", "source_id", "target_id", "position", "attributes"].includes(key))) return "invalid_relation";
    if (relation.id !== undefined && relation.id !== "") return "relation_id_must_be_empty";
    if (!isNonEmptyString(relation.type) || !isNonEmptyString(relation.source_id) || !isNonEmptyString(relation.target_id)
      || relation.source_id === relation.target_id) return "invalid_relation";
    if (relation.position !== undefined && (!Number.isSafeInteger(relation.position) || relation.position < 0)) return "invalid_relation_position";
    if (relation.attributes !== undefined && !isRecord(relation.attributes)) return "invalid_relation_attributes";
    if (!isNonEmptyString(plan.edit_note) || !validSources(plan.sources)) return "invalid_evidence_envelope";
    if (!validIdempotencyKey(plan.idempotency_key)) return "idempotency_key_required";
    try { cloneJson(relation); cloneJson(plan.sources); } catch { return "invalid_json_value"; }
    return null;
  }
  return "unsupported_action";
}

function statusOutcome(status) {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found_or_not_visible";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status === 0 || status >= 500) return "unknown";
  return "rejected";
}

function httpFailure(status, stage, body) {
  return {
    ok: false,
    outcome: statusOutcome(status),
    reason: `${stage}_http_${status || "unknown"}`,
    httpStatus: status,
    ...(body?.error || body?.code ? { code: body.error ?? body.code } : {}),
  };
}

async function read(requestFn, pathname) {
  try {
    const response = await requestFn(pathname, { method: "GET" });
    return { status: Number.isInteger(response?.status) ? response.status : 0, body: response?.body ?? null, threw: false };
  } catch {
    return { status: 0, body: null, threw: true };
  }
}

function entityPath(id, suffix = "") {
  return `${ENTITY_LIST}/${encodeURIComponent(id)}${suffix}`;
}

function extractDefinitions(body) {
  if (!isRecord(body)) return null;
  const document = body.document;
  return isNonEmptyString(body.etag) && isRecord(document)
    && isRecord(document.fields) && isRecord(document.vocabularies) && isRecord(document.relations)
    && isRecord(document.structure) ? { envelope: body, document } : null;
}

async function readDefinitions(requestFn) {
  const response = await read(requestFn, DEFINITIONS);
  if (response.status !== 200) return { error: httpFailure(response.status, "definitions_read", response.body) };
  const definitions = extractDefinitions(response.body);
  if (!definitions) return { error: { ok: false, outcome: "partial", reason: "definitions_shape_invalid", httpStatus: 200 } };
  return { ...definitions };
}

function validOpenApiDocument(body) {
  return isRecord(body) && typeof body.openapi === "string" && body.openapi.startsWith("3.")
    && isRecord(body.paths) && Object.keys(body.paths).length > 0
    && isRecord(body.components) && isRecord(body.components.schemas) && Object.keys(body.components.schemas).length > 0;
}

function positiveVersion(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validEntityShape(entity, expectedId) {
  return isRecord(entity) && isNonEmptyString(entity.id) && (expectedId === undefined || entity.id === expectedId)
    && KINDS.includes(entity.kind) && positiveVersion(entity.version) && isNonEmptyString(entity.status);
}

function validRelationShape(relation) {
  return isRecord(relation) && isNonEmptyString(relation.id) && positiveVersion(relation.version)
    && isNonEmptyString(relation.type) && isNonEmptyString(relation.source_id) && isNonEmptyString(relation.target_id)
    && Number.isSafeInteger(relation.position) && relation.position >= 0
    && (relation.attributes === null || isRecord(relation.attributes));
}

function validReleaseToc(body, releaseId) {
  if (!isRecord(body) || !validEntityShape(body.release, releaseId) || body.release.kind !== "release"
    || !Array.isArray(body.media) || !isRecord(body.expressions) || !isNonEmptyString(body.definition_etag)) return false;
  for (const item of body.media) {
    if (!isRecord(item) || !validEntityShape(item.medium) || item.medium.kind !== "medium"
      || item.medium.release_id !== releaseId || !Array.isArray(item.tracks)) return false;
    if (item.tracks.some((track) => !validEntityShape(track) || track.kind !== "track" || track.medium_id !== item.medium.id)) return false;
  }
  for (const [id, expression] of Object.entries(body.expressions)) {
    if (!validEntityShape(expression, id) || expression.kind !== "expression") return false;
  }
  return true;
}

function openApiPathCandidates(pathname) {
  const withoutApi = pathname.startsWith("/api/") ? pathname.slice(4) : pathname;
  return [...new Set([pathname, withoutApi])];
}

function operationRequestSchema(contract, pathname, method, expectedSchema, { payloadField, requireIdempotency = false } = {}) {
  for (const pathKey of openApiPathCandidates(pathname)) {
    const operation = contract.paths[pathKey]?.[method.toLowerCase()];
    if (!isRecord(operation)) continue;
    const requestSchema = operation.requestBody?.content?.["application/json"]?.schema;
    const reference = requestSchema?.$ref;
    const schemaName = typeof reference === "string" ? reference.split("/").at(-1) : null;
    const schema = schemaName ? contract.components.schemas[schemaName] : null;
    const properties = schema?.properties;
    const fieldsPresent = isRecord(properties) && ["expected_version", "edit_note", "sources"]
      .every((key) => has(properties, key));
    const payloadPresent = isRecord(properties) && has(properties, payloadField ?? "entity");
    const idemDeclared = `${operation.summary ?? ""} ${operation.description ?? ""}`.includes("Idempotency-Key");
    if (schemaName !== expectedSchema || !fieldsPresent || !payloadPresent || (requireIdempotency && !idemDeclared)) return null;
    return { path: pathKey, method: method.toLowerCase(), requestSchema: schemaName, summary: operation.summary ?? "" };
  }
  return null;
}

async function readOpenApiContract(requestFn) {
  const response = await read(requestFn, OPENAPI);
  if (response.status !== 200) return { error: httpFailure(response.status, "openapi_read", response.body) };
  if (!validOpenApiDocument(response.body)) {
    return { error: { ok: false, outcome: "partial", reason: "openapi_shape_invalid", httpStatus: 200 } };
  }
  return { contract: response.body };
}

async function checkCreateContract(requestFn, pathname, requestSchema) {
  const loaded = await readOpenApiContract(requestFn);
  if (loaded.error) return loaded;
  const payloadField = pathname.endsWith("/relations") ? "relation" : "entity";
  const operation = operationRequestSchema(loaded.contract, pathname, "post", requestSchema, { payloadField, requireIdempotency: true });
  if (!operation) return { error: { ok: false, outcome: "partial", reason: "create_operation_not_confirmed_by_openapi", path: pathname, requestSchema } };
  return { operation };
}

async function checkOperationContract(requestFn, pathname, method, requestSchema, payloadField) {
  const loaded = await readOpenApiContract(requestFn);
  if (loaded.error) return loaded;
  const operation = operationRequestSchema(loaded.contract, pathname, method, requestSchema, { payloadField });
  if (!operation) return { error: { ok: false, outcome: "partial", reason: "operation_not_confirmed_by_openapi", path: pathname, method, requestSchema } };
  return { operation, contract: loaded.contract };
}

function fieldValueError(value, field, document, fieldPath, { root = false } = {}) {
  if (!isRecord(field) || field.enabled !== true) return { code: "field_disabled_or_missing", path: fieldPath };
  switch (field.type) {
    case "text":
      return typeof value === "string" ? null : { code: "expected_text", path: fieldPath };
    case "multilingual":
      if (!isRecord(value)) return { code: "expected_object", path: fieldPath };
      for (const [locale, text] of Object.entries(value)) {
        if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale) || typeof text !== "string") {
          return { code: "invalid_multilingual_value", path: `${fieldPath}.${locale}` };
        }
      }
      return null;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)
        || (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
        return { code: "invalid_number", path: fieldPath };
      }
      return null;
    case "date":
      if (typeof value !== "string" || !/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(value)) return { code: "invalid_date_shape", path: fieldPath };
      if (value.length === 7 && Number(value.slice(5)) > 12) return { code: "invalid_date_shape", path: fieldPath };
      if (value.length === 10 && Number(value.slice(5, 7)) > 12) return { code: "invalid_date_shape", path: fieldPath };
      if (value.length === 10 && Number(value.slice(8, 10)) > 31) return { code: "invalid_date_shape", path: fieldPath };
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : { code: "expected_boolean", path: fieldPath };
    case "url":
      return validHttpUrl(value) ? null : { code: "invalid_url", path: fieldPath };
    case "enum": {
      if (typeof value !== "string") return { code: "invalid_term", path: fieldPath };
      const terms = document.vocabularies?.[field.vocabulary]?.terms;
      if (!isRecord(terms) || terms[value]?.enabled !== true) return { code: "term_missing_or_disabled", path: fieldPath };
      return null;
    }
    case "entity":
      if (!isNonEmptyString(value)) return { code: "invalid_reference", path: fieldPath };
      return null; // Fixed structural refs are fetched below; dynamic entity refs remain server-validated.
    case "list": {
      if (!Array.isArray(value) || !isRecord(field.items)) return { code: "invalid_list_shape", path: fieldPath };
      for (let index = 0; index < value.length; index += 1) {
        const error = fieldValueError(value[index], field.items, document, `${fieldPath}[${index}]`);
        if (error) return error;
      }
      return null;
    }
    case "group": {
      if (!isRecord(value) || !isRecord(field.fields)) return { code: "invalid_group_shape", path: fieldPath };
      for (const key of Object.keys(value)) {
        if (!has(field.fields, key)) return { code: "unknown_group_field", path: `${fieldPath}.${key}` };
        const error = fieldValueError(value[key], field.fields[key], document, `${fieldPath}.${key}`);
        if (error) return error;
      }
      for (const [key, child] of Object.entries(field.fields)) {
        if (child.required === true && !has(value, key)) return { code: "required_group_field_missing", path: `${fieldPath}.${key}` };
      }
      return null;
    }
    default:
      return { code: "unsupported_field_type", path: fieldPath, fieldType: field.type ?? null };
  }
}

function validateAttributes(attributes, kind, document, { relationFields = null } = {}) {
  if (!isRecord(attributes)) return { code: "invalid_attributes", path: "attributes" };
  for (const [code, value] of Object.entries(attributes)) {
    const field = document.fields?.[code];
    if (!isRecord(field)) return { code: "unknown_field", path: `attributes.${code}` };
    if (field.enabled !== true) return { code: "field_disabled", path: `attributes.${code}` };
    if (relationFields) {
      if (!relationFields.includes(code)) return { code: "field_not_allowed_by_relation", path: `attributes.${code}` };
    } else if (!Array.isArray(field.applicable_kinds) || !field.applicable_kinds.includes(kind)) {
      return { code: "field_not_applicable_to_kind", path: `attributes.${code}` };
    }
    const error = fieldValueError(value, field, document, `attributes.${code}`, { root: true });
    if (error) return error;
  }
  return null;
}

function validateTranslations(translations) {
  if (translations === undefined) return null;
  if (!isRecord(translations)) return "invalid_translations";
  for (const [locale, row] of Object.entries(translations)) {
    if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(locale) || !isRecord(row)
      || Object.keys(row).some((key) => !["title", "summary", "aliases"].includes(key))) return "invalid_translations";
    if (["title", "summary"].some((key) => has(row, key) && typeof row[key] !== "string")
      || (has(row, "aliases") && (!Array.isArray(row.aliases) || row.aliases.some((value) => typeof value !== "string")))) return "invalid_translations";
  }
  return null;
}

async function preflightEntityReferences(entity, structure, requestFn) {
  // Go encodes a nil []StructureRule as JSON null (the field itself is always
  // present). Treat that runtime shape as an explicitly empty rule set, while
  // keeping a missing field or any other shape unknown and fail-closed.
  const rules = has(structure, "fields") && structure.fields === null
    ? []
    : Array.isArray(structure.fields) ? structure.fields : null;
  if (!rules) return { error: { ok: false, outcome: "partial", reason: "structure_contract_unavailable" } };
  const codes = new Set(rules.map((field) => field?.code).filter((code) => typeof code === "string"));
  const structuralKeys = ["work_id", "content_unit_id", "release_id", "medium_id", "parent_id"];
  for (const code of structuralKeys) {
    if (has(entity, code) && !codes.has(code)) {
      return { error: { ok: false, outcome: "rejected", reason: "structural_field_not_declared", field: code } };
    }
  }
  for (const rule of rules) {
    if (rule?.required === true && !isNonEmptyString(entity[rule.code])) {
      return { error: { ok: false, outcome: "rejected", reason: "required_structure_field_missing", field: rule.code } };
    }
    if (!has(entity, rule.code)) continue;
    const id = entity[rule.code];
    if (!isNonEmptyString(id)) return { error: { ok: false, outcome: "rejected", reason: "invalid_structure_reference", field: rule.code } };
    const targetResult = await read(requestFn, entityPath(id));
    if (targetResult.status !== 200) {
      return { error: httpFailure(targetResult.status, `structure_${rule.code}_read`, targetResult.body) };
    }
    if (!validEntityShape(targetResult.body, id)) {
      return { error: { ok: false, outcome: "partial", reason: "structure_reference_entity_shape_invalid", httpStatus: 200, field: rule.code } };
    }
    const allowedKinds = Array.isArray(rule.target_kinds) && rule.target_kinds.length ? rule.target_kinds : [entity.kind];
    if (!allowedKinds.includes(targetResult.body.kind)) {
      return { error: { ok: false, outcome: "rejected", reason: "structure_target_kind_mismatch", field: rule.code, actualKind: targetResult.body.kind } };
    }
    if (rule.scoped_by) {
      const scope = rule.scoped_by;
      if (!isNonEmptyString(entity[scope]) || targetResult.body[scope] !== entity[scope]) {
        return { error: { ok: false, outcome: "rejected", reason: "structure_scope_mismatch", field: rule.code, scopedBy: scope } };
      }
    }
  }
  const capability = structure;
  if (has(entity, "subjects")) {
    if (capability.subjects !== true || entity.kind !== "release" || !Array.isArray(entity.subjects)) {
      return { error: { ok: false, outcome: "rejected", reason: "subjects_not_declared_for_kind" } };
    }
  }
  if (has(entity, "contents")) {
    return { error: { ok: false, outcome: "rejected", reason: "track_contents_require_specialized_helper" } };
  }
  return { rules };
}

async function preflightSubjects(entity, structure, document, requestFn) {
  if (!has(entity, "subjects")) return { ok: true };
  if (structure.subjects !== true || entity.kind !== "release" || !Array.isArray(entity.subjects)) {
    return { ok: false, outcome: "rejected", reason: "subjects_not_declared_for_kind" };
  }
  const terms = document.vocabularies?.release_role?.terms;
  if (!isRecord(terms)) return { ok: false, outcome: "partial", reason: "release_role_vocabulary_unavailable" };
  const seen = new Set();
  for (const subject of entity.subjects) {
    if (!isRecord(subject) || Object.keys(subject).some((key) => !["work_id", "role", "position", "attributes"].includes(key))
      || !isNonEmptyString(subject.work_id) || !isNonEmptyString(subject.role)
      || !Number.isSafeInteger(subject.position) || subject.position < 0 || !terms[subject.role]?.enabled
      || (subject.attributes !== undefined && !isRecord(subject.attributes))) {
      return { ok: false, outcome: "rejected", reason: "invalid_subject_or_disabled_role" };
    }
    const key = `${subject.work_id}|${subject.role}`;
    if (seen.has(key)) return { ok: false, outcome: "rejected", reason: "duplicate_subject" };
    seen.add(key);
    const work = await read(requestFn, entityPath(subject.work_id));
    if (work.status !== 200) {
      return { ...httpFailure(work.status, "subject_work_read", work.body), field: "subjects.work_id" };
    }
    if (!validEntityShape(work.body, subject.work_id)) {
      return { ok: false, outcome: "partial", reason: "subject_work_entity_shape_invalid", httpStatus: 200, field: "subjects.work_id" };
    }
    if (work.body.kind !== "work") {
      return { ok: false, outcome: "rejected", reason: "subject_work_kind_mismatch", field: "subjects.work_id", actualKind: work.body.kind };
    }
  }
  return { ok: true };
}

async function entityCreatePreflight(plan, requestFn) {
  const kind = plan.entity.kind;
  if (!KINDS.includes(kind)) return { error: { ok: false, outcome: "rejected", reason: "unknown_entity_kind" } };
  const contract = await checkCreateContract(requestFn, ENTITY_LIST, "Edit");
  if (contract.error) return { error: contract.error };
  const defsResult = await readDefinitions(requestFn);
  if (defsResult.error) return { error: defsResult.error };
  const { document } = defsResult;
  let structure = document.structure[kind];
  // Agent, Collection, and Work have no structural reference fields in the
  // fixed entity model. The live definitions omit their structure sections;
  // treat those omissions as an explicitly empty structure contract.
  if (!isRecord(structure) && ["agent", "collection", "work"].includes(kind)) {
    structure = { fields: null };
  }
  if (!isRecord(structure)) return { error: { ok: false, outcome: "partial", reason: "kind_structure_definition_missing" } };
  const entity = cloneJson(plan.entity);
  entity.id = "";
  entity.status = "draft";
  if (Object.keys(entity).some((key) => ["created_by", "redirect_id", "updated_at", "version"].includes(key))) {
    return { error: { ok: false, outcome: "rejected", reason: "server_managed_entity_field" } };
  }
  if (has(entity, "contents")) return { error: { ok: false, outcome: "rejected", reason: "track_contents_require_specialized_helper" } };
  const translationError = validateTranslations(entity.translations);
  if (translationError) return { error: { ok: false, outcome: "rejected", reason: translationError } };
  const attributeError = validateAttributes(entity.attributes ?? {}, kind, document);
  if (attributeError) return { error: { ok: false, outcome: "rejected", ...attributeError } };
  const structural = await preflightEntityReferences(entity, structure, requestFn);
  if (structural.error) return { error: structural.error };
  const subjectCheck = await preflightSubjects(entity, structure, document, requestFn);
  if (!subjectCheck.ok) return { error: subjectCheck };
  return { entity, document, structure, definitions: defsResult.envelope, operation: contract.operation };
}

function visibleCandidate(item) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    status: item.status,
    version: item.version,
    work_id: item.work_id ?? null,
    content_unit_id: item.content_unit_id ?? null,
    release_id: item.release_id ?? null,
    medium_id: item.medium_id ?? null,
    parent_id: item.parent_id ?? null,
  };
}

function identityCandidateInputs(entity) {
  const titles = [entity.title];
  for (const row of Object.values(entity.translations ?? {})) {
    if (!isRecord(row)) continue;
    if (typeof row.title === "string") titles.push(row.title);
    if (Array.isArray(row.aliases)) titles.push(...row.aliases.filter((value) => typeof value === "string"));
  }
  const externalIds = Object.entries(entity.external_ids ?? {})
    .filter(([, value]) => typeof value === "string" && value.trim())
    .map(([provider, value]) => ({ provider, value }));
  const attributes = [];
  for (const key of IDENTITY_ATTRS) {
    const value = entity.attributes?.[key];
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (["string", "number", "boolean"].includes(typeof item) && String(item).trim()) {
        attributes.push({ key, value: String(item) });
      }
    }
  }
  return {
    kind: entity.kind,
    titles: [...new Set(titles.map((value) => value.trim()).filter(Boolean))],
    externalIds,
    attributes,
    ...(entity.kind === "expression" && isNonEmptyString(entity.work_id) ? { workId: entity.work_id } : {}),
  };
}

function sameIds(left, right) {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((id, index) => id === sortedRight[index]);
}

async function createEntity(plan, { apply, requestFn, findIdentityFn = findIdentity }) {
  const preflight = await entityCreatePreflight(plan, requestFn);
  if (preflight.error) return preflight.error;
  const { entity } = preflight;
  let identityReport;
  try {
    identityReport = await findIdentityFn({ ...identityCandidateInputs(entity), requestFn });
  } catch (error) {
    return { ok: false, outcome: "unknown", reason: "identity_candidate_check_failed", detail: String(error?.message ?? ""), applied: false };
  }
  if (!isRecord(identityReport) || !isRecord(identityReport.coverage) || !Array.isArray(identityReport.candidates)
    || !Array.isArray(identityReport.unknown) || !Array.isArray(identityReport.errors)) {
    return { ok: false, outcome: "partial", reason: "identity_candidate_report_shape_invalid", applied: false };
  }
  if (identityReport.coverage.complete !== true || identityReport.unknown.length || identityReport.errors.length) {
    const unknownStatus = identityReport.unknown.map((item) => item?.status).find((status) => [401, 403, 404].includes(status));
    const outcome = unknownStatus ? statusOutcome(unknownStatus)
      : identityReport.unknown.some((item) => item?.status === 0 || item?.status >= 500) ? "unknown" : "partial";
    return {
      ok: false, outcome, reason: "identity_candidate_check_incomplete_or_unresolved", applied: false,
      coverage: identityReport.coverage, candidates: identityReport.candidates, unknown: identityReport.unknown, errors: identityReport.errors,
      visibilityScope: "current caller-visible entities only; unknown canonical identity or incomplete coverage blocks creation",
    };
  }
  if (identityReport.candidates.some((candidate) => candidate?.canonical_verified !== true || !isNonEmptyString(candidate.canonical_id))) {
    return { ok: false, outcome: "unknown", reason: "canonical_candidate_unverified", applied: false, candidates: identityReport.candidates };
  }
  const candidateIds = identityReport.candidates.map((candidate) => candidate.canonical_id);
  const candidateSummaries = identityReport.candidates;
  const reviewedIds = plan.duplicate_check.reviewed_candidate_ids;
  if (!sameIds(candidateIds, reviewedIds) || (candidateIds.length > 0 && plan.duplicate_check.candidate_decision !== "distinct")) {
    return {
      ok: false, outcome: "review_required", reason: "canonical_candidate_set_changed_or_not_reviewed", applied: false,
      candidates: candidateSummaries,
      candidateIds,
      queryModes: identityReport.query_modes,
      visibilityScope: "current caller-visible results only; absent candidates do not prove no duplicate exists elsewhere",
    };
  }
  const preview = {
    ok: true,
    outcome: apply ? "ready" : "preview",
    applied: false,
    operation: "POST /api/catalog/entities",
    request: {
      method: "POST",
      path: ENTITY_LIST,
      headers: { "Idempotency-Key": plan.idempotency_key },
      body: { entity, expected_version: 0, edit_note: plan.edit_note.trim(), sources: plan.sources },
    },
    duplicateCheck: {
      strategy: "mf-find-identity normalized title/translations/aliases, exact external IDs, and known identity attributes; candidates resolved to canonical IDs",
      queryModes: identityReport.query_modes,
      visibilityScope: "current caller-visible results only; absent candidates do not prove no duplicate exists elsewhere",
      reviewedCandidateIds: candidateIds,
      coverage: identityReport.coverage,
    },
    serverValidation: "definitions shape preflight is intentionally partial; the server remains authoritative",
  };
  if (!apply) return preview;

  let write;
  try {
    write = await requestFn(ENTITY_LIST, {
      method: "POST",
      tries: 1,
      idempotencyKey: plan.idempotency_key,
      body: { entity, expected_version: 0, edit_note: plan.edit_note.trim(), sources: cloneJson(plan.sources) },
    });
  } catch {
    return { ok: false, outcome: "unknown", reason: "create_result_unknown_do_not_retry", applied: null, idempotencyKey: plan.idempotency_key };
  }
  const status = Number.isInteger(write?.status) ? write.status : 0;
  if (status === 409) return { ok: false, outcome: "conflict", reason: write?.body?.error ?? "create_conflict_no_retry", httpStatus: status, applied: false };
  if (status === 0 || status >= 500) {
    return { ok: false, outcome: "unknown", reason: "create_result_unknown_do_not_retry", httpStatus: status, applied: null, idempotencyKey: plan.idempotency_key };
  }
  if (status < 200 || status >= 300) return { ...httpFailure(status, "entity_create", write?.body), applied: false };
  const created = write.body;
  if (!validEntityShape(created) || created.kind !== entity.kind) {
    return { ok: false, outcome: "partial", reason: "create_response_entity_shape_invalid", httpStatus: status, applied: true, response: created ?? null };
  }
  const entityRead = await read(requestFn, entityPath(created.id));
  if (entityRead.status !== 200 || !validEntityShape(entityRead.body, created.id)) {
    return { ok: false, outcome: "partial", reason: "created_entity_readback_unavailable", httpStatus: status, readbackStatus: entityRead.status, applied: true, id: created.id };
  }
  const after = entityRead.body;
  const requestedKeys = Object.keys(entity).filter((key) => key !== "id");
  const requestedFieldsMatch = after.id === created.id && after.kind === entity.kind && requestedKeys.every((key) => same(after[key], entity[key]));
  const responseMatchesReadback = same(writableEntity(created), writableEntity(after));
  const responseVersionMatches = positiveVersion(created.version) && created.version === after.version;
  const revisionsRead = await read(requestFn, entityPath(created.id, "/revisions"));
  let revisionCheck = { ok: false, reason: "revision_unavailable", status: revisionsRead.status };
  if (revisionsRead.status === 200 && Array.isArray(revisionsRead.body?.items)) {
    const currentRevisions = revisionsRead.body.items.filter((revision) => revision?.version === after.version);
    if (currentRevisions.length === 1) {
      const revision = currentRevisions[0];
      revisionCheck = {
        ok: isRevisionId(revision.id) && positiveVersion(revision.version) && isRecord(revision.snapshot)
          && validEntityShape(revision.snapshot, after.id) && revision.snapshot.version === revision.version
          && same(writableEntity(revision.snapshot), writableEntity(after))
          && same(revision.sources, plan.sources),
        idPresent: isRevisionId(revision.id),
        version: revision.version,
        matchesCurrentEntity: isRecord(revision.snapshot) && validEntityShape(revision.snapshot, after.id)
          && same(writableEntity(revision.snapshot), writableEntity(after)),
        sourcesMatch: same(revision.sources, plan.sources),
      };
    } else {
      revisionCheck = { ok: false, reason: "current_version_revision_missing_or_ambiguous", version: after.version };
    }
  }
  const verified = requestedFieldsMatch && responseMatchesReadback && responseVersionMatches && revisionCheck.ok;
  return {
    ok: verified,
    outcome: verified ? "verified" : "partial",
    reason: verified ? undefined : "create_readback_not_fully_verified",
    applied: true,
    httpStatus: status,
    id: created.id,
    version: after.version,
    requestedFieldsMatch,
    responseMatchesReadback,
    responseVersionMatches,
    revisionCheck,
    entity: after,
  };
}

function allowedRelationValue(code, value, relationDefinition, document) {
  const relationFields = Array.isArray(relationDefinition.fields) ? relationDefinition.fields : [];
  return validateAttributes({ [code]: value }, "", document, { relationFields });
}

async function relationEndpoints(plan, definition, requestFn) {
  const [sourceResult, targetResult] = await Promise.all([
    read(requestFn, entityPath(plan.relation.source_id)),
    read(requestFn, entityPath(plan.relation.target_id)),
  ]);
  for (const [side, result] of [["source", sourceResult], ["target", targetResult]]) {
    const id = plan.relation[`${side}_id`];
    if (result.status !== 200) {
      return { error: httpFailure(result.status, `relation_${side}_entity_read`, result.body) };
    }
    if (!validEntityShape(result.body, id)) {
      return { error: { ok: false, outcome: "partial", reason: `relation_${side}_entity_shape_invalid`, httpStatus: 200 } };
    }
  }
  const sourceKinds = Array.isArray(definition.source_kinds) ? definition.source_kinds : [];
  const targetKinds = Array.isArray(definition.target_kinds) ? definition.target_kinds : [];
  if (!sourceKinds.includes(sourceResult.body.kind) || !targetKinds.includes(targetResult.body.kind)) {
    return { error: { ok: false, outcome: "rejected", reason: "relation_endpoint_kind_mismatch", direction: {
      sourceKinds, targetKinds, actualSourceKind: sourceResult.body.kind, actualTargetKind: targetResult.body.kind,
    } } };
  }
  return { source: sourceResult.body, target: targetResult.body };
}

async function relationLists(sourceId, targetId, requestFn) {
  const [sourceResult, targetResult] = await Promise.all([
    read(requestFn, entityPath(sourceId, "/relations")),
    read(requestFn, entityPath(targetId, "/relations")),
  ]);
  for (const [side, result] of [["source", sourceResult], ["target", targetResult]]) {
    if (result.status !== 200) return { error: httpFailure(result.status, `relation_${side}_list`, result.body) };
    if (!Array.isArray(result.body?.items)) return { error: { ok: false, outcome: "partial", reason: `relation_${side}_list_shape_invalid`, httpStatus: 200 } };
  }
  return { sourceItems: sourceResult.body.items, targetItems: targetResult.body.items };
}

function relationMatchesPlan(relation, plan) {
  return relation?.type === plan.relation.type && relation?.source_id === plan.relation.source_id
    && relation?.target_id === plan.relation.target_id
    && same(relation?.attributes ?? {}, plan.relation.attributes ?? {})
    && (plan.relation.position === undefined || relation?.position === plan.relation.position);
}

async function relationCreatePreflight(plan, requestFn) {
  const contract = await checkCreateContract(requestFn, `${API}/catalog/relations`, "RelationEdit");
  if (contract.error) return { error: contract.error };
  const defsResult = await readDefinitions(requestFn);
  if (defsResult.error) return { error: defsResult.error };
  const definition = defsResult.document.relations?.[plan.relation.type];
  if (!isRecord(definition) || definition.enabled !== true) return { error: { ok: false, outcome: "rejected", reason: "relation_missing_or_disabled" } };
  const attributes = plan.relation.attributes ?? {};
  const allowedFields = Array.isArray(definition.fields) ? definition.fields : [];
  for (const [code, value] of Object.entries(attributes)) {
    if (!allowedFields.includes(code)) return { error: { ok: false, outcome: "rejected", reason: "relation_attribute_not_allowed", field: code } };
    const fieldError = allowedRelationValue(code, value, definition, defsResult.document);
    if (fieldError) return { error: { ok: false, outcome: "rejected", ...fieldError } };
  }
  const endpoints = await relationEndpoints(plan, definition, requestFn);
  if (endpoints.error) return { error: endpoints.error };
  const edges = await relationLists(plan.relation.source_id, plan.relation.target_id, requestFn);
  if (edges.error) return { error: edges.error };
  const exactExisting = [...edges.sourceItems, ...edges.targetItems]
    .filter((relation) => relationMatchesPlan(relation, plan));
  const existingIds = [...new Set(exactExisting.map((relation) => relation.id).filter(isNonEmptyString))];
  if (existingIds.length) return { error: { ok: false, outcome: "conflict", reason: "exact_relation_already_visible", existingRelationIds: existingIds } };
  return { document: defsResult.document, definition, source: endpoints.source, target: endpoints.target, operation: contract.operation };
}

async function createRelation(plan, { apply, requestFn }) {
  const preflight = await relationCreatePreflight(plan, requestFn);
  if (preflight.error) return preflight.error;
  const relation = {
    id: "",
    type: plan.relation.type,
    source_id: plan.relation.source_id,
    target_id: plan.relation.target_id,
    position: plan.relation.position ?? 0,
    attributes: cloneJson(plan.relation.attributes ?? {}),
  };
  const body = { relation, expected_version: 0, edit_note: plan.edit_note.trim(), sources: cloneJson(plan.sources) };
  const preview = {
    ok: true, outcome: apply ? "ready" : "preview", applied: false,
    operation: "POST /api/catalog/relations",
    direction: {
      type: relation.type,
      source: { id: preflight.source.id, kind: preflight.source.kind },
      target: { id: preflight.target.id, kind: preflight.target.kind },
      definition: { source_kinds: preflight.definition.source_kinds, target_kinds: preflight.definition.target_kinds },
    },
    request: {
      method: "POST", path: `${API}/catalog/relations`,
      headers: { "Idempotency-Key": plan.idempotency_key }, body,
    },
    serverValidation: "relationship rules, cross-field constraints, and authorization remain server-authoritative",
  };
  if (!apply) return preview;

  let write;
  try {
    write = await requestFn(`${API}/catalog/relations`, {
      method: "POST", tries: 1, idempotencyKey: plan.idempotency_key, body,
    });
  } catch {
    return { ok: false, outcome: "unknown", reason: "relation_create_result_unknown_do_not_retry", applied: null, idempotencyKey: plan.idempotency_key };
  }
  const status = Number.isInteger(write?.status) ? write.status : 0;
  if (status === 409) return { ok: false, outcome: "conflict", reason: write?.body?.error ?? "relation_create_conflict_no_retry", httpStatus: status, applied: false };
  if (status === 0 || status >= 500) {
    return { ok: false, outcome: "unknown", reason: "relation_create_result_unknown_do_not_retry", httpStatus: status, applied: null, idempotencyKey: plan.idempotency_key };
  }
  if (status < 200 || status >= 300) return { ...httpFailure(status, "relation_create", write?.body), applied: false };
  const created = write.body;
  if (!validRelationShape(created)) {
    return { ok: false, outcome: "partial", reason: "relation_create_response_shape_invalid", httpStatus: status, applied: true };
  }
  const createdMatchesRequest = created.type === relation.type && created.source_id === relation.source_id
    && created.target_id === relation.target_id && created.position === relation.position
    && same(created.attributes ?? {}, relation.attributes);
  if (!createdMatchesRequest) {
    return { ok: false, outcome: "partial", reason: "relation_create_response_differs_from_request", httpStatus: status, applied: true, id: created.id };
  }
  const edges = await relationLists(relation.source_id, relation.target_id, requestFn);
  if (edges.error) return { ok: false, outcome: "partial", reason: "relation_readback_unavailable", applied: true, httpStatus: status, id: created.id, detail: edges.error };
  const visibleSource = edges.sourceItems.filter((item) => item?.id === created.id);
  const visibleTarget = edges.targetItems.filter((item) => item?.id === created.id);
  const exact = (item) => validRelationShape(item) && item.id === created.id && item.version === created.version
    && item.type === created.type && item.source_id === created.source_id && item.target_id === created.target_id
    && item.position === created.position && same(item.attributes ?? {}, created.attributes ?? {});
  const sourceOk = visibleSource.length === 1 && exact(visibleSource[0]);
  const targetOk = visibleTarget.length === 1 && exact(visibleTarget[0]);
  const versionMatches = positiveVersion(created.version) && sourceOk && targetOk
    && visibleSource[0].version === created.version && visibleTarget[0].version === created.version;
  const verified = sourceOk && targetOk && versionMatches;
  return {
    ok: verified, outcome: verified ? "readback_verified" : "partial", reason: verified ? undefined : "relation_readback_not_fully_verified",
    applied: true, httpStatus: status, id: created.id, version: created.version ?? null,
    sourceReadback: sourceOk, targetReadback: targetOk, versionMatches, relation: created,
    sourcePersistence: "not_independently_verified; relation reads do not expose revision evidence",
    verificationScope: "returned relation compared with both endpoint relation lists, including persisted version",
  };
}

async function runReadPlan(plan, requestFn) {
  const { action } = plan;
  if (action === "entity.list") {
    let collected;
    try {
      collected = await collectPages(ENTITY_LIST, { params: plan.params ?? {}, limit: plan.limit ?? 100, requestFn });
    } catch (error) {
      return { ok: false, outcome: "rejected", reason: "list_plan_invalid", detail: String(error?.message ?? "") };
    }
    return collected.coverage.complete
      ? { ok: true, outcome: "complete", items: collected.items, coverage: collected.coverage, visibilityScope: "current caller-visible results" }
      : {
        ok: false,
        outcome: collected.coverage.failures.some((failure) => [401, 403, 404].includes(failure.status))
          ? statusOutcome(collected.coverage.failures.find((failure) => [401, 403, 404].includes(failure.status)).status)
          : "partial",
        reason: "list_coverage_incomplete", items: collected.items, coverage: collected.coverage,
        visibilityScope: "current caller-visible results",
      };
  }
  let pathname;
  switch (action) {
    case "entity.get": pathname = entityPath(plan.id); break;
    case "entity.resolve": pathname = entityPath(plan.id, "/resolve"); break;
    case "entity.relations": pathname = entityPath(plan.id, "/relations"); break;
    case "entity.occurrences": pathname = entityPath(plan.id, "/occurrences"); break;
    case "release.toc": pathname = `${API}/catalog/releases/${encodeURIComponent(plan.id)}/toc`; break;
    case "definitions": pathname = DEFINITIONS; break;
    case "contract": pathname = OPENAPI; break;
    case "entity.current-revision": {
      const currentResult = await read(requestFn, entityPath(plan.id));
      if (currentResult.status !== 200) return httpFailure(currentResult.status, "entity_read", currentResult.body);
      if (!validEntityShape(currentResult.body, plan.id)) return { ok: false, outcome: "partial", reason: "entity_shape_invalid", httpStatus: 200 };
      const revisionsResult = await read(requestFn, entityPath(plan.id, "/revisions"));
      if (revisionsResult.status !== 200) return httpFailure(revisionsResult.status, "revisions_read", revisionsResult.body);
      if (!Array.isArray(revisionsResult.body?.items)) return { ok: false, outcome: "partial", reason: "revisions_shape_invalid" };
      const matches = revisionsResult.body.items.filter((revision) => revision?.version === currentResult.body.version);
      if (matches.length !== 1) return { ok: false, outcome: "partial", reason: "current_version_revision_missing_or_ambiguous", currentVersion: currentResult.body.version };
      const revision = matches[0];
      if (!isRevisionId(revision.id) || !positiveVersion(revision.version) || !isRecord(revision.snapshot)
        || !validEntityShape(revision.snapshot, plan.id) || revision.snapshot.version !== revision.version) {
        return { ok: false, outcome: "partial", reason: "current_revision_shape_invalid", currentVersion: currentResult.body.version };
      }
      return { ok: true, outcome: "complete", entity: currentResult.body, revision, selectedBy: "revision.version === entity.version" };
    }
    default: return { ok: false, outcome: "rejected", reason: "unsupported_read_action" };
  }
  const response = await read(requestFn, pathname);
  if (response.status !== 200) return httpFailure(response.status, action.replaceAll(".", "_"), response.body);
  if (action === "definitions") {
    const definitions = extractDefinitions(response.body);
    return definitions
      ? { ok: true, outcome: "complete", data: definitions.envelope }
      : { ok: false, outcome: "partial", reason: "definitions_shape_invalid", httpStatus: 200 };
  }
  if (action === "contract") {
    return validOpenApiDocument(response.body)
      ? { ok: true, outcome: "complete", data: response.body }
      : { ok: false, outcome: "partial", reason: "openapi_shape_invalid", httpStatus: 200 };
  }
  if (action === "entity.get" && !validEntityShape(response.body, plan.id)) {
    return { ok: false, outcome: "partial", reason: "entity_shape_invalid", httpStatus: 200 };
  }
  if (action === "entity.resolve" && (!validEntityShape(response.body) || response.body.status === "merged" || response.body.redirect_id)) {
    return { ok: false, outcome: "partial", reason: "canonical_identity_shape_invalid", httpStatus: 200 };
  }
  if (action === "release.toc" && !validReleaseToc(response.body, plan.id)) {
    return { ok: false, outcome: "partial", reason: "release_toc_shape_invalid", httpStatus: 200 };
  }
  if (["entity.relations", "entity.occurrences"].includes(action) && !Array.isArray(response.body?.items)) {
    return { ok: false, outcome: "partial", reason: "response_items_shape_invalid", httpStatus: 200 };
  }
  if (action === "entity.relations" && response.body.items.some((relation) => !validRelationShape(relation))) {
    return { ok: false, outcome: "partial", reason: "relation_items_shape_invalid", httpStatus: 200 };
  }
  if (action === "entity.occurrences" && response.body.items.some((item) => !isRecord(item))) {
    return { ok: false, outcome: "partial", reason: "occurrence_items_shape_invalid", httpStatus: 200 };
  }
  return { ok: true, outcome: "complete", data: response.body, visibilityScope: "current caller-visible response" };
}

export async function runPlan(plan, { apply = false, requestFn = apiRequest, findIdentityFn = findIdentity } = {}) {
  const validationError = validatePlan(plan);
  if (validationError) return { ok: false, outcome: "rejected", reason: validationError, applied: false };
  if (typeof requestFn !== "function") return { ok: false, outcome: "rejected", reason: "invalid_request_function", applied: false };
  if (READ_ACTIONS.includes(plan.action)) return runReadPlan(plan, requestFn);
  if (plan.action === "entity.create") return createEntity(plan, { apply, requestFn, findIdentityFn });
  if (plan.action === "relation.create") return createRelation(plan, { apply, requestFn });
  if (plan.action === "entity.update") {
    const contract = await checkOperationContract(requestFn, `${ENTITY_LIST}/{id}`, "put", "Edit", "entity");
    if (contract.error) return contract.error;
    return guardedUpdate(plan.plan, { apply, requestFn, contract: contract.contract });
  }
  if (plan.action === "track-content.add") return addTrackContent({ plan: plan.plan, apply, requestFn });
  return { ok: false, outcome: "rejected", reason: "unsupported_action", applied: false };
}

export function helpText() {
  return [
    "MetaFusion 白名单平台操作入口",
    "",
    "用法:",
    "  node mf-platform.mjs help",
    "  node mf-platform.mjs list",
    "  node mf-platform.mjs schema [action]",
    "  node mf-platform.mjs --plan <plan.json> [--apply] [--out <result.json>]",
    "",
    "写计划默认只预览；--apply 只是执行开关，不代表平台授权，且必须提供 --out。--out 只创建新文件，不覆盖已有文件。写请求单次发送，不自动重试；结果不明时停止并回报 unknown。",
    "definitions 仅提供只读读取；词表/定义写入使用专职 mf-definitions 工具。",
    "Track.contents 写入仅经 mf-track-content；entity.update 仅允许 Track.status 专用 PATCH，整实体 PUT 仍拒绝。",
    "不提供任意 HTTP、PUT、DELETE、lifecycle 或文件上传入口。",
    "列表和查重结果只覆盖当前调用者可见范围；mf-find-identity 的标题/译名/别名、外部 ID 与身份属性命中只产生候选，canonical 候选需逐项确认 distinct，不自动认定身份。",
    "",
    "用 schema 命令查看每个动作的 JSON plan schema。",
  ].join("\n");
}

function parseCli(argv) {
  if (argv.length === 0 || argv.length === 1 && ["help", "--help", "-h"].includes(argv[0])) return { command: "help" };
  if (argv.length === 1 && argv[0] === "list") return { command: "list" };
  if (argv[0] === "schema" || argv[0] === "--schema") {
    if (argv.length > 2) throw new Error("invalid_cli_args");
    return { command: "schema", action: argv[1] };
  }
  let planPath;
  let outPath;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--plan" && planPath === undefined && argv[index + 1]) {
      planPath = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--apply" && !apply) {
      apply = true;
    } else if (argv[index] === "--out" && outPath === undefined && argv[index + 1]) {
      outPath = argv[index + 1];
      index += 1;
    } else {
      throw new Error("invalid_cli_args");
    }
  }
  if (!planPath) throw new Error("plan_required");
  if (apply && !outPath) {
    const error = new Error("apply_requires_out");
    error.code = "apply_requires_out";
    throw error;
  }
  return { command: "plan", planPath, apply, outPath };
}

function reserveOutputFile(filePath) {
  const fd = fs.openSync(path.resolve(filePath), "wx");
  try {
    fs.writeSync(fd, "{\"state\":\"pending\"}\n", 0, "utf8");
    fs.fsyncSync(fd);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function finishOutputFile(fd, result) {
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  fs.ftruncateSync(fd, 0);
  fs.writeSync(fd, serialized, 0, "utf8");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}

export async function runCli(argv = process.argv.slice(2), {
  stdout = process.stdout,
  stderr = process.stderr,
  requestFn = apiRequest,
} = {}) {
  let options;
  try {
    options = parseCli(argv);
  } catch (error) {
    const reason = error?.code === "apply_requires_out" ? "apply_requires_out" : "invalid_cli_args";
    stderr.write(`${JSON.stringify({ ok: false, outcome: "rejected", reason })}\n`);
    return { exitCode: 2 };
  }
  if (options.command === "help") {
    stdout.write(`${helpText()}\n`);
    return { exitCode: 0 };
  }
  if (options.command === "list") {
    stdout.write(`${JSON.stringify(listOperations(), null, 2)}\n`);
    return { exitCode: 0 };
  }
  if (options.command === "schema") {
    const schema = schemaFor(options.action);
    if (!schema) {
      stderr.write(`${JSON.stringify({ ok: false, outcome: "rejected", reason: "unknown_action" })}\n`);
      return { exitCode: 2 };
    }
    stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
    return { exitCode: 0 };
  }
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(path.resolve(options.planPath), "utf8"));
  } catch {
    stderr.write(`${JSON.stringify({ ok: false, outcome: "rejected", reason: "plan_read_or_json_error" })}\n`);
    return { exitCode: 2 };
  }
  const validationError = validatePlan(plan);
  if (validationError) {
    const result = { ok: false, outcome: "rejected", reason: validationError, applied: false };
    stderr.write(`${JSON.stringify(result)}\n`);
    return { exitCode: 1, result };
  }
  if (options.apply && !["entity.create", "entity.update", "track-content.add", "relation.create"].includes(plan.action)) {
    const result = { ok: false, outcome: "rejected", reason: "apply_not_supported_for_read_action", applied: false };
    stderr.write(`${JSON.stringify(result)}\n`);
    return { exitCode: 1, result };
  }
  let outputFd = null;
  if (options.outPath) {
    try {
      outputFd = reserveOutputFile(options.outPath);
    } catch {
      stderr.write(`${JSON.stringify({ ok: false, outcome: "rejected", reason: "out_reservation_failed" })}\n`);
      return { exitCode: 2 };
    }
  }
  let result;
  try {
    result = await runPlan(plan, { apply: options.apply, requestFn });
  } catch {
    result = {
      ok: false, outcome: options.apply ? "unknown" : "rejected",
      reason: options.apply ? "plan_result_unknown_do_not_retry" : "plan_execution_failed",
      applied: options.apply ? null : false,
    };
  }
  if (outputFd !== null) {
    try {
      finishOutputFile(outputFd, result);
    } catch {
      try { fs.closeSync(outputFd); } catch { /* already closed */ }
      stderr.write(`${JSON.stringify({ ok: false, outcome: "partial", reason: "result_file_write_failed", result })}\n`);
      return { exitCode: 2, result };
    }
  }
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return { exitCode: result.ok ? 0 : 1, result };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { exitCode } = await runCli();
  process.exitCode = exitCode;
}
