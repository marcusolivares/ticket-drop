import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { MIN_ENTRIES } from "../web/booklet.js";
import { AUTO_BOOKLET_BYTES, MAX_AGE_MS, compareDrops, loadPlays } from "../web/load.js";
import { ApiError, StoppedError } from "../web/sesc.js";
import { createStore } from "../web/store.js";

const NOW = new Date("2026-11-05T12:00:00-03:00");
const MINUTE = 60 * 1000;
const BOOKLET_URL = "https://www.sescsp.org.br/wp-content/uploads/2026/10/em-cartaz.pdf";

function play(name, overrides = {}) {
  return {
    id: name,
    titulo: name,
    complemento: "",
    link: `/programacao/${name}`,
    gratuito: "",
    cancelado: "",
    unidade: [{ name: "Pompeia", link: "/unidades/pompeia" }],
    dataPrimeiraSessao: "2026-11-20T20:00",
    dataUltimaSessao: "2026-11-20T20:00",
    datasSessoes: ["2026-11-20"],
    extraFieldThatIsNotKept: "x".repeat(50),
    ...overrides,
  };
}

function detail(online = "2026-11-10T17:00", start = "2026-11-20T20:00") {
  return {
    possuiMais20Sessoes: "false",
    sessoes: [
      {
        dataInicialSessaoFmt: start,
        dataInicialVendaOnlineFmt: online,
        dataInicialVendaRedeFmt: "2026-11-11T17:00",
        qtdeIngressosWeb: 10,
        qtdeIngressosRede: 5,
        valorInteira: 40,
        valorMeia: 20,
        valorComerciario: 12,
        urlCompra: "",
      },
    ],
  };
}

class FakeClient {
  constructor(plays, details = {}) {
    this.plays = plays;
    this.details = details;
    this.listCalls = [];
    this.detailCalls = [];
  }

  async listPlays(start, end) {
    this.listCalls.push({ start, end });
    if (this.plays instanceof Error) throw this.plays;
    return this.plays;
  }

  async getDetail(slug) {
    this.detailCalls.push(slug);
    const result = slug in this.details ? this.details[slug] : detail();
    if (result instanceof Error) throw result;
    return result;
  }

  // The booklet: `booklet` sets its address and size, or an Error to fail.
  booklet = { url: BOOKLET_URL, size: 3_000_000 };
  bookletCalls = { archive: 0, size: 0, file: 0 };

  async getBookletArchive() {
    this.bookletCalls.archive += 1;
    if (this.booklet instanceof Error) throw this.booklet;
    return `<a href="${this.booklet.url}">PDF</a>`;
  }

  async getFileSize() {
    this.bookletCalls.size += 1;
    return this.booklet.size;
  }

  async getFile(url) {
    this.bookletCalls.file += 1;
    return url;
  }
}

const words = (text, weight, size) =>
  text.split(" ").map((word) => ({ text: word, fontname: `X+Informative-${weight}`, size, page: 28 }));

/** A booklet with one play to forecast and enough other entries to look real. */
function bookletWords(name = "Reality Show") {
  const filler = Array.from({ length: MIN_ENTRIES }, (_, n) => [
    ...words(`Outra ${n}`, "Bold", 10),
    ...words("Dia 2/11. GRÁTIS.", "SemiBold", 8.5),
  ]).flat();
  return [
    ...words("EM CARTAZ | NOVEMBRO 2026", "Medium", 6),
    ...words("TEATRO", "Black", 11),
    ...words("POMPEIA", "Medium", 10),
    ...words(name, "Bold", 10),
    ...words("De 19/11 a 13/12. R$70 R$35 R$21", "SemiBold", 8.5),
    ...filler,
  ];
}

const readPdf = async () => bookletWords();

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

describe("loadPlays", () => {
  let store;
  let time;
  const clock = () => new Date(time);
  const load = (client, options = {}) => loadPlays({ client, store, clock, ...options });
  const titles = (result) => result.dataset.drops.map((drop) => drop.title);

  beforeEach(() => {
    const storage = memoryStorage();
    store = createStore(() => storage);
    time = NOW.getTime();
  });

  test("builds the dataset", async () => {
    const { dataset, status } = await load(new FakeClient([play("cao")]));
    assert.equal(dataset.drops.length, 1);
    assert.equal(dataset.drops[0].region, "capital");
    assert.deepEqual(dataset.window, { start: "2026-11-05", end: "2026-12-05", days: 30 });
    assert.equal(dataset.regions.capital, "Capital e Grande SP");
    assert.equal(dataset.generated_at, NOW.toISOString());
    assert.deepEqual(status, {
      phase: "done",
      updatedAt: NOW.toISOString(),
      done: 1,
      total: 1,
      failed: 0,
      problem: null,
      bookletProblem: false,
      bookletOffer: null,
    });
  });

  test("asks for the next 30 days in São Paulo time", async () => {
    const client = new FakeClient([play("cao")]);
    time = new Date("2026-11-06T01:00:00Z").getTime(); // Still Nov 5 in São Paulo.
    await load(client);
    assert.deepEqual(client.listCalls, [{ start: "2026-11-05", end: "2026-12-05" }]);
  });

  test("makes no detail requests for free or cancelled plays", async () => {
    const client = new FakeClient([
      play("cao"),
      play("free", { gratuito: "Atividade gratuita" }),
      play("cancelled", { cancelado: "1" }),
    ]);
    await load(client);
    assert.deepEqual(client.detailCalls, ["cao"]);
  });

  test("makes no detail requests for plays that must already be on sale", async () => {
    const client = new FakeClient([play("cao"), play("running", { dataPrimeiraSessao: "2026-11-05T20:00" })]);
    await load(client);
    assert.deepEqual(client.detailCalls, ["cao"]);
  });

  test("ignores rows with no unit", async () => {
    const client = new FakeClient([play("cao"), play("nowhere", { unidade: [{ name: null, link: null }] })]);
    const result = await load(client);
    assert.deepEqual(client.detailCalls, ["cao"]);
    assert.equal(result.dataset.units.length, 1);
  });

  test("keeps only sales still to open", async () => {
    const details = { opened: detail("2026-11-03T17:00"), exactly: detail("2026-11-05T12:00"), later: detail("2026-11-05T12:01") };
    const result = await load(new FakeClient([play("opened"), play("exactly"), play("later")], details));
    assert.deepEqual(titles(result), ["later"]);
  });

  test("a play with no sessions in the window has no card", async () => {
    const details = { far: detail("2026-11-10T17:00", "2026-12-20T20:00") };
    const result = await load(new FakeClient([play("far"), play("near")], details));
    assert.deepEqual(titles(result), ["near"]);
  });

  test("sorts by opening, then real dates before forecasts, then unit and title", () => {
    const drop = (online_sale_start, unit, title, estimated) => ({ online_sale_start, unit, title, estimated });
    const sorted = [
      drop("2026-11-17T17:00", "A", "first"),
      drop("2026-11-10T17:00", "A", "forecast", true),
      drop("2026-11-10T17:00", "B", "real"),
      drop("2026-11-10T17:00", "A", "real b"),
      drop("2026-11-10T17:00", "A", "real a"),
    ].sort(compareDrops);
    assert.deepEqual(sorted.map((item) => item.title), ["real a", "real b", "real", "forecast", "first"]);
  });

  test("lists the units with their regions", async () => {
    const plays = [
      play("a"),
      play("b"),
      play("c", { unidade: [{ name: "Santos", link: "/unidades/santos" }] }),
      play("d", { unidade: [{ name: "Nova", link: "/unidades/nova" }] }),
    ];
    const { dataset } = await load(new FakeClient(plays));
    assert.deepEqual(dataset.units, [
      { slug: "pompeia", name: "Pompeia", region: "capital" },
      { slug: "santos", name: "Santos", region: "litoral" },
      { slug: "nova", name: "Nova", region: "" },
    ]);
  });

  test("reports progress as plays arrive", async () => {
    const updates = [];
    await load(new FakeClient([play("a"), play("b")]), {
      onUpdate: (dataset, status) => updates.push([status.phase, status.done, status.total, dataset.drops.length]),
    });
    assert.deepEqual(updates, [
      ["loading", 0, 0, 0],
      ["loading", 0, 2, 0],
      ["loading", 1, 2, 1],
      ["loading", 2, 2, 2],
      ["done", 2, 2, 2],
    ]);
  });

  describe("saved results", () => {
    test("shows saved plays before asking the network", async () => {
      await load(new FakeClient([play("cao")]));
      let first;
      await load(new FakeClient([play("cao")]), {
        onUpdate: (dataset) => {
          first ??= dataset.drops.map((drop) => drop.title);
        },
      });
      assert.deepEqual(first, ["cao"]);
    });

    test("a reload soon after makes no requests", async () => {
      await load(new FakeClient([play("cao")]));
      time += MAX_AGE_MS.listing - MINUTE;
      const client = new FakeClient([play("cao")]);
      const result = await load(client);
      assert.equal(client.listCalls.length, 0);
      assert.equal(client.detailCalls.length, 0);
      assert.deepEqual(titles(result), ["cao"]);
    });

    test("a reload soon after doesn't claim the data is newer", async () => {
      await load(new FakeClient([play("cao")]));
      time += MINUTE;
      const { status } = await load(new FakeClient([play("cao")]));
      assert.equal(status.updatedAt, NOW.toISOString());
    });

    test("refreshes the listing but not the plays after a while", async () => {
      await load(new FakeClient([play("cao")]));
      time += MAX_AGE_MS.listing;
      const client = new FakeClient([play("cao")]);
      const { status } = await load(client);
      assert.equal(client.listCalls.length, 1);
      assert.equal(client.detailCalls.length, 0);
      assert.equal(status.updatedAt, new Date(time).toISOString());
    });

    test("only asks about plays it hasn't seen", async () => {
      await load(new FakeClient([play("cao")]));
      time += MAX_AGE_MS.listing;
      const client = new FakeClient([play("cao"), play("novo")]);
      const result = await load(client);
      assert.deepEqual(client.detailCalls, ["novo"]);
      assert.deepEqual(titles(result), ["cao", "novo"].sort());
    });

    test("refreshes plays once they're old", async () => {
      await load(new FakeClient([play("cao")]));
      time += MAX_AGE_MS.play;
      const client = new FakeClient([play("cao")]);
      await load(client);
      assert.deepEqual(client.detailCalls, ["cao"]);
    });

    test("checks a play the API didn't have sooner", async () => {
      await load(new FakeClient([play("cao")], { cao: null }));
      time += MAX_AGE_MS.missing - MINUTE;
      const early = new FakeClient([play("cao")], { cao: null });
      await load(early);
      assert.deepEqual(early.detailCalls, []);
      time += MINUTE;
      const later = new FakeClient([play("cao")]);
      const result = await load(later);
      assert.deepEqual(later.detailCalls, ["cao"]);
      assert.deepEqual(titles(result), ["cao"]);
    });

    test("a play that left the listing leaves the page", async () => {
      await load(new FakeClient([play("cao"), play("gone")]));
      time += MAX_AGE_MS.listing;
      const result = await load(new FakeClient([play("cao")]));
      assert.deepEqual(titles(result), ["cao"]);
    });

    test("a saved listing isn't used on a new day", async () => {
      await load(new FakeClient([play("cao")]));
      time = new Date("2026-11-06T00:01:00-03:00").getTime();
      const client = new FakeClient([play("cao")]);
      await load(client);
      assert.equal(client.listCalls.length, 1);
    });

    test("a sale that has opened since leaves the page", async () => {
      await load(new FakeClient([play("cao")]));
      time = new Date("2026-11-10T17:01:00-03:00").getTime();
      const result = await load(new FakeClient(new ApiError("down")));
      assert.deepEqual(titles(result), []);
    });

    test("keeps progress from a visit that's cut short", async () => {
      const plays = Array.from({ length: 11 }, (_, n) => play(`play-${String(n).padStart(2, "0")}`));
      const client = new FakeClient(plays);
      const original = client.getDetail.bind(client);
      client.getDetail = (slug) => (slug === "play-10" ? new Promise(() => {}) : original(slug));
      load(client);
      await new Promise((resolve) => setImmediate(resolve));
      const next = new FakeClient(plays);
      await load(next);
      assert.deepEqual(next.detailCalls, ["play-10"]);
    });

    test("works when nothing can be saved", async () => {
      const broken = createStore(() => {
        throw new Error("blocked");
      });
      const { dataset } = await loadPlays({ client: new FakeClient([play("cao")]), store: broken, clock });
      assert.equal(dataset.drops.length, 1);
    });
  });

  describe("forecasts", () => {
    const forecasts = (result) => result.dataset.drops.filter((drop) => drop.estimated).map((drop) => drop.title);

    test("are left out when the page can't read PDFs", async () => {
      const client = new FakeClient([play("cao")]);
      const result = await load(client);
      assert.deepEqual(forecasts(result), []);
      assert.equal(client.bookletCalls.archive, 0);
    });

    test("come from a small booklet automatically", async () => {
      const client = new FakeClient([play("cao")]);
      const result = await load(client, { readPdf });
      assert.deepEqual(forecasts(result), ["Reality Show"]);
      assert.equal(result.dataset.drops.find((drop) => drop.estimated).url, `${BOOKLET_URL}#page=28`);
      assert.equal(client.bookletCalls.file, 1);
      assert.equal(result.status.bookletOffer, null);
      assert.equal(result.status.bookletProblem, false);
    });

    test("arrive after the plays from the API", async () => {
      const updates = [];
      await load(new FakeClient([play("cao")]), {
        readPdf,
        onUpdate: (dataset, status) => updates.push([Boolean(status.readingBooklet), dataset.drops.length]),
      });
      assert.deepEqual(updates.at(-2), [true, 1]);
      assert.deepEqual(updates.at(-1), [false, 2]);
    });

    test("leave once the API lists the play", async () => {
      const client = new FakeClient([play("cao"), play("Reality Show", { link: "/programacao/reality-show" })]);
      const result = await load(client, { readPdf });
      assert.deepEqual(forecasts(result), []);
    });

    test("count a free or cancelled play the API lists as listed", async () => {
      const free = play("Reality Show", { link: "/programacao/reality-show", gratuito: "Atividade gratuita" });
      const result = await load(new FakeClient([play("cao"), free]), { readPdf });
      assert.deepEqual(forecasts(result), []);
    });

    test("leave once their time passes", async () => {
      await load(new FakeClient([play("cao", { dataPrimeiraSessao: "2026-11-30T20:00" })]), { readPdf });
      time = new Date("2026-11-10T17:01:00-03:00").getTime();
      const result = await load(new FakeClient(new ApiError("down")), { readPdf });
      assert.deepEqual(forecasts(result), []);
    });

    test("appear straight away on the next visit", async () => {
      await load(new FakeClient([play("cao")]), { readPdf });
      let first;
      await load(new FakeClient([play("cao")]), {
        readPdf,
        onUpdate: (dataset) => {
          first ??= dataset.drops.filter((drop) => drop.estimated).length;
        },
      });
      assert.equal(first, 1);
    });

    test("stay when the list can't be fetched", async () => {
      await load(new FakeClient([play("cao")]), { readPdf });
      time += MAX_AGE_MS.play;
      const result = await load(new FakeClient(new ApiError("down")), { readPdf });
      assert.deepEqual(forecasts(result), ["Reality Show"]);
    });

    describe("a saved booklet", () => {
      test("isn't checked again soon", async () => {
        await load(new FakeClient([play("cao")]), { readPdf });
        time += MAX_AGE_MS.listing;
        const client = new FakeClient([play("cao")]);
        const result = await load(client, { readPdf });
        assert.deepEqual(client.bookletCalls, { archive: 0, size: 0, file: 0 });
        assert.deepEqual(forecasts(result), ["Reality Show"]);
      });

      test("isn't downloaded again if it's still the latest", async () => {
        await load(new FakeClient([play("cao")]), { readPdf });
        time += MAX_AGE_MS.booklet;
        const client = new FakeClient([play("cao")]);
        await load(client, { readPdf });
        assert.deepEqual(client.bookletCalls, { archive: 1, size: 0, file: 0 });
      });

      test("is replaced by a new edition", async () => {
        await load(new FakeClient([play("cao")]), { readPdf });
        time += MAX_AGE_MS.booklet;
        const client = new FakeClient([play("cao")]);
        client.booklet = { url: BOOKLET_URL.replace("em-cartaz", "dezembro"), size: 1000 };
        const result = await load(client, { readPdf: async () => bookletWords("Peça Nova") });
        assert.deepEqual(forecasts(result), ["Peça Nova"]);
      });

      test("is what's used when a new edition can't be read", async () => {
        await load(new FakeClient([play("cao")]), { readPdf });
        time += MAX_AGE_MS.booklet;
        const client = new FakeClient([play("cao")]);
        client.booklet = { url: BOOKLET_URL.replace("em-cartaz", "dezembro"), size: 1000 };
        const broken = async () => {
          throw new Error("not a PDF");
        };
        const warn = console.warn;
        console.warn = () => {};
        const result = await load(client, { readPdf: broken });
        console.warn = warn;
        assert.deepEqual(forecasts(result), ["Reality Show"]);
        assert.equal(result.status.bookletProblem, true);
        assert.equal(result.status.problem, null);
      });
    });

    describe("a large booklet", () => {
      const large = () => {
        const client = new FakeClient([play("cao")]);
        client.booklet = { url: BOOKLET_URL, size: AUTO_BOOKLET_BYTES + 1 };
        return client;
      };

      test("waits for the visitor to ask", async () => {
        const client = large();
        const result = await load(client, { readPdf });
        assert.deepEqual(result.status.bookletOffer, { size: AUTO_BOOKLET_BYTES + 1 });
        assert.deepEqual(forecasts(result), []);
        assert.equal(client.bookletCalls.file, 0);
      });

      test("is read once the visitor asks", async () => {
        const client = large();
        await load(client, { readPdf });
        const result = await load(client, { readPdf, allowLargeBooklet: true });
        assert.deepEqual(forecasts(result), ["Reality Show"]);
        assert.equal(result.status.bookletOffer, null);
        assert.equal(client.bookletCalls.file, 1);
      });

      test("isn't checked on every reload while waiting", async () => {
        const client = large();
        await load(client, { readPdf });
        const result = await load(client, { readPdf });
        assert.equal(client.bookletCalls.archive, 1);
        assert.deepEqual(result.status.bookletOffer, { size: AUTO_BOOKLET_BYTES + 1 });
      });

      test("keeps forecasts from the last edition while waiting", async () => {
        await load(new FakeClient([play("cao")]), { readPdf });
        time += MAX_AGE_MS.booklet;
        const client = large();
        client.booklet.url = BOOKLET_URL.replace("em-cartaz", "dezembro");
        const result = await load(client, { readPdf });
        assert.deepEqual(forecasts(result), ["Reality Show"]);
        assert.ok(result.status.bookletOffer);
      });

      test("is offered if its size is unknown", async () => {
        const client = large();
        client.booklet.size = null;
        const result = await load(client, { readPdf });
        assert.deepEqual(result.status.bookletOffer, { size: null });
      });

      test("a visitor saving data is asked about any booklet", async () => {
        const client = new FakeClient([play("cao")]);
        const result = await load(client, { readPdf, autoBookletBytes: 0 });
        assert.ok(result.status.bookletOffer);
        assert.equal(client.bookletCalls.file, 0);
      });
    });

    describe("when the booklet fails", () => {
      const quietly = async (action) => {
        const warn = console.warn;
        console.warn = () => {};
        try {
          return await action();
        } finally {
          console.warn = warn;
        }
      };

      test("the plays from the API are unaffected", async () => {
        const client = new FakeClient([play("cao")]);
        client.booklet = new Error("no archive");
        const result = await quietly(() => load(client, { readPdf }));
        assert.deepEqual(titles(result), ["cao"]);
        assert.equal(result.status.bookletProblem, true);
        assert.equal(result.status.problem, null);
      });

      test("too few entries means the layout changed", async () => {
        const client = new FakeClient([play("cao")]);
        const result = await quietly(() => load(client, { readPdf: async () => words("TEATRO", "Black", 11) }));
        assert.equal(result.status.bookletProblem, true);
        assert.deepEqual(titles(result), ["cao"]);
      });

      test("not reaching the archive is tried again on the next reload", async () => {
        const unreachable = new FakeClient([play("cao")]);
        unreachable.booklet = new Error("no archive");
        await quietly(() => load(unreachable, { readPdf }));
        const client = new FakeClient([play("cao")]);
        await load(client, { readPdf });
        assert.equal(client.bookletCalls.file, 1);
      });

      describe("an edition that couldn't be read", () => {
        const broken = async () => {
          throw new Error("not a PDF");
        };
        const failOnce = () => quietly(() => load(new FakeClient([play("cao")]), { readPdf: broken }));

        test("isn't downloaded again on the next reload", async () => {
          await failOnce();
          const client = new FakeClient([play("cao")]);
          const result = await quietly(() => load(client, { readPdf }));
          assert.equal(client.bookletCalls.file, 0);
          assert.equal(result.status.bookletProblem, true);
        });

        test("is tried again after a while", async () => {
          await failOnce();
          time += MAX_AGE_MS.failedBooklet;
          const client = new FakeClient([play("cao")]);
          const result = await load(client, { readPdf });
          assert.equal(client.bookletCalls.file, 1);
          assert.deepEqual(forecasts(result), ["Reality Show"]);
          assert.equal(result.status.bookletProblem, false);
        });

        test("doesn't hold back a new edition", async () => {
          await failOnce();
          const client = new FakeClient([play("cao")]);
          client.booklet.url = BOOKLET_URL.replace("em-cartaz", "dezembro");
          const result = await load(client, { readPdf });
          assert.equal(client.bookletCalls.file, 1);
          assert.equal(result.status.bookletProblem, false);
        });
      });
    });
  });

  describe("failures", () => {
    test("with no list and nothing saved, says so", async () => {
      const { dataset, status } = await load(new FakeClient(new ApiError("down")));
      assert.deepEqual(dataset.drops, []);
      assert.equal(status.problem, "offline");
      assert.equal(status.updatedAt, null);
    });

    test("with no list, keeps what was saved and when", async () => {
      await load(new FakeClient([play("cao")]));
      time += MAX_AGE_MS.play;
      const result = await load(new FakeClient(new ApiError("down")));
      assert.deepEqual(titles(result), ["cao"]);
      assert.equal(result.status.problem, "offline");
      assert.equal(result.status.updatedAt, NOW.toISOString());
    });

    test("one failed play doesn't affect the others", async () => {
      const client = new FakeClient([play("good"), play("bad")], { bad: new ApiError("HTTP 500") });
      const result = await load(client);
      assert.deepEqual(titles(result), ["good"]);
      assert.equal(result.status.failed, 1);
      assert.equal(result.status.problem, "partial");
    });

    test("a play in an unknown format counts as failed", async () => {
      const result = await load(new FakeClient([play("odd")], { odd: { sessoes: [{ renamed: "field" }] } }));
      assert.deepEqual(titles(result), []);
      assert.equal(result.status.problem, "partial");
    });

    test("a failed play keeps its saved card", async () => {
      await load(new FakeClient([play("cao")]));
      time += MAX_AGE_MS.play;
      const result = await load(new FakeClient([play("cao")], { cao: new ApiError("HTTP 500") }));
      assert.deepEqual(titles(result), ["cao"]);
      assert.equal(result.status.problem, "partial");
    });

    test("a failed play is tried again next time", async () => {
      await load(new FakeClient([play("cao")], { cao: new ApiError("HTTP 500") }));
      time += MAX_AGE_MS.listing;
      const client = new FakeClient([play("cao")]);
      await load(client);
      assert.deepEqual(client.detailCalls, ["cao"]);
    });

    test("stopping early doesn't claim the data was updated", async () => {
      await load(new FakeClient([play("cao")]));
      time += MAX_AGE_MS.play;
      const details = { cao: new StoppedError("stopped"), novo: new StoppedError("stopped") };
      const { status } = await load(new FakeClient([play("cao"), play("novo")], details));
      assert.equal(status.problem, "partial");
      assert.equal(status.updatedAt, NOW.toISOString());
    });
  });
});
