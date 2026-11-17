import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { addDays, cleanText, decodeEntities, ruleSaleDay, saoPauloDay, saoPauloMoment } from "../web/plays.js";
import { REGIONS, UNITS } from "../web/regions.js";

describe("time helpers", () => {
  test("use São Paulo time", () => {
    const justAfterMidnightUtc = new Date("2026-11-05T01:30:00Z");
    assert.equal(saoPauloMoment(justAfterMidnightUtc), "2026-11-04T22:30");
    assert.equal(saoPauloDay(justAfterMidnightUtc), "2026-11-04");
  });

  test("add days across months", () => {
    assert.equal(addDays("2026-11-29", 3), "2026-12-02");
    assert.equal(addDays("2026-12-02", -3), "2026-11-29");
  });
});

describe("cleanText", () => {
  test("decodes entities and collapses whitespace", () => {
    assert.equal(cleanText("Show &#8211; Fat  Family  "), "Show – Fat Family");
  });

  test("handles a missing value", () => {
    assert.equal(cleanText(null), "");
    assert.equal(cleanText(undefined), "");
  });
});

describe("decodeEntities", () => {
  test("decodes numeric and named entities", () => {
    assert.equal(decodeEntities("a&amp;b &#233; &#xE9; &ndash;"), "a&b é é –");
  });

  test("leaves unknown entities alone", () => {
    assert.equal(decodeEntities("&unknown; &constructor; &#99999999;"), "&unknown; &constructor; &#99999999;");
  });
});

describe("ruleSaleDay", () => {
  test("is the Tuesday of the week before", () => {
    for (const premiere of ["2026-11-16", "2026-11-19", "2026-11-22"]) {
      assert.equal(ruleSaleDay(premiere), "2026-11-10");
    }
  });
});


describe("regions", () => {
  test("every unit belongs to a known region", () => {
    for (const { region } of Object.values(UNITS)) assert.ok(region in REGIONS, region);
  });
});
