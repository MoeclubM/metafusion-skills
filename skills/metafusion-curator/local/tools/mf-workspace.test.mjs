import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { diffDocument, rebasePatch, runWorkspace } from "./mf-workspace.mjs";

const clone = (x) => JSON.parse(JSON.stringify(x));
function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "mf-workspace-")),
    dir = path.join(parent, "working");
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const id = randomUUID(),
    docs = new Map([
      [
        id,
        {
          id,
          kind: "work",
          version: 1,
          title: "base",
          attributes: { language: "ja" },
          translations: { en: { title: "base" } },
          pictures: [],
          status: "draft",
        },
      ],
    ]),
    receipts = new Map(),
    calls = [];
  const fn = async (p, o = {}) => {
    calls.push({ p, o: clone(o) });
    if (p.endsWith("/checkout"))
      return {
        status: 200,
        body: {
          actor_id: "fixture",
          definitions_etag: "defs",
          entities: o.body.entity_ids.map((id) => clone(docs.get(id))),
          relations: [],
        },
      };
    if (p.includes("/commits/") && !p.endsWith("/preview"))
      return receipts.has(p.split("/").at(-1))
        ? { status: 200, body: clone(receipts.get(p.split("/").at(-1))) }
        : { status: 404, body: { error: "not_found" } };
    if (p.endsWith("/commits/preview"))
      return {
        status: 200,
        body: { id: o.body.id, applied: false, refs: {}, items: [] },
      };
    if (p.endsWith("/commits")) {
      const items = o.body.operations.map((op) => {
        const doc = docs.get(op.id),
          rebased = rebasePatch(doc, doc, op.patch);
        docs.set(op.id, { ...rebased.working, version: doc.version + 1 });
        return {
          target: op.target,
          id: op.id,
          version: doc.version + 1,
          changed: true,
          merged: false,
        };
      });
      const receipt = { id: o.body.id, applied: true, refs: {}, items };
      receipts.set(receipt.id, receipt);
      return { status: 200, body: clone(receipt) };
    }
    throw new Error(`unexpected ${p}`);
  };
  const opts = { dir, origin: "https://example.test", requestFn: fn };
  const read = (rel) =>
    JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8"));
  const edit = (patch) => {
    const rel = `entities/${id}.json`,
      doc = read(rel);
    fs.writeFileSync(path.join(dir, rel), JSON.stringify({ ...doc, ...patch }));
  };
  const seal = async () => {
    await runWorkspace("init", opts);
    await runWorkspace("checkout", { ...opts, entityIDs: [id] });
    edit({ title: "mine" });
    return runWorkspace("commit", {
      ...opts,
      note: "verified edit",
      sources: [{ kind: "self", citation: "fixture" }],
    });
  };
  return { dir, id, docs, receipts, calls, fn, opts, read, edit, seal };
}

test("granular diff preserves unrelated fields, arrays remain atomic, readonly mutation rejected", () => {
  const base = {
    id: "id",
    version: 1,
    title: "base",
    attributes: { language: "ja", duration: 3 },
    pictures: [{ url: "a" }],
  };
  assert.deepEqual(
    diffDocument(
      base,
      { ...base, attributes: { language: "ja", duration: 4 } },
      "entity",
    ),
    [{ path: "/attributes/duration", value: 4 }],
  );
  assert.deepEqual(
    diffDocument(base, { ...base, pictures: [{ url: "b" }] }, "entity"),
    [{ path: "/pictures", value: [{ url: "b" }] }],
  );
  assert.throws(
    () => diffDocument(base, { ...base, version: 2 }, "entity"),
    /immutable_field/,
  );
  assert.deepEqual(
    diffDocument(
      { attributes: null },
      { attributes: { language: "ja" } },
      "entity",
    ),
    [{ path: "/attributes/language", value: "ja" }],
  );
});
test("rebase merges disjoint fields and requires explicit overlap resolution", () => {
  const base = { title: "base", attributes: { language: "ja" } },
    current = { title: "theirs", attributes: { language: "ja" } },
    patch = [
      { path: "/title", value: "ours" },
      { path: "/attributes/language", value: "en" },
    ];
  assert.deepEqual(rebasePatch(base, current, patch).conflicts, ["/title"]);
  assert.equal(
    rebasePatch(base, current, patch, { "/title": "ours" }).working.title,
    "ours",
  );
  assert.equal(
    rebasePatch(base, current, patch, { "/title": "theirs" }).working.title,
    "theirs",
  );
  const special = JSON.parse('{"attributes":{"__proto__":{"polluted":false}}}');
  rebasePatch(special, special, [
    { path: "/attributes/__proto__/polluted", value: true },
  ]);
  assert.equal({}.polluted, undefined);
});
test("commit is local, push atomic receipt refreshes base, no entity PUT", async (t) => {
  const f = fixture(t),
    local = await f.seal();
  assert.equal(
    f.calls.some((c) => c.p.endsWith("/commits")),
    false,
  );
  const r = await runWorkspace("push", { ...f.opts, apply: true });
  assert.equal(r.ok, true);
  assert.equal(r.receipt.id, local.commit_id);
  assert.equal(f.read(".mf/state.json").pending, null);
  assert.equal(f.read(`entities/${f.id}.json`).version, 2);
  assert.equal(
    f.calls.some((c) => c.o.method === "PUT"),
    false,
  );
});
test("preview validates complete receipt and keeps sealed pending commit", async (t) => {
  const f = fixture(t),
    local = await f.seal();
  const malformed = await runWorkspace("preview", f.opts);
  assert.equal(malformed.ok, false);
  const requestFn = async (p, o) =>
    p.endsWith("/preview")
      ? {
          status: 200,
          body: {
            id: o.body.id,
            applied: false,
            refs: {},
            items: [
              {
                target: "entity",
                id: f.id,
                version: 2,
                changed: true,
                merged: false,
              },
            ],
          },
        }
      : f.fn(p, o);
  const result = await runWorkspace("preview", { ...f.opts, requestFn });
  assert.equal(result.ok, true);
  assert.equal(f.read(".mf/state.json").pending.id, local.commit_id);
  assert.equal(f.docs.get(f.id).version, 1);
  assert.equal(f.receipts.size, 0);
});
test("entity creation requires identity review and seals explicit local references", async (t) => {
  const f = fixture(t);
  await runWorkspace("init", f.opts);
  const file = path.join(f.dir, "source.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      kind: "expression",
      title: "Recording",
      work_id: { $ref: "work" },
    }),
  );
  await assert.rejects(
    runWorkspace("create", {
      ...f.opts,
      target: "entity",
      ref: "recording",
      file,
    }),
    /identity_review_required/,
  );
  const review = { reviewed_candidate_ids: [] };
  await runWorkspace("create", {
    ...f.opts,
    target: "entity",
    ref: "recording",
    file,
    review,
  });
  const local = await runWorkspace("commit", {
    ...f.opts,
    note: "fixture",
    sources: [{ kind: "self", citation: "fixture" }],
  });
  const op = f.read(`.mf/commits/${local.commit_id}.json`).request
    .operations[0];
  assert.deepEqual(op.reviewed_candidate_ids, []);
  assert.deepEqual(op.document.work_id, { $ref: "work" });
  assert.equal(
    f.calls.some((c) => c.p.endsWith("/commits")),
    false,
  );
});
test("lost response recovers durable receipt without sending another mutation", async (t) => {
  const f = fixture(t);
  await f.seal();
  const requestFn = async (p, o) => {
    const r = await f.fn(p, o);
    return p.endsWith("/commits")
      ? { status: 0, body: { error: "network" } }
      : r;
  };
  const r = await runWorkspace("push", { ...f.opts, requestFn, apply: true });
  assert.equal(r.ok, true);
  assert.equal(f.calls.filter((c) => c.p.endsWith("/commits")).length, 1);
});
test("unknown push remains sealed; preview and rebase cannot turn uncertainty into a new ID", async (t) => {
  const f = fixture(t),
    sealed = await f.seal();
  const unknown = async (p, o) =>
    p.endsWith("/commits")
      ? { status: 0, body: { error: "network" } }
      : f.fn(p, o);
  const r = await runWorkspace("push", {
    ...f.opts,
    requestFn: unknown,
    apply: true,
  });
  assert.equal(r.applied, null);
  await assert.rejects(
    runWorkspace("preview", f.opts),
    /unknown_push_requires_receipt_same_id/,
  );
  await assert.rejects(
    runWorkspace("rebase", f.opts),
    /unknown_push_requires_receipt_same_id/,
  );
  await assert.rejects(
    runWorkspace("commit", { ...f.opts, note: "again", sources: [{}] }),
    /pending_commit/,
  );
  const rateLimited = async (p, o) =>
    p.endsWith("/commits")
      ? { status: 429, body: { error: "rate_limited" } }
      : f.fn(p, o);
  const again = await runWorkspace("push", {
    ...f.opts,
    requestFn: rateLimited,
    apply: true,
  });
  assert.equal(again.applied, null);
  assert.equal(f.read(".mf/state.json").pending.id, sealed.commit_id);
  assert.equal(f.read(".mf/state.json").pending.outcome, "unknown");
});
test("explicit conflict rebases with new ID, keeping old immutable commit", async (t) => {
  const f = fixture(t),
    local = await f.seal();
  f.docs.set(f.id, { ...f.docs.get(f.id), title: "theirs", version: 2 });
  const reject = async (p, o) =>
    p.endsWith("/commits")
      ? { status: 409, body: { error: "commit_conflict" } }
      : f.fn(p, o);
  await runWorkspace("push", { ...f.opts, requestFn: reject, apply: true });
  const conflict = await runWorkspace("rebase", f.opts);
  assert.equal(conflict.reason, "rebase_conflict");
  const newCommit = await runWorkspace("rebase", {
    ...f.opts,
    resolutions: { [`entity:${f.id}`]: { "/title": "ours" } },
  });
  assert.notEqual(newCommit.commit_id, local.commit_id);
  assert.equal(newCommit.supersedes, local.commit_id);
  assert.equal(
    f.read(`.mf/commits/${local.commit_id}.json`).request.operations[0]
      .base_version,
    1,
  );
  assert.equal(
    f.read(`.mf/commits/${newCommit.commit_id}.json`).request.operations[0]
      .base_version,
    2,
  );
});
test("known transaction busy preserves commit and permits explicit same-ID push", async (t) => {
  const f = fixture(t), sealed = await f.seal();
  const busy = async (p, o) => p.endsWith("/commits")
    ? { status: 503, body: { error: "transaction_busy", applied: false } } : f.fn(p, o);
  const result = await runWorkspace("push", { ...f.opts, requestFn: busy, apply: true });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "push_busy_keep_same_commit");
  assert.equal(result.result.error, "transaction_busy");
  assert.equal(f.read(".mf/state.json").pending.id, sealed.commit_id);
  assert.equal(f.read(".mf/state.json").pending.outcome, "rejected");
  const retry = await runWorkspace("push", { ...f.opts, apply: true });
  assert.equal(retry.ok, true);
  assert.equal(retry.receipt.id, sealed.commit_id);
});
test("a busy response cannot clear uncertainty from a previous push", async (t) => {
  const f = fixture(t), sealed = await f.seal();
  const failed = async (p, o) => p.endsWith("/commits") ? { status: 0, body: {} } : f.fn(p,o);
  await runWorkspace("push", { ...f.opts, requestFn: failed, apply: true });
  const busy = async (p, o) => p.endsWith("/commits")
    ? { status: 503, body: { error: "transaction_busy", applied: false } } : f.fn(p, o);
  const result = await runWorkspace("push", { ...f.opts, requestFn: busy, apply: true });
  assert.equal(result.applied, null);
  assert.equal(f.read(".mf/state.json").pending.id, sealed.commit_id);
  assert.equal(f.read(".mf/state.json").pending.outcome, "unknown");
  await assert.rejects(runWorkspace("rebase", f.opts), /unknown_push_requires_receipt_same_id/);
});
test("dirty checkout, origin mismatch, tampered commit, stale local lock refuse", async (t) => {
  const f = fixture(t),
    local = await f.seal();
  await assert.rejects(
    runWorkspace("status", { ...f.opts, origin: "https://other.test" }),
    /origin_mismatch/,
  );
  const commitFile = path.join(f.dir, `.mf/commits/${local.commit_id}.json`),
    corrupt = f.read(`.mf/commits/${local.commit_id}.json`);
  corrupt.request.edit_note = "changed";
  fs.writeFileSync(commitFile, JSON.stringify(corrupt));
  await assert.rejects(
    runWorkspace("push", { ...f.opts, apply: true }),
    /integrity_failure/,
  );
  fs.writeFileSync(path.join(f.dir, ".mf/lock"), "");
  await assert.rejects(runWorkspace("status", f.opts), /EEXIST/);
});
test("edits after a successful push preserve files and applied receipt", async (t) => {
  const f = fixture(t);
  await f.seal();
  const requestFn = async (p, o) => {
    const r = await f.fn(p, o);
    if (p.endsWith("/commits")) f.edit({ title: "extra edit" });
    return r;
  };
  const r = await runWorkspace("push", { ...f.opts, requestFn, apply: true });
  assert.equal(r.applied, true);
  assert.equal(r.reason, "working_tree_changed_after_commit");
  assert.equal(f.read(`entities/${f.id}.json`).title, "extra edit");
  assert.equal(f.read(".mf/state.json").pending.outcome, "applied");
});
