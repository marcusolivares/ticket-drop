// What the page and the booklet command share about Sesc's plays: the site,
// São Paulo dates, and the rule for when sales open.

export const SITE_URL = "https://www.sescsp.org.br";

// Brazil abolished daylight saving in 2019, so a fixed offset is enough.
const SAO_PAULO_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
  ["ndash", "–"],
  ["mdash", "—"],
  ["hellip", "…"],
  ["lsquo", "‘"],
  ["rsquo", "’"],
  ["ldquo", "“"],
  ["rdquo", "”"],
]);

export function saoPauloMoment(date) {
  return new Date(date.getTime() - SAO_PAULO_OFFSET_MS).toISOString().slice(0, 16);
}

export function saoPauloDay(date) {
  return saoPauloMoment(date).slice(0, 10);
}

export function addDays(day, count) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);
}

export function decodeEntities(text) {
  return text.replace(/&(#\d+|#[xX][0-9a-fA-F]+|\w+);/g, (whole, body) => {
    if (!body.startsWith("#")) return NAMED_ENTITIES.get(body) ?? whole;
    const isHex = body[1] === "x" || body[1] === "X";
    const code = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

export function cleanText(value) {
  return decodeEntities(value ?? "").replace(/\s+/g, " ").trim();
}

// The Tuesday of the week before the premiere, as the booklets print it.
export function ruleSaleDay(premiere) {
  const mondayBased = (new Date(`${premiere}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(premiere, -mondayBased - 6);
}
