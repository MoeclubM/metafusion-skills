import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CREDENTIALS = join(LOCAL_DIR, "credentials.json");
const API_PREFIX = "/api/";
const READ_ONLY_ENTITY_FIELDS = new Set(["created_by", "redirect_id", "updated_at"]);

let credentials;

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function normalizeBaseUrl(value) {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("MetaFusion baseUrl 必须使用 HTTPS；只有本机 loopback 可使用 HTTP");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) {
    throw new Error("MetaFusion baseUrl 只能填写实例根地址，不能包含账号、查询串或路径前缀");
  }
  return url.origin;
}

function apiUrl(baseUrl, pathname) {
  const rawPath = String(pathname).split(/[?#]/, 1)[0];
  const hasDotSegment = rawPath.split("/").some((part) => part === "." || part === "..");
  if (
    !pathname.startsWith(API_PREFIX)
    || hasDotSegment
    || /[\\]|%2e|%2f|%5c/i.test(rawPath)
  ) {
    throw new Error(`请求路径必须是规范化后的 ${API_PREFIX} 路径`);
  }

  const base = new URL(baseUrl);
  const target = new URL(pathname, `${baseUrl}/`);
  if (target.origin !== base.origin || !target.pathname.startsWith(API_PREFIX)) {
    throw new Error("请求路径超出 MetaFusion API 范围");
  }
  return target;
}

function loadCredentials() {
  if (credentials) return credentials;

  const file = process.env.MF_CREDENTIALS
    ? resolve(process.env.MF_CREDENTIALS)
    : DEFAULT_CREDENTIALS;
  let stored = {};
  try {
    stored = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`无法读取本地凭据文件：${file}`);
    }
  }

  const baseUrl = process.env.MF_BASE || stored.baseUrl || stored.base_url;
  const pat = String(process.env.MF_PAT || stored.pat || "").trim();
  if (!baseUrl || !pat) {
    throw new Error(`缺少 MetaFusion 凭据；请在本机填写 ${file}，或设置 MF_BASE / MF_PAT`);
  }

  credentials = Object.freeze({ baseUrl: normalizeBaseUrl(baseUrl), pat });
  return credentials;
}

function redact(value, secret) {
  if (typeof value === "string") return value.replaceAll(secret, "[REDACTED]");
  if (Array.isArray(value)) return value.map((item) => redact(item, secret));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secret)]));
  }
  return value;
}

function parseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function retryDelay(headers, attempt) {
  const value = headers.get("retry-after");
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 250), 30_000);
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 250), 30_000);
  }
  return Math.min(750 * 2 ** attempt, 8_000);
}

export async function request(pathname, {
  method = "GET",
  body,
  idempotencyKey,
  tries = 4,
} = {}) {
  const { baseUrl, pat } = loadCredentials();
  const target = apiUrl(baseUrl, pathname);
  const normalizedMethod = method.toUpperCase();
  const safeMethod = ["GET", "HEAD", "OPTIONS"].includes(normalizedMethod);
  const attempts = safeMethod ? Math.max(1, tries) : 1;
  let result = { status: 0, body: { error: "network" }, headers: {} };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const headers = {
        Accept: "application/json",
        Authorization: `Bearer ${pat}`,
        "User-Agent": "metafusion-curator-local/1.0",
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

      const response = await fetch(target, {
        method: normalizedMethod,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
      });
      result = {
        status: response.status,
        body: redact(parseBody(await response.text()), pat),
        headers: redact({
          etag: response.headers.get("etag"),
          location: response.headers.get("location"),
          retryAfter: response.headers.get("retry-after"),
        }, pat),
      };

      if (response.status !== 429 && response.status < 500) return result;
    } catch (error) {
      result = { status: 0, body: { error: "network", detail: String(error) }, headers: {} };
    }

    if (attempt + 1 < attempts) {
      const retryAfter = result.headers?.retryAfter;
      const headers = retryAfter ? { "retry-after": retryAfter } : {};
      await sleep(retryDelay(new Headers(headers), attempt));
    }
  }
  return result;
}

function requireOk(result, operation) {
  if (result.status >= 200 && result.status < 300) return result.body;
  const code = result.body?.error || result.body?.code || result.status;
  throw new Error(`${operation} 失败：HTTP ${result.status} ${code}`);
}

export async function getEntity(id) {
  return request(`/api/catalog/entities/${encodeURIComponent(id)}`);
}

export async function getDefinitions() {
  const definitions = requireOk(await request("/api/catalog/definitions"), "读取 definitions");
  return definitions?.document || definitions;
}

export function normalizePageLimit(limit = 100) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("实体列表 limit 必须是 1–100 的整数");
  }
  return limit;
}

export async function listAll(pathname, params = {}, limit = 100) {
  if (!pathname.startsWith(API_PREFIX)) throw new Error(`请求路径必须以 ${API_PREFIX} 开头`);
  limit = normalizePageLimit(limit);
  const items = [];
  const seenFirstIds = new Set();
  let offset = 0;

  for (;;) {
    const url = new URL(pathname, "https://local.invalid");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));

    const result = await request(`${url.pathname}${url.search}`);
    if (result.status !== 200 || !result.body) {
      const code = result.body?.error || result.body?.code || result.status;
      throw new Error(`分页读取失败：HTTP ${result.status} ${code}`);
    }
    const page = result.body.items || [];
    const firstId = page[0]?.id;
    if (firstId && seenFirstIds.has(firstId)) break;
    if (firstId) seenFirstIds.add(firstId);
    items.push(...page);
    if (page.length < limit || (result.body.total != null && items.length >= result.body.total)) break;
    offset += limit;
  }
  return items;
}

export function writableEntity(entity) {
  return Object.fromEntries(
    Object.entries(entity || {}).filter(([key]) => !READ_ONLY_ENTITY_FIELDS.has(key)),
  );
}

function validateWrite({ editNote, sources }) {
  if (!editNote || !String(editNote).trim()) throw new Error("editNote 必填");
  if (!Array.isArray(sources) || sources.length === 0) throw new Error("sources 至少一条");
  for (const source of sources) {
    if (!["url", "publication", "self"].includes(source.kind)) {
      throw new Error(`source.kind 非法：${source.kind}`);
    }
    if (!source.citation || !String(source.citation).trim()) throw new Error("source.citation 必填");
    if (source.kind === "url" && !/^https?:\/\/\S+$/.test(source.url || "")) {
      throw new Error("source.url 非法");
    }
  }
}

export async function putEntity(id, mutate, {
  editNote,
  sources,
  dryRun = false,
} = {}) {
  validateWrite({ editNote, sources });

  const current = requireOk(await getEntity(id), "读取实体");
  const entity = writableEntity(current);
  const version = current.version;
  const outcome = mutate(entity);
  if (outcome === false || outcome === undefined || outcome === null) {
    return { skipped: true };
  }
  if (outcome && typeof outcome === "object") {
    const readOnly = Object.keys(outcome).filter((key) => READ_ONLY_ENTITY_FIELDS.has(key));
    if (readOnly.length) throw new Error(`mutate 不能写入只读字段：${readOnly.join(", ")}`);
    Object.assign(entity, outcome);
  }
  if (dryRun) return { dryRun: true, entity, version };

  const result = await request(`/api/catalog/entities/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: {
      entity,
      expected_version: version,
      edit_note: String(editNote).trim(),
      sources,
    },
  });
  const ok = result.status >= 200 && result.status < 300;
  if (!ok) {
    return {
      ok: false,
      status: result.status,
      body: result.body,
      readbackStatus: null,
      readback: null,
      readbackOK: false,
    };
  }

  // PUT 成功只说明写入已提交；必须读回完整实体，避免把 200 当作未请求字段未丢失的证明。
  const readback = await getEntity(id);
  const readbackOK = readback.status >= 200 && readback.status < 300
    && readback.body?.version === result.body?.version;
  return {
    ok: true,
    status: result.status,
    body: result.body,
    readbackStatus: readback.status,
    readback: readback.body,
    readbackOK,
  };
}
