import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PLAN_SCHEMA,
  listOperations,
  runCli,
  runPlan,
  schemaFor,
  validatePlan,
} from "./mf-platform.mjs";

const sources = [{ kind: "url", citation: "官方页面确认该作品", url: "https://example.test/item" }];

function definitions({ fields = {}, relations = {}, structure = { work: { fields: null, subjects: false, contents: false } }, vocabularies = {} } = {}) {
  return {
    etag: "defs-test",
    document: {
      fields,
      vocabularies: { release_role: { terms: { primary: { enabled: true } } }, ...vocabularies },
      relations,
      structure,
    },
  };
}

function openApiOperation(schemaName, summary = "Operation with Idempotency-Key") {
  return {
    summary,
    requestBody: { content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaName}` } } } },
  };
}

function openApiContract() {
  const editProperties = { entity: { type: "object" }, expected_version: { type: "integer" }, edit_note: { type: "string" }, sources: { type: "array" } };
  const relationProperties = { relation: { type: "object" }, expected_version: { type: "integer" }, edit_note: { type: "string" }, sources: { type: "array" } };
  return {
    openapi: "3.0.3",
    paths: {
      "/catalog/entities": { post: openApiOperation("Edit", "Create entity with Idempotency-Key") },
      "/catalog/relations": { post: openApiOperation("RelationEdit", "Create relation with Idempotency-Key") },
      "/catalog/entities/{id}": { put: openApiOperation("Edit", "Update entity") },
      "/catalog/tracks/{id}/contents": { post: openApiOperation("TrackContentEdit", "Add track content") },
      "/api/catalog/tracks/{id}/contents": { post: openApiOperation("TrackContentEdit", "Add track content") },
      "/catalog/tracks/{id}/status": { patch: openApiOperation("TrackStatusEdit", "Edit track status without changing contents") },
    },
    components: { schemas: {
      Edit: { type: "object", properties: editProperties },
      RelationEdit: { type: "object", properties: relationProperties },
      TrackContentEdit: { type: "object", properties: { inclusion: { type: "object" }, expected_version: { type: "integer" }, edit_note: { type: "string" }, sources: { type: "array" } } },
      TrackStatusEdit: { type: "object", additionalProperties: false, required: ["status", "expected_version", "edit_note", "sources"], properties: {
        status: { type: "string", enum: ["draft", "pending_review", "published"] }, expected_version: { type: "integer", minimum: 1 },
        edit_note: { type: "string" }, sources: { type: "array" },
      } },
    } },
  };
}

function mockRequest(handler, { openapiBody = openApiContract() } = {}) {
  const calls = [];
  const requestFn = async (pathname, options = {}) => {
    calls.push({ pathname, options });
    if (pathname === "/api/openapi.json") return { status: 200, body: openapiBody };
    return handler(pathname, options, calls);
  };
  return { requestFn, calls };
}

function createPlan(overrides = {}) {
  return {
    action: "entity.create",
    entity: { kind: "work", title: "New work" },
    edit_note: "根据官方页面建立作品",
    sources,
    idempotency_key: "mf-test-create-001",
    duplicate_check: { visibility: "caller_visible_only", reviewed_candidate_ids: [] },
    ...overrides,
  };
}

function relationPlan(overrides = {}) {
  return {
    action: "relation.create",
    relation: { type: "adaptation_of", source_id: "work-a", target_id: "work-b", attributes: {} },
    edit_note: "官方资料说明改编关系",
    sources,
    idempotency_key: "mf-test-relation-001",
    ...overrides,
  };
}

function parseUrl(pathname) {
  return new URL(pathname, "https://mock.invalid");
}

test("help and schema commands are offline and list only the fixed operation allowlist", async () => {
  let output = "";
  let requestCount = 0;
  const io = {
    stdout: { write: (value) => { output += value; } },
    stderr: { write: (value) => { output += value; } },
    requestFn: async () => { requestCount += 1; throw new Error("unexpected network request"); },
  };
  const help = await runCli(["help"], io);
  assert.equal(help.exitCode, 0);
  assert.match(output, /mf-definitions/);
  assert.equal(requestCount, 0);

  output = "";
  const listed = await runCli(["list"], io);
  assert.equal(listed.exitCode, 0);
  const actions = JSON.parse(output).map((entry) => entry.action);
  assert.ok(actions.includes("entity.create"));
  assert.ok(actions.includes("relation.create"));
  assert.ok(!actions.some((action) => /delete|lifecycle|upload|definitions\.update/i.test(action)));
  assert.match(helpTextForTest(), /--out/);
  assert.equal(requestCount, 0);
});

test("schema exports match the delegated guarded and track-content plan envelopes", () => {
  assert.equal(validatePlan({ action: "entity.create", method: "PUT" }), "invalid_plan");
  assert.deepEqual(schemaFor("entity.update").required, ["action", "plan"]);
  assert.deepEqual(schemaFor("track-content.add").required, ["action", "plan"]);
  assert.equal(PLAN_SCHEMA.oneOf.length, listOperations().length);
  assert.ok(schemaFor("entity.create").properties.sources.contains);
  assert.ok(PLAN_ACTIONS().includes("entity.current-revision"));
  assert.equal(schemaFor("definitions").properties.action.const, "definitions");
});

function PLAN_ACTIONS() {
  return listOperations().map((operation) => operation.action);
}

function helpTextForTest() {
  let text = "";
  runCli(["help"], { stdout: { write: (value) => { text += value; } }, stderr: { write() {} }, requestFn: async () => { throw new Error("offline"); } });
  return text;
}

test("--apply requires --out before it reads a plan or makes any request", async () => {
  let requestCount = 0;
  let error = "";
  const result = await runCli(["--plan", "not-read.json", "--apply"], {
    stdout: { write() {} }, stderr: { write: (value) => { error += value; } },
    requestFn: async () => { requestCount += 1; throw new Error("network forbidden"); },
  });
  assert.equal(result.exitCode, 2);
  assert.match(error, /apply_requires_out/);
  assert.equal(requestCount, 0);
});

test("--out reserves a new result file exclusively and never overwrites it", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-platform-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const planPath = path.join(dir, "plan.json");
  const outPath = path.join(dir, "result.json");
  fs.writeFileSync(planPath, JSON.stringify({ action: "entity.get", id: "entity-x" }), "utf8");
  let requestCount = 0;
  let stdoutText = "";
  let stderrText = "";
  const io = {
    requestFn: async () => {
      requestCount += 1;
      return { status: 200, body: { id: "entity-x", kind: "work", status: "draft", version: 1 } };
    },
    stdout: { write: (value) => { stdoutText += value; } },
    stderr: { write: (value) => { stderrText += value; } },
  };
  const first = await runCli(["--plan", planPath, "--out", outPath], io);
  assert.equal(first.exitCode, 0);
  assert.equal(JSON.parse(fs.readFileSync(outPath, "utf8")).outcome, "complete");
  assert.equal(requestCount, 1);

  const second = await runCli(["--plan", planPath, "--out", outPath], io);
  assert.equal(second.exitCode, 2);
  assert.match(stderrText, /out_reservation_failed/);
  assert.equal(requestCount, 1);
});

test("entity.list collects every offset page and reports exact complete coverage", async () => {
  const { requestFn, calls } = mockRequest((pathname) => {
    const url = parseUrl(pathname);
    const offset = Number(url.searchParams.get("offset"));
    if (offset === 0) return { status: 200, body: { items: [{ id: "a" }, { id: "b" }], total: 3 } };
    if (offset === 2) return { status: 200, body: { items: [{ id: "c" }], total: 3 } };
    assert.fail(`unexpected offset ${offset}`);
  });
  const result = await runPlan({ action: "entity.list", params: { kind: "work" }, limit: 2 }, { requestFn });
  assert.equal(result.ok, true);
  assert.equal(result.coverage.complete, true);
  assert.equal(result.coverage.pages, 2);
  assert.deepEqual(result.items.map((item) => item.id), ["a", "b", "c"]);
  assert.equal(calls.length, 2);
});

test("entity.list never labels a failed later page complete", async () => {
  const { requestFn } = mockRequest((pathname) => {
    const offset = Number(parseUrl(pathname).searchParams.get("offset"));
    if (offset === 0) return { status: 200, body: { items: [{ id: "a" }], total: 2 } };
    return { status: 503, body: { error: "unavailable" } };
  });
  const result = await runPlan({ action: "entity.list", limit: 1 }, { requestFn });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "partial");
  assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.failures[0].status, 503);
});

test("point reads preserve 401, 403, and 404 as distinct outcomes", async () => {
  for (const [status, outcome] of [[401, "unauthorized"], [403, "forbidden"], [404, "not_found_or_not_visible"]]) {
    const { requestFn } = mockRequest(() => ({ status, body: { error: "fixture" } }));
    const result = await runPlan({ action: "entity.get", id: "x" }, { requestFn });
    assert.equal(result.outcome, outcome);
    assert.equal(result.httpStatus, status);
  }
});

test("HTTP 200 with an empty entity object is partial, never complete", async () => {
  const { requestFn } = mockRequest(() => ({ status: 200, body: {} }));
  const result = await runPlan({ action: "entity.get", id: "missing-shape" }, { requestFn });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "partial");
  assert.equal(result.reason, "entity_shape_invalid");
});

test("entity.list accepts only the backend listTextParams filter contract", () => {
  const serverTextParams = ["q", "kind", "kinds", "status", "sort", "order", "locale", "work_id", "content_unit_id", "release_id", "medium_id", "parent_id", "field", "value", "tags", "original_language", "has_pictures"];
  assert.equal(validatePlan({ action: "entity.list", params: Object.fromEntries(serverTextParams.map((name) => [name, "x"])) }), null);
  assert.equal(validatePlan({ action: "entity.list", params: { unrecognized_filter: "x" } }), "invalid_list_params");
});

test("create rejects attributes absent from current Fields[].applicable_kinds before search or write", async () => {
  const { requestFn, calls } = mockRequest((pathname) => {
    assert.equal(pathname, "/api/catalog/definitions");
    return { status: 200, body: definitions() };
  });
  const plan = createPlan({ entity: { kind: "work", title: "New work", attributes: { invented: "x" } } });
  const result = await runPlan(plan, { apply: true, requestFn });
  assert.equal(result.code, "unknown_field");
  assert.equal(calls.length, 2); // OpenAPI contract, then definitions.
  assert.equal(calls.some((call) => call.options.method === "POST" && call.pathname !== "/api/catalog/entities/candidates"), false);
});
test("entity create refuses a write plan when runtime OpenAPI does not confirm its POST contract", async () => {
  const contract = openApiContract();
  delete contract.paths["/catalog/entities"].post;
  const { requestFn, calls } = mockRequest(() => assert.fail("definitions/read or write must not follow a failed contract check"), { openapiBody: contract });
  const result = await runPlan(createPlan(), { apply: true, requestFn });
  assert.equal(result.outcome, "partial");
  assert.equal(result.reason, "create_operation_not_confirmed_by_openapi");
  assert.equal(calls.length, 1);
});

test("runtime definitions accept a declared structure.fields null as the Go nil-slice empty rule set", async () => {
  const { requestFn, calls } = mockRequest((pathname) => {
    if (pathname === "/api/catalog/definitions") return { status: 200, body: definitions({
      structure: { work: { fields: null, subjects: false, contents: false } },
    }) };
    if (pathname === "/api/catalog/entities/candidates") return { status: 200, body: { basis: "postgres_repeatable_read", complete: true, items: [], total: 0 } };
    assert.fail(`unexpected request ${pathname}`);
  });
  const result = await runPlan(createPlan(), { requestFn });
  assert.equal(result.outcome, "preview");
  assert.equal(result.ok, true);
  assert.ok(calls.some((call) => call.pathname === "/api/catalog/definitions"));
});

test("missing or malformed structure.fields remains unknown instead of becoming empty", async () => {
  for (const fields of [undefined, "not-an-array"]) {
    const structure = { work: { subjects: false, contents: false } };
    if (fields !== undefined) structure.work.fields = fields;
    const { requestFn } = mockRequest((pathname) => pathname === "/api/catalog/definitions"
      ? { status: 200, body: definitions({ structure }) }
      : { status: 200, body: { basis: "postgres_repeatable_read", complete: true, items: [], total: 0 } });
    const result = await runPlan(createPlan(), { requestFn });
    assert.equal(result.outcome, "partial");
    assert.equal(result.reason, "structure_contract_unavailable");
  }
});

test("structure reference HTTP 200 without a complete entity shape stays partial", async () => {
  const { requestFn, calls } = mockRequest((pathname) => {
    if (pathname === "/api/catalog/definitions") return { status: 200, body: definitions({
      structure: { work: { fields: [{ code: "parent_id", target_kinds: ["agent"], required: false }], subjects: false, contents: false } },
    }) };
    if (pathname === "/api/catalog/entities/agent-x") return { status: 200, body: { id: "agent-x", kind: "agent", status: "published" } };
    assert.fail(`unexpected request ${pathname}`);
  });
  const result = await runPlan(createPlan({ entity: { kind: "work", title: "New work", parent_id: "agent-x" } }), { requestFn });
  assert.equal(result.outcome, "partial");
  assert.equal(result.reason, "structure_reference_entity_shape_invalid");
  assert.equal(calls.some((call) => call.pathname.includes("?kind=work")), false);
});

test("release subject work reference must match its requested id and carry a positive version", async () => {
  const { requestFn, calls } = mockRequest((pathname) => {
    if (pathname === "/api/catalog/definitions") return { status: 200, body: definitions({
      structure: { release: { fields: null, subjects: true, contents: false } },
    }) };
    if (pathname === "/api/catalog/entities/work-x") return { status: 200, body: { id: "another-work", kind: "work", status: "published", version: 1 } };
    assert.fail(`unexpected request ${pathname}`);
  });
  const result = await runPlan(createPlan({ entity: {
    kind: "release", title: "New release", subjects: [{ work_id: "work-x", role: "primary", position: 0 }],
  } }), { requestFn });
  assert.equal(result.outcome, "partial");
  assert.equal(result.reason, "subject_work_entity_shape_invalid");
  assert.equal(calls.some((call) => call.pathname.includes("?kind=release")), false);
});

test("create requires dynamic fields to be applicable to the entity kind", async () => {
  const { requestFn } = mockRequest(() => ({ status: 200, body: definitions({
    fields: { barcode: { enabled: true, type: "text", applicable_kinds: ["release"] } },
  }) }));
  const result = await runPlan(createPlan({ entity: { kind: "work", title: "New work", attributes: { barcode: "123" } } }), { apply: true, requestFn });
  assert.equal(result.code, "field_not_applicable_to_kind");
});

test("create preview checks caller-visible candidate search but sends no write", async () => {
  const { requestFn, calls } = mockRequest((pathname, options) => {
    if (pathname === "/api/catalog/definitions") return { status: 200, body: definitions() };
    if (pathname === "/api/catalog/entities/candidates") return { status: 200, body: { basis: "postgres_repeatable_read", complete: true, items: [], total: 0 } };
    assert.fail(`unexpected request ${options.method} ${pathname}`);
  });
  const result = await runPlan(createPlan(), { requestFn });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "preview");
  assert.equal(result.duplicateCheck.visibilityScope, "current caller-visible results only; absent candidates do not prove no duplicate exists elsewhere");
  assert.equal(calls.some((call) => call.options.method === "POST" && call.pathname !== "/api/catalog/entities/candidates"), false);
});

test("create stops when a new candidate was not explicitly reviewed as distinct", async () => {
  const { requestFn, calls } = mockRequest((pathname) => {
    if (pathname === "/api/catalog/definitions") return { status: 200, body: definitions() };
    if (pathname === "/api/catalog/entities/candidates") {
      const candidate = { id: "possible-duplicate", kind: "work", title: "New work", status: "published", version: 3 };
      return { status: 200, body: { basis: "postgres_repeatable_read", complete: true, items: [{ matched: candidate, canonical: candidate }], total: 1 } };
    }
    assert.fail(`unexpected request ${pathname}`);
  });
  const result = await runPlan(createPlan(), { apply: true, requestFn });
  assert.equal(result.outcome, "review_required");
  assert.deepEqual(result.candidateIds, ["possible-duplicate"]);
  assert.equal(calls.some((call) => call.options.method === "POST" && call.pathname !== "/api/catalog/entities/candidates"), false);
});

test("create duplicate guard searches translated titles, aliases, external IDs, and identity attributes", async () => {
  const entity = {
    kind: "work", title: "New work", translations: { "ja-JP": { title: "翻訳題", aliases: ["別名"] } },
    external_ids: { imdb: "tt1234567" }, attributes: { barcode: "490000000001" },
  };
  const visibleCandidate = {
    id: "candidate-x", kind: "work", title: "別名", status: "published", version: 4,
    translations: { "ja-JP": { title: "翻訳題", aliases: ["別名"] } },
    external_ids: { imdb: "tt1234567" }, attributes: { barcode: "490000000001" },
  };
  const { requestFn, calls } = mockRequest((pathname) => {
    if (pathname === "/api/catalog/definitions") return { status: 200, body: definitions({
      fields: { barcode: { enabled: true, type: "text", applicable_kinds: ["work"] } },
    }) };
    if (pathname === "/api/catalog/entities/candidates") return { status: 200, body: { basis: "postgres_repeatable_read", complete: true, items: [{ matched: visibleCandidate, canonical: visibleCandidate }], total: 1 } };
    assert.fail(`unexpected request ${pathname}`);
  });
  const result = await runPlan(createPlan({ entity }), { requestFn });
  assert.equal(result.outcome, "review_required");
  assert.deepEqual(result.queryModes.map((item) => item.mode), ["title_normalized_equality", "external_id_exact", "attribute_exact"]);
  assert.ok(result.candidates[0].matched_reasons.some((item) => item.matched_field === "translations.ja-JP.title"));
  assert.ok(result.candidates[0].matched_reasons.some((item) => item.matched_field === "external_ids.imdb"));
  assert.ok(result.candidates[0].matched_reasons.some((item) => item.matched_field === "attributes.barcode"));
  assert.equal(calls.some((call) => call.options.method === "POST" && call.pathname !== "/api/catalog/entities/candidates"), false);
});

test("entity create sends one idempotent POST and verifies the matching revision version", async () => {
  const entity = { kind: "work", title: "New work" };
  const readback = {
    id: "created-id", kind: "work", version: 1, title: "New work", status: "draft",
    attributes: null, translations: null, external_ids: null, pictures: null,
  };
  let posted = false;
  const { requestFn, calls } = mockRequest((pathname, options) => {
    if (pathname === "/api/catalog/definitions") return { status: 200, body: definitions() };
    if (pathname === "/api/catalog/entities/candidates") return { status: 200, body: { basis: "postgres_repeatable_read", complete: true, items: [], total: 0 } };
    if (pathname === "/api/catalog/entities" && options.method === "POST") {
      posted = true;
      assert.equal(options.tries, 1);
      assert.equal(options.idempotencyKey, "mf-test-create-001");
      assert.deepEqual(options.body.entity, { ...entity, id: "", status: "draft" });
      assert.equal(options.body.expected_version, 0);
      return { status: 201, body: readback };
    }
    if (pathname === "/api/catalog/entities/created-id") return { status: 200, body: readback };
    if (pathname === "/api/catalog/entities/created-id/revisions") {
      assert.equal(posted, true);
      return { status: 200, body: { items: [
        { id: "old-revision", version: 0, snapshot: { id: "older" }, sources: [] },
        { id: "current-revision", version: 1, snapshot: readback, sources },
      ] } };
    }
    assert.fail(`unexpected request ${options.method} ${pathname}`);
  });
  const result = await runPlan(createPlan(), { apply: true, requestFn });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "verified");
  assert.equal(result.revisionCheck.version, 1);
  assert.equal(calls.filter((call) => call.options.method === "POST" && call.pathname !== "/api/catalog/entities/candidates").length, 1);
});

test("entity create does not retry or claim success after an unknown write result", async () => {
  const { requestFn, calls } = mockRequest((pathname, options) => {
    if (pathname === "/api/catalog/definitions") return { status: 200, body: definitions() };
    if (pathname === "/api/catalog/entities/candidates") return { status: 200, body: { basis: "postgres_repeatable_read", complete: true, items: [], total: 0 } };
    if (pathname === "/api/catalog/entities" && options.method === "POST") throw new Error("socket closed after send");
    assert.fail(`unexpected retry/read after unknown result: ${pathname}`);
  });
  const result = await runPlan(createPlan(), { apply: true, requestFn });
  assert.equal(result.outcome, "unknown");
  assert.equal(result.applied, null);
  assert.equal(calls.filter((call) => call.options.method === "POST" && call.pathname !== "/api/catalog/entities/candidates").length, 1);
});

test("relation preview resolves enabled direction and both endpoint kinds without writing", async () => {
  const defs = definitions({
    fields: { role: { enabled: true, type: "text", applicable_kinds: [] } },
    relations: { adaptation_of: { enabled: true, source_kinds: ["work"], target_kinds: ["work"], fields: ["role"] } },
  });
  const { requestFn, calls } = mockRequest((pathname) => {
    if (pathname === "/api/catalog/definitions") return { status: 200, body: defs };
    if (pathname === "/api/catalog/entities/work-a") return { status: 200, body: { id: "work-a", kind: "work", status: "published", version: 3 } };
    if (pathname === "/api/catalog/entities/work-b") return { status: 200, body: { id: "work-b", kind: "work", status: "published", version: 4 } };
    if (pathname.endsWith("/relations")) return { status: 200, body: { items: [], entities: {} } };
    assert.fail(`unexpected request ${pathname}`);
  });
  const result = await runPlan(relationPlan({ relation: { type: "adaptation_of", source_id: "work-a", target_id: "work-b", attributes: { role: "novel" } } }), { requestFn });
  assert.equal(result.outcome, "preview");
  assert.equal(result.direction.source.id, "work-a");
  assert.equal(result.direction.target.id, "work-b");
  assert.deepEqual(result.direction.definition.source_kinds, ["work"]);
  assert.equal(calls.some((call) => call.options.method === "POST" && call.pathname !== "/api/catalog/entities/candidates"), false);
});

test("relation endpoint HTTP 200 with missing version is unknown shape, not preflight success", async () => {
  const defs = definitions({ relations: {
    adaptation_of: { enabled: true, source_kinds: ["work"], target_kinds: ["work"], fields: [] },
  } });
  const { requestFn, calls } = mockRequest((pathname) => {
    if (pathname === "/api/catalog/definitions") return { status: 200, body: defs };
    if (pathname === "/api/catalog/entities/work-a") return { status: 200, body: { id: "work-a", kind: "work", status: "published" } };
    if (pathname === "/api/catalog/entities/work-b") return { status: 200, body: { id: "work-b", kind: "work", status: "published", version: 2 } };
    assert.fail(`unexpected request ${pathname}`);
  });
  const result = await runPlan(relationPlan(), { requestFn });
  assert.equal(result.outcome, "partial");
  assert.equal(result.reason, "relation_source_entity_shape_invalid");
  assert.equal(calls.some((call) => call.pathname.endsWith("/relations")), false);
  assert.equal(calls.some((call) => call.options.method === "POST" && call.pathname !== "/api/catalog/entities/candidates"), false);
});

test("relation create response without a positive version stays partial", async () => {
  const defs = definitions({ relations: {
    adaptation_of: { enabled: true, source_kinds: ["work"], target_kinds: ["work"], fields: [] },
  } });
  const { requestFn, calls } = mockRequest((pathname, options) => {
    if (pathname === "/api/catalog/definitions") return { status: 200, body: defs };
    if (pathname === "/api/catalog/entities/work-a") return { status: 200, body: { id: "work-a", kind: "work", status: "published", version: 3 } };
    if (pathname === "/api/catalog/entities/work-b") return { status: 200, body: { id: "work-b", kind: "work", status: "published", version: 4 } };
    if (pathname.endsWith("/relations")) return { status: 200, body: { items: [], entities: {} } };
    if (pathname === "/api/catalog/relations" && options.method === "POST") {
      return { status: 201, body: { id: "relation-x", type: "adaptation_of", source_id: "work-a", target_id: "work-b", position: 0, attributes: {} } };
    }
    assert.fail(`unexpected request ${options.method} ${pathname}`);
  });
  const result = await runPlan(relationPlan(), { apply: true, requestFn });
  assert.equal(result.outcome, "partial");
  assert.equal(result.reason, "relation_create_response_shape_invalid");
  assert.equal(result.applied, true);
  assert.equal(calls.filter((call) => call.options.method === "POST" && call.pathname !== "/api/catalog/entities/candidates").length, 1);
});

test("relation create uses one Idempotency-Key POST and verifies both endpoint lists", async () => {
  const defs = definitions({
    relations: { adaptation_of: { enabled: true, source_kinds: ["work"], target_kinds: ["work"], fields: [] } },
  });
  const edge = { id: "relation-id", version: 1, type: "adaptation_of", source_id: "work-a", target_id: "work-b", position: 0, attributes: {} };
  let posted = false;
  const { requestFn, calls } = mockRequest((pathname, options) => {
    if (pathname === "/api/catalog/definitions") return { status: 200, body: defs };
    if (pathname === "/api/catalog/relations" && options.method === "POST") {
      posted = true;
      assert.equal(options.tries, 1);
      assert.equal(options.idempotencyKey, "mf-test-relation-001");
      assert.equal(options.body.expected_version, 0);
      return { status: 201, body: edge };
    }
    if (pathname === "/api/catalog/entities/work-a") return { status: 200, body: { id: "work-a", kind: "work", status: "published", version: 3 } };
    if (pathname === "/api/catalog/entities/work-b") return { status: 200, body: { id: "work-b", kind: "work", status: "published", version: 4 } };
    if (pathname.endsWith("/relations")) return { status: 200, body: { items: posted ? [edge] : [], entities: {} } };
    assert.fail(`unexpected request ${options.method} ${pathname}`);
  });
  const result = await runPlan(relationPlan(), { apply: true, requestFn });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "readback_verified");
  assert.equal(result.sourceReadback, true);
  assert.equal(result.targetReadback, true);
  assert.equal(calls.filter((call) => call.options.method === "POST" && call.pathname !== "/api/catalog/entities/candidates").length, 1);
});

test("current-revision selects by version, not by response ordering", async () => {
  const { requestFn } = mockRequest((pathname) => {
    if (pathname.endsWith("/revisions")) return { status: 200, body: { items: [
      { id: "older", version: 2, snapshot: { id: "x", kind: "work", version: 2, status: "draft" }, sources: [] },
      { id: "current", version: 7, snapshot: { id: "x", kind: "work", version: 7, status: "draft" }, sources: [] },
    ] } };
    return { status: 200, body: { id: "x", kind: "work", version: 7, status: "draft" } };
  });
  const result = await runPlan({ action: "entity.current-revision", id: "x" }, { requestFn });
  assert.equal(result.ok, true);
  assert.equal(result.revision.id, "current");
  assert.equal(result.selectedBy, "revision.version === entity.version");
});

test("current-revision rejects a revision without id or a malformed current entity", async () => {
  const noRevisionId = mockRequest((pathname) => pathname.endsWith("/revisions")
    ? { status: 200, body: { items: [{ version: 4, snapshot: { id: "x", kind: "work", version: 4, status: "draft" } }] } }
    : { status: 200, body: { id: "x", kind: "work", version: 4, status: "draft" } });
  const missingId = await runPlan({ action: "entity.current-revision", id: "x" }, { requestFn: noRevisionId.requestFn });
  assert.equal(missingId.outcome, "partial");
  assert.equal(missingId.reason, "current_revision_shape_invalid");

  const malformedEntity = mockRequest(() => ({ status: 200, body: {} }));
  const invalid = await runPlan({ action: "entity.current-revision", id: "x" }, { requestFn: malformedEntity.requestFn });
  assert.equal(invalid.outcome, "partial");
  assert.equal(invalid.reason, "entity_shape_invalid");
});

test("entity.update is gated by the runtime PUT contract before guardedUpdate reads the entity", async () => {
  const contract = openApiContract();
  delete contract.paths["/catalog/entities/{id}"].put;
  const { requestFn, calls } = mockRequest(() => assert.fail("entity GET must not follow a failed contract check"), { openapiBody: contract });
  const result = await runPlan({
    action: "entity.update",
    plan: { id: "work-x", expected_version: 3, patch: { title: "New" }, edit_note: "edit", sources },
  }, { apply: true, requestFn });
  assert.equal(result.outcome, "partial");
  assert.equal(result.reason, "operation_not_confirmed_by_openapi");
  assert.equal(calls.length, 1);
});

test("entity.update delegates dry-run to guardedUpdate and never issues PUT by default", async () => {
  const before = { id: "work-x", kind: "work", version: 3, title: "Old title", status: "draft", attributes: {}, translations: {}, external_ids: {}, pictures: [] };
  const { requestFn, calls } = mockRequest(() => ({ status: 200, body: before }));
  const result = await runPlan({
    action: "entity.update",
    plan: { id: "work-x", expected_version: 3, patch: { title: "New title" }, edit_note: "title", sources: [{ kind: "url", citation: "title", url: "https://example.test/title" }] },
  }, { requestFn });
  assert.equal(result.ok, true);
  assert.equal(calls.some((call) => call.options.method === "PUT"), false);
});

test("entity.update 对 Track.status 使用专用 PATCH，并复用已读取的运行时契约", async () => {
  const before = { id: "track-x", kind: "track", version: 3, title: "Song", status: "draft", medium_id: "medium-x", contents: [] };
  const after = { ...before, version: 4, status: "published" };
  const evidence = [{ kind: "url", citation: "status；本次仅将 status 由 draft 置为 published", url: "https://example.test/track" }];
  let reads = 0;
  const { requestFn, calls } = mockRequest((pathname, options) => {
    if (options.method === "PATCH") return { status: 200, body: after };
    if (pathname.endsWith("/revisions")) return { status: 200, body: { items: [{ id: 10, version: 4, snapshot: { ...after, contents: null }, sources: evidence }] } };
    if (pathname === "/api/catalog/entities/track-x") return { status: 200, body: reads++ === 0 ? before : after };
    assert.fail(`unexpected request ${pathname}`);
  });
  const result = await runPlan({ action: "entity.update", plan: {
    id: "track-x", expected_version: 3, patch: { status: "published" }, edit_note: "发布 status", sources: evidence,
  } }, { apply: true, requestFn });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.filter((call) => call.pathname === "/api/openapi.json").length, 1);
  assert.equal(calls.filter((call) => call.options.method === "PATCH").length, 1);
  assert.equal(calls.some((call) => call.options.method === "PUT"), false);
  assert.deepEqual(calls.find((call) => call.options.method === "PATCH").options.body, {
    status: "published", expected_version: 3, edit_note: "发布 status", sources: evidence,
  });
});

test("entity.update 在旧实例缺少 Track.status PATCH 时拒绝写入", async () => {
  const contract = openApiContract();
  delete contract.paths["/catalog/tracks/{id}/status"];
  const { requestFn, calls } = mockRequest(() => ({ status: 200, body: {
    id: "track-x", kind: "track", version: 3, status: "draft", title: "Song", medium_id: "medium-x", contents: [],
  } }), { openapiBody: contract });
  const result = await runPlan({ action: "entity.update", plan: {
    id: "track-x", expected_version: 3, patch: { status: "published" }, edit_note: "发布 status",
    sources: [{ kind: "publication", citation: "status" }],
  } }, { apply: true, requestFn });
  assert.equal(result.reason, "track_status_endpoint_not_confirmed_by_openapi");
  assert.equal(calls.some((call) => ["PUT", "PATCH"].includes(call.options.method)), false);
});

test("track-content.add delegates to the dedicated helper and defaults to preview", async () => {
  const entities = {
    "track-x": { id: "track-x", kind: "track", version: 2, medium_id: "medium-x", contents: [] },
    "medium-x": { id: "medium-x", kind: "medium", release_id: "release-x" },
    "release-x": { id: "release-x", kind: "release", subjects: [{ work_id: "work-x" }] },
    "expression-x": { id: "expression-x", kind: "expression", work_id: "work-x" },
  };
  const { requestFn, calls } = mockRequest((pathname) => {
    const id = pathname.split("/").at(-1);
    if (entities[id]) return { status: 200, body: entities[id] };
    assert.fail(`unexpected request ${pathname}`);
  });
  const result = await runPlan({
    action: "track-content.add",
    plan: {
      track_id: "track-x", expected_version: 2,
      inclusion: { expression_id: "expression-x", position: 0, locator: {} },
      edit_note: "按官方曲目表增加收录", sources,
    },
  }, { requestFn });
  assert.equal(result.ok, true, JSON.stringify({ result, calls }));
  assert.equal(calls.some((call) => call.options.method === "POST" && call.pathname !== "/api/catalog/entities/candidates"), false);
});
