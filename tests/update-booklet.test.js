import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { USER_AGENT, updateBooklet } from "../tools/update-booklet.js";
import { MIN_ENTRIES } from "../web/booklet.js";

const ARCHIVE_URL = "https://www.sescsp.org.br/wp-json/wp/v2/posts?slug=emcartaz&_fields=content";
const LATEST = "https://www.sescsp.org.br/wp-content/uploads/2026/10/V13_Em-Cartaz_2026_novembro_VF.pdf";

const words = (text, weight, size) =>
  text.split(" ").map((word) => ({ text: word, fontname: `X+Informative-${weight}`, size, page: 28 }));

function bookletWords(count = MIN_ENTRIES) {
  return [
    ...words("EM CARTAZ | NOVEMBRO 2026", "Medium", 6),
    ...words("TEATRO", "Black", 11),
    ...words("POMPEIA", "Medium", 10),
    ...Array.from({ length: count }, (_, n) => [
      ...words(`Peça ${n}`, "Bold", 10),
      ...words("De 19/11 a 13/12. R$70 R$35 R$21", "SemiBold", 8.5),
    ]).flat(),
  ];
}

/** A stand-in for Sesc's site, which records each request. */
function fakeSesc({ archive = [{ content: { rendered: `<a href="${LATEST}">PDF</a>` } }], pdf = new Uint8Array([1, 2, 3]), status = 200 } = {}) {
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ url, userAgent: options.headers["User-Agent"] });
    if (status !== 200) return new Response("<h1>403 ERROR</h1>", { status });
    return url === ARCHIVE_URL ? Response.json(archive) : new Response(pdf);
  };
  return { fetch, requests, urls: () => requests.map((request) => request.url) };
}

describe("updateBooklet", () => {
  test("reads a new edition", async () => {
    const sesc = fakeSesc();
    let bytes;
    const readPdf = async (data) => {
      bytes = [...data];
      return bookletWords();
    };
    const booklet = await updateBooklet({ fetch: sesc.fetch, readPdf, saved: { url: "an-older-edition.pdf" } });
    assert.equal(booklet.url, LATEST);
    assert.deepEqual(booklet.edition, [11, 2026]);
    assert.equal(booklet.entries.length, MIN_ENTRIES);
    assert.deepEqual(booklet.entries[0], { unit: "POMPEIA", title: "Peça 0", isMain: true, schedule: "De 19/11 a 13/12. R$70 R$35 R$21", page: 28 });
    assert.deepEqual(bytes, [1, 2, 3]);
    assert.deepEqual(sesc.urls(), [ARCHIVE_URL, LATEST]);
  });

  test("says who is asking", async () => {
    const sesc = fakeSesc();
    await updateBooklet({ fetch: sesc.fetch, readPdf: async () => bookletWords() });
    assert.deepEqual(sesc.requests.map((request) => request.userAgent), [USER_AGENT, USER_AGENT]);
  });

  test("doesn't download an edition it already has", async () => {
    const sesc = fakeSesc();
    assert.equal(await updateBooklet({ fetch: sesc.fetch, readPdf: async () => bookletWords(), saved: { url: LATEST } }), null);
    assert.deepEqual(sesc.urls(), [ARCHIVE_URL]);
  });

  test("reads it again when forced", async () => {
    const sesc = fakeSesc();
    const booklet = await updateBooklet({ fetch: sesc.fetch, readPdf: async () => bookletWords(), saved: { url: LATEST }, force: true });
    assert.equal(booklet.url, LATEST);
  });

  test("fails if the layout seems to have changed", async () => {
    const sesc = fakeSesc();
    await assert.rejects(updateBooklet({ fetch: sesc.fetch, readPdf: async () => bookletWords(MIN_ENTRIES - 1) }), /theatre entries/);
  });

  test("stops if Sesc refuses", async () => {
    const sesc = fakeSesc({ status: 403 });
    await assert.rejects(updateBooklet({ fetch: sesc.fetch }), /HTTP 403/);
    assert.deepEqual(sesc.urls(), [ARCHIVE_URL]);
  });

  test("fails on an unexpected archive", async () => {
    const sesc = fakeSesc({ archive: { code: "rest_no_route" } });
    await assert.rejects(updateBooklet({ fetch: sesc.fetch }), /unexpected booklet archive/);
  });

  test("only takes a booklet from Sesc's site", async () => {
    const sesc = fakeSesc({ archive: [{ content: { rendered: '<a href="https://example.com/em-cartaz.pdf">PDF</a>' } }] });
    await assert.rejects(updateBooklet({ fetch: sesc.fetch }), /no booklet link/);
  });
});
