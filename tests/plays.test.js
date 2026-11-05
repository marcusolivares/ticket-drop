import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  addDays,
  buildDrop,
  cleanText,
  decodeEntities,
  isTicketed,
  mightStillOpen,
  ruleSaleDay,
  saoPauloDay,
  saoPauloMoment,
  slugOf,
  unitSlugOf,
} from "../web/plays.js";
import { REGIONS, UNIT_REGIONS } from "../web/regions.js";

const START = "2026-11-03";
const END = "2026-12-03";
const TEST_REGIONS = { pompeia: "capital" };

function listing(overrides = {}) {
  return {
    id: 1,
    titulo: "A Hora e Vez",
    complemento: "",
    link: "/programacao/a-hora-e-vez",
    gratuito: "",
    cancelado: "",
    unidade: [{ name: "Pompeia", link: "/unidades/pompeia" }],
    dataPrimeiraSessao: "2026-11-12T19:30",
    dataUltimaSessao: "2026-12-20T17:30",
    datasSessoes: ["2026-11-12", "2026-11-13"],
    ...overrides,
  };
}

function session(start = "2026-11-12T19:30", online = "2026-11-03T17:00", overrides = {}) {
  return {
    dataInicialSessaoFmt: start,
    dataInicialVendaOnlineFmt: online,
    dataInicialVendaRedeFmt: "2026-11-04T17:00",
    qtdeIngressosWeb: 21,
    qtdeIngressosRede: 9,
    valorInteira: 50,
    valorMeia: 25,
    valorComerciario: 15,
    urlCompra: "https://centralrelacionamento.sescsp.org.br/?path=detalhes-atividade&amp;unidade=5&amp;id=1",
    ...overrides,
  };
}

const detail = (sessions, capped = "false") => ({ possuiMais20Sessoes: capped, sessoes: sessions });
const build = ({ item = listing(), info = detail([session()]) } = {}) => buildDrop(item, info, TEST_REGIONS, START, END);

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

describe("isTicketed", () => {
  test("excludes free and cancelled activities", () => {
    assert.equal(isTicketed(listing()), true);
    assert.equal(isTicketed(listing({ gratuito: "Retirada de ingresso" })), true);
    assert.equal(isTicketed(listing({ gratuito: "Atividade gratuita" })), false);
    assert.equal(isTicketed(listing({ cancelado: "1" })), false);
  });
});

describe("slugs", () => {
  test("take the last part of a link", () => {
    assert.equal(slugOf({ link: "/programacao/a-hora-e-vez/" }), "a-hora-e-vez");
    assert.equal(unitSlugOf(listing()), "pompeia");
  });

  test("cope with a row that has no unit", () => {
    // A real listing row: [{ name: null, link: null }].
    assert.equal(unitSlugOf(listing({ unidade: [{ name: null, link: null }] })), null);
    assert.equal(unitSlugOf(listing({ unidade: [] })), null);
  });
});

describe("ruleSaleDay", () => {
  test("is the Tuesday of the week before", () => {
    for (const premiere of ["2026-11-16", "2026-11-19", "2026-11-22"]) {
      assert.equal(ruleSaleDay(premiere), "2026-11-10");
    }
  });
});

describe("mightStillOpen", () => {
  const premiering = (day) => listing({ dataPrimeiraSessao: `${day}T20:00` });

  test("skips plays that must already be on sale", () => {
    // Week of Nov 2: the rule says Oct 27, plus the margin is Nov 4.
    assert.equal(mightStillOpen(premiering("2026-11-08"), "2026-11-05"), false);
  });

  test("keeps plays that are still to open", () => {
    assert.equal(mightStillOpen(premiering("2026-11-16"), "2026-11-05"), true);
  });

  test("keeps a real play that opened a week after the rule", () => {
    // No Baile de Osa Meji: premiere Nov 14, on sale Nov 10, while the rule says Nov 3.
    assert.equal(mightStillOpen(premiering("2026-11-14"), "2026-11-10"), true);
  });

  test("keeps a real show that went on sale on the day itself", () => {
    // Quarteto de Saxofones: premiere and sale on Nov 25, while the rule says Nov 17.
    assert.equal(mightStillOpen(premiering("2026-11-25"), "2026-11-25"), true);
  });

  test("keeps a play with no first date, rather than risk missing it", () => {
    assert.equal(mightStillOpen(listing({ dataPrimeiraSessao: null }), "2026-11-05"), true);
  });
});

describe("buildDrop", () => {
  test("builds a drop", () => {
    const drop = build();
    assert.equal(drop.id, "1-2026-11-03T17:00");
    assert.equal(drop.url, "https://www.sescsp.org.br/programacao/a-hora-e-vez");
    assert.equal(drop.unit, "Pompeia");
    assert.equal(drop.unit_slug, "pompeia");
    assert.equal(drop.region, "capital");
    assert.equal(drop.online_sale_start, "2026-11-03T17:00");
    assert.equal(drop.in_person_sale_start, "2026-11-04T17:00");
    assert.deepEqual(drop.dates, ["2026-11-12"]);
    assert.equal(drop.sessions[0].online_left, 21);
    assert.equal(drop.season_end, "2026-12-20");
  });

  test("gives nothing when there are no sessions", () => {
    assert.equal(build({ info: detail([]) }), null);
    assert.equal(build({ info: { possuiMais20Sessoes: "false" } }), null);
  });

  test("gives an unknown unit no region", () => {
    const item = listing({ unidade: [{ name: "Nova", link: "/unidades/nova" }] });
    assert.equal(build({ item }).region, "");
  });

  test("unescapes the buy link", () => {
    assert.ok(build().buy_url.endsWith("?path=detalhes-atividade&unidade=5&id=1"));
  });

  test("rejects buy links on other hosts", () => {
    const info = detail([session(undefined, undefined, { urlCompra: "https://example.com/?x=1" })]);
    assert.equal(build({ info }).buy_url, null);
  });

  test("rejects buy links that aren't https", () => {
    const info = detail([session(undefined, undefined, { urlCompra: "http://centralrelacionamento.sescsp.org.br/" })]);
    assert.equal(build({ info }).buy_url, null);
  });

  test("rejects activity links that could point at another site", () => {
    assert.throws(() => build({ item: listing({ link: "@example.com/x" }) }), TypeError);
    assert.throws(() => build({ item: listing({ link: "https://example.com/x" }) }), TypeError);
  });

  test("ignores sessions outside the window", () => {
    const info = detail([session("2026-11-01T19:30"), session("2026-12-04T19:30")]);
    assert.equal(build({ info }), null);
  });

  test("keeps sessions on the window edges", () => {
    const info = detail([session("2026-11-03T19:30"), session("2026-12-03T19:30")]);
    assert.deepEqual(build({ info }).dates, ["2026-11-03", "2026-12-03"]);
  });

  test("the premiere sets the opening", () => {
    // A real case: Sesc sells this play's last session from 08:00 and the rest from 17:00.
    const item = listing({ dataUltimaSessao: "2026-11-29T18:00" });
    const info = detail([
      session("2026-11-20T18:00", "2026-11-10T17:00"),
      session("2026-11-21T20:00", "2026-11-10T17:00"),
      session("2026-11-29T18:00", "2026-11-10T08:00"),
    ]);
    const drop = build({ item, info });
    assert.equal(drop.online_sale_start, "2026-11-10T17:00");
    assert.deepEqual(drop.dates, ["2026-11-20", "2026-11-21"]);
    assert.equal(drop.sessions.length, 2);
    assert.equal(drop.season_end, "2026-11-29");
  });

  test("the premiere wins even when most sessions disagree", () => {
    const info = detail([
      session("2026-11-20T18:00", "2026-11-10T08:00"),
      session("2026-11-21T18:00", "2026-11-10T17:00"),
      session("2026-11-22T18:00", "2026-11-10T17:00"),
    ]);
    const drop = build({ info });
    assert.equal(drop.online_sale_start, "2026-11-10T08:00");
    assert.deepEqual(drop.dates, ["2026-11-20"]);
  });

  test("finds the premiere whatever order the API uses", () => {
    const info = detail([session("2026-11-13T19:30", "2026-11-10T17:00"), session("2026-11-12T19:30", "2026-11-03T17:00")]);
    assert.equal(build({ info }).online_sale_start, "2026-11-03T17:00");
  });

  test("leaves out later sale batches", () => {
    const info = detail([session(), session("2026-11-20T19:30", "2026-11-10T17:00")]);
    const drop = build({ info });
    assert.equal(drop.online_sale_start, "2026-11-03T17:00");
    assert.deepEqual(drop.dates, ["2026-11-12"]);
  });

  test("a later batch of a running season is not a premiere", () => {
    const info = detail([session("2026-11-01T19:30", "2026-10-20T17:00"), session("2026-11-12T19:30", "2026-11-03T17:00")]);
    assert.equal(build({ info }), null);
  });

  test("a premiere with no sale time gives nothing", () => {
    const info = detail([session(undefined, null)]);
    assert.equal(build({ info }), null);
  });

  test("a later session with no sale time is left out", () => {
    const info = detail([session(), session("2026-11-20T19:30", null)]);
    assert.deepEqual(build({ info }).dates, ["2026-11-12"]);
  });

  test("a missing sale field is an error", () => {
    const broken = session();
    delete broken.dataInicialVendaOnlineFmt;
    assert.throws(() => build({ info: detail([broken]) }), TypeError);
  });

  test("a session in an unknown format is an error", () => {
    assert.throws(() => build({ info: detail([{ renamed: "field" }]) }), TypeError);
  });

  test("merges sessions and uses the earliest in-person sale", () => {
    const info = detail([
      session("2026-11-07T16:00", undefined, { dataInicialVendaRedeFmt: "2026-11-07T15:00" }),
      session("2026-11-08T16:00", undefined, { dataInicialVendaRedeFmt: "2026-11-08T15:00" }),
    ]);
    assert.equal(build({ info }).in_person_sale_start, "2026-11-07T15:00");
  });

  test("reports the cheapest price when they vary", () => {
    const info = detail([
      session(undefined, undefined, { valorInteira: 90, valorMeia: 45, valorComerciario: 27 }),
      session("2026-11-13T19:30", undefined, { valorInteira: 60, valorMeia: 30, valorComerciario: 18 }),
    ]);
    const drop = build({ info });
    assert.deepEqual([drop.price_full, drop.price_half, drop.price_member], [60, 30, 18]);
    assert.equal(drop.price_varies, true);
  });

  test("handles free ticketed sessions", () => {
    const info = detail([session(undefined, undefined, { valorInteira: null, valorMeia: null, valorComerciario: null })]);
    assert.equal(build({ info }).price_full, 0);
  });

  test("fills dates past the session cap from the listing", () => {
    const item = listing({ datasSessoes: ["2026-11-12", "2026-11-20", "2026-12-20"] });
    const drop = build({ item, info: detail([session()], "true") });
    assert.deepEqual(drop.dates, ["2026-11-12", "2026-11-20"]);
    assert.equal(drop.sessions.length, 1);
  });

  test("filling dates does not restore left-out sessions", () => {
    const item = listing({ datasSessoes: ["2026-11-12", "2026-11-13", "2026-11-20"] });
    const info = detail([session(), session("2026-11-13T19:30", "2026-11-10T17:00")], "true");
    assert.deepEqual(build({ item, info }).dates, ["2026-11-12", "2026-11-20"]);
  });

  test("does not fill dates when not capped", () => {
    const item = listing({ datasSessoes: ["2026-11-12", "2026-11-20"] });
    assert.deepEqual(build({ item }).dates, ["2026-11-12"]);
  });
});

describe("regions", () => {
  test("every unit belongs to a known region", () => {
    for (const region of Object.values(UNIT_REGIONS)) assert.ok(region in REGIONS, region);
  });
});
