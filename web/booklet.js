// Estimate sale openings from the monthly Em Cartaz booklet.
//
// The booklet is a PDF with no structured data, but each kind of text has its own
// font, which has held across the editions checked. The sale date is not in the
// booklet: it's worked out from the rule the booklet prints, so it's only a forecast.
//
// The booklet command reads the PDF on the maintainer's computer. The page only
// builds the forecasts, so they stay current between editions.

import { SITE_URL, cleanText, ruleSaleDay } from "./plays.js";
import { UNITS } from "./regions.js";

// Sesc's own search page. Play pages can't be linked directly: their addresses
// often differ from the title, for example with a "-2" for a later season.
const SEARCH_URL = `${SITE_URL}/busca/?busca=`;
const BOOKLET_LINK = new RegExp(`${SITE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/wp-content/uploads/[^"'\\s<>]+\\.pdf`);

// The font weight and size of each kind of text.
const SECTION_STYLE = "Black|11";
const UNIT_STYLE = "Medium|10";
const MAIN_TITLE_STYLE = "Bold|10";
const SUB_TITLE_STYLE = "SemiBold|10";
const SCHEDULE_STYLE = "SemiBold|8.5";
const CAPTION_STYLE = "Regular|10";

const THEATRE_SECTION = "TEATRO";
const SALE_TIME = "17:00";
// Far fewer entries than the 36 to 50 seen so far means the layout has changed.
export const MIN_ENTRIES = 10;
const MONTHS = [
  "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];
const DATE_PATTERNS = [
  /\bDe (\d{1,2})\/(\d{1,2}) a/g,
  /\bDe (\d{1,2}) a \d{1,2}\/(\d{1,2})/g,
  /\bDias? (\d{1,2})(?:(?:, | e | a )\d{1,2})*\/(\d{1,2})/g,
];
const PRICE_PATTERN = /R\$\s?(\d+(?:,\d{2})?)/g;
const FREE_WORD = "GRÁTIS";

/** The booklet couldn't be read, or doesn't look as expected. */
export class BookletError extends Error {}

export function normalize(text) {
  return (text ?? "")
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const UNITS_BY_NAME = new Map(Object.entries(UNITS).map(([slug, unit]) => [normalize(unit.name), { slug, ...unit }]));

/** Whether a unit name, as the booklet prints it, is in the fixed list of units. */
export function isKnownUnit(name) {
  return UNITS_BY_NAME.has(normalize(name));
}

/** Return the newest booklet. The archive page lists them newest first. */
export function latestBookletUrl(archiveHtml) {
  const match = BOOKLET_LINK.exec(archiveHtml);
  if (!match) throw new BookletError("no booklet link found on the archive page");
  return match[0];
}

const styleOf = (word) => `${word.fontname.split("-").pop()}|${Math.round(word.size * 10) / 10}`;

/** Merge consecutive words of the same style. */
export function textRuns(words) {
  const runs = [];
  for (const word of words) {
    const style = styleOf(word);
    const last = runs[runs.length - 1];
    if (last?.style === style) last.text += ` ${word.text}`;
    else runs.push({ page: word.page, style, text: word.text });
  }
  return runs;
}

/** Return the [month, year] printed in the page headers. */
export function findEdition(runs) {
  for (const { text } of runs) {
    const match = /EM CARTAZ \| (\S+) (\d{4})/.exec(text);
    const month = match && MONTHS.indexOf(normalize(match[1]));
    if (match && month >= 0) return [month + 1, Number(match[2])];
  }
  throw new BookletError("no edition header found");
}

/** Return the entries of the theatre section, in reading order. */
export function parseEntries(runs) {
  const entries = [];
  let section = null;
  let unit = null;
  runs.forEach(({ page, style, text }, index) => {
    if (style === SECTION_STYLE) {
      // Page numbers share this style, so ignore anything that's only digits.
      const heading = text.replace(/\d+/g, "").trim();
      if (heading) section = heading;
    } else if (section !== THEATRE_SECTION) {
      // Not the part of the booklet this reads.
    } else if (style === UNIT_STYLE) {
      unit = text;
    } else if (style === MAIN_TITLE_STYLE || style === SUB_TITLE_STYLE) {
      // A photo caption looks like a title, followed by a "Unit - dates" line.
      if (runs[index + 1]?.style !== CAPTION_STYLE) {
        entries.push({ unit, title: cleanText(text), isMain: style === MAIN_TITLE_STYLE, schedule: "", page });
      }
    } else if (style === SCHEDULE_STYLE && entries.length) {
      const last = entries[entries.length - 1];
      last.schedule = `${last.schedule} ${text}`.trim();
    }
  });
  return entries;
}

/** Return the first date in a schedule, or null if it has none or is already running. */
export function firstDate(schedule, edition) {
  if (schedule.startsWith("Até")) return null;
  const found = DATE_PATTERNS.flatMap((pattern) =>
    [...schedule.matchAll(pattern)].map((match) => [match.index, Number(match[1]), Number(match[2])]),
  );
  if (!found.length) return null;
  const [, day, month] = found.sort((a, b) => a[0] - b[0] || a[1] - b[1])[0];
  const [editionMonth, editionYear] = edition;
  // A December edition can list January dates.
  const year = month < editionMonth - 6 ? editionYear + 1 : editionYear;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/** Return the prices, the word "free", or null if the entry doesn't say. */
export function parsePrice(schedule) {
  const found = [...schedule.matchAll(PRICE_PATTERN)].map((match) => Number(match[1].replace(",", ".")));
  if (!found.length) return schedule.includes(FREE_WORD) ? "free" : null;
  // Prices come in threes: full, half, Credencial Plena.
  const trios = [];
  for (let index = 0; index < found.length; index += 3) trios.push(found.slice(index, index + 3));
  const lowest = trios.reduce((best, trio) => (trio[0] < best[0] ? trio : best));
  return {
    full: lowest[0],
    half: lowest[1] ?? 0,
    member: lowest[2] ?? 0,
    varies: new Set(trios.map((trio) => trio[0])).size > 1,
  };
}

/** Return a schedule without its prices. */
export function scheduleText(schedule) {
  return cleanText(schedule.split(/R\$|GRÁTIS/, 1)[0]);
}

/**
 * Return a drop for each ticketed play whose sale is still to come.
 *
 * `moment` and `today` are São Paulo time, and `end` is the last day of the window.
 */
export function buildEstimates({ entries, edition, bookletUrl, moment, today, end }) {
  const drops = [];
  let seriesUnit = null;
  let seriesPrice = null;
  for (const entry of entries) {
    const premiere = firstDate(entry.schedule, edition);
    const isRunning = entry.schedule.startsWith("Até");
    let price = parsePrice(entry.schedule);
    const unitKey = normalize(entry.unit);
    if (entry.isMain) {
      // A main title with no dates heads a series, whose plays share its price.
      const isSeries = premiere === null && !isRunning;
      seriesPrice = isSeries ? price : null;
      seriesUnit = isSeries ? unitKey : null;
    } else if (price === null && unitKey === seriesUnit) {
      price = seriesPrice;
    }

    if (premiere === null || price === "free" || premiere < today || premiere > end) continue;
    const sale = ruleSaleDay(premiere);
    if (`${sale}T${SALE_TIME}` <= moment) continue;
    // The booklet command reports units missing from the fixed list.
    const unit = UNITS_BY_NAME.get(unitKey);
    if (!unit) continue;
    drops.push({
      id: `booklet-${unit.slug}-${normalize(entry.title).replaceAll(" ", "-")}`,
      title: entry.title,
      url: `${bookletUrl}#page=${entry.page}`,
      confirm_url: SEARCH_URL + encodeURIComponent(entry.title),
      unit: unit.name,
      unit_slug: unit.slug,
      region: unit.region,
      online_sale_start: `${sale}T${SALE_TIME}`,
      price_full: price?.full ?? null,
      price_half: price?.half ?? null,
      price_member: price?.member ?? null,
      price_varies: price?.varies ?? false,
      schedule: scheduleText(entry.schedule),
    });
  }
  return drops;
}
