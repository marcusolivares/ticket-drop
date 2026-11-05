// Turn raw API responses into the sale openings ("drops") the page displays.

export const SITE_URL = "https://www.sescsp.org.br";
export const BUY_HOST = "centralrelacionamento.sescsp.org.br";
export const FREE_LABEL = "Atividade gratuita";

// Sales that opened later than the printed rule have been at most this late,
// for example shows that go on sale on the day itself.
export const RULE_MARGIN_DAYS = 8;

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

export function isTicketed(item) {
  return item.gratuito !== FREE_LABEL && !item.cancelado;
}

const lastSegment = (link) => link.replace(/\/+$/, "").split("/").pop();

export function slugOf(item) {
  return lastSegment(item.link);
}

export function unitSlugOf(item) {
  const link = item.unidade?.[0]?.link;
  return link ? lastSegment(link) : null;
}

// The Tuesday of the week before the premiere, as the booklets print it.
export function ruleSaleDay(premiere) {
  const mondayBased = (new Date(`${premiere}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(premiere, -mondayBased - 6);
}

// Whether a play's premiere sale could still be ahead. Plays that must already
// be on sale are skipped, to make fewer requests to Sesc.
export function mightStillOpen(item, today) {
  const premiere = item.dataPrimeiraSessao?.slice(0, 10);
  return !premiere || today <= addDays(ruleSaleDay(premiere), RULE_MARGIN_DAYS);
}

function buyUrl(session) {
  const url = decodeEntities(session.urlCompra || "");
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && hostname === BUY_HOST ? url : null;
  } catch {
    return null;
  }
}

function activityUrl(link) {
  // Without this, a link such as "@example.com" would point at another site.
  if (typeof link !== "string" || !link.startsWith("/")) throw new TypeError(`unexpected activity link: ${link}`);
  return SITE_URL + link;
}

function required(record, field) {
  if (!(field in record)) throw new TypeError(`missing field: ${field}`);
  return record[field];
}

const sessionDay = (session) => required(session, "dataInicialSessaoFmt").slice(0, 10);

/**
 * Build the record for an activity's premiere sale, or null if there's nothing to show.
 *
 * The first session sets the opening. Sessions that open at another time, whether
 * later that day or in a later week, are left out.
 */
export function buildDrop(item, detail, regions, start, end) {
  const scheduled = (detail.sessoes ?? [])
    .map((session) => [required(session, "dataInicialSessaoFmt"), session])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, session]) => session);
  if (!scheduled.length) return null;

  const onlineStart = required(scheduled[0], "dataInicialVendaOnlineFmt");
  const inWindow = (day) => start <= day && day <= end;
  const sessions = scheduled.filter(
    (session) => session.dataInicialVendaOnlineFmt === onlineStart && inWindow(sessionDay(session)),
  );
  if (!onlineStart || !sessions.length) return null;

  const dates = new Set(sessions.map(sessionDay));
  // The detail endpoint stops at 20 sessions. The listing still has every date,
  // so dates past the cap are added, without ticket counts.
  if (String(detail.possuiMais20Sessoes).toLowerCase() === "true") {
    const known = new Set(scheduled.map(sessionDay));
    for (const day of item.datasSessoes ?? []) {
      if (inWindow(day) && !known.has(day)) dates.add(day);
    }
  }

  const unit = item.unidade[0];
  const unitSlug = lastSegment(unit.link);
  const inPerson = sessions.map((session) => session.dataInicialVendaRedeFmt).filter(Boolean).sort();
  const fullPrices = sessions.map((session) => session.valorInteira || 0);
  const lowest = Math.min(...fullPrices);
  const cheapest = sessions[fullPrices.indexOf(lowest)];
  return {
    id: `${item.id}-${onlineStart}`,
    title: cleanText(item.titulo),
    subtitle: cleanText(item.complemento),
    url: activityUrl(item.link),
    buy_url: sessions.map(buyUrl).find(Boolean) ?? null,
    unit: cleanText(unit.name),
    unit_slug: unitSlug,
    region: regions[unitSlug] ?? "",
    online_sale_start: onlineStart,
    in_person_sale_start: inPerson[0] ?? null,
    price_full: lowest,
    price_half: cheapest.valorMeia || 0,
    price_member: cheapest.valorComerciario || 0,
    price_varies: new Set(fullPrices).size > 1,
    dates: [...dates].sort(),
    season_end: (item.dataUltimaSessao || "").slice(0, 10) || null,
    sessions: sessions.map((session) => ({
      start: session.dataInicialSessaoFmt,
      online_left: Number.parseInt(session.qtdeIngressosWeb, 10) || 0,
      in_person_left: Number.parseInt(session.qtdeIngressosRede, 10) || 0,
    })),
  };
}
