import assert from "node:assert/strict";
import { test } from "node:test";
import { guardedUpdate } from "./mf-guarded-update.mjs";

const entity = { id: "example-work", kind: "work", version: 1, title: "Original", status: "draft" };
const plan = {
  id: entity.id, expected_version: 1, patch: { title: "Revised" }, edit_note: "官方题名修订",
  sources: [{ kind: "publication", citation: "官方目录支持 title" }],
};

for (const [status, errorCode] of [[401, "invalid_token"], [401, "authentication_required"],
  [403, "forbidden"], [503, "auth_unavailable"]]) {
  for (const stage of ["read", "write"]) {
    test(`${stage} HTTP ${status} preserves ${errorCode} without retries`, async () => {
      let writes = 0;
      const requestFn = async (_path, options = {}) => {
        if (options.method === "PUT") {
          writes += 1;
          return { status, body: { error: errorCode } };
        }
        return stage === "read" ? { status, body: { error: errorCode } } : { status: 200, body: entity };
      };
      const result = await guardedUpdate(plan, { requestFn, apply: true });
      assert.equal(result.errorCode, errorCode);
      assert.equal(result.httpStatus, status);
      assert.equal(result.ok, false);
      assert.equal(result.applied, stage === "write" && status === 503 ? null : false);
      assert.equal(writes, stage === "write" ? 1 : 0);
    });
  }
}

test("arbitrary bodies and status-mismatched codes are not emitted", async () => {
  for (const [status, body] of [[401, { error: "mfp_secret_from_body" }], [401, { error: "forbidden" }],
    [403, { error: "invalid_token" }], [500, { error: "auth_unavailable" }],
    [401, { error: { token: "mfp_secret_from_body" } }], [401, { code: "invalid_token" }]]) {
    const result = await guardedUpdate(plan, { apply: true, requestFn: async (_path, options = {}) =>
      options.method === "PUT" ? { status, body } : { status: 200, body: entity } });
    assert.equal(result.errorCode, undefined);
    assert.equal(JSON.stringify(result).includes("mfp_secret_from_body"), false);
  }
});
