import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ApiError, SescClient, StoppedError } from "../web/sesc.js";

const respond = (payload, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => payload,
});

/** Plays back a list of responses, where a function is called and an Error is thrown. */
function fakeFetch(...responses) {
  const fake = async (url, options) => {
    fake.calls.push({ url, options });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  };
  fake.calls = [];
  return fake;
}

function makeClient(fetch, overrides = {}) {
  const sleeps = [];
  const client = new SescClient({
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 0,
    spacing: 0,
    ...overrides,
  });
  return { client, sleeps };
}

const page = (count, total) => ({ atividade: Array.from({ length: count }, (_, id) => ({ id })), total: { value: total } });

describe("listPlays", () => {
  test("requests theatre for the date range", async () => {
    const fetch = fakeFetch(respond(page(1, 1)));
    await makeClient(fetch).client.listPlays("2026-11-03", "2026-12-03");
    const query = new URL(fetch.calls[0].url).searchParams;
    assert.equal(query.get("linguagem"), "teatro");
    assert.equal(query.get("data_inicial"), "2026-11-03");
    assert.equal(query.get("data_final"), "2026-12-03");
  });

  test("never sends cookies", async () => {
    const fetch = fakeFetch(respond(page(1, 1)));
    await makeClient(fetch).client.listPlays("2026-11-03", "2026-12-03");
    assert.equal(fetch.calls[0].options.credentials, "omit");
  });

  test("follows pages until complete", async () => {
    const fetch = fakeFetch(respond(page(300, 302)), respond(page(2, 302)));
    const items = await makeClient(fetch).client.listPlays("2026-11-03", "2026-12-03");
    assert.equal(items.length, 302);
    assert.equal(fetch.calls.length, 2);
    assert.equal(new URL(fetch.calls[1].url).searchParams.get("page"), "2");
  });

  test("drops null rows", async () => {
    // A real listing had 559 rows, the last two of them null.
    const fetch = fakeFetch(respond({ atividade: [{ id: 1 }, null, null], total: { value: 3 } }));
    const items = await makeClient(fetch).client.listPlays("2026-11-03", "2026-12-03");
    assert.deepEqual(items, [{ id: 1 }]);
  });

  test("counts null rows towards the total", async () => {
    const rows = [...page(299, 300).atividade, null];
    const fetch = fakeFetch(respond({ atividade: rows, total: { value: 300 } }));
    const items = await makeClient(fetch).client.listPlays("2026-11-03", "2026-12-03");
    assert.equal(items.length, 299);
    assert.equal(fetch.calls.length, 1);
  });

  test("rejects an error returned as a string", async () => {
    // The API really does this: HTTP 200 with an error message as the body.
    const fetch = fakeFetch(respond("Erro ao pesquisar documentos"));
    await assert.rejects(makeClient(fetch).client.listPlays("2026-11-03", "2026-12-03"), ApiError);
  });
});

describe("getDetail", () => {
  test("returns the payload", async () => {
    const fetch = fakeFetch(respond({ sessoes: [] }));
    assert.deepEqual(await makeClient(fetch).client.getDetail("cao"), { sessoes: [] });
    assert.equal(new URL(fetch.calls[0].url).searchParams.get("slug"), "cao");
  });

  test("returns null on 404 without retrying", async () => {
    const fetch = fakeFetch(respond({}, 404));
    assert.equal(await makeClient(fetch).client.getDetail("missing"), null);
    assert.equal(fetch.calls.length, 1);
  });

  test("rejects an unknown shape", async () => {
    const fetch = fakeFetch(respond({ unexpected: true }));
    await assert.rejects(makeClient(fetch).client.getDetail("cao"), ApiError);
  });

  test("retries server errors, with a pause", async () => {
    const fetch = fakeFetch(respond({}, 503), respond({ sessoes: [] }));
    const { client, sleeps } = makeClient(fetch);
    assert.deepEqual(await client.getDetail("cao"), { sessoes: [] });
    assert.equal(fetch.calls.length, 2);
    assert.deepEqual(sleeps, [2000]);
  });

  test("retries when told to slow down", async () => {
    const fetch = fakeFetch(respond({}, 429), respond({ sessoes: [] }));
    assert.deepEqual(await makeClient(fetch).client.getDetail("cao"), { sessoes: [] });
    assert.equal(fetch.calls.length, 2);
  });

  test("retries network errors", async () => {
    const fetch = fakeFetch(new TypeError("Failed to fetch"), respond({ sessoes: [] }));
    assert.deepEqual(await makeClient(fetch).client.getDetail("cao"), { sessoes: [] });
  });

  test("retries a response that isn't JSON", async () => {
    // A blocked request has been seen returning an HTML page with status 200.
    const html = { status: 200, ok: true, json: async () => JSON.parse("<!DOCTYPE html>") };
    const fetch = fakeFetch(html, respond({ sessoes: [] }));
    assert.deepEqual(await makeClient(fetch).client.getDetail("cao"), { sessoes: [] });
  });

  test("gives up after the retry limit", async () => {
    const fetch = fakeFetch(respond({}, 500));
    await assert.rejects(makeClient(fetch).client.getDetail("cao"), ApiError);
    assert.equal(fetch.calls.length, 3);
  });

  test("does not retry a refusal", async () => {
    const fetch = fakeFetch(respond({}, 403));
    await assert.rejects(makeClient(fetch).client.getDetail("cao"), ApiError);
    assert.equal(fetch.calls.length, 1);
  });
});

describe("booklet files", () => {
  const PDF = "https://www.sescsp.org.br/wp-content/uploads/2026/10/em-cartaz.pdf";

  test("reads the archive page through the posts route", async () => {
    const fetch = fakeFetch(respond([{ content: { rendered: "<a>booklet</a>" } }]));
    assert.equal(await makeClient(fetch).client.getBookletArchive(), "<a>booklet</a>");
    const url = new URL(fetch.calls[0].url);
    assert.equal(url.pathname, "/wp-json/wp/v2/posts");
    assert.equal(url.searchParams.get("slug"), "emcartaz");
  });

  test("rejects an archive in an unknown format", async () => {
    await assert.rejects(makeClient(fakeFetch(respond([]))).client.getBookletArchive(), ApiError);
  });

  test("asks for a file's size without downloading it", async () => {
    const fetch = fakeFetch({ status: 200, ok: true, headers: new Map([["content-length", "3256530"]]) });
    assert.equal(await makeClient(fetch).client.getFileSize(PDF), 3256530);
    assert.equal(fetch.calls[0].options.method, "HEAD");
  });

  test("copes with a server that doesn't state the size", async () => {
    const fetch = fakeFetch({ status: 200, ok: true, headers: new Map() });
    assert.equal(await makeClient(fetch).client.getFileSize(PDF), null);
  });

  test("downloads a file", async () => {
    const fetch = fakeFetch({ status: 200, ok: true, arrayBuffer: async () => "the bytes" });
    assert.equal(await makeClient(fetch).client.getFile(PDF), "the bytes");
  });

  test("refuses files outside the Sesc site", async () => {
    const fetch = fakeFetch(respond({}));
    const { client } = makeClient(fetch);
    await assert.rejects(async () => client.getFile("https://example.com/x.pdf"), ApiError);
    await assert.rejects(async () => client.getFile("https://www.sescsp.org.br.example.com/x.pdf"), ApiError);
    await assert.rejects(async () => client.getFileSize("https://example.com/x.pdf"), ApiError);
    assert.equal(fetch.calls.length, 0);
  });
});

describe("stopping after repeated failures", () => {
  test("stops sending requests after 3 failures in a row", async () => {
    const fetch = fakeFetch(respond({}, 403));
    const { client } = makeClient(fetch);
    for (let i = 0; i < 3; i += 1) await assert.rejects(client.getDetail("cao"), ApiError);
    assert.equal(client.stopped, true);
    await assert.rejects(client.getDetail("cao"), StoppedError);
    await assert.rejects(client.listPlays("2026-11-03", "2026-12-03"), StoppedError);
    assert.equal(fetch.calls.length, 3);
  });

  test("stops when blocked requests look like network errors", async () => {
    const fetch = fakeFetch(new TypeError("Failed to fetch"));
    const { client } = makeClient(fetch, { attempts: 1 });
    for (let i = 0; i < 3; i += 1) await assert.rejects(client.getDetail("cao"), ApiError);
    await assert.rejects(client.getDetail("cao"), StoppedError);
    assert.equal(fetch.calls.length, 3);
  });

  test("a success resets the count", async () => {
    const fetch = fakeFetch(respond({}, 403), respond({}, 403), respond({ sessoes: [] }), respond({}, 403), respond({}, 403), respond({ sessoes: [] }));
    const { client } = makeClient(fetch);
    await assert.rejects(client.getDetail("a"));
    await assert.rejects(client.getDetail("b"));
    await client.getDetail("c");
    await assert.rejects(client.getDetail("d"));
    await assert.rejects(client.getDetail("e"));
    await client.getDetail("f");
    assert.equal(client.stopped, false);
  });

  test("a 404 resets the count, since the server is answering", async () => {
    const fetch = fakeFetch(respond({}, 403), respond({}, 403), respond({}, 404), respond({}, 403));
    const { client } = makeClient(fetch);
    await assert.rejects(client.getDetail("a"));
    await assert.rejects(client.getDetail("b"));
    assert.equal(await client.getDetail("c"), null);
    await assert.rejects(client.getDetail("d"));
    assert.equal(client.stopped, false);
  });

  test("a retry that's waiting is dropped once stopped", async () => {
    const release = [];
    const fetch = fakeFetch(respond({}, 500), respond({}, 403), respond({}, 403), respond({}, 403));
    const client = new SescClient({
      fetch,
      now: () => 0,
      spacing: 0,
      concurrency: 4,
      sleep: () => new Promise((resolve) => release.push(resolve)),
    });
    const retrying = client.getDetail("retrying");
    const others = ["a", "b", "c"].map((slug) => client.getDetail(slug));
    await Promise.allSettled(others);
    assert.equal(client.stopped, true);
    release.forEach((resolve) => resolve());
    await assert.rejects(retrying, StoppedError);
    assert.equal(fetch.calls.length, 4);
  });
});

describe("pacing", () => {
  test("never runs more than the limit at once", async () => {
    let running = 0;
    let highest = 0;
    const fetch = fakeFetch(async () => {
      running += 1;
      highest = Math.max(highest, running);
      await new Promise((resolve) => setImmediate(resolve));
      running -= 1;
      return respond({ sessoes: [] });
    });
    const { client } = makeClient(fetch, { concurrency: 3 });
    await Promise.all(Array.from({ length: 12 }, (_, n) => client.getDetail(`play-${n}`)));
    assert.equal(highest, 3);
    assert.equal(fetch.calls.length, 12);
  });

  test("keeps requests apart", async () => {
    let time = 1000;
    const started = [];
    const fetch = fakeFetch(async () => {
      started.push(time);
      return respond({ sessoes: [] });
    });
    const client = new SescClient({
      fetch,
      now: () => time,
      spacing: 150,
      concurrency: 1,
      sleep: async (ms) => {
        time += ms;
      },
    });
    for (const slug of ["a", "b", "c"]) await client.getDetail(slug);
    assert.deepEqual(started, [1000, 1150, 1300]);
  });
});
