#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  request,
  configuredOrigin,
  publicFailure,
} from "../metafusion-api.mjs";

const API = "/api/catalog";
const fields = {
  entity: new Set(
    "title original_language translations attributes external_ids pictures status content_unit_id parent_id position number contents subjects".split(
      " ",
    ),
  ),
  relation: new Set(["position", "attributes"]),
};
const record = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const has = (x, k) => Object.hasOwn(x, k);
export function canonical(x) {
  if (Array.isArray(x)) return x.map(canonical);
  if (record(x))
    return Object.fromEntries(
      Object.keys(x)
        .sort()
        .map((k) => [k, canonical(x[k])]),
    );
  return x;
}
const same = (a, b) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const digest = (x) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(x)))
    .digest("hex");
const escape = (x) => x.replaceAll("~", "~0").replaceAll("/", "~1");
const clone = (x) => JSON.parse(JSON.stringify(x));
export function diffDocument(base, working, target) {
  if (!fields[target] || !record(base) || !record(working))
    throw new Error("invalid_working_document");
  for (const k of new Set([...Object.keys(base), ...Object.keys(working)])) {
    if (!fields[target].has(k) && !same(base[k], working[k]))
      throw new Error(`immutable_field:${k}`);
  }
  const result = [];
  function diff(a, b, p, aok, bok) {
    if (aok === bok && same(a, b)) return;
    if (!bok) {
      result.push({ path: p, remove: true });
      return;
    }
    if (record(a) && record(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
        diff(a[k], b[k], `${p}/${escape(k)}`, has(a, k), has(b, k));
    } else if ((!aok || a === null) && record(b)) {
      // Sparse patches let independently added object keys merge.
      const keys = Object.keys(b);
      if (keys.length === 0) result.push({ path: p, value: b });
      else
        for (const k of keys)
          diff(undefined, b[k], `${p}/${escape(k)}`, false, true);
    } else result.push({ path: p, value: b });
  }
  for (const k of fields[target])
    diff(base[k], working[k], `/${escape(k)}`, has(base, k), has(working, k));
  if (result.length > 200) throw new Error("too_many_patch_paths");
  return result;
}
function parts(pointer) {
  return pointer
    .slice(1)
    .split("/")
    .map((x) => x.replaceAll("~1", "/").replaceAll("~0", "~"));
}
function getAt(doc, p) {
  let x = doc;
  for (const k of parts(p)) {
    if (!record(x) || !has(x, k)) return { exists: false };
    x = x[k];
  }
  return { exists: true, value: x };
}
function putAt(doc, p, value, remove) {
  const keys = parts(p);
  let x = doc;
  for (const k of keys.slice(0, -1)) {
    if (!has(x, k) || !record(x[k]))
      Object.defineProperty(x, k, {
        value: {},
        writable: true,
        enumerable: true,
        configurable: true,
      });
    x = x[k];
  }
  if (remove) delete x[keys.at(-1)];
  else
    Object.defineProperty(x, keys.at(-1), {
      value: clone(value),
      writable: true,
      enumerable: true,
      configurable: true,
    });
}
export function rebasePatch(base, current, patch, resolutions = {}) {
  const working = clone(current),
    conflicts = [];
  for (const p of patch) {
    const b = getAt(base, p.path),
      c = getAt(current, p.path),
      want = p.remove ? { exists: false } : { exists: true, value: p.value };
    if (same(c, want)) continue;
    if (!same(b, c)) {
      const choice = resolutions[p.path];
      if (choice === "theirs") continue;
      if (choice !== "ours") {
        conflicts.push(p.path);
        continue;
      }
    }
    putAt(working, p.path, p.value, p.remove);
  }
  return { working, conflicts };
}
function read(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function save(file, value, exclusive = false) {
  const text = JSON.stringify(value, null, 2) + "\n";
  if (exclusive) {
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeFileSync(fd, text, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return;
  }
  const temp = `${file}.${randomUUID()}.tmp`,
    fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}
function safeFile(root, rel) {
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep))
    throw new Error("workspace_path_escape");
  let current = root;
  for (const p of path.relative(root, full).split(path.sep)) {
    current = path.join(current, p);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
      throw new Error("workspace_symlink");
  }
  return full;
}
function requireResponse(r) {
  if (r.status < 200 || r.status >= 300)
    throw new Error(`HTTP_${r.status}:${r.body?.error ?? "unknown"}`);
  return r.body;
}
function validateCheckout(body, entityIDs = [], relationIDs = []) {
  if (
    !record(body) ||
    typeof body.actor_id !== "string" ||
    !body.actor_id ||
    typeof body.definitions_etag !== "string" ||
    !Array.isArray(body.entities) ||
    !Array.isArray(body.relations)
  )
    throw new Error("invalid_checkout_response");
  for (const [target, ids] of [
    ["entity", entityIDs],
    ["relation", relationIDs],
  ]) {
    const items = body[target === "entity" ? "entities" : "relations"];
    if (
      items.length !== ids.length ||
      new Set(items.map((x) => x.id)).size !== ids.length ||
      items.some(
        (x) =>
          !ids.includes(x.id) ||
          !Number.isSafeInteger(x.version) ||
          x.version < 1,
      )
    )
      throw new Error("incomplete_checkout");
  }
  return body;
}
function validReceipt(receipt, commit, applied = true) {
  if (
    !record(receipt) ||
    receipt.id !== commit.id ||
    receipt.applied !== applied ||
    !record(receipt.refs) ||
    !Array.isArray(receipt.items) ||
    receipt.items.length !== commit.operations.length
  )
    return false;
  return commit.operations.every((op, i) => {
    const x = receipt.items[i];
    return (
      x.target === op.target &&
      x.id === (op.action === "create" ? receipt.refs[op.ref] : op.id) &&
      typeof x.id === "string" &&
      /^[0-9a-f-]{36}$/.test(x.id) &&
      Number.isSafeInteger(x.version) &&
      x.version > 0 &&
      typeof x.changed === "boolean" &&
      typeof x.merged === "boolean"
    );
  });
}

// One workspace per editor. A local exclusive lock prevents two processes from
// publishing or changing its receipt at once; server concurrency stays independent.
export async function runWorkspace(
  command,
  {
    dir,
    origin,
    entityIDs = [],
    relationIDs = [],
    target = "entity",
    ref,
    file,
    review,
    note,
    sources,
    commitID,
    resolutions = {},
    reviews = {},
    apply = false,
    requestFn = request,
  } = {},
) {
  if (!dir || !origin) throw new Error("workspace_and_origin_required");
  const root = path.resolve(dir),
    stateFile = safeFile(root, ".mf/state.json");
  if (command === "init") {
    if (fs.existsSync(root)) throw new Error("workspace_directory_exists");
    const checkout = validateCheckout(
      requireResponse(
        await requestFn(`${API}/checkout`, {
          method: "POST",
          body: { entity_ids: [], relation_ids: [] },
        }),
      ),
    );
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(root, ".mf"));
    for (const d of [
      "entities",
      "relations",
      ".mf/commits",
      ".mf/receipts",
      ".mf/refresh",
    ])
      fs.mkdirSync(path.join(root, d));
    save(
      stateFile,
      {
        format: 1,
        origin,
        actor_id: checkout.actor_id,
        definitions_etag: checkout.definitions_etag,
        entries: [],
        pending: null,
      },
      true,
    );
    return { ok: true, dir: root, definitions_etag: checkout.definitions_etag };
  }
  if (!fs.existsSync(stateFile)) throw new Error("workspace_not_initialized");
  const lockFile = safeFile(root, ".mf/lock");
  const lock = fs.openSync(lockFile, "wx", 0o600);
  fs.writeFileSync(
    lock,
    JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }),
  );
  try {
    const state = read(stateFile);
    if (state.format !== 1 || state.origin !== origin)
      throw new Error("workspace_origin_mismatch");
    const fileFor = (e) => safeFile(root, e.file);
    const status = () =>
      state.entries
        .map((e) => ({
          target: e.target,
          id: e.id ?? null,
          ref: e.ref ?? null,
          file: e.file,
          patch: e.base
            ? diffDocument(e.base, read(fileFor(e)), e.target)
            : null,
        }))
        .filter((e, i) => e.patch === null || e.patch.length);
    if (command === "status")
      return { ok: true, pending: state.pending, changes: status() };
    if (command === "checkout") {
      if (state.pending)
        throw new Error("pending_commit_requires_receipt_or_rebase");
      if (status().length) throw new Error("working_tree_dirty");
      const allEntities = [
        ...new Set([
          ...state.entries
            .filter((e) => e.target === "entity")
            .map((e) => e.id),
          ...entityIDs,
        ]),
      ];
      const allRelations = [
        ...new Set([
          ...state.entries
            .filter((e) => e.target === "relation")
            .map((e) => e.id),
          ...relationIDs,
        ]),
      ];
      if (allEntities.length + allRelations.length > 100)
        throw new Error("workspace_entity_limit");
      const co = validateCheckout(
        requireResponse(
          await requestFn(`${API}/checkout`, {
            method: "POST",
            body: { entity_ids: allEntities, relation_ids: allRelations },
          }),
        ),
        allEntities,
        allRelations,
      );
      if (co.actor_id !== state.actor_id)
        throw new Error("workspace_actor_mismatch");
      state.entries = [];
      state.definitions_etag = co.definitions_etag;
      for (const [target, items] of [
        ["entity", co.entities],
        ["relation", co.relations],
      ])
        for (const doc of items) {
          const rel = `${target === "entity" ? "entities" : "relations"}/${doc.id}.json`;
          save(safeFile(root, rel), doc);
          state.entries.push({ target, id: doc.id, file: rel, base: doc });
        }
      save(stateFile, state);
      return { ok: true, checked_out: state.entries.length };
    }
    if (command === "create") {
      if (state.pending) throw new Error("pending_commit");
      if (
        !fields[target] ||
        !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(ref ?? "") ||
        !file
      )
        throw new Error("invalid_create_arguments");
      if (
        state.entries.length >= 100 ||
        state.entries.some((e) => e.ref === ref)
      )
        throw new Error("duplicate_or_excessive_ref");
      const doc = read(file);
      if (
        !record(doc) ||
        doc.id ||
        doc.version ||
        doc.created_by ||
        doc.redirect_id ||
        doc.updated_at ||
        doc.via
      )
        throw new Error("server_fields_forbidden");
      if (
        target === "entity" &&
        (!record(review) ||
          !Array.isArray(review.reviewed_candidate_ids) ||
          review.reviewed_candidate_ids.some((x) => typeof x !== "string"))
      )
        throw new Error("identity_review_required");
      const rel = `${target === "entity" ? "entities" : "relations"}/new-${ref}.json`;
      save(safeFile(root, rel), doc, true);
      state.entries.push({
        target,
        ref,
        file: rel,
        ...(target === "entity" ? { review } : {}),
      });
      save(stateFile, state);
      return { ok: true, file: rel };
    }
    const loadCommit = (id) => {
      if (!/^[0-9a-f-]{36}$/.test(id ?? ""))
        throw new Error("commit_id_required");
      const sealed = read(safeFile(root, `.mf/commits/${id}.json`));
      if (
        sealed.origin !== origin ||
        sealed.hash !== digest(sealed.request) ||
        sealed.request.id !== id
      )
        throw new Error("commit_integrity_failure");
      return sealed;
    };
    const seal = (operations, editNote, evidence, snapshots) => {
      if (!operations.length || operations.length > 100)
        throw new Error("empty_or_excessive_commit");
      if (!editNote?.trim() || !Array.isArray(evidence) || !evidence.length)
        throw new Error("commit_evidence_required");
      const request = {
        id: randomUUID(),
        definitions_etag: state.definitions_etag,
        edit_note: editNote,
        sources: evidence,
        operations,
      };
      save(
        safeFile(root, `.mf/commits/${request.id}.json`),
        { origin, hash: digest(request), request, snapshots },
        true,
      );
      state.pending = { id: request.id, outcome: "local" };
      save(stateFile, state);
      return { ok: true, commit_id: request.id, operations: operations.length };
    };
    if (command === "commit") {
      if (state.pending) throw new Error("pending_commit");
      const operations = [],
        snapshots = {};
      for (const e of state.entries) {
        const doc = read(fileFor(e));
        snapshots[e.file] = doc;
        if (!e.id)
          operations.push({
            target: e.target,
            action: "create",
            ref: e.ref,
            document: doc,
            ...(e.target === "entity"
              ? { reviewed_candidate_ids: e.review.reviewed_candidate_ids }
              : {}),
          });
        else {
          const patch = diffDocument(e.base, doc, e.target);
          if (patch.length)
            operations.push({
              target: e.target,
              action: "update",
              id: e.id,
              base_version: e.base.version,
              patch,
            });
        }
      }
      return seal(operations, note, sources, snapshots);
    }
    const id = commitID ?? state.pending?.id,
      sealed = loadCommit(id),
      commit = sealed.request;
    if (!state.pending || state.pending.id !== id)
      throw new Error("commit_not_pending");
    async function finalize(receipt) {
      if (!validReceipt(receipt, commit)) {
        state.pending.outcome = "unknown";
        save(stateFile, state);
        return {
          ok: false,
          applied: null,
          reason: "invalid_receipt",
          commit_id: id,
        };
      }
      save(safeFile(root, `.mf/receipts/${id}.json`), receipt);
      state.pending.outcome = "applied";
      save(stateFile, state);
      const journalFile = safeFile(root, `.mf/refresh/${id}.json`);
      const journal = fs.existsSync(journalFile) ? read(journalFile) : {};
      // Preserve edits made after sealing: receipt is durable but refresh waits.
      for (const e of state.entries)
        if (
          !same(read(fileFor(e)), sealed.snapshots[e.file]) &&
          !same(read(fileFor(e)), journal[e.file])
        ) {
          return {
            ok: false,
            applied: true,
            reason: "working_tree_changed_after_commit",
            receipt,
          };
        }
      const entityIDs = state.entries
        .filter((e) => e.target === "entity")
        .map((e) => e.id ?? receipt.refs[e.ref]);
      const relationIDs = state.entries
        .filter((e) => e.target === "relation")
        .map((e) => e.id ?? receipt.refs[e.ref]);
      let co;
      try {
        co = validateCheckout(
          requireResponse(
            await requestFn(`${API}/checkout`, {
              method: "POST",
              body: { entity_ids: entityIDs, relation_ids: relationIDs },
            }),
          ),
          entityIDs,
          relationIDs,
        );
      } catch (error) {
        state.pending.outcome = "applied";
        save(stateFile, state);
        return {
          ok: false,
          applied: true,
          reason: "receipt_confirmed_checkout_pending",
          detail: String(error),
          receipt,
        };
      }
      if (co.actor_id !== state.actor_id)
        throw new Error("workspace_actor_mismatch");
      for (const item of receipt.items) {
        const doc = (
          item.target === "entity" ? co.entities : co.relations
        ).find((e) => e.id === item.id);
        if (doc.version < item.version)
          throw new Error("stale_checkout_after_push");
      }
      save(
        journalFile,
        Object.fromEntries(
          state.entries.map((e) => [
            e.file,
            (e.target === "entity" ? co.entities : co.relations).find(
              (x) => x.id === (e.id ?? receipt.refs[e.ref]),
            ),
          ]),
        ),
      );
      for (const e of state.entries) {
        e.id = e.id ?? receipt.refs[e.ref];
        const doc = (e.target === "entity" ? co.entities : co.relations).find(
          (x) => x.id === e.id,
        );
        e.base = doc;
        delete e.ref;
        save(fileFor(e), doc);
      }
      state.definitions_etag = co.definitions_etag;
      state.pending = null;
      save(stateFile, state);
      return { ok: true, applied: true, receipt };
    }
    if (command === "rebase") {
      if (!["conflict", "rejected"].includes(state.pending.outcome))
        throw new Error("unknown_push_requires_receipt_same_id");
      const receipt = await requestFn(`${API}/commits/${id}`);
      if (receipt.status === 200) return finalize(receipt.body);
      if (receipt.status !== 404) throw new Error("receipt_unavailable");
      for (const e of state.entries)
        if (!same(read(fileFor(e)), sealed.snapshots[e.file]))
          throw new Error("working_tree_changed_after_commit");
      const entityIDs = state.entries
          .filter((e) => e.id && e.target === "entity")
          .map((e) => e.id),
        relationIDs = state.entries
          .filter((e) => e.id && e.target === "relation")
          .map((e) => e.id);
      const co = validateCheckout(
        requireResponse(
          await requestFn(`${API}/checkout`, {
            method: "POST",
            body: { entity_ids: entityIDs, relation_ids: relationIDs },
          }),
        ),
        entityIDs,
        relationIDs,
      );
      if (co.actor_id !== state.actor_id)
        throw new Error("workspace_actor_mismatch");
      const rebased = [],
        conflicts = [],
        snapshots = {},
        pendingWrites = [];
      for (const op of commit.operations) {
        if (op.action === "create") {
          const refreshed = reviews[op.ref];
          if (
            refreshed !== undefined &&
            (!Array.isArray(refreshed) ||
              refreshed.some((x) => typeof x !== "string"))
          )
            throw new Error("invalid_identity_review");
          rebased.push({
            ...op,
            ...(refreshed !== undefined
              ? { reviewed_candidate_ids: refreshed }
              : {}),
          });
          continue;
        }
        const entry = state.entries.find(
            (e) => e.target === op.target && e.id === op.id,
          ),
          current = (op.target === "entity" ? co.entities : co.relations).find(
            (e) => e.id === op.id,
          );
        const result = rebasePatch(
          entry.base,
          current,
          op.patch,
          resolutions[`${op.target}:${op.id}`] ?? {},
        );
        if (result.conflicts.length)
          conflicts.push({
            target: op.target,
            id: op.id,
            paths: result.conflicts,
          });
        const patch = diffDocument(current, result.working, op.target);
        if (patch.length)
          rebased.push({ ...op, base_version: current.version, patch });
        pendingWrites.push({ entry, current, working: result.working });
      }
      if (conflicts.length)
        return {
          ok: false,
          applied: false,
          reason: "rebase_conflict",
          conflicts,
        };
      for (const entry of state.entries.filter((e) => e.id)) {
        const edit = pendingWrites.find((x) => x.entry === entry),
          current = (
            entry.target === "entity" ? co.entities : co.relations
          ).find((x) => x.id === entry.id);
        entry.base = current;
        save(fileFor(entry), edit ? edit.working : current);
      }
      state.definitions_etag = co.definitions_etag;
      state.pending = null;
      for (const e of state.entries) snapshots[e.file] = read(fileFor(e));
      if (!rebased.length) {
        save(stateFile, state);
        return { ok: true, applied: false, reason: "changes_already_present" };
      }
      return {
        ...seal(rebased, commit.edit_note, commit.sources, snapshots),
        supersedes: id,
      };
    }
    if (!["preview", "push", "receipt"].includes(command))
      throw new Error("unknown_workspace_command");
    if (command === "preview") {
      if (["unknown", "applied"].includes(state.pending.outcome))
        throw new Error("unknown_push_requires_receipt_same_id");
      const r = await requestFn(`${API}/commits/preview`, {
        method: "POST",
        body: commit,
      });
      if (r.status === 409) {
        state.pending.outcome = "conflict";
        save(stateFile, state);
      }
      return {
        ok: r.status === 200 && validReceipt(r.body, commit, false),
        applied: false,
        commit_id: id,
        status: r.status,
        result: r.status === 200 ? r.body : publicFailure(r),
      };
    }
    const prior = await requestFn(`${API}/commits/${id}`);
    if (prior.status === 200) return finalize(prior.body);
    if (prior.status !== 404)
      return {
        ok: false,
        applied: null,
        reason: "receipt_unavailable",
        status: prior.status,
        commit_id: id,
      };
    if (command === "receipt")
      return {
        ok: false,
        applied: null,
        reason: "receipt_not_found_may_be_in_flight",
        commit_id: id,
      };
    if (!apply) throw new Error("push_requires_apply_and_task_authorization");
    const identity = validateCheckout(
      requireResponse(
        await requestFn(`${API}/checkout`, {
          method: "POST",
          body: { entity_ids: [], relation_ids: [] },
        }),
      ),
    );
    if (identity.actor_id !== state.actor_id)
      throw new Error("workspace_actor_mismatch");
    for (const e of state.entries)
      if (!same(read(fileFor(e)), sealed.snapshots[e.file]))
        throw new Error("working_tree_changed_after_commit");
    // Persist uncertainty before sending. A killed process cannot leave a local
    // state which allows rebasing or giving the same work a new request ID.
    const previouslyUnknown = ["unknown", "applied"].includes(
      state.pending.outcome,
    );
    state.pending.outcome = "unknown";
    save(stateFile, state);
    const pushed = await requestFn(`${API}/commits`, {
      method: "POST",
      body: commit,
      tries: 1,
    });
    if (pushed.status === 200) return finalize(pushed.body);
    if (pushed.status === 0 || pushed.status >= 500) {
      const recovered = await requestFn(`${API}/commits/${id}`);
      if (recovered.status === 200) return finalize(recovered.body);
      return {
        ok: false,
        applied: null,
        reason: "push_unknown_keep_same_commit",
        commit_id: id,
        status: pushed.status,
      };
    }
    if (previouslyUnknown)
      return {
        ok: false,
        applied: null,
        reason: "previous_push_still_unknown_keep_same_commit",
        status: pushed.status,
        commit_id: id,
        result: publicFailure(pushed),
      };
    state.pending.outcome = pushed.status === 409 ? "conflict" : "rejected";
    save(stateFile, state);
    return {
      ok: false,
      applied: false,
      status: pushed.status,
      result: publicFailure(pushed),
      commit_id: id,
    };
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockFile);
  }
}

export async function runCli(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || command === "help") {
    console.log(
      "mf-workspace init|checkout|create|status|commit|preview|push|receipt|rebase --dir DIR\ncheckout: --entity UUID / --relation UUID (repeatable)\ncreate: --target entity|relation --ref NAME --file document.json --review identity-review.json (entities)\ncommit: --note TEXT --sources sources.json\npush: --apply [--commit UUID]; preview/receipt: [--commit UUID]\nrebase: [--resolutions resolutions.json] [--reviews reviewed-candidates-by-ref.json]",
    );
    return;
  }
  const options = { entityIDs: [], relationIDs: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--apply") {
      options.apply = true;
      continue;
    }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error("missing_argument");
    switch (flag) {
      case "--dir":
        options.dir = value;
        break;
      case "--entity":
        options.entityIDs.push(value);
        break;
      case "--relation":
        options.relationIDs.push(value);
        break;
      case "--target":
        options.target = value;
        break;
      case "--ref":
        options.ref = value;
        break;
      case "--file":
        options.file = value;
        break;
      case "--note":
        options.note = value;
        break;
      case "--sources":
        options.sources = read(value);
        break;
      case "--review":
        options.review = read(value);
        break;
      case "--reviews":
        options.reviews = read(value);
        break;
      case "--commit":
        options.commitID = value;
        break;
      case "--resolutions":
        options.resolutions = read(value);
        break;
      default:
        throw new Error(`unknown_argument:${flag}`);
    }
  }
  const result = await runWorkspace(command, {
    ...options,
    origin: configuredOrigin(),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  runCli().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error) }));
    process.exitCode = 1;
  });
