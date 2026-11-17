// Load the forecasts the page shows.
//
// The page asks Sesc for nothing, because Sesc no longer lets other sites read its
// programme or its booklets. The booklet command saves the latest booklet's entries
// in booklet.json, next to the page. The forecasts are worked out here, so a sale
// that has opened leaves the page without waiting for a new edition.

import { buildEstimates } from "./booklet.js";
import { addDays, saoPauloDay, saoPauloMoment } from "./plays.js";

export const WINDOW_DAYS = 30;
const BOOKLET_FILE = "booklet.json";

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareDrops(a, b) {
  return compareText(a.online_sale_start, b.online_sale_start) || compareText(a.unit, b.unit) || compareText(a.title, b.title);
}

/** Return the sales still to open for plays in the next `days` days, soonest first. */
export function forecastsFrom(booklet, now = new Date(), days = WINDOW_DAYS) {
  const today = saoPauloDay(now);
  const drops = buildEstimates({
    entries: booklet.entries,
    edition: booklet.edition,
    bookletUrl: booklet.url,
    moment: saoPauloMoment(now),
    today,
    end: addDays(today, days),
  });
  return drops.sort(compareDrops);
}

/** Whether the booklet is from a month that has already ended in São Paulo. */
export function isOutdated(edition, now = new Date()) {
  const [month, year] = edition;
  const [thisYear, thisMonth] = saoPauloDay(now).split("-").map(Number);
  return year * 12 + month < thisYear * 12 + thisMonth;
}

/** Fetch the saved booklet, which is published with the page. */
export async function loadBooklet(fetch = globalThis.fetch) {
  // Ask the server whether it has changed, so a new edition shows up as soon as it's published.
  const response = await fetch(BOOKLET_FILE, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${BOOKLET_FILE}: HTTP ${response.status}`);
  const booklet = await response.json();
  if (typeof booklet?.url !== "string" || !Array.isArray(booklet.edition) || !Array.isArray(booklet.entries)) {
    throw new Error(`${BOOKLET_FILE}: unexpected contents`);
  }
  return booklet;
}
