// mf-fetch-providers.test.mjs - mf-fetch-providers.mjs 的离线单测
// 全部走注入的 fetchImpl + __fixtures__/，**不发真实网络请求**；联网验证请用 mf-providers-smoke.mjs。
// 运行：node --test mf-fetch-providers.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ProviderError, PROVIDER_MATRIX, describeError, isValidIsni, looksLikeGatewayError, mapDiscogsRelease, providerAccess,
  normalizeAniListId, normalizeArchiveIdentifier, normalizeDiscogsId, normalizeIsni,
  normalizeMalId, normalizeNdlAuthorityId, normalizeOpenLibraryId, normalizeVgmdbAlbumId,
  paceConfig, openLibraryCoverUrl, parseEnglishDate, parseVgmdbAlbumHtml, runProviderOp,
  serialize, tmdbImageUrl,
  fetchAniListMedia, fetchArchiveItem, fetchDiscogsMaster, fetchDiscogsRelease, fetchIsniRecord, fetchMyAnimeList,
  fetchNdlAuthority, fetchOclcFastHeading, fetchTmdbMedia, fetchVgmdbAlbum,
  fetchVgmdbAlbumViaArchive, fetchViafRecord, isniFromWikidataClaims, lookupOpenLibraryAuthor,
  listOpenLibraryEditions, lookupOpenLibraryByIsbn, lookupOpenLibraryEdition, searchAniList, searchArchive, searchDiscogs,
  searchMyAnimeList, searchOpenLibrary, searchTmdb, waybackSnapshot,
} from "./mf-fetch-providers.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
const readText = (name) => fs.readFileSync(path.join(FIXTURES, name), "utf8");

// 单测不等节流；真实调用由模块默认 300ms 保证串行间隔。
paceConfig.minIntervalMs = 0;
paceConfig.backoffBaseMs = 10;

/** 最小 fetch 替身：按 URL 命中返回 fixture，并记录调用序列。 */
function stubFetch(routes) {
  const calls = [];
  const respond = (spec) => new Response(
    typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body),
    {
      status: spec.status === undefined ? 200 : spec.status,
      headers: Object.assign({ "content-type": spec.contentType || "application/json" }, spec.headers || {}),
    });
  const queues = routes.map((route) => Object.assign({}, route, { queue: route.queue ? route.queue.slice() : null }));
  const impl = async (input, init) => {
    const url = String(input);
    calls.push({ url: url, init: init, body: init && init.body });
    for (const route of queues) {
      const hit = route.match instanceof RegExp ? route.match.test(url) : url.includes(route.match);
      if (!hit) continue;
      if (route.thenThrows) throw new Error(route.thenThrows);
      if (route.queue) {
        if (!route.queue.length) throw new Error("test stub queue exhausted for " + url);
        return respond(route.queue.shift());
      }
      return respond(route);
    }
    return new Response("unexpected url in test stub: " + url, { status: 599, headers: { "content-type": "text/plain" } });
  };
  impl.calls = calls;
  return impl;
}

function expectKind(kind, fn) {
  return fn().then(
    () => { throw new Error("expected ProviderError kind=" + kind); },
    (err) => {
      assert.ok(err instanceof ProviderError, "应是 ProviderError，实际：" + err);
      assert.equal(err.kind, kind);
      return err;
    });
}

// ───────── 纯函数与入参规范化 ─────────

test("normalizeDiscogsId accepts id and both site/api URLs", () => {
  assert.equal(normalizeDiscogsId("2879"), "2879");
  assert.equal(normalizeDiscogsId("https://www.discogs.com/release/2879-Daft-Punk-Discovery"), "2879");
  assert.equal(normalizeDiscogsId("https://api.discogs.com/masters/121181", "master"), "121181");
  assert.throws(() => normalizeDiscogsId("release/abc"), (e) => e instanceof ProviderError && e.kind === "bad_input");
});

test("id normalizers reject junk instead of silently returning empty", () => {
  assert.equal(normalizeOpenLibraryId("/books/OL2665823M", "book"), "OL2665823M");
  assert.equal(normalizeOpenLibraryId("https://openlibrary.org/works/OL8996439W", "work"), "OL8996439W");
  assert.equal(normalizeArchiveIdentifier("https://archive.org/details/hot-buttered-rum-internet-archive-2022"), "hot-buttered-rum-internet-archive-2022");
  assert.throws(() => normalizeArchiveIdentifier("../etc/passwd"), (e) => e.kind === "bad_input");
  assert.throws(() => normalizeArchiveIdentifier(""), (e) => e.kind === "bad_input");
  assert.deepEqual(normalizeAniListId("https://anilist.co/manga/123456/x"), { id: 123456, type: "MANGA" });
  assert.equal(normalizeAniListId("20757").id, 20757);
  assert.deepEqual(normalizeMalId("https://myanimelist.net/anime/1/Cowboy_Bebop"), { id: "1", type: "anime" });
  assert.equal(normalizeNdlAuthorityId("https://id.ndl.go.jp/auth/ndlna/00130315"), "00130315");
  assert.throws(() => normalizeNdlAuthorityId("001303"), (e) => e.kind === "bad_input", "6 位以下应拒绝");
  assert.equal(normalizeVgmdbAlbumId("https://vgmdb.net/album/111949"), "111949");
});

test("normalizeIsni tolerates spaces and ISNI tags, validates checksum", () => {
  assert.equal(normalizeIsni("<ISNI>0000 0001 2138 9471</ISNI>"), "0000000121389471");
  assert.equal(normalizeIsni("0000 0001 1048 3251"), "0000000110483251");
  assert.equal(isValidIsni("0000000110483251"), true);
  assert.equal(isValidIsni("0000000110483252"), false, "校验位错一位必须判非法");
  assert.equal(isValidIsni("not-an-isni"), false);
  assert.throws(() => normalizeIsni("00000001104832"), (e) => e.kind === "bad_input");
});

test("isniFromWikidataClaims reads P213/P214 out of a Wikidata EntityData slice", () => {
  const out = isniFromWikidataClaims(readJson("wikidata-entity-synthetic.json"));
  assert.equal(out.qid, "Q54004");
  assert.deepEqual(out.isni, ["0000000121389471"]);
  assert.ok(isValidIsni(out.isni[0]));
  assert.deepEqual(out.viaf, ["102383463"]);
});

test("parseEnglishDate only produces ISO dates it can prove", () => {
  assert.equal(parseEnglishDate("Dec 23, 2020"), "2020-12-23");
  assert.equal(parseEnglishDate("23 Dec 2020"), "2020-12-23");
  assert.equal(parseEnglishDate("1999"), "1999");
  assert.equal(parseEnglishDate("Spring 1999"), null);
  assert.equal(parseEnglishDate(null), null);
});

test("looksLikeGatewayError flags CDN/gateway pages, not provider 404 bodies", () => {
  assert.equal(looksLikeGatewayError("Error Code: 404, Message: Not Found"), true);
  assert.equal(looksLikeGatewayError("Status: 400 Reason: Bad Request"), true);
  assert.equal(looksLikeGatewayError('{"message":"That release does not exist"}'), false);
});

test("providerAccess keeps compatibility fields and marks access as a dated snapshot", () => {
  const entry = providerAccess("viaf");
  assert.equal(entry, PROVIDER_MATRIX.viaf);
  assert.equal(entry.access, "unavailable");
  assert.deepEqual(entry.accessObservation, { status: "unavailable", observedAt: entry.verifiedAt, scope: "snapshot" });
  assert.match(PROVIDER_MATRIX.isni.accessObservation.scope, /snapshot/);
});

test("tmdbImageUrl builds CDN urls and rejects malformed paths", () => {
  assert.equal(tmdbImageUrl("/abc.jpg", "w342"), "https://image.tmdb.org/t/p/w342/abc.jpg");
  assert.equal(tmdbImageUrl(""), null);
  assert.throws(() => tmdbImageUrl("abc.jpg"), (e) => e.kind === "bad_input");
});

test("mapDiscogsRelease rejects a non-object response rather than returning empty", () => {
  assert.throws(() => mapDiscogsRelease(null), (e) => e instanceof ProviderError && e.kind === "parse");
});

test("openLibraryCoverUrl sanitizes the cover id", () => {
  assert.equal(openLibraryCoverUrl("14824481", "m"), "https://covers.openlibrary.org/b/id/14824481-M.jpg");
  assert.throws(() => openLibraryCoverUrl("0"), (e) => e.kind === "bad_input");
});

// ───────── Discogs ─────────

test("fetchDiscogsRelease maps fixture into the shared shape", async () => {
  const fetchImpl = stubFetch([{ match: "api.discogs.com/releases/2879", body: readJson("discogs-release-with-image.json") }]);
  const out = await fetchDiscogsRelease("https://www.discogs.com/release/2879-Daft-Punk-Discovery", { fetchImpl });
  assert.equal(fetchImpl.calls[0].url, "https://api.discogs.com/releases/2879");
  assert.match(fetchImpl.calls[0].init.headers["User-Agent"], /MetaFusion-Curator/);
  assert.equal(out.provider, "discogs");
  assert.equal(out.found, true);
  assert.equal(out.id, "2879");
  assert.equal(out.title, "Discovery");
  assert.equal(out.dates.release, "2001-03-12");
  assert.equal(out.dates.released_formatted, "12 Mar 2001");
  assert.equal(out.external_ids.catalog_number, "V2940");
  assert.equal(out.external_ids.barcode, "7 24384 96061 2");
  assert.equal(out.image_url, readJson("discogs-release-with-image.json").images[0].uri);
  assert.ok(out.tracks.length > 5);
  assert.equal(out.tracks[0].title, "One More Time");
  assert.match(out.rights_note, /社区上传/);
});

test("fetchDiscogsRelease maps a 404 to found:false without throwing", async () => {
  const fetchImpl = stubFetch([{ match: "api.discogs.com/releases/9", status: 404, body: readJson("discogs-release-404.json") }]);
  const out = await fetchDiscogsRelease("9", { fetchImpl });
  assert.equal(out.found, false);
  assert.match(out.notes, /404/);
});

test("searchDiscogs returns candidates and demands triple check", async () => {
  const fetchImpl = stubFetch([{ match: "database/search", body: readJson("discogs-search.json") }]);
  const out = await searchDiscogs("daft punk discovery", { fetchImpl, perPage: 3 });
  assert.match(fetchImpl.calls[0].url, /type=release/);
  assert.equal(out.found, true);
  assert.equal(out.raw.hits.length, 3);
  assert.match(out.notes, /三重核对/);
});

test("HTTP 200 search responses with missing result arrays are parse errors, not empty results", async () => {
  const cases = [
    ["Discogs", () => searchDiscogs("x", { fetchImpl: stubFetch([{ match: "database/search", body: {} }]) })],
    ["Open Library", () => searchOpenLibrary("x", { fetchImpl: stubFetch([{ match: "search.json", body: { numFound: 0 } }]) })],
    ["Internet Archive", () => searchArchive("x", { fetchImpl: stubFetch([{ match: "advancedsearch.php", body: { response: { numFound: 0 } } }]) })],
    ["TMDB", () => searchTmdb("x", { apiKey: "offline-test-key", accessToken: "", fetchImpl: stubFetch([{ match: "search/movie", body: { total_results: 0 } }]) })],
    ["AniList", () => searchAniList("x", { fetchImpl: stubFetch([{ match: "graphql.anilist.co", body: { data: { Page: { pageInfo: { total: 0 } } } } }]) })],
    ["MAL", () => searchMyAnimeList("x", { clientId: "offline-test-client", fetchImpl: stubFetch([{ match: "api.myanimelist.net", body: { data: {} } }]) })],
  ];
  for (const [provider, run] of cases) {
    const err = await expectKind("parse", run);
    assert.match(err.message, /缺少|不是对象/, provider);
  }
});

// ───────── Open Library ─────────

test("lookupOpenLibraryEdition builds cover URL from fixture", async () => {
  const fetchImpl = stubFetch([{ match: "openlibrary.org/books/OL56967691M.json", body: readJson("openlibrary-book-with-cover.json") }]);
  const out = await lookupOpenLibraryEdition("OL56967691M", { fetchImpl });
  assert.equal(out.found, true);
  assert.equal(out.id, "OL56967691M");
  assert.equal(out.title, "Der Name der Rose");
  assert.equal(out.image_url, "https://covers.openlibrary.org/b/id/14824481-L.jpg");
  assert.equal(out.dates.publish, "1989");
  assert.match(out.notes, /出版社=Volk und Wissen/);
});

test("lookupOpenLibraryEdition 404 body maps to found:false", async () => {
  const fetchImpl = stubFetch([{ match: "books/OL99999999999M", status: 404, body: readJson("openlibrary-404.json") }]);
  const out = await lookupOpenLibraryEdition("OL99999999999M", { fetchImpl });
  assert.equal(out.found, false);
});

test("searchOpenLibrary exposes cover ids and isbn hints", async () => {
  const fetchImpl = stubFetch([{ match: "openlibrary.org/search.json", body: readJson("openlibrary-search.json") }]);
  const out = await searchOpenLibrary("the name of the rose", { fetchImpl, limit: 3 });
  assert.equal(out.found, true);
  assert.equal(out.id, "OL8996439W");
  assert.equal(out.image_url, "https://covers.openlibrary.org/b/id/8598263-L.jpg");
  assert.equal(out.raw.docs[0].first_publish_year, "1980");
  assert.match(out.notes, /numFound=603/);
});

test("lookupOpenLibraryByIsbn uses search index (not the dead /isbn path)", async () => {
  const fetchImpl = stubFetch([{ match: "search.json?q=isbn%3A9780156035231", body: readJson("openlibrary-search-isbn.json") }]);
  const out = await lookupOpenLibraryByIsbn("978-0-15-603523-1", { fetchImpl });
  assert.equal(out.found, true);
  assert.deepEqual(out.external_ids.isbn, ["9780156035231"]);
  assert.equal(fetchImpl.calls[0].url.indexOf("/isbn/"), -1);
});

test("lookupOpenLibraryAuthor surfaces ISNI/VIAF as cross-check hints", async () => {
  const fetchImpl = stubFetch([{ match: "authors/OL76088A.json", body: readJson("openlibrary-author-OL76088A.json") }]);
  const out = await lookupOpenLibraryAuthor("OL76088A", { fetchImpl });
  assert.equal(out.title, "Rozanne Gold");
  assert.equal(out.external_ids.isni, "0000000110483251");
  assert.equal(isValidIsni(out.external_ids.isni), true);
  assert.equal(out.external_ids.viaf, "28224202");
  assert.equal(out.dates.birth, "1954");
  assert.match(out.notes, /二重核对/);
});

// ───────── Internet Archive ─────────

test("fetchArchiveItem maps metadata fixture", async () => {
  const fetchImpl = stubFetch([{ match: "archive.org/metadata/hot-buttered-rum", body: readJson("archive-metadata-hot-buttered-rum.json") }]);
  const out = await fetchArchiveItem("https://archive.org/details/hot-buttered-rum-internet-archive-2022", { fetchImpl });
  assert.equal(out.found, true);
  assert.equal(out.id, "hot-buttered-rum-internet-archive-2022");
  assert.match(out.title, /Hot Buttered Rum/);
  assert.equal(out.image_url, "https://archive.org/services/img/hot-buttered-rum-internet-archive-2022");
  assert.equal(out.external_ids.mediatype, "movies");
  assert.match(out.notes, /用户上传件不等于官方来源/);
});

test("fetchArchiveItem treats empty metadata as not found even on HTTP 200", async () => {
  const fetchImpl = stubFetch([{ match: "archive.org/metadata/zzz", status: 200, body: "{}" }]);
  const out = await fetchArchiveItem("zzz", { fetchImpl });
  assert.equal(out.found, false);
  assert.match(out.notes, /HTTP 200 不代表条目存在/);
});

test("searchArchive flattens advancedsearch docs", async () => {
  const fetchImpl = stubFetch([{ match: "advancedsearch.php", body: { response: { numFound: 528316, docs: [{ identifier: "abc", title: ["A Title"], mediatype: "audio", date: "1999" }] } } }]);
  const out = await searchArchive("collection:audio_music", { fetchImpl, rows: 2 });
  assert.equal(out.found, true);
  assert.equal(out.id, "abc");
  assert.equal(out.title, "A Title");
  assert.equal(out.dates.release, "1999");
});

test("waybackSnapshot requires a status-200 snapshot", async () => {
  const fetchImpl = stubFetch([{ match: "wayback/available", body: readJson("archive-wayback-availability-vgmdb-111949.json") }]);
  const out = await waybackSnapshot("https://vgmdb.net/album/111949", { fetchImpl });
  assert.equal(out.found, true);
  assert.match(out.url, /web\.archive\.org\/web\/\d{14}\//);
  const none = stubFetch([{ match: "wayback/available", body: { archived_snapshots: {} } }]);
  const miss = await waybackSnapshot("https://vgmdb.net/album/1", { fetchImpl: none });
  assert.equal(miss.found, false);
});

// ───────── TMDB：缺 key 优雅降级，有 key 正常映射 ─────────

test("fetchTmdbMedia without credentials throws credential_missing (no request)", async () => {
  const fetchImpl = stubFetch([{ match: "themoviedb.org", body: readJson("tmdb-movie.synthetic.json") }]);
  const err = await expectKind("credential_missing", () => fetchTmdbMedia("550", { apiKey: "", accessToken: "", fetchImpl }));
  assert.match(err.message, /TMDB_API_KEY/);
  assert.equal(fetchImpl.calls.length, 0, "缺凭据时不该白打一次请求");
});

test("fetchTmdbMedia with v3 key sends api_key and maps fixture", async () => {
  const fetchImpl = stubFetch([{ match: "themoviedb.org/3/movie/550", body: readJson("tmdb-movie.synthetic.json") }]);
  const out = await fetchTmdbMedia("550", { apiKey: "unit-test-key", accessToken: "", fetchImpl, language: "ja-JP" });
  assert.match(fetchImpl.calls[0].url, /api_key=unit-test-key/);
  assert.match(fetchImpl.calls[0].url, /language=ja-JP/);
  assert.equal(out.provider, "tmdb");
  assert.equal(out.title, "ファイト・クラブ");
  assert.equal(out.titles.original, "Fight Club");
  assert.equal(out.dates.release, "1999-10-15");
  assert.equal(out.image_url, "https://image.tmdb.org/t/p/w500/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg");
  assert.equal(out.external_ids.imdb, "tt0137523");
  assert.match(out.notes, /时长=139min/);
});

test("fetchTmdbMedia with v4 token uses Bearer header", async () => {
  const fetchImpl = stubFetch([{ match: "themoviedb.org/3/tv/1399", body: { id: 1399, name: "Game of Thrones", original_name: "Game of Thrones", first_air_date: "2011-04-17", poster_path: "/1XS1oqL89opfnbLl8WnZY1O1uJx.jpg" } }]);
  const out = await fetchTmdbMedia("1399", { apiKey: "", accessToken: "unit-test-token", fetchImpl, type: "tv" });
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, "Bearer unit-test-token");
  assert.equal(out.dates.release, "2011-04-17");
  assert.equal(out.url, "https://www.themoviedb.org/tv/1399");
});

test("searchTmdb lists candidates with TMDB urls", async () => {
  const fetchImpl = stubFetch([{ match: "search/movie", body: readJson("tmdb-search.synthetic.json") }]);
  const out = await searchTmdb("fight club", { apiKey: "unit-test-key", accessToken: "", fetchImpl, limit: 2 });
  assert.equal(out.found, true);
  assert.equal(out.id, "550");
  assert.equal(out.raw.total_results, 47);
  assert.match(out.notes, /候选 2 条/);
});

test("TMDB network errors redact v3 keys from logs, URL and cause", async () => {
  const key = "synthetic-secret-value";
  const fetchImpl = async (input) => { throw new Error("request failed: " + String(input)); };
  const err = await expectKind("network", () => fetchTmdbMedia("550", {
    apiKey: key, accessToken: "", fetchImpl, attempts: 1,
  }));
  const logged = JSON.stringify(describeError(err));
  assert.equal(err.url.includes(key), false);
  assert.equal(err.message.includes(key), false);
  assert.equal(err.cause.message.includes(key), false);
  assert.equal(logged.includes(key), false);
  assert.match(err.url, /api_key=\[REDACTED\]/);
});

// ───────── AniList ─────────

test("fetchAniListMedia posts GraphQL and maps fixture", async () => {
  const fetchImpl = stubFetch([{ match: "graphql.anilist.co", body: readJson("anilist-media.json") }]);
  const out = await fetchAniListMedia("https://anilist.co/anime/20757/Girlfriend", { fetchImpl });
  assert.equal(fetchImpl.calls[0].init.method, "POST");
  const sent = JSON.parse(fetchImpl.calls[0].body);
  assert.equal(sent.variables.id, 20757);
  assert.equal(sent.variables.type, "ANIME");
  assert.equal(out.provider, "anilist");
  assert.equal(out.title, "Girlfriend (Kari)");
  assert.equal(out.dates.start, "2014-10-13");
  assert.match(out.image_url, /^https:\/\/s4\.anilist\.co\//);
  assert.ok(Array.isArray(out.titles.synonyms));
  assert.match(out.rights_note, /版权方官方页/);
});

test("fetchAniListMedia maps GraphQL 404 to found:false", async () => {
  const fetchImpl = stubFetch([{ match: "graphql.anilist.co", status: 404, body: readJson("anilist-notfound.json") }]);
  const out = await fetchAniListMedia({ id: 999999999, type: "ANIME" }, { fetchImpl });
  assert.equal(out.found, false);
  assert.match(out.notes, /不存在/);
});

test("fetchAniListMedia null data suggests re-checking the other type", async () => {
  const fetchImpl = stubFetch([{ match: "graphql.anilist.co", body: { data: { Media: null } } }]);
  const out = await fetchAniListMedia("1", { fetchImpl, type: "MANGA" });
  assert.equal(out.found, false);
  assert.match(out.notes, /先换 type 复查/);
});

test("searchAniList returns page candidates", async () => {
  // 现有 synthetic fixture 保留原有返回切片；Page.pageInfo 是该查询请求的字段，在测试 mock 中补齐，不回写旧 fixture。
  const response = readJson("anilist-search.json");
  response.data.Page.pageInfo = { total: 3, perPage: 3, hasNextPage: false };
  const fetchImpl = stubFetch([{ match: "graphql.anilist.co", body: response }]);
  const out = await searchAniList("Frieren", { fetchImpl, perPage: 3 });
  assert.equal(out.found, true);
  assert.equal(out.id, "154587");
  assert.equal(out.raw.hits.length, 3);
  assert.match(out.notes, /罗马字与别名混用/);
});

test("AniList GraphQL schema error surfaces as http failure (not empty result)", async () => {
  const fetchImpl = stubFetch([{ match: "graphql.anilist.co", status: 400, body: { errors: [{ message: "Cannot query field \"synonym\"", status: 400 }] } }]);
  const err = await expectKind("http", () => searchAniList("x", { fetchImpl }));
  assert.match(err.message, /Cannot query field/);
  assert.equal(err.retryable, false, "查询写错不是限流，重试无意义");
});

// ───────── MyAnimeList ─────────

test("fetchMyAnimeList without client id throws credential_missing", async () => {
  const fetchImpl = stubFetch([{ match: "myanimelist.net", status: 403, body: readJson("mal-anonymous-forbidden.json") }]);
  const err = await expectKind("credential_missing", () => fetchMyAnimeList("1", { clientId: "", fetchImpl }));
  assert.match(err.message, /MAL_CLIENT_ID/);
  assert.equal(fetchImpl.calls.length, 0);
});

test("fetchMyAnimeList with client id sends X-MAL-CLIENT-ID header", async () => {
  const fetchImpl = stubFetch([{ match: "api.myanimelist.net/v2/anime/1?", body: { id: 1, title: "Cowboy Bebop", main_picture: { medium: "https://cdn.myanimelist.net/images/anime/4/19644.jpg", large: "https://cdn.myanimelist.net/images/anime/4/19644l.jpg" }, start_date: "1998-04-03", end_date: "1999-04-24", media_type: "TV", status: "finished_airing", num_episodes: 26 } }]);
  const out = await fetchMyAnimeList("https://myanimelist.net/anime/1/Cowboy_Bebop", { clientId: "unit-test-client", fetchImpl });
  assert.equal(fetchImpl.calls[0].init.headers["X-MAL-CLIENT-ID"], "unit-test-client");
  assert.equal(out.title, "Cowboy Bebop");
  assert.equal(out.dates.start, "1998-04-03");
  assert.equal(out.image_url, "https://cdn.myanimelist.net/images/anime/4/19644l.jpg");
  assert.match(out.notes, /集数=26/);
});

// ───────── ISNI / VIAF / OCLC：不可行路径必须显式抛错 ─────────

test("fetchIsniRecord surfaces the Cloudflare challenge as blocked", async () => {
  const fetchImpl = stubFetch([{ match: "isni.org/isni/", status: 403, contentType: "text/html; charset=UTF-8", body: readText("isni-challenge.synthetic.html") }]);
  const err = await expectKind("blocked", () => fetchIsniRecord("0000 0001 2138 9471", { fetchImpl }));
  assert.match(err.message, /反爬挑战页/);
  assert.match(err.hint, /Wikidata P213/, "ISNI 被拦时要指向真正可用的替代读取路径");
  assert.equal(err.retryable, false);
});

test("fetchIsniRecord parses a matching RDF record and returns an explicit 404 miss", async () => {
  const fetchImpl = stubFetch([{ match: "isni.org/isni/0000000121389471", contentType: "application/rdf+xml", body: readText("provider-isni-record.synthetic.rdf") }]);
  const out = await fetchIsniRecord("0000 0001 2138 9471", { fetchImpl });
  assert.equal(out.found, true);
  assert.equal(out.id, "0000000121389471");
  assert.equal(out.title, "Daft Punk");
  assert.deepEqual(out.external_ids, { isni: "0000000121389471" });

  const miss = await fetchIsniRecord("0000 0001 2138 9471", {
    fetchImpl: stubFetch([{ match: "isni.org/isni/", status: 404, body: "Not Found" }]),
  });
  assert.equal(miss.found, false);
  assert.match(miss.notes, /HTTP 404/);
});

test("fetchIsniRecord rejects HTTP 200 challenge pages and mismatched or unlabeled RDF", async () => {
  await expectKind("blocked", () => fetchIsniRecord("0000000121389471", {
    fetchImpl: stubFetch([{ match: "isni.org/isni/", contentType: "text/html", body: readText("isni-challenge.synthetic.html") }]),
  }));

  const wrongId = readText("provider-isni-record.synthetic.rdf").replace("0000000121389471", "0000000110483251");
  await expectKind("parse", () => fetchIsniRecord("0000000121389471", {
    fetchImpl: stubFetch([{ match: "isni.org/isni/", contentType: "application/rdf+xml", body: wrongId }]),
  }));

  const noLabel = readText("provider-isni-record.synthetic.rdf").replace(/<rdfs:label>[\s\S]*?<\/rdfs:label>/, "");
  const err = await expectKind("parse", () => fetchIsniRecord("0000000121389471", {
    fetchImpl: stubFetch([{ match: "isni.org/isni/", contentType: "application/rdf+xml", body: noLabel }]),
  }));
  assert.match(err.message, /label/);
});

test("fetchViafRecord parses only a matching known JSON record shape", async () => {
  const fetchImpl = stubFetch([{ match: "viaf.org/viaf/59163545", body: readJson("provider-viaf-record.synthetic.json") }]);
  const out = await fetchViafRecord("59163545", { fetchImpl });
  assert.equal(out.found, true);
  assert.equal(out.id, "59163545");
  assert.equal(out.title, "Turing, Alan, 1912-1954");
  assert.deepEqual(out.external_ids, { viaf: "59163545" });

  const miss = await fetchViafRecord("59163545", {
    fetchImpl: stubFetch([{ match: "viaf.org/viaf/", status: 404, body: "Not Found" }]),
  });
  assert.equal(miss.found, false);

  const malformed = await expectKind("parse", () => fetchViafRecord("59163545", {
    fetchImpl: stubFetch([{ match: "viaf.org/viaf/", body: { viafID: "59163545", mainHeadings: [] } }]),
  }));
  assert.match(malformed.message, /mainHeadings\.data/);
});

test("fetchViafRecord treats the gateway 404 as unavailable, not not-found", async () => {
  const fetchImpl = stubFetch([{ match: "viaf.org/viaf/", status: 404, body: readText("viaf-gateway-error.txt") }]);
  const err = await expectKind("unavailable", () => fetchViafRecord("59163545", { fetchImpl }));
  assert.match(err.hint, /NDL|OpenLibrary|Wikidata/);
});

test("fetchOclcFastHeading reports the changed FAST endpoint", async () => {
  const fetchImpl = stubFetch([{ match: "fast.oclc.org", status: 200, body: readText("oclc-fast-status.txt") }]);
  const err = await expectKind("unavailable", () => fetchOclcFastHeading("mark twain", { fetchImpl }));
  assert.match(err.message, /FAST 端点返回/);
  assert.match(err.hint, /WorldCat/);
});

test("fetchOclcFastHeading does not treat an unrecognized HTTP 200 body as a hit", async () => {
  const err = await expectKind("parse", () => fetchOclcFastHeading("mark twain", {
    fetchImpl: stubFetch([{ match: "fast.oclc.org", contentType: "text/plain", body: "request accepted" }]),
  }));
  assert.match(err.message, /没有可核的成功响应解析形状/);
});

// ───────── NDL ─────────

test("fetchNdlAuthority maps the JSON-LD authority record", async () => {
  const fetchImpl = stubFetch([{ match: "id.ndl.go.jp/auth/ndlna/00130315.json", body: readJson("ndl-authority-00130315.json") }]);
  const out = await fetchNdlAuthority("00130315", { fetchImpl });
  assert.equal(out.found, true);
  assert.equal(out.id, "00130315");
  assert.equal(out.title, "関口, 照生, 1938-");
  assert.equal(out.titles.kana, "セキグチ, テルオ, 1938-");
  assert.equal(out.titles.romaji, "Sekiguchi, Teruo, 1938-");
  assert.equal(out.dates.birth, "1938");
  assert.match(out.notes, /type=Person/);
  assert.match(out.notes, /inScheme=personalNames/);
  assert.ok(out.external_ids.viaf.length === 1 && /viaf/i.test(String(out.external_ids.viaf[0])));
});

test("fetchNdlAuthority 404 maps to found:false with guidance", async () => {
  const fetchImpl = stubFetch([{ match: "ndlna/99999999", status: 404, body: "" }]);
  const out = await fetchNdlAuthority("99999999", { fetchImpl });
  assert.equal(out.found, false);
  assert.match(out.notes, /书志 LD/);
});

// ───────── VGMdb ─────────

test("parseVgmdbAlbumHtml reads the real archived album page", () => {
  const out = parseVgmdbAlbumHtml(readText("vgmdb-album-111949.html"), { albumId: "111949" });
  assert.equal(out.found, true);
  assert.equal(out.title, "Phantasmagoria of F.M");
  assert.equal(out.image_url, "https://medium-media.vgm.io/albums/94/111949/111949-32052d212c19.png");
  assert.equal(out.dates.release, "2020-12-23");
  assert.equal(out.dates.release_raw, "Dec 23, 2020");
  assert.equal(out.external_ids.catalog_number, null, "N/A 不能当作品番");
  assert.match(out.notes, /发行形式=Doujin\/Indie/);
  assert.match(out.notes, /出版=\+TEK/);
  assert.ok(out.tracks.length >= 10, "曲目应解析出来");
  assert.equal(out.tracks[0].position, "01");
  assert.equal(out.tracks[0].title, "Maiden's Capriccio ~ Dream Battle");
  assert.equal(out.tracks[0].duration, "5:28");
  assert.match(out.raw.notes, /All tracks originally composed by ZUN/);
  assert.match(out.rights_note, /社区数据库/);
});

test("parseVgmdbAlbumHtml refuses a bot-challenge page", () => {
  assert.throws(() => parseVgmdbAlbumHtml(readText("isni-challenge.synthetic.html")), (e) => e instanceof ProviderError && e.kind === "blocked");
  assert.throws(() => parseVgmdbAlbumHtml("<html><body>nothing here</body></html>"), (e) => e.kind === "parse");
});

test("fetchVgmdbAlbum direct route fails loudly when the site is challenged", async () => {
  const fetchImpl = stubFetch([{ match: "vgmdb.net/album/", status: 403, contentType: "text/html", body: readText("isni-challenge.synthetic.html") }]);
  const err = await expectKind("blocked", () => fetchVgmdbAlbum("111949", { fetchImpl }));
  assert.match(err.hint, /fetchVgmdbAlbumViaArchive/);
});

test("fetchVgmdbAlbumViaArchive uses the id_ snapshot and keeps provenance", async () => {
  const fetchImpl = stubFetch([
    { match: "archive.org/wayback/available", body: readJson("archive-wayback-availability-vgmdb-111949.json") },
    { match: "web.archive.org/web/", contentType: "text/html; charset=UTF-8", body: readText("vgmdb-album-111949.html") },
  ]);
  const out = await fetchVgmdbAlbumViaArchive("111949", { fetchImpl });
  assert.equal(out.found, true);
  assert.equal(out.id, "111949");
  assert.match(fetchImpl.calls[1].url, /\/web\/\d{14}id_\/https:/, "必须取 id_ 原样正文");
  assert.match(out.notes, /经 Internet Archive 存档读取/);
  assert.match(out.notes, /https:\/\/vgmdb\.net\/album\/111949/);
  assert.equal(out.raw.original_url, "https://vgmdb.net/album/111949");
  assert.ok(out.raw.snapshot_timestamp);
});

// ───────── 错误与节流行为 ─────────

test("429 honours Retry-After and succeeds on retry", async () => {
  const fetchImpl = stubFetch([{
    match: "openlibrary.org/books/OL1M.json",
    queue: [
      { status: 429, body: "slow down", headers: { "retry-after": "0" } },
      { status: 200, body: { key: "/books/OL1M", title: "Retry OK" } },
    ],
  }]);
  const out = await lookupOpenLibraryEdition("OL1M", { fetchImpl });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(out.title, "Retry OK");
});

test("persistent 429 throws rate_limited instead of an empty result", async () => {
  const fetchImpl = stubFetch([{ match: "anilist", status: 429, body: "rate limited", headers: { "retry-after": "600" } }]);
  const err = await expectKind("rate_limited", () => searchAniList("x", { fetchImpl }));
  assert.equal(err.retryable, true);
  assert.match(err.hint, /降频/);
});

test("network failure throws retryable network error after exhausting attempts", async () => {
  const fetchImpl = stubFetch([{ match: "discogs", thenThrows: "socket hang up" }]);
  const err = await expectKind("network", () => fetchDiscogsRelease("2879", { fetchImpl }));
  assert.equal(err.retryable, true);
  assert.match(err.message, /第 2\/2 次/);
});

test("provider 5xx is classified like a transport failure (unknown, retryable)", async () => {
  const fetchImpl = stubFetch([{ match: "archive.org/metadata/", status: 500, body: "server error" }]);
  const err = await expectKind("network", () => fetchArchiveItem("abc", { fetchImpl }));
  assert.equal(err.retryable, true);
  assert.equal(err.status, 500);
  assert.match(err.hint, /不代表条目不存在/);
});

test("4xx is a definite protocol rejection and is not retryable", async () => {
  const fetchImpl = stubFetch([{ match: "discogs", status: 400, body: "bad id" }]);
  const err = await expectKind("http", () => fetchDiscogsRelease("2879", { fetchImpl }));
  assert.equal(err.retryable, false);
});

test("non-JSON body throws parse rather than returning empty", async () => {
  const fetchImpl = stubFetch([{ match: "discogs", status: 200, contentType: "text/html", body: "<html>login required</html>" }]);
  const err = await expectKind("parse", () => fetchDiscogsRelease("2879", { fetchImpl }));
  assert.match(err.message, /不是合法 JSON/);
});

test("serialize keeps same-host calls spaced and different hosts independent", async () => {
  const saved = paceConfig.minIntervalMs;
  paceConfig.minIntervalMs = 60;
  try {
    const stamps = [];
    const job = (host) => serialize(host, () => { stamps.push([host, Date.now()]); return host; });
    await Promise.all([job("a.example"), job("a.example"), job("b.example")]);
    const aTimes = stamps.filter((s) => s[0] === "a.example").map((s) => s[1]);
    assert.equal(aTimes.length, 2);
    assert.ok(aTimes[1] - aTimes[0] >= 59, "同主机必须串行且有最小间隔，实测 " + (aTimes[1] - aTimes[0]) + "ms");
  } finally {
    paceConfig.minIntervalMs = saved;
  }
});

test("describeError and runProviderOp behave for callers", async () => {
  const err = new ProviderError("blocked", "vgmdb", "x", { status: 403, hint: "h" });
  assert.deepEqual(describeError(err), { kind: "blocked", provider: "vgmdb", status: 403, retryable: false, message: "[vgmdb/blocked] x", hint: "h" });
  assert.equal(describeError(new Error("boom")).kind, "unexpected");
  await assert.rejects(() => runProviderOp("nope", "x"), (e) => e.kind === "bad_input");
  await assert.rejects(() => runProviderOp("discogs.release", "  "), (e) => e.kind === "bad_input");
  const fetchImpl = stubFetch([{ match: "api.discogs.com/releases/2879", body: readJson("discogs-release-with-image.json") }]);
  const out = await runProviderOp("discogs.release", "2879", { fetchImpl });
  assert.equal(out.id, "2879");
});

test("every connector result carries the same key set", async () => {
  const pairs = [
    [() => fetchDiscogsRelease("2879", { fetchImpl: stubFetch([{ match: "releases/2879", body: readJson("discogs-release-with-image.json") }]) }), "discogs"],
    [() => fetchArchiveItem("abc", { fetchImpl: stubFetch([{ match: "metadata/abc", body: "{}" }]) }), "internetarchive"],
    [() => fetchNdlAuthority("00130315", { fetchImpl: stubFetch([{ match: "ndlna/00130315.json", body: readJson("ndl-authority-00130315.json") }]) }), "ndl"],
  ];
  for (const [run, provider] of pairs) {
    const out = await run();
    for (const key of ["provider", "found", "id", "title", "image_url", "dates", "url", "raw", "notes"]) {
      assert.ok(key in out, provider + " 缺少出参键 " + key);
    }
    assert.equal(out.provider, provider);
  }
});

// ───────── 复用其余实测 fixture（覆盖"没有封面"这一常见形态） ─────────

test("fetchDiscogsRelease tolerates releases without images", async () => {
  const fixture = readJson("discogs-release-1137851.json");
  const fetchImpl = stubFetch([{ match: "api.discogs.com/releases/1137851", body: fixture }]);
  const out = await fetchDiscogsRelease("1137851", { fetchImpl });
  assert.equal(out.found, true);
  assert.equal(out.dates.year, "1995");
  assert.equal(out.external_ids.discogs, "1137851");
  assert.ok(out.image_url === null || /^https:\/\//.test(out.image_url), "无图时必须是 null，不能是空串");
  assert.equal(out.external_ids.catalog_number, "SHADOW 72");
});

test("fetchDiscogsMaster maps master fixture and keeps master id", async () => {
  const fetchImpl = stubFetch([{ match: "api.discogs.com/masters/121181", body: readJson("discogs-master-121181.json") }]);
  const out = await fetchDiscogsMaster("https://www.discogs.com/master/121181-Duran-Duran", { fetchImpl });
  assert.equal(fetchImpl.calls[0].url, "https://api.discogs.com/masters/121181");
  assert.equal(out.id, "121181");
  assert.equal(out.external_ids.master, "121181");
  assert.equal(out.title, "Red Carpet Massacre");
  assert.deepEqual(out.titles.artists, ["Duran Duran"]);
  assert.equal(out.dates.year, "2007");
  assert.match(out.notes, /master 记录/);
  assert.ok(out.image_url && /^https:\/\/i\.discogs\.com\//.test(out.image_url), "master 的图在 images[] 里");
});

test("searchDiscogs tolerates empty cover_image in results", async () => {
  const fetchImpl = stubFetch([{ match: "database/search", body: readJson("discogs-search-cover.json") }]);
  const out = await searchDiscogs("daft punk discovery", { fetchImpl, perPage: 20 });
  const noCover = out.raw.hits.filter((h) => !h.image_url);
  assert.ok(noCover.length > 0, "实测检索结果里确实存在 cover_image 为空的条目");
  assert.ok(out.raw.hits.every((h) => h.image_url === null || /^https:\/\//.test(h.image_url)));
});

test("lookupOpenLibraryEdition returns null image when the edition has no covers", async () => {
  const fetchImpl = stubFetch([{ match: "books/OL2665823M.json", body: readJson("openlibrary-book-OL2665823M.json") }]);
  const out = await lookupOpenLibraryEdition("OL2665823M", { fetchImpl });
  assert.equal(out.title, "Diplomatic security");
  assert.equal(out.image_url, null);
  assert.equal(out.dates.publish, "1985");
  assert.match(out.notes, /出版社=U\.S\. G\.P\.O\./);
});

test("listOpenLibraryEditions finds which version carries a cover", async () => {
  const fetchImpl = stubFetch([{ match: "works/OL8996439W/editions.json", body: readJson("openlibrary-editions-OL8996439W.json") }]);
  const out = await listOpenLibraryEditions("OL8996439W", { fetchImpl });
  assert.equal(out.found, true);
  assert.equal(out.id, "OL8996439W");
  assert.ok(out.raw.entries.length >= 2);
  const withCover = out.raw.entries.filter((e) => e.image_url);
  assert.ok(withCover.length >= 1, "至少要找出一条有封面的版本");
  assert.equal(withCover[0].cover_id, "14824481");
  assert.match(withCover[0].image_url, /^https:\/\/covers\.openlibrary\.org\/b\/id\/14824481-L\.jpg$/);
  assert.match(out.notes, /有封面 /);
});
