import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  normalizePageLimit,
  putEntity,
  writableEntity,
} from "./metafusion-api.mjs";

process.env.MF_BASE = "https://example.com";
process.env.MF_PAT = "test-token-not-a-real-credential";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function currentEntity() {
  return {
    id: "entity-1",
    kind: "work",
    version: 4,
    title: "Example",
    original_language: "en-US",
    types: ["film"],
    attributes: { language: "en" },
    external_ids: {},
    pictures: [],
    translations: {
      "en-US": { title: "Example", summary: "Official summary" },
    },
    status: "draft",
    created_by: "user-1",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

test("normalizePageLimit 拒绝目标实例不会接受的边界", () => {
  assert.equal(normalizePageLimit(), 100);
  assert.equal(normalizePageLimit(1), 1);
  for (const invalid of [0, -1, 101, 1.5, Number.NaN]) {
    assert.throws(() => normalizePageLimit(invalid), /1–100/);
  }
});

test("writableEntity 保留完整可写实体并剔除只读投影", () => {
  const writable = writableEntity(currentEntity());
  assert.deepEqual(writable.translations["en-US"], {
    title: "Example",
    summary: "Official summary",
  });
  assert.deepEqual(writable.attributes, { language: "en" });
  assert.equal(writable.created_by, undefined);
  assert.equal(writable.updated_at, undefined);
});

test("putEntity 使用完整 PUT、expected_version，并在成功后回读", async () => {
  const calls = [];
  let getCount = 0;
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push({ url: String(url), method, body: init.body ? JSON.parse(init.body) : null });
    if (method === "PUT") {
      const updated = { ...currentEntity(), version: 5, updated_at: "2026-01-02T00:00:00Z" };
      return jsonResponse(updated);
    }
    getCount += 1;
    return jsonResponse(getCount === 1 ? currentEntity() : { ...currentEntity(), version: 5, updated_at: "2026-01-02T00:00:00Z" });
  };

  const result = await putEntity("entity-1", (entity) => {
    entity.translations["zh-CN"] = { title: "示例" };
    return true;
  }, {
    editNote: "根据官方作品页补充中文正式译名",
    sources: [{
      kind: "url",
      citation: "官方本地化页：支持 work.translations.zh-CN.title",
      url: "https://example.org/official-zh-CN",
    }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.readbackOK, true);
  assert.equal(result.readback.version, 5);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => call.method), ["GET", "PUT", "GET"]);
  assert.equal(calls[1].body.expected_version, 4);
  assert.equal(calls[1].body.entity.created_by, undefined);
  assert.equal(calls[1].body.entity.updated_at, undefined);
  assert.equal(calls[1].body.entity.translations["zh-CN"].title, "示例");
  assert.match(calls[1].body.sources[0].citation, /translations\.zh-CN\.title/);
});

test("putEntity 遇到 409 不自动重放，也不把冲突当成功", async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push(method);
    if (method === "PUT") return jsonResponse({ error: "version_conflict" }, 409);
    return jsonResponse(currentEntity());
  };

  const result = await putEntity("entity-1", (entity) => {
    entity.title = "Changed";
    return true;
  }, {
    editNote: "并发测试",
    sources: [{ kind: "publication", citation: "官方出版记录：支持 work.title" }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(result.readbackOK, false);
  assert.equal(result.readbackStatus, null);
  assert.deepEqual(calls, ["GET", "PUT"]);
});
