import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  dispatchSourceOperation,
  executeMfSource,
  listSources,
  listSourceOperations,
  runSourceCli,
} from "./mf-source.mjs";

test("list/help are static, do not invoke fetch, and keep runtime status separate", async () => {
  let fetchCalled = false;
  const fetchImpl = async () => { fetchCalled = true; throw new Error("network must not run"); };
  const originalFetch = globalThis.fetch;
  const envDescriptor = Object.getOwnPropertyDescriptor(process, "env");
  let credentialRead = false;
  const guardedEnv = new Proxy(envDescriptor.value, {
    get() { credentialRead = true; throw new Error("help/list must not read credentials"); },
    has() { credentialRead = true; throw new Error("help/list must not inspect credentials"); },
    ownKeys() { credentialRead = true; throw new Error("help/list must not enumerate credentials"); },
  });
  try {
    Object.defineProperty(process, "env", { configurable: true, enumerable: true, writable: true, value: guardedEnv });
    globalThis.fetch = fetchImpl;
    const list = await executeMfSource(["list"], { fetchImpl });
    const help = await executeMfSource(["help"], { fetchImpl });
    const sourceHelp = await executeMfSource(["help", "openlibrary"]);
    const operationHelp = await executeMfSource(["help", "isni.record"]);
    assert.equal(fetchCalled, false);
    assert.equal(credentialRead, false);
    assert.ok(list.sources.length > 0);
    assert.ok(help.operations.length > 0);
    assert.match(help.usage.at(-1), /run <operation> <arg>/);
    assert.ok(list.sources.every(source => source.status === "not_probed"));
    assert.ok(!JSON.stringify(list).includes("当前被反爬拦"));
    assert.ok(!JSON.stringify(list).includes("网关已变更"));
    assert.ok(sourceHelp.operations.some(operation => operation.id === "openlibrary.search"));
    assert.ok(operationHelp.operation.example.startsWith("node mf-source.mjs run isni.record "));
    assert.match(operationHelp.note, /skills\/metafusion-curator\/local\/tools 目录运行/);

    const oclc = list.sources.find(source => source.id === "oclc");
    assert.equal(oclc.access_requirement.type, "connector_uses_no_credentials");
    assert.equal(oclc.access_requirement.environment_names, undefined);
    assert.ok(!JSON.stringify(oclc).includes("WORLDCLIENTID"));

    const viaf = list.sources.find(source => source.id === "viaf");
    assert.equal(viaf.status, "not_probed");
    assert.equal(viaf.access_requirement.type, "not_stated");
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(process, "env", envDescriptor);
  }
});

test("no args, --help, and -h all show the same free help", async () => {
  const noArgs = await executeMfSource([]);
  const longFlag = await executeMfSource(["--help"]);
  const shortFlag = await executeMfSource(["-h"]);
  assert.deepEqual(noArgs, longFlag);
  assert.deepEqual(noArgs, shortFlag);
});

test("all registered operations and source help expose a concrete format and copyable example", async () => {
  const operations = listSourceOperations();
  const help = await executeMfSource(["help"]);
  assert.equal(operations.length, 40);
  assert.deepEqual(help.operations.map(operation => operation.id), operations.map(operation => operation.id));

  for (const operation of operations) {
    assert.ok(operation.argument.length >= 12, `input format missing for ${operation.id}`);
    assert.match(operation.example, /^node mf-source\.mjs run \S+ \S+$/, `example must be an executable one-argument command for ${operation.id}`);
    assert.equal(operation.example.split(/\s+/)[3], operation.id, `example operation mismatch for ${operation.id}`);
    assert.doesNotMatch(operation.argument, /连接器支持的 ID|连接器支持的官方 URL|来源 ID|检索词$|endpoint/i, `generic input text remains for ${operation.id}`);

    const operationHelp = await executeMfSource(["help", operation.id]);
    assert.equal(operationHelp.operation.argument, operation.argument);
    assert.equal(operationHelp.operation.example, operation.example);
  }

  for (const source of listSources()) {
    const sourceHelp = await executeMfSource(["help", source.id]);
    assert.deepEqual(sourceHelp.operations.map(operation => operation.id), source.operation_ids);
    assert.ok(sourceHelp.operations.every(operation => operation.argument && operation.example));
  }
});

test("Bushiroad and BanG Dream help advertise their catalog and price output contract", async () => {
  const bushiroad = await executeMfSource(["help", "publisher.bushiroad_music"]);
  assert.equal(bushiroad.operation.example, "node mf-source.mjs run publisher.bushiroad_music BRMM-11078");
  assert.ok(bushiroad.operation.advertised_fields.includes("requested_catalog_number"));
  assert.ok(bushiroad.operation.advertised_fields.includes("price_candidates"));
  assert.ok(bushiroad.operation.advertised_fields.includes("price"));
  assert.match(bushiroad.operation.input_note, /requested_catalog_number 保留原请求品番/);
  assert.match(bushiroad.operation.input_note, /官方目录 ACF/);
  assert.match(bushiroad.operation.input_note, /不使用 WordPress search/);
  assert.match(bushiroad.operation.input_note, /不按价格顺序猜版/);
  assert.match(bushiroad.operation.input_note, /image_urls 不自动归版/);

  const bangDream = await executeMfSource(["help", "publisher.bang_dream"]);
  assert.ok(bangDream.operation.advertised_fields.includes("requested_catalog_number"));
  assert.ok(bangDream.operation.advertised_fields.includes("price_candidates"));
  assert.ok(bangDream.operation.advertised_fields.includes("price"));
  assert.match(bangDream.operation.input_note, /requested_catalog_number 为 null/);
  assert.match(bangDream.operation.input_note, /image_urls 不自动归版/);

  const ponyCanyon = await executeMfSource(["help", "publisher.pony_canyon"]);
  assert.equal(ponyCanyon.operation.advertised_fields, undefined);
  assert.equal(listSourceOperations().find(operation => operation.id === "publisher.bang_dream").advertised_fields.includes("price"), true);
});

test("publisher runtime available_fields expose returned price contract fields", async () => {
  const priceCandidate = {
    edition: "通常盤",
    catalog_number: "BRMM-11078",
    amount: "1650円（税込）",
    currency: "JPY",
    tax_included: true,
    raw: "通常盤 1650円（税込）",
  };
  const result = await dispatchSourceOperation("publisher.bushiroad_music", "BRMM-11078", {
    runPublisherOpImpl: async () => ({
      publisher: "bushiroad_music",
      catalog_number: null,
      catalog_candidates: [{ edition: "通常盤", catalog_number: "BRMM-11078" }],
      requested_catalog_number: "BRMM-11078",
      price: null,
      price_candidates: [priceCandidate],
      field_status: { price: "multiple_editions_ambiguous" },
    }),
  });
  assert.ok(result.available_fields.includes("requested_catalog_number"));
  assert.ok(result.available_fields.includes("price_candidates"));
  assert.ok(result.available_fields.includes("price"));
  assert.deepEqual(result.data.price_candidates, [priceCandidate]);
});

test("representative provider and publisher help examples pass real parsers with mocked responses", async () => {
  const operations = new Map(listSourceOperations().map(operation => [operation.id, operation]));
  const exampleArgument = id => {
    const parts = operations.get(id).example.split(/\s+/);
    assert.deepEqual(parts.slice(0, 3), ["node", "mf-source.mjs", "run"]);
    assert.equal(parts[3], id);
    return parts[4];
  };

  const requestedUrls = [];
  const providerFetch = async url => {
    requestedUrls.push(url);
    const isni = url.includes("isni.org/isni/");
    const body = isni
      ? '<rdf:RDF><rdf:Description rdf:about="https://isni.org/isni/0000000000000001"><rdfs:label>Example Record</rdfs:label></rdf:Description></rdf:RDF>'
      : JSON.stringify({ id: 123, title: "Example Release" });
    return {
      ok: true,
      status: 200,
      url,
      headers: { get: name => String(name).toLowerCase() === "content-type" ? (isni ? "application/rdf+xml" : "application/json") : null },
      text: async () => body,
    };
  };

  for (const id of ["discogs.release", "isni.record"]) {
    const result = await dispatchSourceOperation(id, exampleArgument(id), { fetchImpl: providerFetch });
    assert.equal(result.response_status, "ok");
    assert.equal(result.operation.id, id);
  }

  const publisherHtml = '<html><head><title>Example Release | Example Artist</title><meta property="og:title" content="Example Release | Example Artist"></head><body></body></html>';
  for (const id of ["publisher.pony_canyon", "publisher.canime", "publisher.sony_music"]) {
    const result = await dispatchSourceOperation(id, exampleArgument(id), {
      fetchImpl: async url => {
        requestedUrls.push(url);
        return { ok: true, status: 200, url, headers: { get: () => null }, text: async () => publisherHtml };
      },
      delay: async () => {},
    });
    assert.equal(result.response_status, "ok");
    assert.equal(result.operation.id, id);
  }

  const bushiroadExampleCatalog = exampleArgument("publisher.bushiroad_music");
  const bushiroadExampleHtml = `<html><head><title>Example Discography</title><meta property="og:title" content="Example Discography"></head><body><p>品番</p><p>通常盤: ${bushiroadExampleCatalog}</p><p>収録曲</p></body></html>`;
  const bushiroadExample = await dispatchSourceOperation("publisher.bushiroad_music", bushiroadExampleCatalog, {
    fetchImpl: async url => {
      requestedUrls.push(url);
      return { ok: true, status: 200, url, headers: { get: () => null }, text: async () => bushiroadExampleHtml };
    },
    delay: async () => {},
  });
  assert.equal(bushiroadExample.response_status, "ok");
  assert.equal(bushiroadExample.operation.id, "publisher.bushiroad_music");

  const bushiroadFixture = readFileSync(new URL("./__fixtures__/publisher-bushiroad.html", import.meta.url), "utf8");
  const bushiroadMultiEdition = await dispatchSourceOperation("publisher.bushiroad_music", "BRMM-11079", {
    fetchImpl: async url => {
      requestedUrls.push(url);
      return { ok: true, status: 200, url, headers: { get: () => null }, text: async () => bushiroadFixture };
    },
    delay: async () => {},
  });
  assert.equal(bushiroadMultiEdition.response_status, "ok");
  assert.equal(bushiroadMultiEdition.candidate_count, null);
  assert.equal(bushiroadMultiEdition.catalog_candidate_count, 2);
  assert.equal(bushiroadMultiEdition.data.catalog_number, null);
  assert.equal(bushiroadMultiEdition.data.field_status.edition_association, "ambiguous");
  assert.ok(bushiroadMultiEdition.available_fields.includes("catalog_candidates"));
  assert.ok(bushiroadMultiEdition.available_fields.includes("field_status"));
  assert.ok(!bushiroadMultiEdition.available_fields.includes("raw"));

  const umjEnvelope = await dispatchSourceOperation("umj.product", "demo-artist/abcd-1234", {
    runAuthoritativeOpImpl: async () => ({
      source: "umj",
      title: "Example Product",
      catalog_number: "ABCD-1234",
      field_status: { catalog_number: "source_reported_unverified" },
      raw: { page_title: "Example Product" },
    }),
  });
  assert.ok(umjEnvelope.available_fields.includes("catalog_number"));
  assert.ok(umjEnvelope.available_fields.includes("field_status"));
  assert.ok(!umjEnvelope.available_fields.includes("raw"));

  assert.equal(requestedUrls.length, 7);
  assert.ok(requestedUrls.every(url => /^https:\/\//.test(url)));
});

test("BanG Dream publisher example is HTTPS only and rejects HTTP before fetch", async () => {
  const help = await executeMfSource(["help", "publisher.bang_dream"]);
  assert.match(help.operation.argument, /完整 HTTPS 官方 URL/);
  assert.match(help.operation.example, /^node mf-source\.mjs run publisher\.bang_dream https:\/\//);

  let fetchCalled = false;
  await assert.rejects(
    dispatchSourceOperation("publisher.bang_dream", "http://bang-dream.com/discographies/123/", {
      fetchImpl: async () => { fetchCalled = true; throw new Error("HTTP input must be rejected before fetch"); },
    }),
    error => error.kind === "bad_input",
  );
  assert.equal(fetchCalled, false);
});

test("every registered operation maps to its provider, authoritative, or publisher dispatcher", async () => {
  const operations = listSourceOperations();
  const routed = [];
  const mockFetch = async () => { throw new Error("a dispatcher stub must prevent network access"); };
  const stubs = {
    runProviderOpImpl: async (op, arg, opts) => {
      routed.push({ backend: "provider", op, arg, opts });
      return { provider: "fixture", raw: { hits: [{ id: "candidate-1", title: "Fixture" }] } };
    },
    runAuthoritativeOpImpl: async (op, arg, opts) => {
      routed.push({ backend: "authoritative", op, arg, opts });
      return { source: "fixture", raw: { hits: [{ id: "candidate-1", title: "Fixture" }] } };
    },
    runPublisherOpImpl: async (key, arg, opts) => {
      routed.push({ backend: "publisher", op: `publisher.${key}`, key, arg, opts });
      return { publisher: key, raw: { hits: [{ id: "candidate-1", title: "Fixture" }] } };
    },
  };

  for (const entry of operations) {
    const result = await dispatchSourceOperation(entry.id, "Fixture input", { ...stubs, fetchImpl: mockFetch });
    assert.equal(result.operation.id, entry.id);
    assert.equal(result.response_status, "ok");
    assert.equal(result.candidate_count, 1);
    const expectedFields = entry.backend === "publisher" ? ["publisher"] : entry.id === "umj.product" ? ["source"] : ["id", "title"];
    assert.deepEqual(result.available_fields, expectedFields);
  }

  assert.equal(routed.length, operations.length);
  for (const entry of operations) assert.ok(routed.some(call => call.op === entry.id), `missing route for ${entry.id}`);
  assert.ok(routed.some(call => call.key === "bushiroad_music"));
  assert.ok(routed.some(call => call.key === "bang_dream"));
  assert.ok(routed.every(call => call.arg === "Fixture input"));
});

test("publisher aliases resolve in help while canonical operation names match runPublisherOp keys", async () => {
  const bushiroad = await executeMfSource(["help", "bushiroad"]);
  const bangdream = await executeMfSource(["help", "bangdream"]);
  assert.equal(bushiroad.source.id, "bushiroad_music");
  assert.ok(bushiroad.source.operation_ids.includes("publisher.bushiroad_music"));
  assert.equal(bangdream.source.id, "bang_dream");
  assert.ok(bangdream.source.operation_ids.includes("publisher.bang_dream"));

  const bushiroadCall = [];
  await dispatchSourceOperation("publisher.bushiroad_music", "BRMM-12345", {
    runPublisherOpImpl: async (key, arg, opts) => { bushiroadCall.push({ key, arg, opts }); return { publisher: key }; },
    fetchImpl: async () => {},
  });
  assert.equal(bushiroadCall[0].key, "bushiroad_music");
  assert.equal(bushiroadCall[0].arg, "BRMM-12345");
  assert.equal(bushiroadCall[0].opts.fetchFn, bushiroadCall[0].opts.fetchImpl);

  const bangdreamCall = [];
  await dispatchSourceOperation("publisher.bang_dream", "https://bang-dream.com/discographies/123/", {
    runPublisherOpImpl: async (key, arg) => { bangdreamCall.push({ key, arg }); return { publisher: key }; },
  });
  assert.equal(bangdreamCall[0].key, "bang_dream");
  assert.equal(bangdreamCall[0].arg, "https://bang-dream.com/discographies/123/");
});

test("provider search results count raw hits/editions and expose candidate fields, not wrapper fields", async () => {
  const hitsResult = await dispatchSourceOperation("discogs.search", "Fixture", {
    runProviderOpImpl: async () => ({ provider: "discogs", found: true, raw: { hits: [{ id: 10, title: "One" }, { id: 11, title: "Two" }] } }),
  });
  assert.equal(hitsResult.candidate_count, 2);
  assert.deepEqual(hitsResult.available_fields, ["id", "title"]);
  assert.equal(hitsResult.search_completeness, "returned_candidates_only");
  assert.match(hitsResult.search_note, /不保证覆盖/);

  const editionsResult = await dispatchSourceOperation("openlibrary.editions", "OL123W", {
    runProviderOpImpl: async () => ({ provider: "openlibrary", raw: { editions: [{ key: "/books/OL1M", title: "Edition" }] } }),
  });
  assert.equal(editionsResult.candidate_count, 1);
  assert.deepEqual(editionsResult.available_fields, ["key", "title"]);
});

test("errors are structured and never echo operation args, tokens, or connector messages", async () => {
  let stderr = "";
  const exitCode = await runSourceCli(["run", "unknown-secret-token", "private-argument"], {
    stderr: value => { stderr += value; },
    stdout: () => {},
  });
  assert.equal(exitCode, 1);
  const unknown = JSON.parse(stderr);
  assert.equal(unknown.response_status, "error");
  assert.equal(unknown.error.kind, "bad_input");
  assert.equal(unknown.error.operation, null);
  assert.ok(!stderr.includes("unknown-secret-token"));
  assert.ok(!stderr.includes("private-argument"));

  stderr = "";
  const failedRun = await runSourceCli(["run", "tmdb.movie", "42"], {
    runProviderOpImpl: async () => { throw Object.assign(new Error("TMDB_ACCESS_TOKEN=do-not-print"), { kind: "credential_missing", status: null }); },
    stderr: value => { stderr += value; },
    stdout: () => {},
  });
  assert.equal(failedRun, 1);
  const failure = JSON.parse(stderr);
  assert.equal(failure.error.kind, "credential_missing");
  assert.equal(failure.error.source, "tmdb");
  assert.equal(failure.error.operation, "tmdb.movie");
  assert.ok(!stderr.includes("do-not-print"));
  assert.ok(!stderr.includes("TMDB_ACCESS_TOKEN="));
});

test("unknown operations fail without reaching any source dispatcher", async () => {
  let called = false;
  await assert.rejects(
    dispatchSourceOperation("not-an-op", "arg", {
      runProviderOpImpl: async () => { called = true; },
      runAuthoritativeOpImpl: async () => { called = true; },
      runPublisherOpImpl: async () => { called = true; },
    }),
    error => error.kind === "bad_input",
  );
  assert.equal(called, false);
});

test("--out writes structured JSON exclusively and reports a structured collision", async () => {
  const writes = [];
  let stdout = "";
  const success = await runSourceCli(["list", "--out", "mf-source-fixture.json"], {
    writeFileImpl: async (...args) => writes.push(args),
    stdout: value => { stdout += value; },
    stderr: () => {},
  });
  assert.equal(success, 0);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][2].flag, "wx");
  assert.ok(JSON.parse(writes[0][1]).sources.length > 0);
  assert.match(stdout, /mf-source-fixture\.json/);

  let stderr = "";
  const collision = await runSourceCli(["list", "--out", "existing.json"], {
    writeFileImpl: async () => { throw Object.assign(new Error("private path"), { code: "EEXIST" }); },
    stdout: () => {},
    stderr: value => { stderr += value; },
  });
  assert.equal(collision, 1);
  assert.equal(JSON.parse(stderr).error.kind, "output_exists");
  assert.ok(!stderr.includes("private path"));
});

test("--out preflight rejects existing destinations and missing directories before source dispatch", async () => {
  const existing = fileURLToPath(import.meta.url);
  let sourceCalled = false;
  let stderr = "";
  const existingCode = await runSourceCli(["run", "discogs.release", "123", "--out", existing], {
    runProviderOpImpl: async () => { sourceCalled = true; return {}; },
    stderr: value => { stderr += value; },
    stdout: () => {},
  });
  assert.equal(existingCode, 1);
  assert.equal(sourceCalled, false);
  assert.equal(JSON.parse(stderr).error.kind, "output_exists");

  stderr = "";
  const missingDir = `${existing}.missing-parent/output.json`;
  const missingCode = await runSourceCli(["list", "--out", missingDir], {
    stderr: value => { stderr += value; },
    stdout: () => {},
  });
  assert.equal(missingCode, 1);
  assert.equal(JSON.parse(stderr).error.kind, "output_path_missing");
});
