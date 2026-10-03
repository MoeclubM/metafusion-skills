import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { collectEntities } from "./mf-catalog-snapshot.mjs";
import { findIdentity, runCli } from "./mf-find-identity.mjs";

const TOOL_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "mf-find-identity.mjs");
const completeCoverage = {
  pages: 1, total: 1, rawCount: 1, uniqueCount: 1, duplicateIds: [], complete: true, failures: [],
};

function collector(items, coverage = completeCoverage, observed) {
  return async (options) => {
    if (observed) observed.push(options);
    return { items, coverage };
  };
}

function resolvedRequest(entities) {
  return async (pathname) => {
    const prefix = "/api/catalog/entities/";
    assert.ok(pathname.startsWith(prefix), "expected resolve endpoint");
    assert.ok(pathname.endsWith("/resolve"), "identity lookup must resolve canonical ids");
    const id = decodeURIComponent(pathname.slice(prefix.length, -"/resolve".length));
    const entity = entities[id];
    if (!entity) return { status: 404, body: { error: "not_found" } };
    return { status: 200, body: entity };
  };
}

function entity(id, overrides = {}) {
  return { id, kind: "work", title: "夜明け", status: "published", translations: {},
    attributes: {}, external_ids: {}, ...overrides };
}

test("翻译别名与题名大小写空白归一只产生弱候选", async () => {
  const item = entity("work-1", { title: "別題", translations: { "zh-CN": { title: "晨光", aliases: ["黎明", "Li   Ming"] } } });
  const report = await findIdentity({ kind: "work", titles: ["  li ming  "],
    collectEntitiesFn: collector([item]), requestFn: resolvedRequest({ "work-1": item }) });
  assert.equal(report.decision, "needs_evidence");
  assert.equal(report.identity_confirmed, false);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].matched_reasons[0].query_mode, "title_normalized_equality");
  assert.equal(report.candidates[0].matched_reasons[0].matched_field, "translations.zh-CN.aliases[1]");
  assert.equal(report.candidates[0].matched_reasons[0].strength, "weak_title_candidate");
});

test("同名的不同 Work 都保留为独立候选", async () => {
  const first = entity("work-a");
  const second = entity("work-b", { title: " 夜明け " });
  const report = await findIdentity({ titles: ["夜明け"], collectEntitiesFn: collector([first, second]),
    requestFn: resolvedRequest({ "work-a": first, "work-b": second }) });
  assert.deepEqual(report.candidates.map((candidate) => candidate.canonical_id), ["work-a", "work-b"]);
  assert.equal(report.decision, "needs_evidence");
  assert.ok(report.candidates.every((candidate) => candidate.matched_reasons[0].strength === "weak_title_candidate"));
});

test("同名录音室与现场 Expression 不会按标题混成一项，且保留区分字段", async () => {
  const studio = entity("expr-studio", { kind: "expression", title: "星屑", work_id: "work-9",
    content_unit_id: "unit-1", attributes: { version_label: "錄音室版", duration: 213 } });
  const live = entity("expr-live", { kind: "expression", title: "星屑", work_id: "work-9",
    content_unit_id: "unit-1", attributes: { version_label: "現場版", duration: 247 } });
  const report = await findIdentity({ kind: "expression", workId: "work-9", titles: ["星屑"],
    collectEntitiesFn: collector([studio, live]), requestFn: resolvedRequest({ "expr-studio": studio, "expr-live": live }) });
  assert.equal(report.candidates.length, 2);
  assert.deepEqual(report.candidates.map((candidate) => candidate.entity.attributes.version_label).sort(), ["現場版", "錄音室版"]);
  assert.deepEqual(report.candidates.map((candidate) => candidate.entity.attributes.duration).sort(), [213, 247]);
  assert.ok(report.candidates.every((candidate) => candidate.entity.work_id === "work-9"));
  assert.ok(report.candidates.every((candidate) => candidate.entity.content_unit_id === "unit-1"));
});

test("多個原始 ID resolve 到同一 canonical ID 时合并候选并保留来源 ID 和命中理由", async () => {
  const old = entity("work-old", { title: "星の歌" });
  const current = entity("work-current", { title: "星の歌" });
  const requestFn = resolvedRequest({ "work-old": current, "work-current": current });
  const report = await findIdentity({ titles: ["星の歌"], collectEntitiesFn: collector([old, current]), requestFn });
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].canonical_id, "work-current");
  assert.deepEqual(report.candidates[0].matched_original_ids, ["work-current", "work-old"]);
  assert.deepEqual(new Set(report.candidates[0].matched_reasons.map((reason) => reason.original_id)),
    new Set(["work-current", "work-old"]));
});

test("标题弱命中与另一个外部标识命中分别报告，不把任一命中解释为身份确认", async () => {
  const titleHit = entity("work-title", { title: "共同题名" });
  const externalHit = entity("work-external", { title: "其他题名", external_ids: { musicbrainz: "mb-123" } });
  const report = await findIdentity({ titles: ["共同题名"], externalIds: [{ provider: "musicbrainz", value: "mb-123" }],
    collectEntitiesFn: collector([titleHit, externalHit]),
    requestFn: resolvedRequest({ "work-title": titleHit, "work-external": externalHit }) });
  assert.equal(report.candidates.length, 2);
  assert.equal(report.identity_confirmed, false);
  assert.deepEqual(report.candidates.map((candidate) => candidate.matched_reasons[0].query_mode).sort(),
    ["external_id_exact", "title_normalized_equality"]);
  assert.ok(report.candidates.some((candidate) => candidate.matched_reasons[0].strength === "weak_title_candidate"));
  assert.equal(report.decision, "needs_evidence");
});

test("属性精确命中使用独立 query mode", async () => {
  const item = entity("release-1", { kind: "release", attributes: { barcode: "4901234567890" } });
  const report = await findIdentity({ kind: "release", attributes: [{ key: "barcode", value: "4901234567890" }],
    collectEntitiesFn: collector([item]), requestFn: resolvedRequest({ "release-1": item }) });
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].matched_reasons[0].query_mode, "attribute_exact");
  assert.equal(report.candidates[0].matched_reasons[0].matched_field, "attributes.barcode");
  assert.equal(report.identity_confirmed, false);
});

test("resolve 失败时列为 unknown，不宣称无候选", async () => {
  const item = entity("work-private");
  const report = await findIdentity({ titles: ["夜明け"], collectEntitiesFn: collector([item]),
    requestFn: async () => ({ status: 403, body: { error: "forbidden" } }) });
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].canonical_id, null);
  assert.equal(report.candidates[0].canonical_verified, false);
  assert.equal(report.unknown[0].reason, "canonical_identity_unverified");
  assert.equal(report.decision, "needs_evidence");
});

test("分页失败或覆盖不完整时不报告不存在", async () => {
  const failed = await findIdentity({ titles: ["没有候选"], collectEntitiesFn: async () => {
    throw new Error("mock page 2 failed");
  }, requestFn: async () => { throw new Error("resolve must not run"); } });
  assert.equal(failed.candidates.length, 0);
  assert.equal(failed.decision, "needs_evidence");
  assert.equal(failed.unknown[0].reason, "pagination_or_snapshot_unverified");
  assert.equal(failed.coverage.complete, false);

  const partial = await findIdentity({ titles: ["没有候选"], collectEntitiesFn: collector([], { complete: false, pages: 1 }),
    requestFn: async () => { throw new Error("resolve must not run"); } });
  assert.equal(partial.decision, "needs_evidence");
  assert.equal(partial.unknown[0].reason, "coverage_incomplete");
  assert.equal(partial.identity_confirmed, false);
});

test("完整可见范围没有命中时只报告本次可见范围无候选", async () => {
  const report = await findIdentity({ titles: ["不存在的题名"], collectEntitiesFn: collector([]),
    requestFn: async () => { throw new Error("resolve must not run"); } });
  assert.equal(report.decision, "no_visible_candidate");
  assert.equal(report.candidates.length, 0);
  assert.match(report.decision_note, /不证明真实实例中不存在/u);
});

test("按 kind 和 work_id 调用共享快照收集接口，并将 requestFn 注入分页与 resolve", async () => {
  const observed = [];
  const item = entity("expr-1", { kind: "expression", work_id: "work-1" });
  const requestFn = resolvedRequest({ "expr-1": item });
  const report = await findIdentity({ kind: "expression", workId: "work-1", titles: ["夜明け"], limit: 37,
    collectEntitiesFn: collector([item], completeCoverage, observed), requestFn });
  assert.equal(report.candidates.length, 1);
  assert.equal(observed.length, 1);
  assert.deepEqual(observed[0].params, { work_id: "work-1" });
  assert.equal(observed[0].kind, "expression");
  assert.equal(observed[0].limit, 37);
  assert.equal(observed[0].requestFn, requestFn);
});

test("findIdentity 经真实 collectEntities 分页读取两页并解析命中实体", async () => {
  const records = [
    entity("work-1", { title: "同一题名" }),
    entity("work-2", { title: "同一题名" }),
    entity("work-3", { title: "另一标题", translations: { en: { title: "same title" } } }),
  ];
  const calls = [];
  const requestFn = async (pathname) => {
    const url = new URL(pathname, "https://local.invalid");
    calls.push(url);
    if (url.pathname === "/api/catalog/entities") {
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      const page = records.slice(offset, offset + limit);
      return { status: 200, body: { items: page, total: records.length } };
    }
    const prefix = "/api/catalog/entities/";
    assert.equal(url.pathname.slice(-"/resolve".length), "/resolve");
    const id = decodeURIComponent(url.pathname.slice(prefix.length, -"/resolve".length));
    const canonical = records.find((item) => item.id === id);
    return canonical
      ? { status: 200, body: canonical }
      : { status: 404, body: { error: "not_found" } };
  };
  const report = await findIdentity({ titles: ["same title"], limit: 2, collectEntitiesFn: collectEntities, requestFn });
  assert.equal(report.decision, "needs_evidence");
  assert.equal(report.coverage.complete, true);
  assert.equal(report.coverage.pages, 2);
  assert.equal(report.coverage.total, 3);
  assert.equal(report.coverage.rawCount, 3);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0].canonical_id, "work-3");
  assert.deepEqual(calls.slice(0, 2).map((url) => url.searchParams.get("offset")), ["0", "2"]);
  assert.ok(calls.slice(0, 2).every((url) => url.searchParams.get("kind") === "work"));
});

test("CLI 对不完整覆盖、unknown 和 errors 返回非零；有效候选可返回零", async () => {
  const output = [];
  const incompleteCode = await runCli(["--title", "没有命中"], {
    stdout: (text) => output.push(text),
    stderr: (text) => output.push(text),
    collectEntitiesFn: collector([], { complete: false, pages: 1, total: 2, rawCount: 1, uniqueCount: 1, failures: [] }),
    requestFn: async () => { throw new Error("resolve must not run"); },
  });
  assert.equal(incompleteCode, 2);

  const unresolvedItem = entity("work-unknown");
  const unknownCode = await runCli(["--title", "夜明け"], {
    stdout: (text) => output.push(text),
    stderr: (text) => output.push(text),
    collectEntitiesFn: collector([unresolvedItem]),
    requestFn: async () => ({ status: 403, body: { error: "forbidden" } }),
  });
  assert.equal(unknownCode, 2);

  const candidateCode = await runCli(["--title", "夜明け"], {
    stdout: (text) => output.push(text),
    stderr: (text) => output.push(text),
    collectEntitiesFn: collector([unresolvedItem]),
    requestFn: resolvedRequest({ "work-unknown": unresolvedItem }),
  });
  assert.equal(candidateCode, 0);
});

test("--out 写入可解析 JSON 并以换行结尾", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mf-find-identity-"));
  try {
    const outputPath = join(directory, "report.json");
    const item = entity("work-1");
    const code = await runCli(["--title", "夜明け", "--out", outputPath], {
      stdout: () => {},
      stderr: (text) => { throw new Error(text); },
      collectEntitiesFn: collector([item]),
      requestFn: resolvedRequest({ "work-1": item }),
    });
    assert.equal(code, 0);
    const serialized = await readFile(outputPath, "utf8");
    assert.ok(serialized.endsWith("\n"));
    const report = JSON.parse(serialized);
    assert.equal(report.decision, "needs_evidence");
    assert.ok("coverage" in report && "candidates" in report && "unknown" in report && "errors" in report);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("--help 无凭据可用，模块导入不会执行 CLI", () => {
  const env = { ...process.env };
  delete env.MF_BASE;
  delete env.MF_PAT;
  delete env.MF_CREDENTIALS;
  const help = spawnSync(process.execPath, [TOOL_PATH, "--help"], { encoding: "utf8", env });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /不会合并、新建实体或修改题名/u);

  const imported = spawnSync(process.execPath, ["--input-type=module", "-e",
    "await import(process.argv[1]); console.log('import-ok')", pathToFileURL(TOOL_PATH).href], { encoding: "utf8", env });
  assert.equal(imported.status, 0, imported.stderr);
  assert.match(imported.stdout, /import-ok/u);
});
