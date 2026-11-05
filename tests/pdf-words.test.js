import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseEntries, textRuns } from "../web/booklet.js";
import { wordsFromDocument } from "../web/pdf-words.js";

const FONTS = {
  black: "LORBCC+Informative-Black",
  medium: "LORBCC+Informative-Medium",
  bold: "LORBCC+Informative-Bold",
  semi: "LORBCC+Informative-SemiBold",
  regular: "LORBCC+Informative-Regular",
};

const item = (str, fontName, size) => ({ str, fontName, transform: [size, 0, 0, size, 48, 500] });

/** A stand-in for a pdf.js document. Font names only become known after a page's operator list is read. */
function fakeDocument(...pages) {
  const operatorListsRead = [];
  return {
    numPages: pages.length,
    operatorListsRead,
    async getPage(number) {
      const known = new Set();
      return {
        cleanup() {},
        async getTextContent() {
          return { items: pages[number - 1] };
        },
        async getOperatorList() {
          operatorListsRead.push(number);
          for (const { fontName } of pages[number - 1]) known.add(fontName);
        },
        commonObjs: {
          has: (name) => known.has(name),
          get: (name) => ({ name: FONTS[name] }),
        },
      };
    },
  };
}

describe("wordsFromDocument", () => {
  test("splits text into styled words, with page numbers", async () => {
    const words = await wordsFromDocument(fakeDocument([], [item("Reality Show", "bold", 10)]));
    assert.deepEqual(words, [
      { text: "Reality", fontname: FONTS.bold, size: 10, page: 2 },
      { text: "Show", fontname: FONTS.bold, size: 10, page: 2 },
    ]);
  });

  test("skips empty text", async () => {
    const words = await wordsFromDocument(fakeDocument([item("", "bold", 10), item("  ", "bold", 10), { type: "marked" }]));
    assert.deepEqual(words, []);
  });

  test("reads as few pages' full contents as it can", async () => {
    const document = fakeDocument(
      [item("a", "bold", 10)],
      [],
      [item("b", "bold", 10), item("c", "regular", 8.5)],
      [],
      [item("d", "regular", 8.5)],
    );
    const words = await wordsFromDocument(document);
    assert.equal(words.length, 4);
    assert.ok(words.every((word) => word.fontname));
    assert.deepEqual(document.operatorListsRead, [3]);
  });

  test("a badge merged after schedule text is still small", async () => {
    // A real item from page 28 of the November 2026 booklet.
    const words = await wordsFromDocument(fakeDocument([item("18h. Exceto dia 25/10. A14", "semi", 8.5)]));
    assert.deepEqual(words.map((word) => [word.text, word.size]), [
      ["18h.", 8.5], ["Exceto", 8.5], ["dia", 8.5], ["25/10.", 8.5], ["A14", 6],
    ]);
  });

  test("schedule text merged after a small badge is not small", async () => {
    // pdf.js reports this whole item at size 6, which once hid the word GRÁTIS.
    const words = await wordsFromDocument(fakeDocument([item("A14 GRÁTIS.", "semi", 6)]));
    assert.deepEqual(words.map((word) => [word.text, word.size]), [["A14", 6], ["GRÁTIS.", 8.5]]);
  });

  test("leaves other SemiBold text alone", async () => {
    const words = await wordsFromDocument(fakeDocument([item("Do Ventre à Cabeça", "semi", 10)]));
    assert.ok(words.every((word) => word.size === 10));
  });

  test("leaves words that only look like badges in other fonts alone", async () => {
    const words = await wordsFromDocument(fakeDocument([item("A12 de outubro", "regular", 8.5)]));
    assert.ok(words.every((word) => word.size === 8.5));
  });

  test("gives the parser what it expects", async () => {
    const words = await wordsFromDocument(
      fakeDocument([
        item("TEATRO", "black", 11),
        item("IPIRANGA", "medium", 10),
        item("Dúvida", "bold", 10),
        item("Dia 17/11. Terça, 19h30.", "semi", 8.5),
        item("A14 GRÁTIS.", "semi", 6),
      ]),
    );
    const [entry] = parseEntries(textRuns(words));
    assert.equal(entry.title, "Dúvida");
    assert.equal(entry.schedule, "Dia 17/11. Terça, 19h30. GRÁTIS.");
  });
});
