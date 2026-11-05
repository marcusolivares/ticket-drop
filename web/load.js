// Fetch what the page shows, reporting progress as it arrives.
//
// Everything runs in the visitor's browser, so results are kept on their device:
// a returning visitor mostly makes one listing request. If a request fails, what
// was saved before stays on the page.

import { BookletError, MIN_ENTRIES, buildEstimates, findEdition, latestBookletUrl, parseEntries, textRuns } from "./booklet.js";
import {
  addDays,
  buildDrop,
  cleanText,
  isTicketed,
  mightStillOpen,
  saoPauloDay,
  saoPauloMoment,
  slugOf,
  unitSlugOf,
} from "./plays.js";
import { REGIONS, UNIT_REGIONS } from "./regions.js";
import { StoppedError } from "./sesc.js";
import { isFresh } from "./store.js";

export const WINDOW_DAYS = 30;

const MINUTE_MS = 60 * 1000;
export const MAX_AGE_MS = {
  listing: 10 * MINUTE_MS,
  play: 180 * MINUTE_MS,
  // Plays can reach the detail route shortly before their sale, so check these sooner.
  missing: 30 * MINUTE_MS,
  booklet: 720 * MINUTE_MS,
  // Booklets can be large, so one that failed isn't downloaded on every reload.
  failedBooklet: 60 * MINUTE_MS,
};

const SAVE_EVERY = 10;
const LISTING_FIELDS = [
  "id",
  "titulo",
  "complemento",
  "link",
  "gratuito",
  "cancelado",
  "unidade",
  "dataPrimeiraSessao",
  "dataUltimaSessao",
  "datasSessoes",
];

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareDrops(a, b) {
  return (
    compareText(a.online_sale_start, b.online_sale_start) ||
    Number(Boolean(a.estimated)) - Number(Boolean(b.estimated)) ||
    compareText(a.unit, b.unit) ||
    compareText(a.title, b.title)
  );
}

function keepFields(item) {
  return Object.fromEntries(LISTING_FIELDS.map((field) => [field, item[field]]));
}

function listUnits(plays) {
  const units = new Map();
  for (const item of plays) {
    const slug = unitSlugOf(item);
    units.set(slug, { slug, name: cleanText(item.unidade[0].name), region: UNIT_REGIONS[slug] ?? "" });
  }
  return [...units.values()];
}

/** Every play with a unit, from a saved listing if it's recent enough. */
async function readListing(client, store, window, now) {
  const saved = store.read("listing");
  if (saved?.start === window.start && isFresh(saved.savedAt, MAX_AGE_MS.listing, now)) {
    return { items: saved.items, wasFetched: false };
  }
  const listed = await client.listPlays(window.start, window.end);
  const items = listed.filter((item) => unitSlugOf(item)).map(keepFields);
  store.write("listing", { savedAt: now, start: window.start, items });
  return { items, wasFetched: true };
}

/** Return the latest booklet's entries, reading it only if it's new to this device. */
async function readBooklet({ client, store, readPdf, now }) {
  const saved = store.read("booklet");
  if (saved && isFresh(saved.checkedAt, MAX_AGE_MS.booklet, now)) return saved;

  const url = latestBookletUrl(await client.getBookletArchive());
  if (saved?.url === url) {
    const booklet = { ...saved, checkedAt: now };
    store.write("booklet", booklet);
    return booklet;
  }
  const failure = store.read("failedBooklet");
  if (failure?.url === url && isFresh(failure.failedAt, MAX_AGE_MS.failedBooklet, now)) {
    throw new BookletError("this edition couldn't be read recently, so it isn't being downloaded again yet");
  }

  try {
    const runs = textRuns(await readPdf(await client.getFile(url)));
    const entries = parseEntries(runs);
    if (entries.length < MIN_ENTRIES) {
      throw new BookletError(`only ${entries.length} theatre entries found, so the layout may have changed`);
    }
    const booklet = { url, edition: findEdition(runs), entries, checkedAt: now };
    store.write("booklet", booklet);
    return booklet;
  } catch (error) {
    store.write("failedBooklet", { url, failedAt: now });
    throw error;
  }
}

/**
 * Load the sale openings still to come, for plays in the next `days` days.
 *
 * `onUpdate(dataset, status)` is called each time there's more to show. In the
 * status, `problem` is null, "partial" (some plays couldn't be checked) or
 * "offline" (the list itself couldn't be fetched).
 *
 * Forecasts are added last, so the booklet never delays the main list. They need
 * `readPdf`, which turns a PDF's bytes into words.
 */
export async function loadPlays({
  client,
  store,
  clock = () => new Date(),
  days = WINDOW_DAYS,
  onUpdate = () => {},
  readPdf = null,
}) {
  const started = clock();
  const today = saoPauloDay(started);
  const moment = saoPauloMoment(started);
  const window = { start: today, end: addDays(today, days), days };

  const saved = store.read("plays");
  let entries = saved?.entries ?? {};
  let units = saved?.units ?? [];
  let updatedAt = saved?.updatedAt ?? null;
  let forecasts = saved?.forecasts ?? [];

  const dataset = () => ({
    generated_at: updatedAt,
    window,
    regions: REGIONS,
    units,
    drops: [...Object.values(entries).map((entry) => entry.drop), ...forecasts]
      .filter((drop) => drop && drop.online_sale_start > moment)
      .sort(compareDrops),
  });
  const save = () => store.write("plays", { updatedAt, units, entries, forecasts });
  const finish = (status) => {
    const result = { dataset: dataset(), status: { phase: "done", updatedAt, ...status } };
    onUpdate(result.dataset, result.status);
    return result;
  };

  onUpdate(dataset(), { phase: "loading", done: 0, total: 0, failed: 0, problem: null, updatedAt });

  let listing;
  try {
    listing = await readListing(client, store, window, clock().getTime());
  } catch {
    return finish({ done: 0, total: 0, failed: 0, problem: "offline" });
  }

  const plays = listing.items.filter((item) => isTicketed(item) && mightStillOpen(item, today));
  units = listUnits(plays);
  entries = Object.fromEntries(
    plays.map(slugOf).filter((slug) => slug in entries).map((slug) => [slug, entries[slug]]),
  );

  const isUpToDate = (slug) => {
    const entry = entries[slug];
    return entry && isFresh(entry.savedAt, entry.missing ? MAX_AGE_MS.missing : MAX_AGE_MS.play, clock().getTime());
  };
  const pending = plays.filter((item) => !isUpToDate(slugOf(item)));

  let done = 0;
  let failed = 0;
  let stopped = false;
  const report = () => onUpdate(dataset(), { phase: "loading", done, total: pending.length, failed, problem: null, updatedAt });
  report();

  await Promise.all(
    pending.map(async (item) => {
      const slug = slugOf(item);
      try {
        const detail = await client.getDetail(slug);
        entries[slug] = {
          savedAt: clock().getTime(),
          missing: detail === null,
          drop: detail && buildDrop(item, detail, UNIT_REGIONS, window.start, window.end),
        };
      } catch (error) {
        failed += 1;
        if (error instanceof StoppedError) stopped = true;
      }
      done += 1;
      if (done % SAVE_EVERY === 0) save();
      report();
    }),
  );

  if (!stopped && (listing.wasFetched || pending.length)) updatedAt = clock().toISOString();
  save();

  let bookletProblem = false;
  if (readPdf) {
    onUpdate(dataset(), { phase: "loading", readingBooklet: true, done, total: pending.length, failed, problem: null, updatedAt });
    let booklet;
    try {
      booklet = await readBooklet({ client, store, readPdf, now: clock().getTime() });
    } catch (error) {
      console.warn("Couldn't read the booklet:", error);
      bookletProblem = true;
      booklet = store.read("booklet");
    }
    if (booklet) {
      forecasts = buildEstimates({
        entries: booklet.entries,
        edition: booklet.edition,
        listing: listing.items,
        bookletUrl: booklet.url,
        moment,
        today,
        end: window.end,
      });
      save();
    }
  }
  return finish({ done, total: pending.length, failed, problem: failed ? "partial" : null, bookletProblem });
}
