// mf-fetch-providers.mjs - 编目外链提供方只读连接器（read-only catalog provider connectors）
//
// 定位：mf-fetch-authoritative.mjs 已覆盖 Wikidata / Bangumi / MusicBrainz / UMJ 官方商品页。
// 本模块补齐常见编目外链的其他提供方：Discogs、Open Library、Internet Archive、TMDB、
// AniList、MyAnimeList、ISNI / VIAF / OCLC、NDL Linked Data、VGMdb。
// 全部只读：不读 MetaFusion 凭据、不写任何线上数据，也不向外部站点携带站内凭据。
//
// 三条硬约定（与 COMMON-BRIEF 的权威来源口径一致，踩过坑才写进代码）：
//   1. 失败必须抛出，不能返回空。found:false 只表示"提供方明确说没有"（HTTP 404、空结果集、
//      archive.org 的空 metadata）；429 / 5xx / 超时 / 网络失败 / 反爬拦截一律抛 ProviderError
//      且 retryable:true。把"未知"当成"不存在"会直接导致漏补或误删外链。
//   2. 403 不等于失效。反爬挑战（Cloudflare "Just a moment"）与网关错误页归为 blocked /
//      unavailable，绝不映射成 found:false。
//   3. 同一主机串行 + 间隔不小于 300ms（paceConfig.minIntervalMs），并对 Retry-After 退避重试；
//      各家限流值见 README-providers.md 的提供方矩阵。
//
// 出参形状（所有 connector 一致，便于上层统一处理）：
//   { provider, found, id, title, titles?, image_url, image_page_url?, dates?, external_ids?,
//     url, raw, notes?, rights_note?, tracks? }
// raw 保留提供方原始响应，便于逐字核对；本模块不替调用方判断"是不是同一个对象"，
// 写入前仍须按 COMMON-BRIEF 第 2 条做三重核对。
//
// 用法：
//   import { fetchDiscogsRelease, searchOpenLibrary, PROVIDER_MATRIX } from "./mf-fetch-providers.mjs";
//   const r = await fetchDiscogsRelease("https://www.discogs.com/release/2879-Daft-Punk-Discovery");
// CLI：node mf-fetch-providers.mjs <op> <参数>   （op 见文件末尾 PROVIDER_OPS）

export const USER_AGENT = "MetaFusion-Curator/1.0 ( +https://findverse.cc ; contact: admin@findverse.cc )";

/** 单次请求超时；可用 MF_PROVIDER_TIMEOUT_MS 覆盖。 */
export const TIMEOUT_MS = Number(process.env.MF_PROVIDER_TIMEOUT_MS || 20000);

/** 节流与重试策略。离线单测里把 minIntervalMs 调成 0，保持快速且确定。 */
export const paceConfig = {
  minIntervalMs: 300,    // 同一主机两次请求的最小间隔（COMMON-BRIEF 第 7 条）
  attempts: 2,           // 总尝试次数（含首次）
  backoffBaseMs: 1200,   // 网络 / 5xx 退避基数：backoffBaseMs * attempt
  retryAfterCapMs: 8000, // Retry-After 超过该值就放弃等待并抛 rate_limited
};

const hostState = new Map(); // host -> { chain: Promise, lastAt: number }

/** 清空节流状态（测试或换网络后用）。 */
export function resetPace() { hostState.clear(); }

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 同主机串行执行 + 最小间隔；上一次的失败不会污染下一次的队列。 */
export async function serialize(host, fn) {
  const state = hostState.get(host) || { chain: Promise.resolve(), lastAt: 0 };
  hostState.set(host, state);
  const run = async () => {
    const wait = paceConfig.minIntervalMs - (Date.now() - state.lastAt);
    if (wait > 0) await delay(wait);
    try {
      return await fn();
    } finally {
      state.lastAt = Date.now();
    }
  };
  const result = state.chain.then(run, run);
  state.chain = result.then(() => undefined, () => undefined);
  return result;
}

function redactCredentialText(value) {
  return String(value == null ? "" : value)
    .replace(/([?&](?:api[_-]?key|access[_-]?token|client[_-]?(?:secret|id)|token|key|password|secret|authorization)=)[^&#\s"'<>]*/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");
}

export class ProviderError extends Error {
  // kind: bad_input | http（4xx 明确拒绝）| rate_limited | network（传输失败 / 超时 / 5xx，未知可重试）|
  //       parse | blocked | credential_missing | unavailable | unsupported
  constructor(kind, provider, message, info) {
    const meta = info || {};
    super(redactCredentialText("[" + provider + "/" + kind + "] " + message));
    this.name = "ProviderError";
    this.kind = kind;
    this.provider = provider;
    this.status = meta.status ?? null;
    this.url = meta.url == null ? null : redactCredentialText(meta.url);
    this.retryable = meta.retryable ?? (kind === "rate_limited" || kind === "network");
    this.hint = meta.hint ?? null;
    if (meta.cause) {
      const cause = new Error(redactCredentialText(meta.cause.message || String(meta.cause)));
      cause.name = meta.cause.name || "Error";
      if (meta.cause.code) cause.code = meta.cause.code;
      this.cause = cause;
    }
  }
}

/** 把异常压成一行可记录的结构（供 smoke / 日志用，不吞掉原因）。 */
export function describeError(err) {
  if (err instanceof ProviderError) {
    return {
      kind: err.kind, provider: err.provider, status: err.status,
      retryable: err.retryable, message: err.message, hint: err.hint,
    };
  }
  return { kind: "unexpected", provider: null, status: null, retryable: false, message: redactCredentialText(err && err.message ? err.message : err) };
}

/** 提供方网关 / CDN 的错误页特征：出现即说明"这一路不通"，不是"条目不存在"。 */
export function looksLikeGatewayError(text) {
  const head = String(text || "").slice(0, 2000);
  return /no Route matched|Error Code: \d{3}|ErrorCode: \d{3}|^Status: \d{3} /m.test(head);
}

function looksLikeBotChallenge(text) {
  const head = String(text || "").slice(0, 4000);
  return /Just a moment|cf-browser-verification|challenges\.cloudflare\.com|cf-turnstile|Attention Required! \| Cloudflare/i.test(head);
}

function parseRetryAfter(value, nowMs) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

/**
 * 带节流 / 超时 / 退避的一次读取，返回 {status, text, contentType, headers, notFound, url}。
 * 404 与 410 是"正常答案"（notFound:true）；其余失败抛 ProviderError，绝不返回空。
 */
export async function httpRequest(url, opts) {
  const o = opts || {};
  const provider = o.provider ?? "unknown";
  const method = o.method ?? "GET";
  const attempts = o.attempts ?? paceConfig.attempts;
  const timeoutMs = o.timeoutMs ?? TIMEOUT_MS;
  const fetchImpl = o.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new ProviderError("unsupported", provider, "运行时没有可用的 fetch");
  const headers = Object.assign({
    "User-Agent": o.userAgent ?? USER_AGENT,
    Accept: o.accept ?? "application/json",
  }, o.headers || {});
  const host = new URL(url).host;

  return serialize(host, async () => {
    let lastFailure = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let res;
      try {
        res = await fetchImpl(url, {
          method, headers, body: o.body ?? undefined, redirect: "follow",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        lastFailure = new ProviderError("network", provider,
          "网络失败（" + (err && err.name ? err.name : "Error") + ": " + ((err && err.cause && err.cause.code) || (err && err.message) || "unknown") + "）；第 " + attempt + "/" + attempts + " 次",
          { url: url, cause: err, hint: "超时 / 断网属未知状态，不得当作条目不存在" });
        if (attempt < attempts) { await delay(paceConfig.backoffBaseMs * attempt); continue; }
        throw lastFailure;
      }

      let text = "";
      try {
        text = await res.text();
      } catch (err) {
        lastFailure = new ProviderError("network", provider, "响应体读取失败：" + (err && err.message ? err.message : String(err)), { url: url, cause: err });
        if (attempt < attempts) { await delay(paceConfig.backoffBaseMs * attempt); continue; }
        throw lastFailure;
      }
      const contentType = res.headers && res.headers.get ? res.headers.get("content-type") || "" : "";
      const retryAfter = res.headers && res.headers.get ? res.headers.get("retry-after") : null;
      const status = res.status;

      if (status === 404 || status === 410) {
        if (looksLikeGatewayError(text) || looksLikeBotChallenge(text)) {
          throw new ProviderError("unavailable", provider,
            "HTTP " + status + " 返回的是网关 / 反爬页，而不是提供方的「不存在」答复",
            { status: status, url: url, retryable: true, hint: "该提供方当前不可用；按矩阵换读取路径" });
        }
        return { status: status, text: text, contentType: contentType, headers: res.headers, notFound: true, url: url };
      }

      if (status === 429 || status === 503) {
        const waitMs = parseRetryAfter(retryAfter, Date.now());
        if (attempt < attempts && waitMs !== null && waitMs <= paceConfig.retryAfterCapMs) {
          await delay(Math.max(waitMs, 250));
          continue;
        }
        if (attempt < attempts && waitMs === null) {
          await delay(paceConfig.backoffBaseMs * attempt * 2);
          continue;
        }
        throw new ProviderError("rate_limited", provider,
          "HTTP " + status + " 限流（Retry-After=" + (retryAfter || "无") + "）；已尝试 " + attempt + "/" + attempts + " 次",
          { status: status, url: url, retryable: true, hint: "按矩阵限流值降频后重试；不要据此判定条目失效" });
      }

      if (status === 401) {
        throw new ProviderError("credential_missing", provider, "HTTP 401：需要 API key / access token",
          { status: status, url: url, retryable: false, hint: o.credentialHint ?? "在环境变量里配置该提供方凭据后重试" });
      }

      if (status === 403 || status === 451) {
        const challenge = looksLikeBotChallenge(text);
        throw new ProviderError("blocked", provider,
          challenge ? "HTTP " + status + "：反爬挑战页（不是内容失效）" : "HTTP " + status + "：提供方拒绝当前调用者",
          { status: status, url: url, retryable: false, hint: challenge ? (o.archiveHint ?? "改走 Internet Archive 存档读取") : "确认 UA / 凭据要求，或换提供方" });
      }

      // 5xx 与传输失败同属"未知状态"：归 network（可重试），绝不映射成 found:false。
      if (status >= 500) {
        lastFailure = new ProviderError("network", provider, "HTTP " + status + "（提供方 5xx，状态未知）",
          { status: status, url: url, hint: "退避后重试；5xx 不代表条目不存在" });
        if (attempt < attempts) { await delay(paceConfig.backoffBaseMs * attempt); continue; }
        throw lastFailure;
      }

      // 其余 4xx 是明确的协议级拒绝（可判定），归 http。
      if (!res.ok) {
        throw new ProviderError("http", provider, "HTTP " + status + ": " + String(text).replace(/\s+/g, " ").slice(0, 200),
          { status: status, url: url, retryable: false });
      }

      if (!contentType.includes("html") && looksLikeGatewayError(text)) {
        throw new ProviderError("unavailable", provider,
          "HTTP " + status + " 但响应体是网关错误：" + String(text).replace(/\s+/g, " ").slice(0, 160),
          { status: status, url: url, retryable: true });
      }

      return { status: status, text: text, contentType: contentType, headers: res.headers, notFound: false, url: url };
    }
    throw lastFailure ?? new ProviderError("network", provider, "未预期的读取失败（状态未知）", { url: url });
  });
}

/** JSON 读取：解析失败抛 parse，不当成"没有数据"。 */
export async function jsonRequest(url, opts) {
  const o = opts || {};
  const res = await httpRequest(url, Object.assign({ accept: "application/json" }, o));
  if (res.notFound) return { notFound: true, status: res.status, json: null, raw: res.text, url: res.url };
  try {
    return { notFound: false, status: res.status, json: JSON.parse(res.text), raw: res.text, url: res.url };
  } catch (err) {
    throw new ProviderError("parse", o.provider ?? "unknown",
      "响应不是合法 JSON（content-type=" + (res.contentType || "?") + "）：" + String(res.text).replace(/\s+/g, " ").slice(0, 160),
      { status: res.status, url: res.url, cause: err });
  }
}

/** 统一出参：键齐全，found:false 时其余为 null，上层不必逐家判空。 */
function result(provider, fields) {
  return Object.assign({
    provider: provider,
    found: true,
    id: null,
    title: null,
    titles: null,
    image_url: null,
    image_page_url: null,
    dates: null,
    external_ids: null,
    url: null,
    raw: null,
    notes: null,
    rights_note: null,
  }, fields || {});
}

function clean(value) {
  const s = String(value == null ? "" : value)
    .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, "\"")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return s || null;
}

function requireObject(value, provider, description) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError("parse", provider, description + " 响应不是对象", { retryable: false });
  }
  return value;
}

function requireArrayField(value, field, provider, description) {
  const object = requireObject(value, provider, description);
  if (!Array.isArray(object[field])) {
    throw new ProviderError("parse", provider, description + " 缺少数组字段 " + field, { retryable: false });
  }
  return object[field];
}

function hasMeaningfulText(value) {
  if (typeof value === "string" || typeof value === "number") return Boolean(clean(value));
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).some((item) => typeof item === "string" && Boolean(clean(item)));
}

function requireSearchItem(value, provider, description, idKeys, titleKeys) {
  const item = requireObject(value, provider, description + " 候选项");
  const hasId = idKeys.some((key) => item[key] != null && String(item[key]).trim());
  const hasTitle = titleKeys.some((key) => hasMeaningfulText(item[key]));
  if (!hasId || !hasTitle) {
    throw new ProviderError("parse", provider, description + " 候选项缺少标识或题名", { retryable: false });
  }
  return item;
}

const ISO_DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;
/** 只有确证的 YYYY / YYYY-MM / YYYY-MM-DD 才进 dates；其他形式原样放 raw，不做猜测加工。 */
function isoDate(value) {
  const s = String(value == null ? "" : value).trim();
  return ISO_DATE.test(s) ? s : null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
/** "Dec 23, 2020" / "23 Dec 2020" 转 "2020-12-23"；解析不了返回 null。 */
export function parseEnglishDate(value) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return null;
  const m = text.match(/^([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})$/)
    || text.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s*(\d{4})$/);
  if (!m) return isoDate(text);
  const monthName = /^[A-Za-z]/.test(m[1]) ? m[1] : m[2];
  const day = Number(/^[A-Za-z]/.test(m[1]) ? m[2] : m[1]);
  const year = Number(m[3]);
  const month = MONTHS[monthName.slice(0, 3).toLowerCase()];
  if (!month || !Number.isFinite(day) || !Number.isFinite(year)) return null;
  return String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
}

// ───────────────────────── 提供方能力矩阵 ─────────────────────────
// access 是 verifiedAt 日期的观测快照，不表示之后始终可用；变化时先复核再更新。

export const PROVIDER_MATRIX = {
  discogs: {
    label: "Discogs", access: "anonymous", authority: "official-community",
    baseUrl: "https://api.discogs.com",
    entities: ["release", "master", "artist", "label", "search"],
    rateLimit: "匿名 25 req/min（响应头 x-discogs-ratelimit: 25）",
    note: "匿名可读 database/search、releases/{id}、masters/{id}；写端点与 /oauth/ 身份需 token。图片为社区上传，授权须人工判断。",
    verifiedAt: "2026-10-03",
  },
  openlibrary: {
    label: "Open Library", access: "anonymous", authority: "official",
    baseUrl: "https://openlibrary.org",
    entities: ["search", "work", "edition", "author", "cover"],
    rateLimit: "公开 API，未公布固定额度；按不小于 300ms 串行使用",
    note: "/search.json 与 /books|/works|/authors/<ID>.json 可用；封面走 covers.openlibrary.org/b/id/<cover_id>-{S,M,L}.jpg。/isbn/<isbn>.json 现返回 404 HTML，改用 search?q=isbn:<isbn>。",
    verifiedAt: "2026-10-03",
  },
  internetarchive: {
    label: "Internet Archive", access: "anonymous", authority: "official",
    baseUrl: "https://archive.org",
    entities: ["item metadata", "advancedsearch", "wayback"],
    rateLimit: "未公布；metadata 属高流量端点，保持串行",
    note: "/metadata/<identifier> 对不存在条目返回 HTTP 200 且 body 为空对象 —— 必须按 metadata 是否为空判 not found，不能按 200 判存在。缩略图 /services/img/<identifier> 实测 200 image/jpeg。",
    verifiedAt: "2026-10-03",
  },
  tmdb: {
    label: "TMDB", access: "credential", authority: "official-community",
    baseUrl: "https://api.themoviedb.org/3",
    entities: ["movie", "tv", "person", "search"],
    rateLimit: "key 制，官方未固定额度",
    note: "无 key 实测 HTTP 401（status_code 7）。支持 TMDB_API_KEY（v3 ?api_key=）或 TMDB_ACCESS_TOKEN（v4 Bearer）；两者都缺时抛 credential_missing 而不是返回空。image.tmdb.org 的图片 URL 无需 key。",
    credentialEnv: ["TMDB_API_KEY", "TMDB_ACCESS_TOKEN"],
    verifiedAt: "2026-10-03",
  },
  anilist: {
    label: "AniList", access: "anonymous", authority: "official-community",
    baseUrl: "https://graphql.anilist.co",
    entities: ["anime", "manga", "search"],
    rateLimit: "匿名 30 req/min（x-ratelimit-limit: 30）",
    note: "公开 GraphQL。不存在的 id 返回 HTTP 404 且 body 含 Not Found，可判 found:false。当前 schema 已不可用的字段（实测 400）：Media.synonym（应为 synonyms）、Media.idAbbreviation、Media.year、Page(type:)、MediaTitle.canonical。",
    verifiedAt: "2026-10-03",
  },
  myanimelist: {
    label: "MyAnimeList", access: "credential", authority: "official",
    baseUrl: "https://api.myanimelist.net/v2",
    entities: ["anime", "manga", "search"],
    rateLimit: "按 client id 计量",
    note: "匿名实测 HTTP 403（error: forbidden），OAuth client id 必需（X-MAL-CLIENT-ID）。Jikan（api.jikan.moe）能匿名读，但它是第三方镜像，不满足站内官方原始数据口径，本模块不实现，仅在此记录。",
    credentialEnv: ["MAL_CLIENT_ID"],
    verifiedAt: "2026-10-03",
  },
  isni: {
    label: "ISNI Registry", access: "blocked", authority: "official",
    baseUrl: "https://isni.org",
    entities: ["isni"],
    rateLimit: "n/a",
    note: "最近一次本机观测（日期见 verifiedAt）：isni.org 记录页与 SPARQL 返回 Cloudflare 挑战页（HTTP 403，body 含 Just a moment / challenges.cloudflare.com），换浏览器 UA 同样 403。此状态是观测快照；替代线索为 Wikidata P213/P214 与 Open Library author.remote_ids（须二重核对）。",
    verifiedAt: "2026-10-03",
  },
  viaf: {
    label: "VIAF (OCLC)", access: "unavailable", authority: "official",
    baseUrl: "https://viaf.org",
    entities: ["viaf"],
    rateLimit: "响应头 ratelimit-limit 约 1000/min",
    note: "最近一次本机观测（日期见 verifiedAt）：记录端点 /viaf/<id> 对已知存在号返回网关 404（Error Code: 404）；/viaf/SRU 与 /ws/1.0/... 为 no Route matched；/viaf/search 的 SRW JSON 对 pers.name / cor.name 返回 numberOfRecords:0。此状态是观测快照，不表示端点永久不可用。",
    verifiedAt: "2026-10-03",
  },
  oclc: {
    label: "OCLC / WorldCat", access: "credential", authority: "official",
    baseUrl: "https://api.worldcat.org",
    entities: ["worldcat holdings", "FAST headings"],
    rateLimit: "需 OCLC token",
    note: "api.worldcat.org 未认证请求返回 500 HTML 错误页（重定向到 api.on.worldcat.org/discovery），Read / Search API 均需 client_id + WSKey；FAST Search & Select（fast.oclc.org/searchfast/fastsuggest）当前返回 body 形如 Status: 400 / 404 Reason —— 两条都不可匿名使用。",
    credentialEnv: ["WORLDCLIENTID", "WORLDAUTHTOKEN"],
    verifiedAt: "2026-10-03",
  },
  ndl: {
    label: "NDL Linked Data", access: "anonymous", authority: "official",
    baseUrl: "https://id.ndl.go.jp",
    entities: ["auth/ndlna（人物・団体・統一タイトル・件名）"],
    rateLimit: "未公布；串行使用",
    note: "权威记录 JSON-LD 实测可用：/auth/ndlna/<8 码>.json（label、prefLabel.transcription（ja-Kana）、transcription-l（ja-Latn）、primaryTopic.dateOfBirth / dateOfDeath、exactMatch VIAF URI、inScheme）。书志 LD /bib/<id>.json 与 ndlsht、ncl 当前 404；lod.ndl.go.jp SPARQL 与 www.ndlsearch.ndlsearch.go.jp 在本机 ECONNRESET（NDL Search API 另需申请 key）。",
    verifiedAt: "2026-10-03",
  },
  vgmdb: {
    label: "VGMdb", access: "blocked", authority: "official-community",
    baseUrl: "https://vgmdb.net",
    entities: ["album（页面解析）"],
    rateLimit: "n/a",
    note: "无公开 API（官方 XML API 只对订阅者开放）。站内页面对本机返回 Cloudflare 403 挑战页；图片 CDN medium-media.vgm.io 可匿名 200。页面不含 JSON-LD（实测 0 个 ld+json script、无 microdata itemtype），字段在 table#album_infobit_large 的 label/value 行与 span.albumtitle[lang]，因此实现为 HTML 解析 + Internet Archive id_ 原样存档读取（parseVgmdbAlbumHtml 可离线复用）。",
    verifiedAt: "2026-10-03",
  },
};

for (const entry of Object.values(PROVIDER_MATRIX)) {
  entry.accessObservation = {
    status: entry.access,
    observedAt: entry.verifiedAt,
    scope: "snapshot",
  };
}

export function providerAccess(provider) {
  const entry = PROVIDER_MATRIX[provider];
  if (!entry) throw new ProviderError("bad_input", provider, "未知提供方：" + provider + "（可用：" + Object.keys(PROVIDER_MATRIX).join(", ") + "）");
  return entry;
}

function needCredential(provider, envNames, purpose) {
  for (const name of envNames) {
    const value = process.env[name];
    if (value && String(value).trim()) return String(value).trim();
  }
  throwCredentialMissing(provider, envNames, purpose);
}

function throwCredentialMissing(provider, envNames, purpose) {
  throw new ProviderError("credential_missing", provider,
    purpose + " 需要凭据，但环境变量 " + envNames.join(" 或 ") + " 都没配置",
    {
      retryable: false,
      hint: "申请凭据后写入环境变量 " + envNames[0] + "（不要提交进仓库、不要打进日志）；缺凭据是跳过，不是提供方没有该条目",
    });
}

// ───────────────────────── 1. Discogs ─────────────────────────

/** 接受 2879 / https://www.discogs.com/release/2879-Daft-Punk-Discovery / https://api.discogs.com/releases/2879 */
export function normalizeDiscogsId(input, kind) {
  const kindName = kind || "release";
  const text = String(input == null ? "" : input).trim();
  if (/^\d{1,12}$/.test(text)) return text;
  const m = text.match(new RegExp("discogs\\.com/" + kindName + "(?:s)?/(\\d+)", "i"));
  if (m) return m[1];
  throw new ProviderError("bad_input", "discogs", "无法从 " + text.slice(0, 80) + " 解析 Discogs " + kindName + " id（需要纯数字或 /" + kindName + "/<数字> 链接）");
}

function discogsImages(data) {
  const primary = (data.images || []).find((i) => i.type === "primary") || (data.images || [])[0];
  const url = (primary && (primary.uri || primary.resource_url)) || data.cover_image || data.thumbnail_url || null;
  return { image_url: url, image_page_url: data.uri || null };
}

export function mapDiscogsRelease(data, kind) {
  const kindName = kind || "release";
  requireObject(data, "discogs", kindName);
  if (data.id == null || !String(data.id).trim() || !clean(data.title)) {
    throw new ProviderError("parse", "discogs", kindName + " 响应缺少 id 或 title", { retryable: false });
  }
  const barcode = (data.identifiers || []).find((i) => i.type === "Barcode");
  const label0 = (data.labels || [])[0] || null;
  const artists = (data.artists || []).map((a) => a.name).filter(Boolean);
  const images = discogsImages(data);
  return result("discogs", {
    id: String(data.id == null ? "" : data.id),
    title: clean(data.title),
    titles: { release: clean(data.title), artists: artists.length ? artists : null, artists_sort: clean(data.artists_sort) },
    image_url: images.image_url,
    image_page_url: images.image_page_url,
    dates: {
      year: data.year != null ? String(data.year) : null,
      release: isoDate(data.released),
      released_formatted: clean(data.released_formatted) || clean(data.released),
    },
    external_ids: {
      discogs: String(data.id),
      master: data.master_id != null ? String(data.master_id) : null,
      barcode: barcode ? clean(barcode.value) : null,
      catalog_number: label0 ? clean(label0.catno) : null,
      label: label0 && label0.name ? clean(label0.name) : null,
    },
    url: data.uri || ("https://www.discogs.com/" + kindName + "/" + data.id),
    tracks: (data.tracklist || [])
      .filter((t) => (t.type_ || "track") === "track")
      .map((t) => ({
        position: clean(t.position),
        title: clean(t.title),
        duration: clean(t.duration),
        performers: (t.extraartists || []).map((e) => clean(e.name) + (e.role ? " (" + clean(e.role) + ")" : "")).filter((s) => s.trim()),
      })),
    notes: [
      data.country ? "国=" + clean(data.country) : null,
      (data.formats || []).length ? "形式=" + data.formats.map(clean).join(",") : null,
      data.status ? "状态=" + clean(data.status) : null,
      data.data_quality ? "数据质量=" + clean(data.data_quality) : null,
    ].filter(Boolean).join("；") || null,
    rights_note: "Discogs 图片由社区上传，不等于官方封面图；写入 pictures[] 前须逐条判断来源与授权。",
    raw: data,
  });
}

export async function fetchDiscogsRelease(idOrUrl, opts) {
  const id = normalizeDiscogsId(idOrUrl, "release");
  const url = "https://api.discogs.com/releases/" + id;
  const res = await jsonRequest(url, Object.assign({ provider: "discogs" }, opts));
  if (res.notFound) return result("discogs", { found: false, id: id, url: url, raw: res.raw, notes: "Discogs 返回 404（该 release 不存在或已删除）" });
  return mapDiscogsRelease(res.json, "release");
}

export async function fetchDiscogsMaster(idOrUrl, opts) {
  const id = normalizeDiscogsId(idOrUrl, "master");
  const url = "https://api.discogs.com/masters/" + id;
  const res = await jsonRequest(url, Object.assign({ provider: "discogs" }, opts));
  if (res.notFound) return result("discogs", { found: false, id: id, url: url, raw: res.raw, notes: "Discogs master 404" });
  const mapped = mapDiscogsRelease(res.json, "master");
  mapped.external_ids = Object.assign({}, mapped.external_ids, { master: id });
  mapped.notes = "master 记录（版本列表在 " + ((res.json && res.json.versions_url) ? res.json.versions_url : "缺") + "）；" + (mapped.notes || "");
  return mapped;
}

/** 社区库检索：只返回候选，身份判定留给调用方（同名不同物在 Discogs 极常见）。 */
export async function searchDiscogs(query, opts) {
  const o = opts || {};
  const q = String(query == null ? "" : query).trim();
  if (!q) throw new ProviderError("bad_input", "discogs", "检索词不能为空");
  const params = new URLSearchParams({
    q: q,
    type: o.type || "release",
    per_page: String(Math.min(50, Math.max(1, o.perPage || 5))),
  });
  if (o.year) params.set("year", String(o.year));
  if (o.label) params.set("label", o.label);
  if (o.catno) params.set("catno", o.catno);
  if (o.format) params.set("format", o.format);
  const url = "https://api.discogs.com/database/search?" + params.toString();
  const res = await jsonRequest(url, Object.assign({ provider: "discogs" }, o));
  const records = requireArrayField(res.json, "results", "discogs", "database/search");
  const hits = records.map((r) => requireSearchItem(r, "discogs", "database/search", ["id"], ["title"])).map((r) => ({
    id: String(r.id == null ? "" : r.id),
    type: r.type || null,
    title: clean(r.title),
    year: r.year ? String(r.year) : null,
    country: clean(r.country),
    label: (r.label || []).length ? clean(r.label[0]) : null,
    catalog_number: clean(r.catno),
    barcode: (r.barcode || []).length ? clean(r.barcode[0]) : null,
    formats: Array.isArray(r.formats) ? r.formats.map(clean).filter(Boolean) : null,
    master: r.master_id != null ? String(r.master_id) : null,
    image_url: r.cover_image || r.thumb || null,
    url: r.uri || r.resource_url || null,
  }));
  return result("discogs", {
    found: hits.length > 0,
    id: hits[0] ? hits[0].id : null,
    title: hits[0] ? hits[0].title : null,
    image_url: hits[0] ? hits[0].image_url : null,
    dates: hits[0] && hits[0].year ? { year: hits[0].year } : null,
    url: hits[0] ? hits[0].url : null,
    notes: "候选 " + hits.length + " 条（total=" + (res.json && res.json.pagination ? res.json.pagination.items : "?") + "）；题名 + 年份 + 品番三重核对前不得写入",
    raw: { pagination: res.json ? res.json.pagination : null, hits: hits },
  });
}

// ───────────────────────── 2. Open Library ─────────────────────────

/** 接受 OL2665823M / /books/OL2665823M / https://openlibrary.org/books/OL2665823M */
export function normalizeOpenLibraryId(input, kind) {
  const kindName = kind || "book";
  const suffix = ({ book: "M", edition: "M", work: "W", author: "A" })[kindName] || "M";
  const text = String(input == null ? "" : input).trim().toUpperCase();
  const m = text.match(/OL(\d+)/);
  if (!m) throw new ProviderError("bad_input", "openlibrary", "无法解析 OpenLibrary id：" + text.slice(0, 60));
  const id = "OL" + m[1] + suffix;
  if (!/^OL\d+[MWA]$/.test(id)) throw new ProviderError("bad_input", "openlibrary", "OpenLibrary " + kindName + " id 形状非法：" + id);
  return id;
}

export function openLibraryCoverUrl(coverId, size) {
  const id = Number(String(coverId == null ? "" : coverId).replace(/[^0-9]/g, ""));
  if (!id || id <= 0) throw new ProviderError("bad_input", "openlibrary", "封面 id 非法：" + String(coverId));
  const s = String(size || "L").toUpperCase().replace(/[^SML]/g, "") || "L";
  return "https://covers.openlibrary.org/b/id/" + id + "-" + s + ".jpg";
}

function olKeyToId(key) {
  const parts = String(key || "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

export function mapOpenLibraryBook(data, kindLabel) {
  requireObject(data, "openlibrary", "edition/work");
  if (!clean(data.key) || !clean(data.title)) {
    throw new ProviderError("parse", "openlibrary", "edition/work 响应缺少 key 或 title", { retryable: false });
  }
  const cover = Array.isArray(data.covers) ? data.covers.find((c) => Number(c) > 0) : null;
  const key = clean(data.key) || "";
  const olid = olKeyToId(key);
  const isbn13 = Array.isArray(data.isbn_13) ? data.isbn_13.map(clean).filter(Boolean) : [];
  const isbn10 = Array.isArray(data.isbn_10) ? data.isbn_10.map(clean).filter(Boolean) : [];
  return result("openlibrary", {
    id: olid,
    title: clean(data.title),
    titles: { title: clean(data.title), subtitle: clean(data.subtitle), alternative_titles: data.alternative_titles || null },
    image_url: cover ? openLibraryCoverUrl(cover, "L") : null,
    image_page_url: key ? "https://openlibrary.org" + key : null,
    dates: {
      publish: clean(data.publish_date),
      first_publish_year: data.first_publish_year != null ? String(data.first_publish_year) : null,
      created: data.created ? data.created.value || null : null,
      modified: data.last_modified ? data.last_modified.value || null : null,
    },
    external_ids: {
      openlibrary: olid,
      isbn: isbn13.concat(isbn10).slice(0, 6),
      lccn: (data.lccn || []).length ? clean((data.lccn || [])[0]) : null,
      oclc: data.oclc ? String(data.oclc) : (data.oclc_number ? String(data.oclc_number) : null),
      viaf: data.remote_ids && data.remote_ids.viaf ? String(data.remote_ids.viaf) : null,
      isni: data.remote_ids && data.remote_ids.isni ? String(data.remote_ids.isni) : null,
      wikidata: data.remote_ids && data.remote_ids.wikidata ? String(data.remote_ids.wikidata) : null,
    },
    url: "https://openlibrary.org" + key,
    notes: [
      kindLabel ? "记录类型=" + kindLabel : null,
      (data.publishers || []).length ? "出版社=" + data.publishers.map(clean).join(",") : null,
      data.number_of_pages != null ? "页数=" + data.number_of_pages : null,
      Array.isArray(data.authors) && data.authors.length ? "作者键=" + data.authors.map((a) => a && a.key).filter(Boolean).join(",") : null,
    ].filter(Boolean).join("；") || null,
    raw: data,
  });
}

export async function lookupOpenLibraryEdition(olidOrUrl, opts) {
  const olid = normalizeOpenLibraryId(olidOrUrl, "book");
  const url = "https://openlibrary.org/books/" + olid + ".json";
  const res = await jsonRequest(url, Object.assign({ provider: "openlibrary" }, opts));
  if (res.notFound) return result("openlibrary", { found: false, id: olid, url: url, raw: res.raw, notes: "OpenLibrary edition 404" });
  return mapOpenLibraryBook(res.json, "edition");
}

export async function lookupOpenLibraryWork(olidOrUrl, opts) {
  const olid = normalizeOpenLibraryId(olidOrUrl, "work");
  const url = "https://openlibrary.org/works/" + olid + ".json";
  const res = await jsonRequest(url, Object.assign({ provider: "openlibrary" }, opts));
  if (res.notFound) return result("openlibrary", { found: false, id: olid, url: url, raw: res.raw, notes: "OpenLibrary work 404" });
  const data = requireObject(res.json, "openlibrary", "work");
  if (!clean(data.key) || !clean(data.title)) throw new ProviderError("parse", "openlibrary", "work 响应缺少 key 或 title", { retryable: false });
  const cover = Array.isArray(data.covers) ? data.covers.find((c) => Number(c) > 0) : null;
  return result("openlibrary", {
    id: olid,
    title: clean(data.title),
    titles: { title: clean(data.title), subtitle: clean(data.subtitle) },
    image_url: cover ? openLibraryCoverUrl(cover, "L") : null,
    dates: { first_publish_year: clean(data.first_publish_date) },
    external_ids: { openlibrary: olid },
    url: "https://openlibrary.org/works/" + olid,
    notes: "subjects=" + (data.subjects || []).slice(0, 5).map(clean).join(",") + (data.edition_count != null ? "；edition_count=" + data.edition_count : ""),
    raw: data,
  });
}

/** author 记录带 remote_ids（viaf / isni / wikidata / lc_naf）—— isni.org 被拦时的合法线索来源之一。 */
export async function lookupOpenLibraryAuthor(olidOrUrl, opts) {
  const olid = normalizeOpenLibraryId(olidOrUrl, "author");
  const url = "https://openlibrary.org/authors/" + olid + ".json";
  const res = await jsonRequest(url, Object.assign({ provider: "openlibrary" }, opts));
  if (res.notFound) return result("openlibrary", { found: false, id: olid, url: url, raw: res.raw, notes: "OpenLibrary author 404" });
  const data = requireObject(res.json, "openlibrary", "author");
  if (!clean(data.key) || !(clean(data.name) || clean(data.personal_name))) {
    throw new ProviderError("parse", "openlibrary", "author 响应缺少 key 或 name", { retryable: false });
  }
  const remote = data.remote_ids || {};
  return result("openlibrary", {
    id: olid,
    title: clean(data.name) || clean(data.personal_name),
    titles: { name: clean(data.name), personal_name: clean(data.personal_name), alternate_names: data.alternate_names || null },
    dates: {
      birth: clean(data.birth_date), death: clean(data.death_date),
      created: data.created ? data.created.value || null : null,
      modified: data.last_modified ? data.last_modified.value || null : null,
    },
    external_ids: {
      openlibrary: olid,
      viaf: remote.viaf ? String(remote.viaf) : null,
      isni: remote.isni ? String(remote.isni) : null,
      wikidata: remote.wikidata ? String(remote.wikidata) : null,
      lc_naf: remote.lc_naf ? String(remote.lc_naf) : null,
    },
    url: "https://openlibrary.org/authors/" + olid,
    notes: remote.isni
      ? "ISNI / VIAF 是 OpenLibrary 登记的第三方标识，须与 Wikidata P213 / P214 或官方记录二重核对后才可写入"
      : "该 author 未登记 ISNI / VIAF",
    raw: data,
  });
}

/** 列出某个 work 的 editions：找「哪个版本有封面 / 有 ISBN」时用；只读，不改写任何数据。 */
export async function listOpenLibraryEditions(olidOrUrl, opts) {
  const o = opts || {};
  const olid = normalizeOpenLibraryId(olidOrUrl, "work");
  const url = "https://openlibrary.org/works/" + olid + "/editions.json?limit=" + String(Math.min(100, Math.max(1, o.limit || 20)));
  const res = await jsonRequest(url, Object.assign({ provider: "openlibrary" }, o));
  if (res.notFound) return result("openlibrary", { found: false, id: olid, url: url, raw: res.raw, notes: "OpenLibrary work 不存在（editions 404）" });
  const rawEntries = requireArrayField(res.json, "entries", "openlibrary", "work editions");
  const entries = rawEntries.map((e) => requireSearchItem(e, "openlibrary", "work editions", ["key"], ["title"])).map((e) => ({
    id: olKeyToId(e.key),
    key: clean(e.key),
    title: clean(e.title),
    subtitle: clean(e.subtitle),
    publish_date: clean(e.publish_date),
    languages: Array.isArray(e.languages) ? e.languages.map((l) => (l && l.key ? String(l.key).split("/").pop() : null)).filter(Boolean) : null,
    cover_id: Array.isArray(e.covers) && e.covers.length ? String(e.covers.find((c) => Number(c) > 0) || e.covers[0]) : null,
    image_url: Array.isArray(e.covers) && e.covers.some((c) => Number(c) > 0) ? openLibraryCoverUrl(e.covers.find((c) => Number(c) > 0), "L") : null,
    isbn_13: Array.isArray(e.isbn_13) ? e.isbn_13.map(clean).filter(Boolean) : null,
    isbn_10: Array.isArray(e.isbn_10) ? e.isbn_10.map(clean).filter(Boolean) : null,
    physical_pages: e.number_of_pages != null ? String(e.number_of_pages) : null,
  }));
  return result("openlibrary", {
    found: entries.length > 0,
    id: olid,
    title: entries.length ? entries[0].title : null,
    image_url: (entries.find((e) => e.image_url) || {}).image_url || null,
    url: "https://openlibrary.org/works/" + olid + "/editions",
    notes: "版本 " + entries.length + " 条；有封面 " + entries.filter((e) => e.image_url).length + " 条；取封面须再核版本",
    raw: { entries: entries },
  });
}

/** work 级检索；cover_i 可直接拼封面 URL。 */
export async function searchOpenLibrary(query, opts) {
  const o = opts || {};
  const q = String(query == null ? "" : query).trim();
  if (!q) throw new ProviderError("bad_input", "openlibrary", "检索词不能为空");
  const params = new URLSearchParams({
    q: q,
    limit: String(Math.min(50, Math.max(1, o.limit || 5))),
    fields: o.fields || "key,title,author_name,first_publish_year,cover_i,isbn,publish_date,publisher_name,language",
  });
  const url = "https://openlibrary.org/search.json?" + params.toString();
  const res = await jsonRequest(url, Object.assign({ provider: "openlibrary" }, o));
  const response = requireObject(res.json, "openlibrary", "search");
  const rawDocs = requireArrayField(response, "docs", "openlibrary", "search");
  if (!Number.isInteger(response.numFound) || response.numFound < 0) {
    throw new ProviderError("parse", "openlibrary", "search 响应缺少有效 numFound", { retryable: false });
  }
  const docs = rawDocs.map((d) => requireSearchItem(d, "openlibrary", "search", ["key"], ["title"])).map((d) => ({
    id: olKeyToId(d.key),
    key: clean(d.key),
    title: clean(d.title),
    authors: Array.isArray(d.author_name) ? d.author_name.map(clean).filter(Boolean) : null,
    first_publish_year: d.first_publish_year != null ? String(d.first_publish_year) : null,
    publish_date: Array.isArray(d.publish_date) ? d.publish_date.map(clean).filter(Boolean).slice(0, 3) : clean(d.publish_date),
    cover_id: d.cover_i != null ? String(d.cover_i) : null,
    image_url: d.cover_i != null ? openLibraryCoverUrl(d.cover_i, "L") : null,
    isbn: Array.isArray(d.isbn) ? d.isbn.slice(0, 4) : null,
    languages: Array.isArray(d.language) ? d.language : null,
  }));
  return result("openlibrary", {
    found: docs.length > 0,
    id: docs[0] ? docs[0].id : null,
    title: docs[0] ? docs[0].title : null,
    image_url: docs[0] ? docs[0].image_url : null,
    dates: docs[0] && docs[0].first_publish_year ? { first_publish_year: docs[0].first_publish_year } : null,
    url: docs[0] && docs[0].key ? "https://openlibrary.org" + docs[0].key : null,
    notes: "命中 " + docs.length + " 条（numFound=" + (res.json ? res.json.numFound : "?") + "）；结果集含同名与译本，须逐字核题",
    raw: { numFound: res.json ? res.json.numFound : null, docs: docs },
  });
}

/** ISBN 查记录：/isbn/<isbn>.json 已不可用（实测 404 HTML），走 search?q=isbn: 。 */
export async function lookupOpenLibraryByIsbn(isbn, opts) {
  const raw = String(isbn == null ? "" : isbn).trim();
  const cleanIsbn = raw.replace(/[^0-9Xx]/g, "").toUpperCase();
  if (!/^(97[89]\d{10}|\d{9}[\dX])$/.test(cleanIsbn)) {
    throw new ProviderError("bad_input", "openlibrary", "ISBN 形状非法：" + raw.slice(0, 30));
  }
  const url = "https://openlibrary.org/search.json?q=isbn%3A" + cleanIsbn + "&limit=5&fields=key,title,cover_i,publish_date,first_publish_year,isbn";
  const res = await jsonRequest(url, Object.assign({ provider: "openlibrary" }, opts));
  const response = requireObject(res.json, "openlibrary", "ISBN search");
  const docs = requireArrayField(response, "docs", "openlibrary", "ISBN search");
  if (!Number.isInteger(response.numFound) || response.numFound < 0) {
    throw new ProviderError("parse", "openlibrary", "ISBN search 响应缺少有效 numFound", { retryable: false });
  }
  if (!docs.length) {
    return result("openlibrary", { found: false, id: null, url: "https://openlibrary.org/isbn/" + cleanIsbn, raw: res.json, notes: "OpenLibrary 无该 ISBN 记录（isbn=" + cleanIsbn + "）" });
  }
  const hit = requireSearchItem(docs[0], "openlibrary", "ISBN search", ["key"], ["title"]);
  return result("openlibrary", {
    id: olKeyToId(hit.key),
    title: clean(hit.title),
    image_url: hit.cover_i != null ? openLibraryCoverUrl(hit.cover_i, "L") : null,
    dates: {
      publish: Array.isArray(hit.publish_date) ? clean(hit.publish_date[0]) : clean(hit.publish_date),
      first_publish_year: hit.first_publish_year != null ? String(hit.first_publish_year) : null,
    },
    external_ids: { isbn: [cleanIsbn], openlibrary: olKeyToId(hit.key) },
    url: "https://openlibrary.org" + hit.key,
    notes: "ISBN 命中 " + docs.length + " 条记录，取第一条" + (docs.length > 1 ? "（多版本须人工确认）" : ""),
    raw: { isbn: cleanIsbn, docs: docs },
  });
}

// ───────────────────────── 3. Internet Archive ─────────────────────────

/** 接受 identifier 或 https://archive.org/details/<identifier> 链接。 */
export function normalizeArchiveIdentifier(input) {
  const text = String(input == null ? "" : input).trim();
  const m = text.match(/archive\.org\/(?:details|metadata)\/([^/?#]+)/i);
  const id = m ? m[1] : text;
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-]{1,199}$/.test(id)) {
    throw new ProviderError("bad_input", "internetarchive", "identifier 非法：" + text.slice(0, 60) + "（只允许字母数字与 . _ -，且不能以分隔符开头）");
  }
  return id;
}

export function mapArchiveMetadata(data, identifier) {
  requireObject(data, "internetarchive", "metadata");
  const metadata = data && data.metadata;
  // 关键口径：观测到不存在的 item 返回 HTTP 200 且 body 为 {} 或 metadata:{}。
  if (!Object.keys(data).length || (metadata && typeof metadata === "object" && !Array.isArray(metadata) && !Object.keys(metadata).length)) {
    return result("internetarchive", {
      found: false, id: identifier,
      url: "https://archive.org/details/" + identifier,
      raw: data, notes: "archive.org /metadata 返回空 metadata（HTTP 200 不代表条目存在）",
    });
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new ProviderError("parse", "internetarchive", "metadata 响应缺少对象字段 metadata", { retryable: false });
  }
  if (metadata.identifier == null || !String(metadata.identifier).trim()) {
    throw new ProviderError("parse", "internetarchive", "metadata 记录缺少 identifier", { retryable: false });
  }
  if (String(metadata.identifier) !== String(identifier)) {
    throw new ProviderError("parse", "internetarchive", "metadata identifier 与请求条目标识不一致", { retryable: false });
  }
  const files = Array.isArray(data.files) ? data.files : [];
  const hasImage = files.some((f) => /\.(jpg|jpeg|png)$/i.test(f.name || "") || /(^|\/)(thumb)\.jpg$/i.test(f.name || ""));
  const title = Array.isArray(metadata.title) ? metadata.title[0] : metadata.title;
  const creator = Array.isArray(metadata.creator) ? metadata.creator.map(clean).filter(Boolean)
    : (metadata.creator ? [clean(metadata.creator)] : null);
  const epochDay = (value) => {
    if (value == null || value === "") return null;
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      const d = new Date(asNumber * 1000);
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
    return isoDate(String(value)) ? String(value).slice(0, 10) : null;
  };
  return result("internetarchive", {
    id: identifier,
    title: clean(title),
    titles: { title: clean(title), creator: creator, description: clean(metadata.description) ? String(clean(metadata.description)).slice(0, 400) : null },
    image_url: hasImage ? "https://archive.org/services/img/" + identifier : null,
    image_page_url: "https://archive.org/details/" + identifier,
    dates: {
      release: isoDate(metadata.date) || clean(metadata.date),
      original_date: isoDate(metadata.originaldate) || clean(metadata.originaldate),
      year: metadata.year != null ? String(metadata.year) : null,
      public_date: epochDay(metadata.publicdate),
      added: epochDay(metadata.addeddate),
      item_last_updated: epochDay(data.item_last_updated),
    },
    external_ids: {
      identifier: identifier,
      mediatype: metadata.mediatype ? String(metadata.mediatype) : null,
      collection: Array.isArray(metadata.collection) ? metadata.collection.map(String) : (metadata.collection ? [String(metadata.collection)] : null),
      uploader: metadata.uploader ? String(metadata.uploader) : null,
      isrc: metadata.isrc ? String(metadata.isrc) : null,
    },
    url: "https://archive.org/details/" + identifier,
    notes: "mediatype=" + (metadata.mediatype || "?") + "；文件数=" + (data.files_count != null ? data.files_count : files.length) + "；上传件=" + (metadata.uploader || "?") + " —— 用户上传件不等于官方来源，只有官方元数据可作证据",
    raw: { metadata: metadata, files: files.slice(0, 40), files_count: data.files_count, item_size: data.item_size, server: data.server, dir: data.dir },
  });
}

export async function fetchArchiveItem(identifier, opts) {
  const id = normalizeArchiveIdentifier(identifier);
  const url = "https://archive.org/metadata/" + encodeURIComponent(id);
  const res = await jsonRequest(url, Object.assign({ provider: "internetarchive" }, opts));
  if (res.notFound) return result("internetarchive", { found: false, id: id, url: url, raw: res.raw, notes: "archive.org /metadata 返回 404" });
  return mapArchiveMetadata(res.json, id);
}

/** advancedsearch：只用于发现候选，不代替逐字核对。 */
export async function searchArchive(query, opts) {
  const o = opts || {};
  const q = String(query == null ? "" : query).trim();
  if (!q) throw new ProviderError("bad_input", "internetarchive", "检索词不能为空");
  const params = new URLSearchParams();
  params.set("q", q);
  for (const f of String(o.fields || "identifier,title,mediatype,creator,date,year").split(",")) params.append("fl[]", f.trim());
  params.set("rows", String(Math.min(100, Math.max(1, o.rows || 5))));
  params.set("page", String(Math.max(1, o.page || 1)));
  params.set("sort", o.sort || "metadata.titleSort asc");
  params.set("output", "json");
  const url = "https://archive.org/advancedsearch.php?" + params.toString();
  const res = await jsonRequest(url, Object.assign({ provider: "internetarchive" }, o));
  const root = requireObject(res.json, "internetarchive", "advancedsearch");
  const response = requireObject(root.response, "internetarchive", "advancedsearch.response");
  const rawDocs = requireArrayField(response, "docs", "internetarchive", "advancedsearch.response");
  if (!Number.isInteger(response.numFound) || response.numFound < 0) {
    throw new ProviderError("parse", "internetarchive", "advancedsearch.response 缺少有效 numFound", { retryable: false });
  }
  const docs = rawDocs.map((d) => {
    const doc = requireObject(d, "internetarchive", "advancedsearch 候选项");
    if (doc.identifier == null || !String(doc.identifier).trim()) {
      throw new ProviderError("parse", "internetarchive", "advancedsearch 候选项缺少 identifier", { retryable: false });
    }
    return {
    identifier: d.identifier ? String(d.identifier) : null,
    title: Array.isArray(d.title) ? clean(d.title[0]) : clean(d.title),
    mediatype: d.mediatype ? String(Array.isArray(d.mediatype) ? d.mediatype[0] : d.mediatype) : null,
    creator: d.creator ? (Array.isArray(d.creator) ? d.creator.map(clean).filter(Boolean) : [clean(d.creator)]) : null,
    date: clean(d.date),
    url: "https://archive.org/details/" + d.identifier,
    };
  });
  return result("internetarchive", {
    found: docs.length > 0,
    id: docs[0] ? docs[0].identifier : null,
    title: docs[0] ? docs[0].title : null,
    url: docs[0] ? docs[0].url : null,
    dates: docs[0] && docs[0].date ? { release: isoDate(docs[0].date) || docs[0].date } : null,
    notes: "命中 " + (response.numFound != null ? response.numFound : "?") + " 条，本页 " + docs.length + " 条",
    raw: { numFound: response.numFound, docs: docs },
  });
}

/** Wayback 可用性：用于 VGMdb 这类被反爬拦但确有存档的站。 */
export async function waybackSnapshot(archivedUrl, opts) {
  const o = opts || {};
  const target = String(archivedUrl == null ? "" : archivedUrl).trim();
  if (!/^https?:\/\//i.test(target)) throw new ProviderError("bad_input", "internetarchive", "需要完整 URL：" + target.slice(0, 80));
  const params = new URLSearchParams({ url: target });
  if (o.timestamp) params.set("timestamp", String(o.timestamp));
  const res = await jsonRequest("https://archive.org/wayback/available?" + params.toString(), Object.assign({ provider: "internetarchive" }, o));
  const root = requireObject(res.json, "internetarchive", "Wayback availability");
  const snapshots = requireObject(root.archived_snapshots, "internetarchive", "Wayback archived_snapshots");
  const snap = snapshots.closest || null;
  if (snap != null) requireObject(snap, "internetarchive", "Wayback closest snapshot");
  if (snap && (typeof snap.available !== "boolean" || snap.status == null || !snap.url)) {
    throw new ProviderError("parse", "internetarchive", "Wayback closest snapshot 缺少 available/status/url", { retryable: false });
  }
  const usable = Boolean(snap && snap.available && String(snap.status) === "200");
  return result("internetarchive", {
    found: usable,
    id: null,
    title: null,
    url: usable ? snap.url : null,
    dates: snap && snap.timestamp ? { snapshot: clean(snap.timestamp) } : null,
    notes: usable ? "最近存档 " + snap.timestamp + "（status=" + snap.status + "）" : "该 URL 没有 status=200 的可用存档",
    raw: res.json,
  });
}

// ───────────────────────── 4. TMDB（需 key，缺 key 时优雅降级） ─────────────────────────

export function tmdbCredential(options) {
  const o = options || {};
  const explicit = Object.prototype.hasOwnProperty.call(o, "apiKey") || Object.prototype.hasOwnProperty.call(o, "accessToken");
  const v3 = String(explicit ? (o.apiKey || "") : (process.env.TMDB_API_KEY || "")).trim();
  const v4 = String(explicit ? (o.accessToken || "") : (process.env.TMDB_ACCESS_TOKEN || "")).trim();
  return { v3: v3 || null, v4: v4 || null };
}

export function tmdbImageUrl(posterPath, size) {
  const p = String(posterPath == null ? "" : posterPath).trim();
  if (!p) return null;
  if (!p.startsWith("/")) throw new ProviderError("bad_input", "tmdb", "TMDB path 应以 / 开头：" + p.slice(0, 40));
  return "https://image.tmdb.org/t/p/" + (size || "w500") + p;
}

export function mapTmdbMedia(data, type) {
  requireObject(data, "tmdb", "media");
  const kindName = type || "movie";
  const isPerson = kindName === "person";
  const title = isPerson ? clean(data.name) : (clean(data.title) || clean(data.name));
  if (data.id == null || !String(data.id).trim() || !title) {
    throw new ProviderError("parse", "tmdb", "media 响应缺少 id 或 title/name", { retryable: false });
  }
  const path = isPerson ? data.profile_path : (data.poster_path || data.backdrop_path);
  return result("tmdb", {
    id: String(data.id == null ? "" : data.id),
    title: title,
    titles: {
      title: title,
      original: isPerson ? null : clean(data.original_title || data.original_name),
      alternatives: isPerson ? null : (data.alternative_titles || null),
    },
    image_url: tmdbImageUrl(path, "w500"),
    image_page_url: data.homepage ? clean(data.homepage) : null,
    dates: {
      release: isPerson ? null : isoDate(data.release_date || data.first_air_date),
      birth: isPerson ? isoDate(data.birthday) : null,
      death: isPerson ? isoDate(data.deathday) : null,
    },
    external_ids: {
      tmdb: String(data.id),
      imdb: data.imdb_id ? String(data.imdb_id) : null,
      homepage: data.homepage ? String(data.homepage) : null,
    },
    url: "https://www.themoviedb.org/" + (isPerson ? "person" : kindName) + "/" + data.id,
    notes: [
      isPerson ? null : "原语=" + (data.original_language || "?"),
      data.runtime ? "时长=" + data.runtime + "min" : null,
      !isPerson && data.number_of_episodes != null ? "集数=" + data.number_of_episodes : null,
      clean(data.tagline) ? "tagline=" + clean(data.tagline) : null,
    ].filter(Boolean).join("；") || null,
    rights_note: "TMDB 素材按其条款使用（须署名 TMDB）；站内图片应取版权方官方页，TMDB 图只作线索。",
    raw: data,
  });
}

function tmdbRequestConfig(providerOpts) {
  const o = providerOpts || {};
  const { v3, v4 } = tmdbCredential(o);
  if (!v3 && !v4) {
    const envNames = ["TMDB_API_KEY", "TMDB_ACCESS_TOKEN"];
    const purpose = o.purpose || "TMDB 读取";
    if (Object.prototype.hasOwnProperty.call(o, "apiKey") || Object.prototype.hasOwnProperty.call(o, "accessToken")) {
      throwCredentialMissing("tmdb", envNames, purpose);
    }
    needCredential("tmdb", envNames, purpose);
  }
  const params = new URLSearchParams(o.params || {});
  if (v3) params.set("api_key", v3);
  const headers = v4 ? { Authorization: "Bearer " + v4 } : undefined;
  return { params: params, headers: headers };
}

function tmdbCredentialOverrides(options) {
  const source = options || {};
  const overrides = {};
  for (const key of ["apiKey", "accessToken"]) {
    if (Object.prototype.hasOwnProperty.call(source, key)) overrides[key] = source[key];
  }
  return overrides;
}

/** TMDB 读取：无凭据时抛 credential_missing，调用方应记「跳过（缺凭据）」而不是「无数据」。 */
export async function fetchTmdbMedia(id, opts) {
  const o = opts || {};
  const type = o.type || "movie";
  if (!["movie", "tv", "person"].includes(type)) throw new ProviderError("bad_input", "tmdb", "type 只能是 movie / tv / person，收到 " + type);
  const normId = String(id == null ? "" : id).trim();
  if (!/^\d{1,12}$/.test(normId)) throw new ProviderError("bad_input", "tmdb", "TMDB id 需为数字：" + normId.slice(0, 40));
  const cfg = tmdbRequestConfig(Object.assign({
    purpose: "TMDB " + type + "/" + normId + " 读取",
    params: Object.assign({ language: o.language || "ja-JP" }, o.appendToResponse ? { append_to_response: o.appendToResponse } : {}),
  }, tmdbCredentialOverrides(o)));
  const url = "https://api.themoviedb.org/3/" + type + "/" + normId + "?" + cfg.params.toString();
  const res = await jsonRequest(url, Object.assign({ provider: "tmdb", headers: cfg.headers, credentialHint: "在环境变量 TMDB_API_KEY（v3）或 TMDB_ACCESS_TOKEN（v4）里配置" }, o));
  if (res.notFound) {
    return result("tmdb", { found: false, id: normId, url: "https://www.themoviedb.org/" + type + "/" + normId, raw: res.raw, notes: "TMDB " + type + " " + normId + " 不存在（404）" });
  }
  return mapTmdbMedia(res.json, type);
}

export async function searchTmdb(query, opts) {
  const o = opts || {};
  const q = String(query == null ? "" : query).trim();
  if (!q) throw new ProviderError("bad_input", "tmdb", "检索词不能为空");
  const type = o.type || "movie";
  if (!["movie", "tv", "person", "multi"].includes(type)) throw new ProviderError("bad_input", "tmdb", "type 非法：" + type);
  const base = { query: q, include_adult: String(Boolean(o.includeAdult)), language: o.language || "ja-JP" };
  if (o.year) base.year = String(o.year);
  if (o.firstAirDateYear) base.first_air_date_year = String(o.firstAirDateYear);
  const cfg = tmdbRequestConfig(Object.assign({ purpose: "TMDB " + type + " 检索", params: base }, tmdbCredentialOverrides(o)));
  const url = "https://api.themoviedb.org/3/search/" + type + "?" + cfg.params.toString();
  const res = await jsonRequest(url, Object.assign({ provider: "tmdb", headers: cfg.headers, credentialHint: "配置 TMDB_API_KEY 或 TMDB_ACCESS_TOKEN" }, o));
  const root = requireObject(res.json, "tmdb", "search");
  const rawHits = requireArrayField(root, "results", "tmdb", "search");
  if (!Number.isInteger(root.total_results) || root.total_results < 0) {
    throw new ProviderError("parse", "tmdb", "search 响应缺少有效 total_results", { retryable: false });
  }
  const hits = rawHits.map((r) => requireSearchItem(r, "tmdb", "search", ["id"], ["title", "name"]))
    .slice(0, Math.max(1, o.limit || 5)).map((r) => ({
    id: String(r.id),
    media_type: r.media_type || type,
    title: clean(r.title || r.name),
    original: clean(r.original_title || r.original_name),
    image_url: tmdbImageUrl(r.poster_path || r.profile_path, "w342"),
    dates: { release: isoDate(r.release_date || r.first_air_date) },
    url: "https://www.themoviedb.org/" + (r.media_type || type) + "/" + r.id,
  }));
  return result("tmdb", {
    found: hits.length > 0,
    id: hits[0] ? hits[0].id : null,
    title: hits[0] ? hits[0].title : null,
    image_url: hits[0] ? hits[0].image_url : null,
    dates: hits[0] ? hits[0].dates : null,
    url: hits[0] ? hits[0].url : null,
    notes: "候选 " + hits.length + " 条（page=" + (res.json ? res.json.page : "?") + "/" + (res.json ? res.json.total_pages : "?") + "，total=" + (res.json ? res.json.total_results : "?") + "）",
    raw: { page: res.json ? res.json.page : null, total_results: res.json ? res.json.total_results : null, hits: hits },
  });
}

// ───────────────────────── 5. AniList（公开 GraphQL） ─────────────────────────

const ANILIST_MEDIA_QUERY = "query($id:Int,$type:MediaType){Media(id:$id,type:$type){id title{romaji english native} coverImage{large medium color} bannerImage startDate{year month day} endDate{year month day} synonyms episodes format status season description siteUrl studios{edges{node{name}}}}}";
const ANILIST_SEARCH_QUERY = "query($s:String!,$p:Int,$l:Int,$type:MediaType){Page(page:$p,perPage:$l){pageInfo{total perPage hasNextPage} media(search:$s,type:$type){id title{romaji english native} coverImage{large} startDate{year month day} format status season siteUrl}}}";

/** 接受 1 / https://anilist.co/anime/20757/xxx / { id, type }。 */
export function normalizeAniListId(input, defaultType) {
  const text = String(input == null ? "" : input).trim();
  const m = text.match(/anilist\.co\/(anime|manga)\/(\d+)/i);
  if (m) return { id: Number(m[2]), type: m[1].toUpperCase() };
  if (/^\d{1,12}$/.test(text)) return { id: Number(text), type: (defaultType || "ANIME").toUpperCase() };
  throw new ProviderError("bad_input", "anilist", "无法解析 AniList id：" + text.slice(0, 60));
}

function formatDatePart(d) {
  if (!d || d.year == null) return null;
  const y = String(d.year).padStart(4, "0");
  if (d.month == null) return y;
  const mo = String(d.month).padStart(2, "0");
  if (d.day == null) return y + "-" + mo;
  return y + "-" + mo + "-" + String(d.day).padStart(2, "0");
}

/** GraphQL 层的错误也要区分「条目不存在」与「服务异常」。 */
function anilistGuard(res, idLabel) {
  const root = requireObject(res.json, "anilist", "GraphQL");
  if (Object.prototype.hasOwnProperty.call(root, "errors") && !Array.isArray(root.errors)) {
    throw new ProviderError("parse", "anilist", "GraphQL errors 字段不是数组", { status: res.status, retryable: false });
  }
  const errors = root.errors;
  if (!errors || !errors.length) return;
  const first = requireObject(errors[0], "anilist", "GraphQL errors[0]");
  if (!clean(first.message)) throw new ProviderError("parse", "anilist", "GraphQL error 缺少 message", { status: res.status, retryable: false });
  const message = String(first.message || "");
  if (res.status === 404 || /Not Found/i.test(message)) return; // 交由调用方按 data:null 判 found:false
  throw new ProviderError(first.status === 429 ? "rate_limited" : "parse", "anilist",
    "GraphQL 错误（" + message.slice(0, 160) + "）" + (idLabel || ""),
    { status: res.status, retryable: first.status === 429 || (first.status >= 500) });
}

export function mapAniListMedia(data) {
  requireObject(data, "anilist", "Media");
  if (data.id == null || !String(data.id).trim() || !(clean(data.title && data.title.romaji) || clean(data.title && data.title.english) || clean(data.title && data.title.native))) {
    throw new ProviderError("parse", "anilist", "Media 响应缺少 id 或可用题名", { retryable: false });
  }
  return result("anilist", {
    id: String(data.id),
    title: clean(data.title && data.title.romaji) || clean(data.title && data.title.english) || clean(data.title && data.title.native),
    titles: {
      romaji: clean(data.title && data.title.romaji),
      english: clean(data.title && data.title.english),
      native: clean(data.title && data.title.native),
      synonyms: data.synonyms || null,
    },
    image_url: (data.coverImage && (data.coverImage.large || data.coverImage.medium)) || null,
    image_page_url: data.bannerImage || null,
    dates: { start: formatDatePart(data.startDate), end: formatDatePart(data.endDate), season: clean(data.season) },
    external_ids: { anilist: String(data.id) },
    url: data.siteUrl || ("https://anilist.co/anime/" + data.id),
    notes: [
      data.format ? "形式=" + clean(data.format) : null,
      data.status ? "状态=" + clean(data.status) : null,
      data.episodes != null ? "集数=" + data.episodes : null,
      data.studios && data.studios.edges && data.studios.edges.length ? "制作=" + data.studios.edges.map((e) => clean(e.node && e.node.name)).filter(Boolean).join(",") : null,
    ].filter(Boolean).join("；") || null,
    rights_note: "AniList 封面为社区 / CMS 抓取图；站内图片应取版权方官方页，AniList 值只作核对线索。",
    raw: data,
  });
}

async function anilistGql(query, variables, opts) {
  const o = opts || {};
  return jsonRequest("https://graphql.anilist.co", Object.assign({
    provider: "anilist",
    method: "POST",
    accept: "application/json",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: query, variables: variables }),
    archiveHint: "AniList 公开可用；持续 429 时降到 30 req/min 以下再重试",
  }, o));
}

export async function fetchAniListMedia(idOrUrl, opts) {
  const o = opts || {};
  const parsed = (idOrUrl && typeof idOrUrl === "object" && idOrUrl.id)
    ? { id: Number(idOrUrl.id), type: String(idOrUrl.type || "ANIME").toUpperCase() }
    : normalizeAniListId(idOrUrl, o.type);
  const type = o.type ? String(o.type).toUpperCase() : parsed.type;
  const res = await anilistGql(ANILIST_MEDIA_QUERY, { id: parsed.id, type: type }, o);
  const pageUrl = "https://anilist.co/" + type.toLowerCase() + "/" + parsed.id;
  if (res.notFound) {
    return result("anilist", { found: false, id: String(parsed.id), url: pageUrl, raw: res.raw, notes: "AniList " + type + " " + parsed.id + " 不存在（404 Not Found）" });
  }
  anilistGuard(res, "（id=" + parsed.id + "）");
  const root = requireObject(res.json, "anilist", "GraphQL");
  const data = requireObject(root.data, "anilist", "GraphQL data");
  if (!Object.prototype.hasOwnProperty.call(data, "Media")) {
    throw new ProviderError("parse", "anilist", "GraphQL data 缺少 Media 字段", { status: res.status, retryable: false });
  }
  const media = data.Media;
  if (!media) {
    return result("anilist", { found: false, id: String(parsed.id), url: pageUrl, raw: res.json, notes: "AniList 返回 data.Media=null（该 id 在 type=" + type + " 下无条目；先换 type 复查，再判无此线索）" });
  }
  requireObject(media, "anilist", "GraphQL data.Media");
  return mapAniListMedia(media);
}

export async function searchAniList(query, opts) {
  const o = opts || {};
  const s = String(query == null ? "" : query).trim();
  if (!s) throw new ProviderError("bad_input", "anilist", "检索词不能为空");
  const res = await anilistGql(ANILIST_SEARCH_QUERY, {
    s: s, p: Math.max(1, o.page || 1), l: Math.min(50, Math.max(1, o.perPage || 5)), type: (o.type || "ANIME").toUpperCase(),
  }, o);
  anilistGuard(res);
  const root = requireObject(res.json, "anilist", "GraphQL");
  const data = requireObject(root.data, "anilist", "GraphQL data");
  const page = requireObject(data.Page, "anilist", "GraphQL data.Page");
  const pageInfo = requireObject(page.pageInfo, "anilist", "GraphQL Page.pageInfo");
  if (!Number.isInteger(pageInfo.total) || pageInfo.total < 0) {
    throw new ProviderError("parse", "anilist", "GraphQL Page.pageInfo 缺少有效 total", { status: res.status, retryable: false });
  }
  const media = requireArrayField(page, "media", "anilist", "GraphQL Page");
  const hits = media.map((m) => requireSearchItem(m, "anilist", "GraphQL search", ["id"], ["title"]))
    .map((m) => ({
    id: String(m.id),
    title: clean(m.title && m.title.romaji) || clean(m.title && m.title.native),
    native: clean(m.title && m.title.native),
    image_url: (m.coverImage && m.coverImage.large) || null,
    dates: { start: formatDatePart(m.startDate), season: clean(m.season) },
    format: clean(m.format), status: clean(m.status), url: m.siteUrl || null,
  }));
  return result("anilist", {
    found: hits.length > 0,
    id: hits[0] ? hits[0].id : null,
    title: hits[0] ? hits[0].title : null,
    image_url: hits[0] ? hits[0].image_url : null,
    dates: hits[0] ? hits[0].dates : null,
    url: hits[0] ? hits[0].url : null,
    notes: "候选 " + hits.length + " 条（total=" + (page && page.pageInfo ? page.pageInfo.total : "?") + "）；AniList 罗马字与别名混用，须与官方页核对",
    raw: { pageInfo: page ? page.pageInfo : null, hits: hits },
  });
}

// ───────────────────────── 6. MyAnimeList（需 client id） ─────────────────────────

export function normalizeMalId(input, type) {
  const text = String(input == null ? "" : input).trim();
  const m = text.match(/myanimelist\.net\/(anime|manga)\/(\d+)/i);
  if (m) return { id: m[2], type: m[1] };
  if (/^\d{1,12}$/.test(text)) return { id: text, type: type || "anime" };
  throw new ProviderError("bad_input", "myanimelist", "无法解析 MAL id：" + text.slice(0, 60));
}

const MAL_FIELDS = "id,title,main_picture,alternative_titles,start_date,end_date,media_type,status,rank,popularity,num_episodes,mean,genres,synopsis";

function malClientId(options, purpose) {
  const o = options || {};
  if (Object.prototype.hasOwnProperty.call(o, "clientId")) {
    const value = String(o.clientId || "").trim();
    if (value) return value;
    throwCredentialMissing("myanimelist", ["MAL_CLIENT_ID"], purpose);
  }
  return needCredential("myanimelist", ["MAL_CLIENT_ID"], purpose);
}

export function mapMalAnime(data) {
  requireObject(data, "myanimelist", "anime/manga");
  if (data.id == null || !String(data.id).trim() || !clean(data.title)) {
    throw new ProviderError("parse", "myanimelist", "anime/manga 响应缺少 id 或 title", { retryable: false });
  }
  return result("myanimelist", {
    id: String(data.id),
    title: clean(data.title),
    titles: {
      title: clean(data.title),
      english: clean(data.alternative_titles && data.alternative_titles.english),
      ja: clean(data.alternative_titles && data.alternative_titles.ja),
    },
    image_url: (data.main_picture && (data.main_picture.large || data.main_picture.medium)) || null,
    dates: { start: isoDate(data.start_date) || clean(data.start_date), end: isoDate(data.end_date) || clean(data.end_date) },
    external_ids: { myanimelist: String(data.id) },
    url: "https://myanimelist.net/anime/" + data.id,
    notes: [
      data.media_type ? "媒体=" + clean(data.media_type) : null,
      data.status ? "状态=" + clean(data.status) : null,
      data.num_episodes != null ? "集数=" + data.num_episodes : null,
    ].filter(Boolean).join("；") || null,
    rights_note: "MAL 图片也是第三方转载；封面应以版权方官方页为准。",
    raw: data,
  });
}

/** 匿名访问 api.myanimelist.net 实测 403 forbidden：必须有 OAuth client id。 */
export async function fetchMyAnimeList(idOrUrl, opts) {
  const o = opts || {};
  const parsed = normalizeMalId(idOrUrl, o.type);
  const clientId = malClientId(o, "MyAnimeList " + parsed.type + "/" + parsed.id + " 读取");
  const url = "https://api.myanimelist.net/v2/" + parsed.type + "/" + parsed.id + "?fields=" + (o.fields || MAL_FIELDS);
  const res = await jsonRequest(url, Object.assign({ provider: "myanimelist", headers: { "X-MAL-CLIENT-ID": clientId } }, o));
  if (res.notFound) {
    return result("myanimelist", { found: false, id: parsed.id, url: "https://myanimelist.net/" + parsed.type + "/" + parsed.id, raw: res.raw, notes: "MyAnimeList " + parsed.type + " " + parsed.id + " 不存在（404）" });
  }
  return mapMalAnime(res.json);
}

export async function searchMyAnimeList(query, opts) {
  const o = opts || {};
  const q = String(query == null ? "" : query).trim();
  if (!q) throw new ProviderError("bad_input", "myanimelist", "检索词不能为空");
  const clientId = malClientId(o, "MyAnimeList 检索");
  const type = o.type || "anime";
  const params = new URLSearchParams({
    q: q,
    limit: String(Math.min(100, Math.max(1, o.limit || 5))),
    fields: o.fields || ("id,title,main_picture,alternative_titles,start_date,end_date,media_type,num_episodes,mean"),
  });
  const res = await jsonRequest("https://api.myanimelist.net/v2/" + type + "?" + params.toString(),
    Object.assign({ provider: "myanimelist", headers: { "X-MAL-CLIENT-ID": clientId } }, o));
  const data = requireArrayField(res.json, "data", "myanimelist", "search");
  const hits = data.map((n) => {
    const row = requireObject(n, "myanimelist", "search 候选项");
    const node = requireSearchItem(row.node, "myanimelist", "search", ["id"], ["title"]);
    return {
    id: String(node.id),
    title: clean(node.title),
    image_url: (node.main_picture && (node.main_picture.large || node.main_picture.medium)) || null,
    dates: { start: isoDate(node.start_date) || clean(node.start_date) },
    media_type: clean(node.media_type),
    url: "https://myanimelist.net/" + type + "/" + node.id,
    };
  });
  return result("myanimelist", {
    found: hits.length > 0,
    id: hits[0] ? hits[0].id : null,
    title: hits[0] ? hits[0].title : null,
    image_url: hits[0] ? hits[0].image_url : null,
    dates: hits[0] ? hits[0].dates : null,
    url: hits[0] ? hits[0].url : null,
    notes: "候选 " + hits.length + " 条",
    raw: { hits: hits },
  });
}

// ───────────────────────── 7. ISNI / VIAF / OCLC ─────────────────────────

/** ISNI：16 位数字含 ISO 7064 MOD 11-2 校验位（可为 X）。接受带空格、连字符与 ISNI 包装。 */
export function normalizeIsni(input) {
  const raw = String(input == null ? "" : input).trim();
  const unwrapped = raw.match(/<ISNI[^>]*>([^<]+)<\/ISNI>/i) ? raw.match(/<ISNI[^>]*>([^<]+)<\/ISNI>/i)[1] : raw;
  const digits = String(unwrapped).replace(/[\s\-]/g, "").toUpperCase();
  if (!/^(\d{15}[0-9X])$/.test(digits)) {
    throw new ProviderError("bad_input", "isni", "ISNI 形状非法：" + raw.slice(0, 40) + "（应为 16 位，最后可含校验位 X）");
  }
  return digits;
}

/** 校验位检查：错一位的 ISNI 会把外链指向别人，必须在联网前先本地拦下。 */
export function isValidIsni(input) {
  let value;
  try { value = normalizeIsni(input); } catch { return false; }
  let total = 0;
  for (const ch of value.slice(0, 15)) total = ((total + Number(ch)) * 2) % 11;
  const check = (12 - total) % 11;
  return value[15] === (check === 10 ? "X" : String(check));
}

/** 从 Wikidata EntityData JSON 取 ISNI(P213) / VIAF(P214) —— isni.org 被拦时的官方登记路径。 */
export function isniFromWikidataClaims(entityData, qid) {
  const entities = entityData && entityData.entities ? entityData.entities : null;
  const entity = entities ? entities[qid || Object.keys(entities)[0]] : entityData;
  if (!entity) throw new ProviderError("bad_input", "isni", "缺少 Wikidata entity（传 Special:EntityData/Qxxx.json 解析后的对象）");
  const claimValues = (pid) => {
    const seen = [];
    for (const c of (entity.claims && entity.claims[pid] ? entity.claims[pid] : [])) {
      const v = c && c.mainsnak && c.mainsnak.datavalue ? c.mainsnak.datavalue.value : null;
      if (typeof v !== "string" || !v.trim()) continue;
      const value = v.trim();
      if (!seen.includes(value)) seen.push(value);
    }
    return seen;
  };
  const isni = claimValues("P213");
  const viaf = claimValues("P214");
  return {
    qid: entity.id || qid || null,
    isni: isni.length ? isni.map(normalizeIsni) : [],
    viaf: Array.from(new Set(viaf.map((v) => v.replace(/^https?:\/\/viaf\.org\/viaf\//i, "").replace(/[\s\-]/g, "")).filter((v) => /^\d+$/.test(v)))),
    note: "取自 Wikidata 声明；维基值须经官方页二重核对后才可作为写入证据",
  };
}

/** ISNI 登记机构读取：访问状态按当次 HTTP 响应分类；只有匹配到 RDF 记录结构后才返回 found。 */
export async function fetchIsniRecord(isni, opts) {
  const value = normalizeIsni(isni);
  const url = "https://isni.org/isni/" + value;
  const res = await httpRequest(url, Object.assign({
      provider: "isni", accept: "application/rdf+xml",
      archiveHint: "isni.org 被反爬拦：ISNI / VIAF 改从 Wikidata P213 / P214 取（mf-fetch-authoritative 的 fetchWikidataEntity），或用 isniFromWikidataClaims 抽取；OpenLibrary author.remote_ids 只作线索",
    }, opts));
  if (res.notFound) {
    return result("isni", { found: false, id: value, url: url, raw: res.text.slice(0, 4000), notes: "ISNI 登记机构明确返回 HTTP " + res.status });
  }
  if (looksLikeBotChallenge(res.text)) {
    throw new ProviderError("blocked", "isni", "HTTP " + res.status + " 返回反爬挑战页，不是 ISNI 记录", {
      status: res.status, url: url, retryable: false,
      hint: "改从 Wikidata P213 / P214 取线索，或用 OpenLibrary author.remote_ids 二重核对",
    });
  }
  if (/html/i.test(res.contentType) || /<!doctype\s+html|<html\b/i.test(res.text)) {
    throw new ProviderError("parse", "isni", "ISNI 端点返回 HTML 页面而不是 RDF/XML 记录", {
      status: res.status, url: url, retryable: false,
    });
  }
  if (!/<(?:[\w.-]+:)?RDF\b/i.test(res.text) || !/<\/(?:[\w.-]+:)?RDF\s*>/i.test(res.text)) {
    throw new ProviderError("parse", "isni", "ISNI 响应缺少 RDF 根元素", { status: res.status, url: url, retryable: false });
  }
  const descriptionRe = /<((?:[\w.-]+:)?Description)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
  let description;
  let recordBody = null;
  while ((description = descriptionRe.exec(res.text))) {
    const about = description[2].match(/(?:^|\s)(?:[\w.-]+:)?about\s*=\s*(["'])(.*?)\1/i);
    if (!about) continue;
    const match = about[2].match(/^https?:\/\/isni\.org\/isni\/(\d{16})\/?$/i);
    if (match && match[1] === value) {
      recordBody = description[3];
      break;
    }
  }
  if (recordBody == null) {
    throw new ProviderError("parse", "isni", "RDF/XML 未包含与请求 ISNI 匹配的记录标识", { status: res.status, url: url, retryable: false });
  }
  const labelMatch = recordBody.match(/<((?:[\w.-]+:)?label)\b[^>]*>([\s\S]*?)<\/\1\s*>/i);
  const label = labelMatch ? clean(labelMatch[2]) : null;
  if (!label) {
    throw new ProviderError("parse", "isni", "记录缺少有效 label", { status: res.status, url: url, retryable: false });
  }
  return result("isni", {
    id: value,
    title: label,
    external_ids: { isni: value },
    url: url,
    notes: "content-type=" + (res.contentType || "?") + "；ISNI 记录本体",
    raw: res.text.slice(0, 4000),
  });
}

/** VIAF 记录：只解析带匹配 viafID 和 mainHeadings.data 的 JSON 记录；网关错误不作 not-found。 */
export async function fetchViafRecord(viafId, opts) {
  const id = String(viafId == null ? "" : viafId).trim().replace(/^https?:\/\/viaf\.org\/viaf\//i, "").replace(/[^\d]/g, "");
  if (!id) throw new ProviderError("bad_input", "viaf", "VIAF id 非法：" + String(viafId).slice(0, 40));
  const url = "https://viaf.org/viaf/" + id;
  let res;
  try {
    res = await jsonRequest(url, Object.assign({ provider: "viaf", accept: "application/json", attempts: 1 }, opts));
  } catch (err) {
    if (err instanceof ProviderError && (err.kind === "unavailable" || err.kind === "blocked")) {
      throw new ProviderError("unavailable", "viaf",
        "VIAF 记录端点当前返回网关或访问拦截响应，不能据此判定记录不存在",
        { status: err.status, url: url, retryable: err.retryable, hint: "改用 NDL exactMatch、OpenLibrary author.remote_ids.viaf 或 Wikidata P214 作线索；访问状态见 providerAccess 快照" });
    }
    throw err;
  }
  if (res.notFound) {
    return result("viaf", { found: false, id: id, url: url, raw: res.raw, notes: "VIAF 明确返回 HTTP " + res.status });
  }
  const record = requireObject(res.json, "viaf", "record");
  if (String(record.viafID == null ? "" : record.viafID) !== id || !record.mainHeadings || !Array.isArray(record.mainHeadings.data)) {
    throw new ProviderError("parse", "viaf", "JSON 响应不符合 VIAF record 形状（需匹配 viafID 与 mainHeadings.data 数组）", {
      status: res.status, url: url, retryable: false,
    });
  }
  const heading = record.mainHeadings.data
    .map((item) => item && typeof item === "object" && !Array.isArray(item) ? clean(item.text) : null)
    .find(Boolean);
  if (!heading) {
    throw new ProviderError("parse", "viaf", "VIAF record 缺少有效 main heading", { status: res.status, url: url, retryable: false });
  }
  return result("viaf", {
    id: id,
    title: heading,
    external_ids: { viaf: id },
    url: url,
    notes: "VIAF 主标题；仍需与其他权威记录交叉核对",
    raw: record,
  });
}

/** OCLC：WorldCat Read / Search API 需 client_id + WSKey；FAST 端点当前返回 Status: 4xx。 */
export async function fetchOclcFastHeading(query, opts) {
  const o = opts || {};
  const q = String(query == null ? "" : query).trim();
  if (!q) throw new ProviderError("bad_input", "oclc", "检索词不能为空");
  const params = new URLSearchParams({
    query: q, queryIndex: o.queryIndex || "fastrname", queryReturn: o.queryReturn || "fastrname,idroot",
    database: "fast", suggest: o.suggest || "auto", maxRecords: String(Math.min(20, o.maxRecords || 5)),
  });
  let bodyText;
  let bodyUrl = "https://fast.oclc.org/searchfast/fastsuggest";
  try {
    const res = await httpRequest("https://fast.oclc.org/searchfast/fastsuggest?" + params.toString(), Object.assign({ provider: "oclc" }, o));
    bodyText = res.text;
    bodyUrl = res.url || bodyUrl;
  } catch (err) {
    // 通用网关检测会先把 "Status: 4xx Reason" 归为 unavailable；这里换成指向 FAST 的说明。
    if (err instanceof ProviderError && err.kind === "unavailable") {
      throw new ProviderError("unavailable", "oclc",
        "FAST 端点返回网关错误体（fast.oclc.org/searchfast/fastsuggest 接口已变更或需凭据）：" + err.message,
        { status: err.status, url: err.url, retryable: false, hint: "需要 OCLC 凭据的 WorldCat Read API 见矩阵；主题词表可改用 Wikidata / LC / NDL 件名" });
    }
    throw err;
  }
  if (/^Status:\s*\d{3}/m.test(bodyText)) {
    throw new ProviderError("unavailable", "oclc",
      "FAST 端点返回「" + bodyText.replace(/\s+/g, " ").slice(0, 80) + "」（接口已变更或需凭据）",
      { url: bodyUrl, retryable: false, hint: "需要 OCLC 凭据的 WorldCat Read API 见矩阵；主题词表可改用 Wikidata / LC / NDL 件名" });
  }
  throw new ProviderError("parse", "oclc", "FAST 返回 HTTP 200，但当前没有可核的成功响应解析形状，不能据此声称检索命中", {
    status: 200, url: bodyUrl, retryable: false,
    hint: "保留响应供人工核对；确认 FAST 成功格式后再增加解析器",
  });
}

// ───────────────────────── 8. NDL Linked Data ─────────────────────────

/** NDLNA 权威记录号：通常 8 位数字（允许 6-10 位历史值）。接受 id.ndl.go.jp 链接。 */
export function normalizeNdlAuthorityId(input) {
  const text = String(input == null ? "" : input).trim();
  const m = text.match(/id\.ndl\.go\.jp\/auth\/(?:ndlna|entity)\/(\d{7,10})/i);
  const id = m ? m[1] : text.replace(/[^\d]/g, "");
  if (!/^\d{7,10}$/.test(id)) {
    throw new ProviderError("bad_input", "ndl", "NDL 权威记录号非法：" + text.slice(0, 50) + "（需要 7-10 位数字，NDLNA 实际为 8 位）");
  }
  return id;
}

const JA_RE = /[\u3040-\u30ff\u4e00-\u9fff]/;
const KANA_RE = /[\u3040-\u30ff]/;

export function mapNdlAuthority(data, id) {
  requireObject(data, "ndl", "authority");
  const topic = data.primaryTopic || {};
  if (!(clean(data.label) || clean(data.prefLabel && data.prefLabel.literalForm) || clean(topic.name))) {
    throw new ProviderError("parse", "ndl", "authority 响应缺少 label / prefLabel.literalForm / primaryTopic.name", { retryable: false });
  }
  const typeUri = topic.type && topic.type.uri ? topic.type.uri : null;
  const schemeUri = data.inScheme && data.inScheme.uri ? data.inScheme.uri : null;
  const labelForms = (v) => (Array.isArray(v) ? v.map((x) => x && x["@value"]).filter(Boolean) : (v ? [String(v)] : []));
  const transcriptionL = labelForms(data.prefLabel && data.prefLabel["transcription-l"]);
  const viafList = [].concat(data.exactMatch || [])
    .map((m) => (typeof m === "string" ? m : (m && m.uri) || null))
    .filter((u) => u && /viaf\.org/i.test(u))
    .map((u) => {
      const direct = u.match(/viaf\.org\/viaf\/(\d+)/i);
      if (direct) return direct[1];
      const sourceId = u.match(/viaf\/sourceID\/[^#]+/i);
      return sourceId ? sourceId[0] : u;
    });
  return result("ndl", {
    id: id,
    title: clean(data.label) || clean(data.prefLabel && data.prefLabel.literalForm) || clean(topic.name),
    titles: {
      label: clean(data.label),
      literalForm: clean(data.prefLabel && data.prefLabel.literalForm),
      kana: clean(data.prefLabel && data.prefLabel.transcription) || transcriptionL.find((v) => KANA_RE.test(v)) || null,
      romaji: transcriptionL.find((v) => !JA_RE.test(v)) || null,
      name: clean(topic.name),
    },
    dates: {
      birth: clean(topic.dateOfBirth), death: clean(topic.dateOfDeath),
      created: clean(data.created), modified: clean(data.modified),
    },
    external_ids: {
      ndlna: id,
      uri: data.uri || ("http://id.ndl.go.jp/auth/ndlna/" + id),
      viaf: viafList.length ? viafList : null,
    },
    url: "https://id.ndl.go.jp/auth/ndlna/" + id,
    notes: [
      typeUri ? "type=" + typeUri.split("/").pop() : null,
      schemeUri ? "inScheme=" + schemeUri.split("#").pop() : null,
      Array.isArray(data.source) && data.source.length ? "出典=" + data.source.slice(0, 3).map(clean).join(" / ") : null,
    ].filter(Boolean).join("；") || null,
    raw: data,
  });
}

export async function fetchNdlAuthority(idOrUrl, opts) {
  const id = normalizeNdlAuthorityId(idOrUrl);
  const url = "https://id.ndl.go.jp/auth/ndlna/" + id + ".json";
  const res = await jsonRequest(url, Object.assign({ provider: "ndl" }, opts));
  if (res.notFound) {
    return result("ndl", { found: false, id: id, url: url, raw: res.raw, notes: "NDL 权威记录 " + id + " 不存在（404；书志 LD / ndlsht / ncl 当前也可能 404，见矩阵）" });
  }
  return mapNdlAuthority(res.json, id);
}

// ───────────────────────── 9. VGMdb（无 API：HTML 解析 + 存档读取） ─────────────────────────

export function normalizeVgmdbAlbumId(input) {
  const text = String(input == null ? "" : input).trim();
  const m = text.match(/vgmdb\.net\/album\/(\d+)/i);
  const id = m ? m[1] : text.replace(/[^\d]/g, "");
  if (!/^\d{1,12}$/.test(id)) throw new ProviderError("bad_input", "vgmdb", "VGMdb album id 非法：" + text.slice(0, 50));
  return id;
}

function vgmdbRowPairs(tableHtml) {
  const rows = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(tableHtml))) {
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let c;
    while ((c = cellRe.exec(m[1]))) cells.push(c[1]);
    if (cells.length < 2) continue;
    const key = clean(cells[0]);
    const value = clean(cells[1]);
    if (key) rows.push([key, value]);
  }
  return rows;
}

/**
 * VGMdb 专辑页解析。页面**没有 JSON-LD**（实测 0 个 ld+json script、无 microdata itemtype），
 * 字段在 table#album_infobit_large 的 label/value 行、span.albumtitle[lang]、
 * span#tracklist 区的 tr.rolebit 行与 div#notes 里。纯函数，可对 Internet Archive
 * 存档 HTML 离线复用（也是本模块唯一能离线验证的 VGMdb 路径）。
 */
export function parseVgmdbAlbumHtml(html, info) {
  const meta = info || {};
  const text = String(html == null ? "" : html);
  if (!text.trim()) throw new ProviderError("parse", "vgmdb", "空 HTML");
  if (looksLikeBotChallenge(text) && !/og:image/i.test(text)) {
    throw new ProviderError("blocked", "vgmdb", "收到反爬挑战页而不是专辑页", { retryable: false, hint: "用 fetchVgmdbAlbumViaArchive 走 Internet Archive 存档" });
  }
  const pageTitle = (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const ogImage = (text.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) || [])[1] || null;
  const canonical = (text.match(/<link\s+href="([^"]+)"\s+rel="canonical"/i) || [])[1]
    || (text.match(/<meta\s+property="og:url"\s+content="([^"]+)"/i) || [])[1] || null;
  const idFromPage = canonical && canonical.match(/vgmdb\.net\/album\/(\d+)/i) ? canonical.match(/vgmdb\.net\/album\/(\d+)/i)[1] : null;

  const titles = {};
  const spanRe = /<span class="albumtitle" lang="([^"]+)"[^>]*>([\s\S]*?)<\/span>/gi;
  let s;
  while ((s = spanRe.exec(text))) {
    const value = clean(s[2]);
    if (value) titles[s[1]] = value;
  }

  const infoMap = {};
  const tableRe = /<table id="album_infobit_large"[^>]*>([\s\S]*?)<\/table>/gi;
  let t;
  while ((t = tableRe.exec(text))) {
    for (const pair of vgmdbRowPairs(t[1])) if (!(pair[0] in infoMap)) infoMap[pair[0]] = pair[1];
  }

  const tracks = [];
  const start = text.indexOf('id="tracklist"');
  if (start >= 0) {
    const region = text.slice(start, start + 120000);
    const chunkRe = /<b>\s*Disc\s+(\d+)\s*<\/b>|<tr class="rolebit">([\s\S]*?)<\/tr>/gi;
    let disc = "1";
    let c;
    while ((c = chunkRe.exec(region))) {
      if (c[1]) { disc = c[1]; continue; }
      const row = c[2];
      const cells = [];
      const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      let cell;
      while ((cell = cellRe.exec(row))) cells.push(clean(cell[1]));
      const position = cells.length ? cells[0] : null;
      const title = cells.length > 1 ? cells[1] : null;
      const duration = cells.length > 2 ? cells[cells.length - 1] : null;
      if (title) tracks.push({ disc: disc, position: position, title: title, duration: duration && /[:\d]/.test(duration) ? duration : null });
    }
  }

  const notes = clean((text.match(/<div[^>]*id="notes"[^>]*>([\s\S]*?)<\/div>/i) || [])[1]);
  const title = titles.en || Object.keys(titles).map((k) => titles[k])[0]
    || (clean(pageTitle) ? String(clean(pageTitle)).replace(/\s*-\s*VGMdb$/i, "") : null)
    || infoMap.Title || null;
  if (!title || (!Object.keys(titles).length && !Object.keys(infoMap).length)) {
    throw new ProviderError("parse", "vgmdb", "响应缺少 VGMdb 专辑题名或字段结构（可能是搜索 / 登录页）", { retryable: false });
  }
  const id = meta.albumId ? String(meta.albumId) : idFromPage;
  if (meta.albumId && idFromPage && String(meta.albumId) !== String(idFromPage)) {
    throw new ProviderError("parse", "vgmdb", "页面 canonical album id 与请求 id 不一致", { retryable: false });
  }
  const catalog = infoMap["Catalog Number"] && infoMap["Catalog Number"] !== "N/A" ? infoMap["Catalog Number"] : null;
  return result("vgmdb", {
    id: id,
    title: title,
    titles: Object.keys(titles).length ? titles : null,
    image_url: ogImage,
    image_page_url: canonical || null,
    dates: {
      release: parseEnglishDate(infoMap["Release Date"]),
      release_raw: clean(infoMap["Release Date"]),
      copyright: parseEnglishDate(infoMap["Copyright Date"]) || clean(infoMap["Copyright Date"]),
    },
    external_ids: { vgmdb: id ? String(id) : null, catalog_number: catalog },
    url: canonical || (id ? "https://vgmdb.net/album/" + id : null),
    notes: [
      infoMap["Publish Format"] ? "发行形式=" + infoMap["Publish Format"] : null,
      infoMap["Media Format"] ? "媒体=" + infoMap["Media Format"] : null,
      infoMap["Classification"] ? "分类=" + infoMap["Classification"] : null,
      infoMap["Release Price"] ? "价格=" + infoMap["Release Price"] : null,
      infoMap.Publisher ? "出版=" + infoMap.Publisher : null,
      infoMap["Exclusive Retailer"] ? "独家零售=" + infoMap["Exclusive Retailer"] : null,
      tracks.length ? "曲目=" + tracks.length : null,
      meta.sourceUrl ? "来源页=" + meta.sourceUrl : null,
    ].filter(Boolean).join("；") || null,
    rights_note: "VGMdb 为社区数据库；封面与曲目须与版权方官方页或实体扫描核对后才可作为站内写入证据。",
    tracks: tracks,
    raw: { page_title: clean(pageTitle), info: infoMap, notes: notes, tracks_found: tracks.length, bytes: text.length },
  });
}

/** 直连读取：vgmdb.net 对本机返回 Cloudflare 403（httpRequest 归为 blocked）。 */
export async function fetchVgmdbAlbum(idOrUrl, opts) {
  const id = normalizeVgmdbAlbumId(idOrUrl);
  const url = "https://vgmdb.net/album/" + id;
  const res = await httpRequest(url, Object.assign({
      provider: "vgmdb", accept: "text/html",
      archiveHint: "直连被反爬拦：改用 fetchVgmdbAlbumViaArchive 走 Internet Archive id_ 存档读取",
    }, opts));
  return parseVgmdbAlbumHtml(res.text, { albumId: id, sourceUrl: url });
}

/** 经 Internet Archive 存档读取原样正文（id_ 修饰符），并保留「经存档」标注。 */
export async function fetchVgmdbAlbumViaArchive(idOrUrl, opts) {
  const o = opts || {};
  const id = normalizeVgmdbAlbumId(idOrUrl);
  const originalUrl = "https://vgmdb.net/album/" + id;
  const availability = await waybackSnapshot(originalUrl, o);
  if (!availability.found) {
    throw new ProviderError("unavailable", "vgmdb", "没有可用的 Internet Archive 存档：" + originalUrl,
      { retryable: false, hint: availability.notes || "wayback available 未返回 status=200 的快照" });
  }
  let snapshotUrl = String(availability.url).replace(/^http:/i, "https:");
  if (!/\/web\/\d{8,14}id_\//i.test(snapshotUrl)) {
    snapshotUrl = snapshotUrl.replace(/(\/web\/\d{8,14})\/(https?:\/\/.*)$/i, "$1id_/$2");
  }
  if (snapshotUrl === String(availability.url).replace(/^http:/i, "https:") && !/id_\//.test(snapshotUrl)) {
    throw new ProviderError("parse", "internetarchive", "无法从快照 URL 拼出 id_ 原样正文：" + snapshotUrl, { retryable: false });
  }
  const res = await httpRequest(snapshotUrl, Object.assign({
    provider: "internetarchive", accept: "text/html", timeoutMs: Math.max(TIMEOUT_MS, 30000),
  }, o));
  const parsed = parseVgmdbAlbumHtml(res.text, { albumId: id, sourceUrl: originalUrl });
  parsed.notes = (parsed.notes ? parsed.notes + "；" : "")
    + "经 Internet Archive 存档读取（快照 " + (availability.dates && availability.dates.snapshot ? availability.dates.snapshot : "?") + "）；写入时 pictures[].source.url 用 "
    + originalUrl + " 并在 citation 注明经存档";
  parsed.raw = Object.assign({}, parsed.raw, {
    snapshot_url: res.url, snapshot_timestamp: availability.dates ? availability.dates.snapshot : null, original_url: originalUrl,
  });
  return parsed;
}

// ───────────────────────── 汇总入口（CLI 与 smoke 共用） ─────────────────────────

export const PROVIDER_OPS = {
  "discogs.release": { provider: "discogs", label: "Discogs release（数字或 /release/<id> 链接）", run: (arg, o) => fetchDiscogsRelease(arg, o) },
  "discogs.master": { provider: "discogs", label: "Discogs master", run: (arg, o) => fetchDiscogsMaster(arg, o) },
  "discogs.search": { provider: "discogs", label: "Discogs 检索", run: (arg, o) => searchDiscogs(arg, o) },
  "openlibrary.edition": { provider: "openlibrary", label: "OpenLibrary edition", run: (arg, o) => lookupOpenLibraryEdition(arg, o) },
  "openlibrary.work": { provider: "openlibrary", label: "OpenLibrary work", run: (arg, o) => lookupOpenLibraryWork(arg, o) },
  "openlibrary.author": { provider: "openlibrary", label: "OpenLibrary author（含 ISNI / VIAF 线索）", run: (arg, o) => lookupOpenLibraryAuthor(arg, o) },
  "openlibrary.search": { provider: "openlibrary", label: "OpenLibrary 检索", run: (arg, o) => searchOpenLibrary(arg, o) },
  "openlibrary.editions": { provider: "openlibrary", label: "OpenLibrary work 版本列表", run: (arg, o) => listOpenLibraryEditions(arg, o) },
  "openlibrary.isbn": { provider: "openlibrary", label: "OpenLibrary 按 ISBN", run: (arg, o) => lookupOpenLibraryByIsbn(arg, o) },
  "archive.item": { provider: "internetarchive", label: "archive.org 条目元数据", run: (arg, o) => fetchArchiveItem(arg, o) },
  "archive.search": { provider: "internetarchive", label: "archive.org advancedsearch", run: (arg, o) => searchArchive(arg, o) },
  "archive.wayback": { provider: "internetarchive", label: "Wayback 可用性", run: (arg, o) => waybackSnapshot(arg, o) },
  "tmdb.movie": { provider: "tmdb", label: "TMDB movie（需 key）", run: (arg, o) => fetchTmdbMedia(arg, Object.assign({ type: "movie" }, o)) },
  "tmdb.tv": { provider: "tmdb", label: "TMDB tv（需 key）", run: (arg, o) => fetchTmdbMedia(arg, Object.assign({ type: "tv" }, o)) },
  "tmdb.search": { provider: "tmdb", label: "TMDB 检索（需 key）", run: (arg, o) => searchTmdb(arg, o) },
  "anilist.media": { provider: "anilist", label: "AniList media", run: (arg, o) => fetchAniListMedia(arg, o) },
  "anilist.search": { provider: "anilist", label: "AniList 检索", run: (arg, o) => searchAniList(arg, o) },
  "mal.anime": { provider: "myanimelist", label: "MyAnimeList anime（需 client id）", run: (arg, o) => fetchMyAnimeList(arg, o) },
  "mal.search": { provider: "myanimelist", label: "MyAnimeList 检索（需 client id）", run: (arg, o) => searchMyAnimeList(arg, o) },
  "isni.record": { provider: "isni", label: "ISNI 记录（访问状态见日期快照）", run: (arg, o) => fetchIsniRecord(arg, o) },
  "viaf.record": { provider: "viaf", label: "VIAF 记录（访问状态见日期快照）", run: (arg, o) => fetchViafRecord(arg, o) },
  "oclc.fast": { provider: "oclc", label: "OCLC FAST（需凭据 / 已变更）", run: (arg, o) => fetchOclcFastHeading(arg, o) },
  "ndl.authority": { provider: "ndl", label: "NDL Linked Data 权威记录", run: (arg, o) => fetchNdlAuthority(arg, o) },
  "vgmdb.album": { provider: "vgmdb", label: "VGMdb 专辑（直连；被拦时抛 blocked）", run: (arg, o) => fetchVgmdbAlbum(arg, o) },
  "vgmdb.archive": { provider: "vgmdb", label: "VGMdb 专辑（经 Internet Archive 存档）", run: (arg, o) => fetchVgmdbAlbumViaArchive(arg, o) },
};

/** CLI / smoke 统一分发：未知 op 抛 bad_input，不静默返回空。 */
export async function runProviderOp(op, arg, opts) {
  const entry = PROVIDER_OPS[op];
  if (!entry) throw new ProviderError("bad_input", op, "未知操作：" + op + "（可用：" + Object.keys(PROVIDER_OPS).join(", ") + "）");
  if (!String(arg == null ? "" : arg).trim()) throw new ProviderError("bad_input", entry.provider, "操作 " + op + " 缺少参数");
  return entry.run(arg, opts || {});
}

if (process.argv[1] && String(process.argv[1]).endsWith("mf-fetch-providers.mjs")) {
  const op = process.argv[2];
  const arg = process.argv.slice(3).join(" ");
  if (!op) {
    console.log("用法：node mf-fetch-providers.mjs <op> <参数>\n可用 op：");
    for (const [key, entry] of Object.entries(PROVIDER_OPS)) console.log("  " + key.padEnd(20) + entry.label);
    process.exit(0);
  }
  try {
    const out = await runProviderOp(op, arg);
    const slim = Object.assign({}, out);
    if (typeof slim.raw === "string") slim.raw = slim.raw.slice(0, 600);
    console.log(JSON.stringify(slim, null, 2));
  } catch (err) {
    console.error("抓取失败:", JSON.stringify(describeError(err), null, 2));
    process.exit(1);
  }
}
