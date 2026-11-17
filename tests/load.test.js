import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { compareDrops, forecastsFrom, isOutdated, loadBooklet } from "../web/load.js";

const NOW = new Date("2026-11-05T12:00:00-03:00");
const BOOKLET_URL = "https://www.sescsp.org.br/wp-content/uploads/2026/10/em-cartaz.pdf";

const entry = (title, schedule, unit = "POMPEIA") => ({ unit, title, isMain: true, schedule, page: 28 });
const booklet = (...entries) => ({ url: BOOKLET_URL, edition: [11, 2026], entries });
const titles = (drops) => drops.map((drop) => drop.title);

describe("forecastsFrom", () => {
  const plays = booklet(
    entry("Depois", "De 26/11 a 13/12. R$70 R$35 R$21"),
    entry("Antes", "De 19/11 a 13/12. R$70 R$35 R$21"),
    entry("Já abriu", "De 12/11 a 13/12. R$70 R$35 R$21"),
    entry("Longe", "De 20/12 a 23/12. R$70 R$35 R$21"),
  );

  test("keeps sales still to open, soonest first", () => {
    assert.deepEqual(titles(forecastsFrom(plays, NOW)), ["Antes", "Depois"]);
  });

  test("a sale leaves once its time passes", () => {
    assert.deepEqual(titles(forecastsFrom(plays, new Date("2026-11-10T17:00:00-03:00"))), ["Depois"]);
  });

  test("only covers premieres in the next `days` days", () => {
    assert.deepEqual(titles(forecastsFrom(plays, NOW, 50)), ["Antes", "Depois", "Longe"]);
  });
});

test("compareDrops sorts by opening, then unit and title", () => {
  const drop = (online_sale_start, unit, title) => ({ online_sale_start, unit, title });
  const drops = [
    drop("2026-11-17T17:00", "Pompeia", "A"),
    drop("2026-11-10T17:00", "Pompeia", "B"),
    drop("2026-11-10T17:00", "Pompeia", "A"),
    drop("2026-11-10T17:00", "Belenzinho", "Z"),
  ];
  assert.deepEqual(drops.sort(compareDrops).map((item) => `${item.unit} ${item.title}`), [
    "Belenzinho Z",
    "Pompeia A",
    "Pompeia B",
    "Pompeia A",
  ]);
});

describe("isOutdated", () => {
  test("a booklet for this month or a later one is current", () => {
    assert.equal(isOutdated([11, 2026], NOW), false);
    assert.equal(isOutdated([12, 2026], NOW), false);
  });

  test("a booklet for an earlier month is outdated", () => {
    assert.equal(isOutdated([10, 2026], NOW), true);
    assert.equal(isOutdated([12, 2025], NOW), true);
  });

  test("uses São Paulo time", () => {
    assert.equal(isOutdated([11, 2026], new Date("2026-12-01T02:00:00Z")), false);
  });
});

describe("loadBooklet", () => {
  const serving = (response) => {
    const requests = [];
    const fetch = async (url, options) => {
      requests.push({ url, options });
      return response;
    };
    return { fetch, requests };
  };

  test("returns the saved booklet", async () => {
    const saved = booklet(entry("Antes", "De 19/11 a 13/12."));
    assert.deepEqual(await loadBooklet(serving(Response.json(saved)).fetch), saved);
  });

  test("asks the server whether it has changed", async () => {
    const server = serving(Response.json(booklet()));
    await loadBooklet(server.fetch);
    assert.deepEqual(server.requests, [{ url: "booklet.json", options: { cache: "no-cache" } }]);
  });

  test("fails when the file is missing", async () => {
    await assert.rejects(loadBooklet(serving(new Response("", { status: 404 })).fetch), /HTTP 404/);
  });

  test("fails on unexpected contents", async () => {
    await assert.rejects(loadBooklet(serving(Response.json({ entries: [] })).fetch), /unexpected contents/);
  });
});
