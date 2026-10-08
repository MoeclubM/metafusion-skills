import assert from "node:assert/strict";
import { test } from "node:test";

import { guardedUpdate } from "./mf-guarded-update.mjs";

const source = {
  kind: "publication",
  citation: "官方书目支持 title 字段",
};

function entity(overrides = {}) {
  return {
    id: "entity-1",
    kind: "work",
    version: 4,
    title: "Old title",
    original_language: "ja-JP",
    translations: { "ja-JP": { title: "旧题名" } },
    attributes: { tags: ["verified"] },
    external_ids: {},
    pictures: [],
    status: "published",
    created_by: "user-1",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function plan(overrides = {}) {
  return {
    id: "entity-1",
    expected_version: 4,
    patch: { title: "New title" },
    edit_note: "按官方书目更正正式题名",
    sources: [source],
    ...overrides,
  };
}

function response(body, status = 200) {
  return { status, body };
}

function revisions(snapshot, revisionSources = [source], version = snapshot.version, id = "revision-1") {
  return { items: [{ id, version, sources: revisionSources, snapshot }] };
}

function statusContract() {
  return {
    openapi: "3.0.3",
    paths: { "/catalog/tracks/{id}/status": { patch: {
      requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/TrackStatusEdit" } } } },
    } } },
    components: { schemas: { TrackStatusEdit: {
      type: "object", additionalProperties: false, required: ["status", "expected_version", "edit_note", "sources"],
      properties: {
        status: { type: "string", enum: ["draft", "pending_review", "published"] },
        expected_version: { type: "integer", minimum: 1 }, edit_note: { type: "string" }, sources: { type: "array" },
      },
    } } },
  };
}

function statusPlan(overrides = {}) {
  return plan({ patch: { status: "published" }, edit_note: "本次仅将 status 由 draft 置为 published",
    sources: [{ kind: "url", citation: "官方曲目表支持 status；本次仅将 status 由 draft 置为 published", url: "https://example.test/track" }], ...overrides });
}

function harness({ current = entity(), after = null, put = response({ version: 5 }), revisionItems = null, contract = statusContract(), contractStatus = 200 } = {}) {
  const calls = [];
  let writes = 0;
  const updated = after ?? { ...current, title: "New title", version: 5, updated_at: "2026-01-02T00:00:00Z" };
  const requestFn = async (path, options = {}) => {
    calls.push({ path, method: options.method ?? "GET", body: options.body, tries: options.tries });
    if (["PUT", "PATCH"].includes(options.method)) {
      writes += 1;
      return typeof put === "function" ? put({ path, options, calls }) : put;
    }
    if (path === "/api/openapi.json") return response(contract, contractStatus);
    if (path.endsWith("/revisions")) {
      const sources = calls.find((call) => ["PUT", "PATCH"].includes(call.method))?.body?.sources ?? [source];
      return response(revisionItems ?? revisions(updated, sources));
    }
    if (path === "/api/catalog/entities/entity-1") {
      return response(calls.filter((call) => call.path === path && call.method === "GET").length === 1 ? current : updated);
    }
    return response({ items: [], subject_id: decodeURIComponent(path.split("/").at(-2)), entities: {} });
  };
  return { requestFn, calls, get writes() { return writes; }, updated };
}

test("dry-run 读取当前实体但不发 PUT", async () => {
  const h = harness();
  const result = await guardedUpdate(plan(), { requestFn: h.requestFn });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.outcome, "dry_run");
  assert.deepEqual(result.changedFields, ["title"]);
  assert.deepEqual(result.changes, [{ field: "title", before: "Old title", after: "New title", beforePresent: true, afterPresent: true }]);
  assert.equal(h.writes, 0);
  assert.deepEqual(h.calls.map((call) => call.method), ["GET"]);
});

test("预期版本不符时拒绝且不写", async () => {
  const h = harness({ current: entity({ version: 5 }) });
  const result = await guardedUpdate(plan(), { requestFn: h.requestFn, apply: true });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "version_mismatch");
  assert.equal(h.writes, 0);
});

test("409 后只读回查，不自动重放 PUT", async () => {
  const h = harness({ put: response({ error: "version_conflict" }, 409) });
  const result = await guardedUpdate(plan(), { requestFn: h.requestFn, apply: true });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "conflict");
  assert.equal(result.recheck.currentVersion, 5);
  assert.equal(h.writes, 1);
  assert.deepEqual(h.calls.filter((call) => call.method === "PUT").map((call) => call.path), ["/api/catalog/entities/entity-1"]);
});

test("写后发现非目标可写字段被丢失则为 partial", async () => {
  const h = harness({ after: { ...entity({ title: "New title", version: 5 }), translations: undefined } });
  const result = await guardedUpdate(plan(), { requestFn: h.requestFn, apply: true });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "partial");
  assert.ok(result.fieldChecks.some((check) => check.field === "translations" && check.role === "preserved" && !check.ok));
});

test("当前修订按 version 查找，不假定排列顺序", async () => {
  const h = harness();
  let writes = 0;
  const old = { ...h.updated, version: 3, title: "Earlier" };
  h.requestFn = async (path, options = {}) => {
    h.calls.push({ path, method: options.method ?? "GET", body: options.body, tries: options.tries });
    if (options.method === "PUT") { writes += 1; return response({ version: 5 }); }
    if (path.endsWith("/revisions")) return response({ items: [{ id: "r4", version: 3, snapshot: old, sources: [source] }, { id: "r5", version: 5, snapshot: h.updated, sources: [source] }] });
    return response(h.calls.filter((call) => call.path === path && call.method === "GET").length === 1 ? entity() : h.updated);
  };
  const result = await guardedUpdate(plan(), { requestFn: h.requestFn, apply: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.revisionCheck.version, 5);
  assert.equal(writes, 1);
});

test("PUT 结果未知时回查实体但仍返回 unknown", async () => {
  const current = entity({ attributes: { tags: ["verified"], language: "ja" } });
  const after = { ...current, attributes: { tags: ["verified"], language: "ja", catalog_number: "NEW-1" }, version: 5, updated_at: "2026-01-02T00:00:00Z" };
  const calls = [];
  let entityReads = 0;
  let writes = 0;
  const requestFn = async (path, options = {}) => {
    calls.push({ path, method: options.method ?? "GET", body: options.body });
    if (options.method === "PUT") { writes += 1; return response({ error: "network" }, 0); }
    if (path.endsWith("/revisions")) return response(revisions(after));
    entityReads += 1;
    return response(entityReads === 1 ? current : after);
  };
  const p = plan({ patch: { attributes: { catalog_number: "NEW-1" } }, sources: [{ kind: "publication", citation: "官方书目支持 attributes.catalog_number" }] });
  const result = await guardedUpdate(p, { requestFn, apply: true });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "unknown");
  assert.equal(result.recheck.state, "expected_state_visible");
  assert.equal(result.recheck.expectedStateVisible, true);
  assert.equal(writes, 1);
  assert.equal(calls.filter((call) => call.method === "PUT").length, 1);
});

test("正常应用仅 PUT 一次并逐字段、修订与来源验证", async () => {
  const h = harness();
  const result = await guardedUpdate(plan(), { requestFn: h.requestFn, apply: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.outcome, "verified");
  assert.equal(result.version, 5);
  assert.equal(result.fieldChecks.every((check) => check.ok), true);
  assert.equal(result.revisionCheck.snapshotMatches, true);
  assert.equal(result.revisionCheck.sourcesMatch, true);
  assert.equal(result.entityDeepMatches, true);
  assert.equal(h.writes, 1);
  assert.equal(h.calls.filter((call) => call.method === "PUT")[0].tries, 1);
  assert.equal(h.calls.find((call) => call.method === "PUT").body.entity.version, 4);
  assert.equal(result.fieldChecks.find((check) => check.field === "version").role, "version");
  assert.equal(result.fieldChecks.find((check) => check.field === "version").ok, true);
  assert.equal(h.calls.find((call) => call.method === "PUT").body.entity.translations["ja-JP"].title, "旧题名");
});

test("当前修订存在但 snapshot 或 sources 不匹配时不得报告成功", async () => {
  const h = harness({ revisionItems: { items: [{ id: "revision-5", version: 5, snapshot: { ...entity(), version: 5, title: "wrong" }, sources: [{ kind: "publication", citation: "不同来源" }] }] } });
  const result = await guardedUpdate(plan(), { requestFn: h.requestFn, apply: true });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "partial");
  assert.equal(result.revisionCheck.snapshotMatches, false);
  assert.equal(result.revisionCheck.sourcesMatch, false);
});

test("无变化直接 skip，不读取修订也不写", async () => {
  const p = plan({ patch: { title: "Old title" }, sources: [{ kind: "publication", citation: "官方书目支持 title 字段" }] });
  const h = harness();
  const result = await guardedUpdate(p, { requestFn: h.requestFn, apply: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.outcome, "skipped");
  assert.equal(h.writes, 0);
  assert.equal(h.calls.length, 1);
});

test("拒绝无效证据、只读字段、归属字段与任意点路径", async () => {
  for (const p of [
    plan({ sources: [{ kind: "self", citation: "维护" }] }),
    plan({ patch: { created_by: "attacker" }, sources: [source] }),
    plan({ patch: { work_id: "another-work" }, sources: [{ kind: "publication", citation: "官方材料支持 work_id" }] }),
    plan({ patch: { "attributes.barcode": "123" }, sources: [{ kind: "publication", citation: "官方材料支持 attributes.barcode" }] }),
  ]) {
    const h = harness();
    const result = await guardedUpdate(p, { requestFn: h.requestFn, apply: true });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "rejected");
    assert.equal(h.calls.length, 0);
  }
});

test("对象 patch 递归合并并保留未列的嵌套键", async () => {
  const current = entity({
    attributes: { catalog_number: "OLD-1", language: "ja", tags: ["archive", "verified"] },
    translations: { "ja-JP": { title: "旧题名", summary: "既有简介", aliases: ["旧别名"] } },
    external_ids: { wikidata: "Q1", musicbrainz: "mb-1" },
  });
  const p = plan({
    patch: {
      attributes: { catalog_number: "NEW-1" },
      translations: { "ja-JP": { title: "新题名" } },
      external_ids: { wikidata: "Q2" },
    },
    sources: [{ kind: "publication", citation: "官方书目支持 attributes、translations、external_ids" }],
  });
  const calls = [];
  const requestFn = async (path, options = {}) => {
    calls.push({ path, method: options.method ?? "GET", body: options.body });
    if (options.method === "PUT") {
      const sent = options.body.entity;
      assert.deepEqual(sent.attributes, { catalog_number: "NEW-1", language: "ja", tags: ["archive", "verified"] });
      assert.deepEqual(sent.translations["ja-JP"], { title: "新题名", summary: "既有简介", aliases: ["旧别名"] });
      assert.deepEqual(sent.external_ids, { wikidata: "Q2", musicbrainz: "mb-1" });
      return response({ version: 5 });
    }
    if (path.endsWith("/revisions")) {
      const sent = calls.find((call) => call.method === "PUT").body.entity;
      return response(revisions({ ...sent, version: 5, updated_at: "2026-01-02T00:00:00Z" }, p.sources));
    }
    if (calls.filter((call) => call.path === path && call.method === "GET").length === 1) return response(current);
    const sent = calls.find((call) => call.method === "PUT").body.entity;
    return response({ ...sent, version: 5, updated_at: "2026-01-02T00:00:00Z" });
  };
  const result = await guardedUpdate(p, { requestFn, apply: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.fieldChecks.every((check) => check.ok), true);
  assert.deepEqual(result.changes.map(({ field, before, after }) => [field, before, after]), [
    ["attributes.catalog_number", "OLD-1", "NEW-1"],
    ["translations.ja-JP.title", "旧题名", "新题名"],
    ["external_ids.wikidata", "Q1", "Q2"],
  ]);
});

test("数组整体替换、null 显式清空；contents patch 明确拒绝", async () => {
  const current = entity({ attributes: { tags: ["one", "two"], language: "ja" } });
  const after = { ...current, attributes: { tags: ["replacement"], language: null }, version: 5, updated_at: "2026-01-02T00:00:00Z" };
  const h = harness({ current, after });
  const p = plan({
    patch: { attributes: { tags: ["replacement"], language: null } },
    sources: [{ kind: "publication", citation: "官方书目支持 attributes.tags 与 attributes.language" }],
  });
  const result = await guardedUpdate(p, { requestFn: h.requestFn, apply: true });
  assert.deepEqual(h.calls.find((call) => call.method === "PUT").body.entity.attributes, { tags: ["replacement"], language: null });
  assert.equal(result.ok, true);
  assert.deepEqual(result.changes.map(({ field, before, after }) => [field, before, after]), [
    ["attributes.tags", ["one", "two"], ["replacement"]],
    ["attributes.language", "ja", null],
  ]);

  const rejected = await guardedUpdate(plan({ patch: { contents: [] }, sources: [{ kind: "publication", citation: "官方目录支持 contents" }] }), { requestFn: h.requestFn, apply: true });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "contents_not_patchable");
});

test("Track.title 的预览与 apply 均拒绝 whole-entity PUT", async () => {
  for (const apply of [false, true]) {
    const current = entity({ kind: "track", medium_id: "medium-1", contents: [{ expression_id: "expr-1", position: 1, locator: {} }] });
    const h = harness({ current });
    const result = await guardedUpdate(plan(), { requestFn: h.requestFn, apply });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "track_requires_dedicated_endpoint");
    assert.equal(h.writes, 0);
    assert.deepEqual(h.calls.map((call) => call.method), ["GET"]);
  }
});

test("Track.status 预览确认专用 PATCH 契约，apply 只发送四个白名单字段", async () => {
  const contents = [{ expression_id: "expr-1", position: 1, locator: { role: "complete" } }];
  for (const apply of [false, true]) {
    const current = entity({ kind: "track", status: "draft", medium_id: "medium-1", contents });
    const h = harness({ current, after: { ...current, status: "published", version: 5 } });
    const p = statusPlan();
    const result = await guardedUpdate(p, { requestFn: h.requestFn, apply });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.changedFields, ["status"]);
    assert.equal(h.calls.some((call) => call.method === "PUT"), false);
    assert.equal(h.writes, apply ? 1 : 0);
    if (apply) {
      const sent = h.calls.find((call) => call.method === "PATCH");
      assert.equal(sent.path, "/api/catalog/tracks/entity-1/status");
      assert.equal(sent.tries, 1);
      assert.deepEqual(sent.body, { status: "published", expected_version: 4, edit_note: p.edit_note, sources: p.sources });
      assert.deepEqual(h.updated.contents, contents);
      assert.equal(result.fieldChecks.find((check) => check.field === "contents").ok, true);
    }
  }
});

test("Track 空 contents 的 GET [] 与修订 null 等价，非空收录差异仍拒绝", async () => {
  const current = entity({ kind: "track", status: "draft", medium_id: "medium-1", contents: [] });
  const after = { ...current, status: "published", version: 5 };
  const p = statusPlan();
  const empty = harness({ current, after, revisionItems: revisions({ ...after, contents: null }, p.sources) });
  assert.equal((await guardedUpdate(p, { requestFn: empty.requestFn, apply: true })).ok, true);
  const nonempty = harness({ current, after: { ...after, contents: [{ expression_id: "unexpected", position: 0 }] } });
  const failed = await guardedUpdate(p, { requestFn: nonempty.requestFn, apply: true });
  assert.equal(failed.outcome, "partial");
  assert.equal(failed.fieldChecks.find((check) => check.field === "contents").ok, false);
});

test("Track.status 版本预检失败不写；409 后只读回查且不重放 PATCH", async () => {
  const current = entity({ kind: "track", status: "draft", medium_id: "medium-1", contents: [] });
  const after = { ...current, status: "published", version: 5 };
  const mismatch = harness({ current: { ...current, version: 5 }, after });
  assert.equal((await guardedUpdate(statusPlan(), { requestFn: mismatch.requestFn, apply: true })).outcome, "version_mismatch");
  assert.equal(mismatch.writes, 0);
  const conflict = harness({ current, after, put: response({ error: "version_conflict" }, 409) });
  const result = await guardedUpdate(statusPlan(), { requestFn: conflict.requestFn, apply: true });
  assert.equal(result.outcome, "conflict");
  assert.equal(conflict.writes, 1);
  assert.equal(conflict.calls.filter((call) => call.method === "PATCH").length, 1);
});

test("Track.status 写入结果未知时即使回读已发布也不重放或报告 verified", async () => {
  const current = entity({ kind: "track", status: "draft", medium_id: "medium-1", contents: [] });
  const after = { ...current, status: "published", version: 5 };
  for (const put of [response({ error: "network" }, 503), () => { throw new Error("connection closed"); }]) {
    const h = harness({ current, after, put });
    const result = await guardedUpdate(statusPlan(), { requestFn: h.requestFn, apply: true });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "unknown");
    assert.equal(result.applied, null);
    assert.equal(result.recheck.expectedStateVisible, true);
    assert.equal(h.writes, 1);
    assert.equal(h.calls.filter((call) => call.method === "PATCH").length, 1);
    assert.equal(h.calls.some((call) => call.method === "PUT"), false);
  }
});

test("Track 不接受非白名单字段、非法状态与发布降级", async () => {
  const current = entity({ kind: "track", status: "draft", medium_id: "medium-1", contents: [] });
  for (const patch of [{ status: "published", title: "Other" }, { status: "published", contents: [] }, { contents: [] }]) {
    const h = harness({ current });
    const p = statusPlan({ patch, sources: [{ kind: "publication", citation: "status title contents" }] });
    assert.equal((await guardedUpdate(p, { requestFn: h.requestFn, apply: true })).reason, "track_requires_dedicated_endpoint");
    assert.equal(h.writes, 0);
  }
  for (const status of [null, "", "unknown"]) {
    const h = harness({ current });
    assert.equal((await guardedUpdate(statusPlan({ patch: { status } }), { requestFn: h.requestFn, apply: true })).reason, "invalid_status");
    assert.equal(h.writes, 0);
  }
  const downgrade = harness({ current: { ...current, status: "published" } });
  assert.equal((await guardedUpdate(statusPlan({ patch: { status: "draft" } }), { requestFn: downgrade.requestFn, apply: true })).reason, "use_lifecycle_endpoint");
  assert.equal(downgrade.writes, 0);
});

test("未上线或放宽字段的 Track.status 契约均失败关闭，不回退 PUT", async () => {
  const current = entity({ kind: "track", status: "draft", medium_id: "medium-1", contents: [] });
  const contracts = [{ paths: {} }, statusContract(), statusContract(), statusContract(), statusContract(), statusContract(), statusContract(), statusContract()];
  contracts[1].components.schemas.TrackStatusEdit.additionalProperties = true;
  contracts[2].components.schemas.TrackStatusEdit.properties.contents = { type: "array" };
  contracts[3].components.schemas.TrackStatusEdit.required = {};
  contracts[4].components.schemas.TrackStatusEdit.properties.expected_version.type = "string";
  contracts[5].components.schemas.TrackStatusEdit.type = "array";
  contracts[6].components.schemas.TrackStatusEdit.required.push("entity");
  contracts[7].components.schemas.TrackStatusEdit.properties.status = null;
  for (const contract of contracts) {
    const h = harness({ current, contract });
    const result = await guardedUpdate(statusPlan(), { requestFn: h.requestFn, apply: true });
    assert.equal(result.reason, "track_status_endpoint_not_confirmed_by_openapi");
    assert.equal(h.writes, 0);
  }
  const unavailable = harness({ current, contractStatus: 503 });
  assert.equal((await guardedUpdate(statusPlan(), { requestFn: unavailable.requestFn, apply: true })).reason, "track_status_endpoint_not_confirmed_by_openapi");
  assert.equal(unavailable.writes, 0);
});

test("关系端点 HTTP 200 但计划没有期望边时标为 unverified", async () => {
  const p = plan({ verification: { relationEntityIds: ["entity-2"] } });
  const h = harness();
  const result = await guardedUpdate(p, { requestFn: h.requestFn, apply: true });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "unverified");
  assert.deepEqual(result.verificationChecks.map((check) => check.state), ["unverified"]);
});

test("Release TOC 回读核对发行实体完整快照，而非只看 HTTP 200", async () => {
  const current = entity({ kind: "release", subjects: [] });
  const after = { ...current, title: "New title", version: 5, updated_at: "2026-01-02T00:00:00Z" };
  const calls = [];
  const requestFn = async (path, options = {}) => {
    calls.push({ path, method: options.method ?? "GET", body: options.body });
    if (options.method === "PUT") return response({ version: 5 });
    if (path.endsWith("/revisions")) return response(revisions(after));
    if (path.endsWith("/toc")) return response({ release: after, media: [], expressions: {}, definition_etag: "fixture" });
    return response(calls.filter((call) => call.path === path && call.method === "GET").length === 1 ? current : after);
  };
  const p = plan({ verification: { tocReleaseIds: ["entity-1"] } });
  const result = await guardedUpdate(p, { requestFn, apply: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.verificationChecks, [{ kind: "toc", id: "entity-1", state: "verified", entityMatches: true }]);
  assert.equal(calls.filter((call) => call.path.endsWith("/toc")).length, 1);
});
