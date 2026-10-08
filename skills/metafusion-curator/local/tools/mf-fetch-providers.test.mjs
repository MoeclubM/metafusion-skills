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
  normalizeItunesCollectionId, normalizeMalId, normalizeNdlAuthorityId, normalizeOpenLibraryId, normalizeVgmdbAlbumId,
  paceConfig, openLibraryCoverUrl, parseEnglishDate, parseVgmdbAlbumHtml, runProviderOp,
  itunesArtworkUrl, itunesArtworkBarcode, itunesArtworkSizes, serialize, splitItunesStorefrontArg, tmdbImageUrl,
  normalizeSteamAppId, parseSteamLocalDate, splitSteamArgOptions, steamStoreUrl,
  fetchAniListMedia, fetchArchiveItem, fetchDiscogsMaster, fetchDiscogsRelease, fetchIsniRecord, fetchMyAnimeList,
  fetchNdlAuthority, fetchOclcFastHeading, fetchTmdbMedia, fetchVgmdbAlbum,
  fetchSteamApp, searchSteam,
  fetchVgmdbAlbumViaArchive, fetchViafRecord, isniFromWikidataClaims, lookupOpenLibraryAuthor,
  listOpenLibraryEditions, lookupItunesAlbum, lookupOpenLibraryByIsbn, lookupOpenLibraryEdition, searchAniList,
  searchArchive, searchDiscogs, searchItunes, searchMyAnimeList, searchOpenLibrary, searchTmdb, waybackSnapshot,
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
    ["iTunes", () => searchItunes("x", { fetchImpl: stubFetch([{ match: "itunes.apple.com/search", body: { resultCount: 0 } }]) })],
    ["Steam", () => searchSteam("x", { fetchImpl: stubFetch([{ match: "storesearch", body: { total: 0 } }]) })],
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

// ───────── iTunes Store ─────────

test("normalizeItunesCollectionId accepts digit ids and music.apple.com album urls", () => {
  assert.equal(normalizeItunesCollectionId("541874266"), "541874266");
  assert.equal(normalizeItunesCollectionId("https://music.apple.com/jp/album/aquaplus-vocal-collection-vol-1/541874266?uo=4"), "541874266");
  assert.equal(normalizeItunesCollectionId("https://music.apple.com/jp/album/541874266?i=541874350"), "541874266");
  assert.throws(() => normalizeItunesCollectionId("abc"), (e) => e instanceof ProviderError && e.kind === "bad_input");
  assert.throws(() => normalizeItunesCollectionId(""), (e) => e.kind === "bad_input");
});

test("splitItunesStorefrontArg pulls an optional trailing country= override", () => {
  assert.deepEqual(splitItunesStorefrontArg("  まいてつ  "), { value: "まいてつ", storefront: null });
  assert.deepEqual(splitItunesStorefrontArg("LiSA country=US"), { value: "LiSA", storefront: "us" });
  assert.deepEqual(splitItunesStorefrontArg("country=jp"), { value: "", storefront: "jp" });
  assert.throws(() => splitItunesStorefrontArg("x country=jpn"), (e) => e instanceof ProviderError && e.kind === "bad_input");
});

test("itunesArtworkUrl rewrites the mzstatic size prefix and keeps foreign shapes", () => {
  assert.equal(
    itunesArtworkUrl("https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/8f/ee/39/x.jpg/100x100bb.jpg", 600),
    "https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/8f/ee/39/x.jpg/600x600bb.jpg");
  assert.equal(itunesArtworkUrl(null), null);
  assert.equal(itunesArtworkUrl("https://example.org/cover.jpg"), "https://example.org/cover.jpg");
});

test("itunesArtworkUrl clamps to 60-3000 and can switch the container ext", () => {
  const url = "https://is1-ssl.mzstatic.com/image/thumb/Music62/v4/af/98/a6/u/4538182209493_cov.jpg/100x100bb.jpg";
  assert.equal(itunesArtworkUrl(url, 99999), "https://is1-ssl.mzstatic.com/image/thumb/Music62/v4/af/98/a6/u/4538182209493_cov.jpg/3000x3000bb.jpg");
  assert.equal(itunesArtworkUrl(url, 1), "https://is1-ssl.mzstatic.com/image/thumb/Music62/v4/af/98/a6/u/4538182209493_cov.jpg/60x60bb.jpg");
  assert.equal(itunesArtworkUrl(url, 600, "webp"), "https://is1-ssl.mzstatic.com/image/thumb/Music62/v4/af/98/a6/u/4538182209493_cov.jpg/600x600bb.webp");
});

test("itunesArtworkSizes emits the default size map and rejects non-mzstatic shapes", () => {
  const url = "https://is1-ssl.mzstatic.com/image/thumb/Music62/v4/af/98/a6/u/4538182209493_cov.jpg/100x100bb.jpg";
  const map = itunesArtworkSizes(url);
  assert.deepEqual(Object.keys(map), ["60", "100", "170", "300", "600", "1200", "3000"]);
  assert.equal(map["600"], "https://is1-ssl.mzstatic.com/image/thumb/Music62/v4/af/98/a6/u/4538182209493_cov.jpg/600x600bb.jpg");
  assert.equal(map["3000"], "https://is1-ssl.mzstatic.com/image/thumb/Music62/v4/af/98/a6/u/4538182209493_cov.jpg/3000x3000bb.jpg");
  assert.deepEqual(itunesArtworkSizes(url, [300, 600]), {
    "300": "https://is1-ssl.mzstatic.com/image/thumb/Music62/v4/af/98/a6/u/4538182209493_cov.jpg/300x300bb.jpg",
    "600": "https://is1-ssl.mzstatic.com/image/thumb/Music62/v4/af/98/a6/u/4538182209493_cov.jpg/600x600bb.jpg",
  });
  assert.equal(itunesArtworkSizes("https://example.org/cover.jpg"), null);
  assert.equal(itunesArtworkSizes(null), null);
});

test("itunesArtworkBarcode surfaces every numeric candidate (no hard validation) for agent verification", () => {
  const base = "https://is1-ssl.mzstatic.com/image/thumb/Music62/v4/af/98/a6/u/";
  assert.deepEqual(itunesArtworkBarcode(base + "4538182209493_cov.jpg/100x100bb.jpg"),
    { value: "4538182209493", source: "apple_artwork_filename", scheme: "ean-13", checksum_valid: true });
  assert.equal(itunesArtworkBarcode(base + "194491717186.jpg/100x100bb.jpg").scheme, "upc-a");
  // 校验位不通过也不丢弃，只标记 checksum_valid:false，交 agent 按技能核实
  const bad = itunesArtworkBarcode(base + "4538182209490.jpg/100x100bb.jpg");
  assert.equal(bad.value, "4538182209490");
  assert.equal(bad.checksum_valid, false);
  // 非标准位数照样给候选，scheme 记 null
  const odd = itunesArtworkBarcode(base + "1234567.jpg/100x100bb.jpg");
  assert.equal(odd.value, "1234567");
  assert.equal(odd.scheme, null);
  // 文件名里没有数字编号段才返回 null
  assert.equal(itunesArtworkBarcode("https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/8f/ee/39/u/dj.lxhnqrgt.jpg/100x100bb.jpg"), null);
  assert.equal(itunesArtworkBarcode("https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/a/b/c/u/ami-identity-9f0.png/100x100bb.jpg"), null);
  assert.equal(itunesArtworkBarcode(null), null);
});

test("searchItunes maps album candidates and keeps a raw slice per hit", async () => {
  const fetchImpl = stubFetch([{ match: "itunes.apple.com/search", body: readJson("itunes-search.synthetic.json") }]);
  const out = await searchItunes("AQUAPLUS", { fetchImpl });
  const sent = new URL(fetchImpl.calls[0].url);
  assert.equal(sent.pathname, "/search");
  assert.equal(sent.searchParams.get("term"), "AQUAPLUS");
  assert.equal(sent.searchParams.get("media"), "music");
  assert.equal(sent.searchParams.get("entity"), "album");
  assert.equal(sent.searchParams.get("country"), "jp");
  assert.equal(sent.searchParams.get("limit"), "5");
  assert.equal(out.provider, "itunes");
  assert.equal(out.found, true);
  assert.equal(out.id, "541874266");
  assert.equal(out.title, "AQUAPLUS VOCAL COLLECTION VOL.1");
  assert.equal(out.dates.release, "2006-01-01");
  assert.equal(out.raw.resultCount, 2);
  const hit = out.raw.hits[0];
  assert.equal(hit.artist, "美崎しのぶ, 中司雅美, AKKO, 森川由綺 & 緒方理奈");
  assert.equal(hit.track_count, 10);
  assert.equal(hit.country, "JPN");
  assert.equal(hit.storefront, "jp");
  assert.equal(hit.release_date_raw, "2006-01-01T00:00:00Z");
  assert.match(hit.url, /^https:\/\/music\.apple\.com\/jp\/album\//);
  assert.match(hit.image_url, /\/600x600bb\.jpg$/);
  assert.match(hit.images["3000"], /\/3000x3000bb\.jpg$/);
  assert.equal(hit.release_number, null, "VOL.1 封面文件名 dj.lxhnqrgt 不是条码，应为 null");
  assert.equal(hit.raw.collectionId, 541874266);
  assert.equal(hit.raw.currency, "JPY");
  const barcodeHit = out.raw.hits[1];
  assert.deepEqual(barcodeHit.release_number, { value: "4538182209493", source: "apple_artwork_filename", scheme: "ean-13", checksum_valid: true, kind: "candidate" });
  assert.match(barcodeHit.images["600"], /\/4538182209493_cov\.jpg\/600x600bb\.jpg$/);
});

test("searchItunes empty result is an explicit found:false, not a silent empty array", async () => {
  const fetchImpl = stubFetch([{ match: "itunes.apple.com/search", body: { resultCount: 0, results: [] } }]);
  const out = await searchItunes("Maitetsu", { fetchImpl });
  assert.equal(out.found, false);
  assert.equal(out.id, null);
  assert.match(out.notes, /无命中/);
  assert.match(out.notes, /resultCount=0/);
  assert.deepEqual(out.raw.hits, []);
});

test("searchItunes honours a country= override and rejects a blank term before any request", async () => {
  const fetchImpl = stubFetch([{ match: "itunes.apple.com/search", body: { resultCount: 0, results: [] } }]);
  await searchItunes("LiSA country=us", { fetchImpl });
  assert.match(fetchImpl.calls[0].url, /country=us/);
  const blank = stubFetch([{ match: "itunes.apple.com/search", body: { resultCount: 0, results: [] } }]);
  const err = await expectKind("bad_input", () => searchItunes("  ", { fetchImpl: blank }));
  assert.equal(blank.calls.length, 0, "坏输入不该发出请求");
  assert.match(err.message, /检索词不能为空/);
});

test("lookupItunesAlbum maps the collection plus the track list", async () => {
  const fetchImpl = stubFetch([{ match: "itunes.apple.com/lookup", body: readJson("itunes-album.synthetic.json") }]);
  const out = await lookupItunesAlbum("https://music.apple.com/jp/album/aquaplus-vocal-collection-vol-1/541874266?uo=4", { fetchImpl });
  const sent = new URL(fetchImpl.calls[0].url);
  assert.equal(sent.pathname, "/lookup");
  assert.equal(sent.searchParams.get("id"), "541874266");
  assert.equal(sent.searchParams.get("entity"), "song");
  assert.equal(sent.searchParams.get("country"), "jp");
  assert.equal(out.found, true);
  assert.equal(out.id, "541874266");
  assert.equal(out.title, "AQUAPLUS VOCAL COLLECTION VOL.1");
  assert.equal(out.dates.release, "2006-01-01");
  assert.equal(out.dates.release_raw, "2006-01-01T00:00:00Z");
  assert.equal(out.external_ids.itunes, "541874266");
  assert.equal(out.external_ids.barcode_candidate, null, "封面文件名非条码时不给候选编号");
  assert.match(out.images["600"], /\/600x600bb\.jpg$/);
  assert.equal(out.release_number, null);
  assert.match(out.notes, /未含可识别编号/);
  assert.equal(out.tracks.length, 2);
  assert.equal(out.tracks[0].disc_number, 1);
  assert.equal(out.tracks[0].track_number, 1);
  assert.equal(out.tracks[0].title, "Brand-New Heart");
  assert.equal(out.tracks[0].duration_ms, 277160);
  assert.equal(out.tracks[0].duration_seconds, 277.2);
  assert.equal(out.tracks[0].has_preview, true);
  assert.match(out.tracks[0].preview_url, /^https:\/\/audio-ssl\.itunes\.apple\.com\//);
  assert.equal(out.tracks[1].track_number, 2);
  assert.match(out.notes, /曲目 2 条（trackCount=10）/);
  assert.match(out.notes, /不一致/);
  assert.match(out.notes, /storefront=jp/);
  assert.equal(out.raw.resultCount, 3);
});

test("lookupItunesAlbum maps an empty lookup to found:false (HTTP 200 + resultCount=0)", async () => {
  const fetchImpl = stubFetch([{ match: "itunes.apple.com/lookup", body: { resultCount: 0, results: [] } }]);
  const out = await lookupItunesAlbum("999999999999", { fetchImpl });
  assert.equal(out.found, false);
  assert.equal(out.id, "999999999999");
  assert.match(out.notes, /不存在或未上架/);
});

test("lookupItunesAlbum flags an id that resolves to tracks but no collection", async () => {
  const fetchImpl = stubFetch([{ match: "itunes.apple.com/lookup", body: { resultCount: 1, results: [{ wrapperType: "track", trackId: 541874350, trackName: "Brand-New Heart" }] } }]);
  const out = await lookupItunesAlbum("541874350", { fetchImpl });
  assert.equal(out.found, false);
  assert.match(out.notes, /trackId/);
});

test("lookupItunesAlbum rejects a non-numeric id without any request", async () => {
  const fetchImpl = stubFetch([{ match: "itunes.apple.com/lookup", body: {} }]);
  const err = await expectKind("bad_input", () => lookupItunesAlbum("not-an-id", { fetchImpl }));
  assert.equal(fetchImpl.calls.length, 0);
  assert.match(err.message, /collectionId/);
});

test("lookupItunesAlbum surfaces the artwork-filename barcode as an explicit candidate, not a verified upc", async () => {
  const fetchImpl = stubFetch([{ match: "itunes.apple.com/lookup", body: readJson("itunes-album-barcode.synthetic.json") }]);
  const out = await lookupItunesAlbum("1591536789", { fetchImpl });
  assert.equal(out.found, true);
  assert.deepEqual(out.release_number, { value: "4547366532999", source: "apple_artwork_filename", scheme: "ean-13", checksum_valid: true, kind: "candidate" });
  assert.equal(out.external_ids.barcode_candidate, "4547366532999");
  assert.equal(out.external_ids.upc, null, "Apple Search API 不返回 upc，保持 null");
  assert.match(out.notes, /编号候选 4547366532999/);
  assert.match(out.notes, /校验位通过/);
  assert.match(out.notes, /须由 agent 按技能核实确认/);
  assert.match(out.images["600"], /\/4547366532999\.jpg\/600x600bb\.jpg$/);
});

// ───────── Steam 商店 ─────────

test("normalizeSteamAppId accepts ids and both store/steamdb urls", () => {
  assert.equal(normalizeSteamAppId("504230"), "504230");
  assert.equal(normalizeSteamAppId(" 504230 "), "504230");
  assert.equal(normalizeSteamAppId("https://store.steampowered.com/app/504230/Celeste/"), "504230");
  assert.equal(normalizeSteamAppId("https://steamdb.info/app/504230/"), "504230");
  assert.equal(normalizeSteamAppId("https://steamdb.info/app/504230"), "504230");
  for (const junk of ["0", "-1", "abc", "https://store.steampowered.com/app/Celeste/", ""]) {
    assert.throws(() => normalizeSteamAppId(junk), (e) => e instanceof ProviderError && e.kind === "bad_input", "应拒绝：" + junk);
  }
});

test("splitSteamArgOptions pulls trailing lang/langs/cc and rejects malformed codes", () => {
  assert.deepEqual(splitSteamArgOptions("504230"), { value: "504230", lang: null, langs: null, cc: null });
  assert.deepEqual(splitSteamArgOptions("504230 cc=jp lang=japanese"), { value: "504230", lang: "japanese", langs: null, cc: "jp" });
  assert.deepEqual(splitSteamArgOptions("Celeste langs=english,schinese cc=cn"), { value: "Celeste", lang: null, langs: ["english", "schinese"], cc: "cn" });
  assert.throws(() => splitSteamArgOptions("x cc=jpn"), (e) => e.kind === "bad_input");
  assert.throws(() => splitSteamArgOptions("x lang=zh-CN"), (e) => e.kind === "bad_input");
});

test("parseSteamLocalDate normalizes english and CJK store dates only", () => {
  assert.equal(parseSteamLocalDate("Jan 25, 2018"), "2018-01-25");
  assert.equal(parseSteamLocalDate("2018 年 1 月 25 日"), "2018-01-25");
  assert.equal(parseSteamLocalDate("2018年1月25日"), "2018-01-25");
  assert.equal(parseSteamLocalDate("2020"), "2020");
  assert.equal(parseSteamLocalDate("Coming soon"), null);
  assert.equal(parseSteamLocalDate("2024 年 2 月"), null);
  assert.equal(parseSteamLocalDate(""), null);
});

test("steamStoreUrl builds the canonical store url", () => {
  assert.equal(steamStoreUrl("504230"), "https://store.steampowered.com/app/504230/");
  assert.equal(steamStoreUrl(504230), "https://store.steampowered.com/app/504230/");
});

test("fetchSteamApp maps multi-language appdetails into the shared shape", async () => {
  const english = {
    type: "game", name: "Celeste", steam_appid: 504230, is_free: false,
    short_description: "Help Madeline survive her inner demons.",
    supported_languages: "English, French, Italian",
    header_image: "https://cdn.akamai.steamstatic.com/steam/apps/504230/header.jpg",
    website: "https://www.celestegame.com/",
    developers: ["Maddy Makes Games Inc.", "Extremely OK Games, Ltd."],
    publishers: ["Maddy Makes Games Inc."],
    platforms: { windows: true, mac: true, linux: true },
    genres: [{ id: "1", description: "Action" }, { id: "23", description: "Indie" }],
    release_date: { coming_soon: false, date: "Jan 25, 2018" },
    price_overview: { currency: "USD", initial: 1999, final: 499, discount_percent: 75, initial_formatted: "$19.99", final_formatted: "$4.99" },
  };
  const schinese = {
    name: "蔚蓝",
    short_description: "帮助 Madeline 战胜内心的恶魔。",
    release_date: { coming_soon: false, date: "2018 年 1 月 25 日" },
    price_overview: { currency: "USD", initial: 1999, final: 1999, discount_percent: 0, initial_formatted: "$19.99", final_formatted: "$19.99" },
  };
  const fetchImpl = stubFetch([
    { match: "l=english", body: { "504230": { success: true, data: english } } },
    { match: "l=schinese", body: { "504230": { success: true, data: schinese } } },
  ]);
  const out = await fetchSteamApp("https://store.steampowered.com/app/504230/Celeste/ langs=english,schinese", { fetchImpl });
  assert.equal(out.found, true);
  assert.equal(out.id, "504230");
  assert.equal(out.title, "Celeste");
  assert.deepEqual(out.titles, { english: "Celeste", schinese: "蔚蓝" });
  assert.equal(out.dates.release, "2018-01-25");
  assert.equal(out.dates.release_raw, "Jan 25, 2018");
  assert.equal(out.dates.by_lang.schinese.normalized, "2018-01-25");
  assert.deepEqual(out.external_ids, { steam: "504230" });
  assert.equal(out.url, "https://store.steampowered.com/app/504230/");
  assert.deepEqual(out.developers, ["Maddy Makes Games Inc.", "Extremely OK Games, Ltd."]);
  assert.deepEqual(out.genres, ["Action", "Indie"]);
  assert.equal(out.price.amount, 19.99);
  assert.equal(out.price.final_amount, 4.99);
  assert.equal(out.price.region, "us");
  assert.match(out.notes, /未折扣标价/);
  assert.ok(fetchImpl.calls.every((call) => call.url.includes("cc=us")), "未写 cc 时应默认 us");
  assert.equal(out.raw.locales.english.short_description, "Help Madeline survive her inner demons.");
});

test("fetchSteamApp reports success:false as found:false without throwing", async () => {
  const fetchImpl = stubFetch([{ match: "appdetails", body: { "999999999": { success: false } } }]);
  const out = await fetchSteamApp("999999999 cc=us", { fetchImpl });
  assert.equal(out.found, false);
  assert.equal(out.id, "999999999");
  assert.match(out.notes, /success:false/);
  assert.match(out.notes, /不代表该作品在其他区域或平台/);
});

test("fetchSteamApp keeps the languages that answered and flags the ones without data", async () => {
  const fetchImpl = stubFetch([
    { match: "l=english", body: { "504230": { success: true, data: { name: "Celeste", type: "game", release_date: { date: "Jan 25, 2018", coming_soon: false } } } } },
    { match: "l=japanese", body: { "504230": { success: false } } },
  ]);
  const out = await fetchSteamApp("504230 langs=english,japanese", { fetchImpl });
  assert.equal(out.found, true);
  assert.deepEqual(out.titles, { english: "Celeste" });
  assert.match(out.notes, /success:false 或无资料：japanese/);
  assert.equal(out.raw.success.japanese, false);
});

test("fetchSteamApp flags coming_soon and refuses to read a missing price as free", async () => {
  const fetchImpl = stubFetch([{ match: "appdetails", body: { "123": { success: true, data: { name: "TBA Game", type: "game", is_free: false, release_date: { coming_soon: true, date: "Coming soon" } } } } }]);
  const out = await fetchSteamApp("123", { fetchImpl });
  assert.equal(out.coming_soon, true);
  assert.equal(out.dates.release, null);
  assert.equal(out.dates.release_raw, "Coming soon");
  assert.equal(out.price, null);
  assert.match(out.notes, /不能按已发售日期写 edition_date/);
  assert.match(out.notes, /不能当作免费/);
});

test("fetchSteamApp rejects more than four languages before any request", async () => {
  const fetchImpl = stubFetch([{ match: "appdetails", body: {} }]);
  const err = await expectKind("bad_input", () => fetchSteamApp("1 langs=english,japanese,schinese,tchinese,koreana", { fetchImpl }));
  assert.equal(fetchImpl.calls.length, 0);
  assert.match(err.message, /最多取 4 个语种/);
});

test("searchSteam lists store candidates and keeps type/price for triage", async () => {
  const body = {
    total: 9,
    items: [
      { type: "app", id: 504230, name: "Celeste", price: { currency: "CNY", initial: 6800, final: 1700 }, tiny_image: "https://cdn.akamai.steamstatic.com/steam/apps/504230/capsule_sm_120.jpg", metascore: "88", platforms: { windows: true, mac: true, linux: true } },
      { type: "app", id: 1092840, name: "Celeste Soundtrack", price: { currency: "CNY", initial: 3400, final: 850 }, tiny_image: "", metascore: "", platforms: { windows: true } },
    ],
  };
  const fetchImpl = stubFetch([{ match: "storesearch", body: body }]);
  const out = await searchSteam("Celeste cc=cn", { fetchImpl });
  assert.equal(out.found, true);
  assert.equal(out.id, "504230");
  assert.equal(out.title, "Celeste");
  assert.equal(out.url, "https://store.steampowered.com/app/504230/");
  assert.match(out.notes, /候选 2 条（total=9/);
  assert.match(out.notes, /核对 AppID、类型/);
  assert.equal(out.raw.hits[0].price.amount, 68);
  assert.equal(out.raw.hits[0].raw.metascore, "88");
  assert.equal(out.raw.hits[1].image_url, null);
  assert.ok(fetchImpl.calls[0].url.includes("cc=cn"));
});

test("searchSteam maps an empty result to found:false and suggests another language", async () => {
  const fetchImpl = stubFetch([{ match: "storesearch", body: { total: 0, items: [] } }]);
  const out = await searchSteam("まいてつ", { fetchImpl });
  assert.equal(out.found, false);
  assert.equal(out.id, null);
  assert.equal(out.url, null);
  assert.match(out.notes, /无命中/);
  assert.match(out.notes, /lang=schinese/);
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
