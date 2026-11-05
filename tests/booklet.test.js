import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  BookletError,
  buildEstimates,
  findEdition,
  firstDate,
  latestBookletUrl,
  parseEntries,
  parsePrice,
  samePlay,
  scheduleText,
  textRuns,
} from "../web/booklet.js";
import { ruleSaleDay } from "../web/plays.js";

const MOMENT = "2026-11-04T12:00";
const TODAY = "2026-11-04";
const END = "2026-12-04";
const EDITION = [11, 2026];
const BOOKLET_URL = "https://www.sescsp.org.br/wp-content/uploads/2026/10/em-cartaz.pdf";

const wordsOf = (text, weight, size, page = 1) =>
  text.split(" ").map((word) => ({ text: word, fontname: `LORBCC+Informative-${weight}`, size, page }));
const section = (text, page) => wordsOf(text, "Black", 11, page);
const unit = (text, page) => wordsOf(text, "Medium", 10, page);
const title = (text, page) => wordsOf(text, "Bold", 10, page);
const subTitle = (text, page) => wordsOf(text, "SemiBold", 10, page);
const schedule = (text, page) => wordsOf(text, "SemiBold", 8.5, page);
const description = (text, page) => wordsOf(text, "Regular", 8.5, page);
const caption = (text, page) => wordsOf(text, "Regular", 10, page);
const entriesFrom = (...lists) => parseEntries(textRuns(lists.flat()));

function entry({ name = "Reality Show", when = "De 19/11 a 13/12. Quintas a sábados, 20h. R$70 R$35 R$21", place = "POMPEIA", isMain = true, page = 28 } = {}) {
  return { unit: place, title: name, isMain, schedule: when, page };
}

function build(entries, { listing = [], moment = MOMENT, today = TODAY } = {}) {
  return buildEstimates({ entries, edition: EDITION, listing, bookletUrl: BOOKLET_URL, moment, today, end: END });
}

const listed = (name, place = "Pompeia") => ({ titulo: name, unidade: [{ name: place }] });

describe("latestBookletUrl", () => {
  test("takes the first link", () => {
    const page = `<a href="${BOOKLET_URL}">nov</a><a href="https://www.sescsp.org.br/wp-content/uploads/2026/09/old.pdf">out</a>`;
    assert.equal(latestBookletUrl(page), BOOKLET_URL);
  });

  test("ignores links outside the site", () => {
    assert.throws(() => latestBookletUrl('<a href="https://example.com/wp-content/uploads/x.pdf">x</a>'), BookletError);
  });
});

describe("parseEntries", () => {
  test("reads unit, title, schedule and page", () => {
    const entries = entriesFrom(section("TEATRO"), unit("POMPEIA"), title("Reality Show", 28), description("Dez performers."), schedule("De 19/11 a 13/12.", 28));
    assert.deepEqual(entries, [{ unit: "POMPEIA", title: "Reality Show", isMain: true, schedule: "De 19/11 a 13/12.", page: 28 }]);
  });

  test("ignores other sections", () => {
    const entries = entriesFrom(section("MÚSICA"), unit("POMPEIA"), title("Um Show"), schedule("Dia 5/11."), section("TEATRO"), title("Uma Peça"), schedule("Dia 6/11."), section("DANÇA"), title("Uma Dança"));
    assert.deepEqual(entries.map((e) => e.title), ["Uma Peça"]);
  });

  test("page numbers don't end the section", () => {
    const entries = entriesFrom(section("TEATRO"), unit("POMPEIA"), title("Primeira"), section("25"), title("Segunda"));
    assert.deepEqual(entries.map((e) => e.title), ["Primeira", "Segunda"]);
  });

  test("a page number merged with the heading still counts", () => {
    const entries = entriesFrom(section("TEATRO 24"), unit("POMPEIA"), title("Primeira"));
    assert.deepEqual(entries.map((e) => e.title), ["Primeira"]);
  });

  test("photo captions are not titles", () => {
    // A real case: this caption interrupted A Avó Inventada, and took its dates.
    const entries = entriesFrom(
      section("TEATRO"), unit("VILA MARIANA"), title("A Avó Inventada"), description("Espetáculo inspirado"),
      subTitle("Fôlego"), caption("Santo Amaro – Até 13/12"), description("e memória."), schedule("Dia 11/11. Quarta, 20h30."),
    );
    assert.deepEqual(entries.map((e) => e.title), ["A Avó Inventada"]);
    assert.equal(entries[0].schedule, "Dia 11/11. Quarta, 20h30.");
  });

  test("joins schedule pieces", () => {
    const entries = entriesFrom(section("TEATRO"), unit("POMPEIA"), title("Peça"), schedule("Dia 5/11."), wordsOf("A12", "SemiBold", 6), schedule("R$50 R$25 R$15"));
    assert.equal(entries[0].schedule, "Dia 5/11. R$50 R$25 R$15");
  });

  test("joins a title across lines", () => {
    const entries = entriesFrom(section("TEATRO"), unit("POMPEIA"), title("Os Amores de Lorca,"), title("ou o Amor"));
    assert.equal(entries[0].title, "Os Amores de Lorca, ou o Amor");
  });

  test("marks sub-titles", () => {
    const entries = entriesFrom(section("TEATRO"), unit("POMPEIA"), subTitle("Do Ventre à Cabeça"));
    assert.equal(entries[0].isMain, false);
  });
});

describe("findEdition", () => {
  test("reads the header", () => {
    assert.deepEqual(findEdition(textRuns(wordsOf("EM CARTAZ | MARÇO 2027", "Medium", 6))), [3, 2027]);
  });

  test("fails without a header", () => {
    assert.throws(() => findEdition(textRuns(wordsOf("Outra coisa", "Medium", 6))), BookletError);
  });
});

describe("firstDate", () => {
  test("understands the formats seen in the booklet", () => {
    const cases = {
      "De 19/11 a 13/12. Quintas a sábados, 20h.": "2026-11-19",
      "De 25 a 27/11. Quarta a sexta, 15h.": "2026-11-25",
      "Dia 17/11. Terça, 19h30.": "2026-11-17",
      "Dias 7 e 8/11. Sábado e domingo, 16h.": "2026-11-07",
      "Dias 7, 8 e 9/11.": "2026-11-07",
      "De 31/10 a 2/11.": "2026-10-31",
    };
    for (const [text, expected] of Object.entries(cases)) assert.equal(firstDate(text, EDITION), expected, text);
  });

  test("takes the earliest mention", () => {
    assert.equal(firstDate("Dia 11/11. Quarta, 20h30. De 12/11 a 5/12. Quintas a sábados.", EDITION), "2026-11-11");
  });

  test("running seasons have no first date", () => {
    assert.equal(firstDate("Até 14/11. Quintas a sábados, 20h. De 1 a 15/11.", EDITION), null);
  });

  test("handles no date", () => {
    assert.equal(firstDate("R$50 R$25 R$15", EDITION), null);
  });

  test("handles an impossible date", () => {
    assert.equal(firstDate("Dia 31/11.", EDITION), null);
  });

  test("a December edition rolls into January", () => {
    assert.equal(firstDate("Dia 8/1.", [12, 2026]), "2027-01-08");
  });
});

describe("parsePrice", () => {
  test("reads full, half and member", () => {
    assert.deepEqual(parsePrice("Dia 5/11. R$70 R$35 R$21"), { full: 70, half: 35, member: 21, varies: false });
  });

  test("reads cents", () => {
    assert.equal(parsePrice("R$30,50 R$15,25 R$9").full, 30.5);
  });

  test("uses the cheapest when prices vary", () => {
    assert.deepEqual(parsePrice("Dia 5/11. R$60 R$30 R$18 Dia 6/11. R$30 R$15 R$9"), { full: 30, half: 15, member: 9, varies: true });
  });

  test("recognises free plays", () => {
    assert.equal(parsePrice("Dia 5/11. GRÁTIS."), "free");
  });

  test("handles no stated price", () => {
    assert.equal(parsePrice("Dia 5/11."), null);
  });
});

describe("scheduleText", () => {
  test("removes prices", () => {
    assert.equal(scheduleText("De 19/11 a 13/12. Quintas, 20h. R$70 R$35 R$21 (às sextas)."), "De 19/11 a 13/12. Quintas, 20h.");
  });
});

describe("the sale rule", () => {
  test("matches the table printed in the November booklet", () => {
    const table = {
      "2026-11-02": "2026-10-27",
      "2026-11-08": "2026-10-27",
      "2026-11-09": "2026-11-03",
      "2026-11-22": "2026-11-10",
      "2026-11-23": "2026-11-17",
      "2026-12-06": "2026-11-24",
    };
    for (const [premiere, sale] of Object.entries(table)) assert.equal(ruleSaleDay(premiere), sale, premiere);
  });
});

describe("samePlay", () => {
  test("ignores accents and case", () => assert.equal(samePlay("CÃO", "Cão"), true));
  test("small differences match", () => assert.equal(samePlay("A Hora e a Vez", "A Hora e Vez"), true));
  test("shortened titles match", () => assert.equal(samePlay("Os Amores de Lorca, ou o Amor Dorme no Peito do Poeta", "Os Amores de Lorca"), true));
  test("different plays don't match", () => assert.equal(samePlay("Reality Show", "Rei Menino"), false));
  test("short titles need to be equal", () => assert.equal(samePlay("Cão", "A Coleção de Cão e Gato"), false));
});

describe("buildEstimates", () => {
  test("builds a forecast", () => {
    const [drop] = build([entry()]);
    assert.equal(drop.estimated, true);
    assert.equal(drop.online_sale_start, "2026-11-10T17:00");
    assert.equal(drop.url, `${BOOKLET_URL}#page=28`);
    assert.ok(drop.confirm_url.endsWith("unidades=pompeia"));
    assert.deepEqual([drop.unit, drop.unit_slug, drop.region], ["Pompeia", "pompeia", "capital"]);
    assert.deepEqual([drop.price_full, drop.price_half, drop.price_member], [70, 35, 21]);
    assert.deepEqual(drop.dates, ["2026-11-19"]);
    assert.equal(drop.schedule, "De 19/11 a 13/12. Quintas a sábados, 20h.");
    assert.equal(drop.buy_url, null);
    assert.deepEqual(drop.sessions, []);
  });

  test("matches booklet unit names in capitals", () => {
    assert.equal(build([entry({ place: "24 DE MAIO" })])[0].unit, "24 de Maio");
    assert.equal(build([entry({ place: "SÃO CAETANO" })])[0].unit_slug, "sao-caetano");
  });

  test("skips a play the API already lists", () => {
    assert.deepEqual(build([entry()], { listing: [listed("Reality Show")] }), []);
  });

  test("keeps a play the API lists at another unit", () => {
    assert.equal(build([entry()], { listing: [listed("Reality Show", "24 de Maio")] }).length, 1);
  });

  test("skips free plays", () => assert.deepEqual(build([entry({ when: "De 19/11 a 13/12. GRÁTIS." })]), []));
  test("skips running seasons", () => assert.deepEqual(build([entry({ when: "Até 14/11. R$60 R$30 R$18" })]), []));
  test("skips entries without dates", () => assert.deepEqual(build([entry({ when: "R$50 R$25 R$15" })]), []));
  test("skips sales already open", () => assert.deepEqual(build([entry({ when: "De 10/11 a 13/12. R$60 R$30 R$18" })]), []));

  test("keeps a sale opening later today", () => {
    assert.equal(build([entry({ when: "De 10/11 a 13/12. R$60 R$30 R$18" })], { moment: "2026-11-03T16:59" }).length, 1);
  });

  test("skips a sale opening this minute", () => {
    assert.deepEqual(build([entry({ when: "De 10/11 a 13/12. R$60 R$30 R$18" })], { moment: "2026-11-03T17:00" }), []);
  });

  test("skips premieres past the window", () => {
    assert.deepEqual(build([entry({ when: "De 5/12 a 13/12. R$60 R$30 R$18" })]), []);
  });

  test("skips unknown units", (context) => {
    context.mock.method(console, "warn", () => {});
    assert.deepEqual(build([entry({ place: "UNIDADE NOVA" })]), []);
  });

  test("keeps a play with no price stated", () => {
    assert.equal(build([entry({ when: "De 19/11 a 13/12." })])[0].price_full, null);
  });

  test("a sub-title inherits the series price", () => {
    const series = entry({ name: "TEATRO MÍNIMO", when: "R$50 R$25 R$15" });
    const play = entry({ name: "Peça para os Homens", when: "De 20/11 a 13/12. Sextas, 21h.", isMain: false });
    assert.equal(build([series, play])[0].price_full, 50);
  });

  test("a sub-title inherits a free series", () => {
    const series = entry({ name: "PARA A FAMÍLIA", when: "GRÁTIS." });
    const play = entry({ name: "Hoje Tem Festa", when: "De 20 a 22/11.", isMain: false });
    assert.deepEqual(build([series, play]), []);
  });

  test("its own price beats the series price", () => {
    const series = entry({ name: "TEATRO MÍNIMO", when: "R$50 R$25 R$15" });
    const play = entry({ name: "Circo Secreto", when: "Dia 20/11. GRÁTIS.", isMain: false });
    assert.deepEqual(build([series, play]), []);
  });

  test("a series price doesn't leak to another unit", () => {
    const series = entry({ name: "TEATRO MÍNIMO", when: "R$50 R$25 R$15" });
    const play = entry({ name: "Outra Peça", when: "De 20/11 a 13/12.", place: "24 DE MAIO", isMain: false });
    assert.equal(build([series, play])[0].price_full, null);
  });

  test("a series ends at the next main title", () => {
    const series = entry({ name: "TEATRO MÍNIMO", when: "R$50 R$25 R$15" });
    const main = entry({ name: "Outra Peça", when: "De 20/11 a 13/12. R$70 R$35 R$21" });
    const play = entry({ name: "Terceira", when: "De 20/11 a 13/12.", isMain: false });
    assert.equal(build([series, main, play])[1].price_full, null);
  });
});
