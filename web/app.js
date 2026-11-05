// The page: everything the visitor sees. Text from the API only reaches the page as text nodes.

import { loadPlays } from "./load.js";
import { readPdfWords } from "./pdf-words.js";
import { SITE_URL } from "./plays.js";
import { REGIONS } from "./regions.js";
import { SescClient } from "./sesc.js";
import { createStore } from "./store.js";

let data = { generated_at: null, regions: REGIONS, units: [], drops: [] };
let status = { phase: "loading", done: 0, total: 0, failed: 0, problem: null, updatedAt: null };

const TIME_ZONE = "America/Sao_Paulo";
const PROGRAMME_URL = `${SITE_URL}/programacao/?tipos=shows-espetaculos-e-performances&linguagens=teatro`;
const RENDER_EVERY_MS = 250;
const REGION_PREFIX = "region:";
const DEFAULT_CHOICE = `${REGION_PREFIX}capital`;
const UNIT_INDENT = "   ";
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const loadedAt = Date.now();

const $ = (id) => document.getElementById(id);
const fold = (text) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const number = (value) => value.toLocaleString("pt-BR");
const plural = (count, one, many) => `${number(count)} ${count === 1 ? one : many}`;

// All API dates are São Paulo local times without an offset.
const toInstant = (text) => new Date(text.length === 10 ? `${text}T00:00:00-03:00` : `${text}:00-03:00`);
const todayInSaoPaulo = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5);

function shortDate(day) {
  const [, month, date] = day.split("-").map(Number);
  return `${date} ${MONTHS[month - 1]}`;
}

function clock(moment) {
  const [hours, minutes] = moment.slice(11, 16).split(":");
  return minutes === "00" ? `${Number(hours)}h` : `${Number(hours)}h${minutes}`;
}

function longDate(moment) {
  const text = new Intl.DateTimeFormat("pt-BR", {
    timeZone: TIME_ZONE, weekday: "long", day: "numeric", month: "long",
  }).format(toInstant(moment));
  return capitalize(text.replace("-feira", ""));
}

function saleMoment(moment) {
  const days = daysBetween(todayInSaoPaulo(), moment.slice(0, 10));
  const day = days === 0 ? "Hoje" : days === 1 ? "Amanhã" : longDate(moment);
  return `${day}, ${clock(moment)}`;
}

function timeUntil(moment) {
  const minutes = Math.ceil((toInstant(moment) - Date.now()) / 6e4);
  if (minutes <= 0) return "venda aberta";
  if (minutes < 60) return `daqui a ${plural(minutes, "minuto", "minutos")}`;
  if (minutes < 24 * 60) return `daqui a ${plural(Math.round(minutes / 60), "hora", "horas")}`;
  return `daqui a ${plural(daysBetween(todayInSaoPaulo(), moment.slice(0, 10)), "dia", "dias")}`;
}

function datesText(days, seasonEnd) {
  const last = days[days.length - 1];
  let text;
  if (days.length <= 4) {
    const sameMonth = days.every((day) => day.slice(0, 7) === days[0].slice(0, 7));
    const parts = days.map((day) => (sameMonth ? String(Number(day.slice(8))) : shortDate(day)));
    text = new Intl.ListFormat("pt-BR", { type: "conjunction" }).format(parts);
    if (sameMonth) text += ` ${MONTHS[Number(days[0].slice(5, 7)) - 1]}`;
  } else {
    const sameMonth = days[0].slice(0, 7) === last.slice(0, 7);
    const from = sameMonth ? String(Number(days[0].slice(8))) : shortDate(days[0]);
    text = `${from} a ${shortDate(last)} · ${days.length} datas`;
  }
  if (seasonEnd && seasonEnd > last) text += ` · temporada até ${shortDate(seasonEnd)}`;
  return text;
}

function priceText(drop) {
  if (drop.price_full === null) return null;
  if (!drop.price_full) return "Grátis";
  const money = (value) => new Intl.NumberFormat("pt-BR", {
    style: "currency", currency: "BRL", minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2,
  }).format(value);
  const prefix = drop.price_varies ? "A partir de " : "";
  return `${prefix}${money(drop.price_full)} · meia ${money(drop.price_half)} · credencial ${money(drop.price_member)}`;
}

// Only sales still to open are listed. One that opens while the page is open
// stays until the next reload, with a buy button, so someone waiting for it
// doesn't lose the link at the moment they need it.
function buildViews() {
  const now = Date.now();
  const today = todayInSaoPaulo();
  const views = [];
  for (const drop of data.drops) {
    const opensAt = toInstant(drop.online_sale_start);
    if (opensAt <= loadedAt) continue;
    const days = drop.dates.filter((day) => day >= today);
    if (!days.length) continue;
    const sessions = drop.sessions.filter((session) => session.start.slice(0, 10) >= today);
    const counted = new Set(sessions.map((session) => session.start.slice(0, 10)));
    views.push({
      drop,
      days,
      isOpen: opensAt <= now,
      onlineLeft: sessions.reduce((sum, session) => sum + session.online_left, 0),
      inPersonLeft: sessions.reduce((sum, session) => sum + session.in_person_left, 0),
      isPartial: days.some((day) => !counted.has(day)),
    });
  }
  return views;
}

function matchesFilters(view, query, choice) {
  const { title, subtitle, unit, unit_slug: unitSlug, region } = view.drop;
  if (choice.startsWith(REGION_PREFIX)) {
    if (region !== choice.slice(REGION_PREFIX.length)) return false;
  } else if (choice && unitSlug !== choice) {
    return false;
  }
  if (!query) return true;
  // Match the start of a word, so "cao" finds "Cão" but not "coração".
  return ` ${fold(`${title} ${subtitle} ${unit}`)}`.includes(` ${query}`);
}

function el(tag, attributes, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes || {})) node.setAttribute(name, value);
  // Text from the API only ever reaches the page as text nodes.
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== ""));
  return node;
}

function stock(view) {
  const { isOpen, onlineLeft, inPersonLeft, isPartial } = view;
  if (isOpen) return { text: "Venda on-line aberta", isWarning: false };
  const atVenue = inPersonLeft ? ` · ${number(inPersonLeft)} na bilheteria` : "";
  if (!onlineLeft) return { text: `Sem ingressos on-line listados${atVenue}`, isWarning: true };
  const count = isPartial ? `pelo menos ${number(onlineLeft)}` : number(onlineLeft);
  return { text: `${count} on-line${atVenue}`, isWarning: false };
}

function saleLines(view) {
  const { drop } = view;
  if (drop.estimated) {
    const moment = drop.online_sale_start;
    return [el("p", { class: "play-stock is-warning" },
      `Previsão: ${shortDate(moment.slice(0, 10))}, ${clock(moment)} · Obtido no livreto, sujeito a mudanças. `,
      el("a", { href: drop.confirm_url, target: "_blank", rel: "noopener" }, "Confirme no Sesc"))];
  }
  const { text, isWarning } = stock(view);
  const inPerson = drop.in_person_sale_start;
  return [
    el("p", { class: isWarning ? "play-stock is-warning" : "play-stock" }, text),
    inPerson && toInstant(inPerson) > Date.now()
      ? el("p", { class: "play-stock" }, `Bilheteria a partir de ${shortDate(inPerson.slice(0, 10))}, ${clock(inPerson)}`)
      : null,
  ];
}

function actionLink(view) {
  const { drop, isOpen, onlineLeft } = view;
  if (drop.estimated) {
    return el("a", { class: "play-action", href: drop.url, target: "_blank", rel: "noopener" }, "Ver no livreto");
  }
  if (isOpen && onlineLeft > 0 && drop.buy_url) {
    return el("a", { class: "play-action is-primary", href: drop.buy_url, target: "_blank", rel: "noopener" }, drop.price_full ? "Comprar no Sesc" : "Retirar no Sesc");
  }
  return el("a", { class: "play-action", href: drop.url, target: "_blank", rel: "noopener" }, "Ver no Sesc");
}

function playRow(view) {
  const { drop, days } = view;
  const price = priceText(drop);
  return el("article", { class: "play" },
    el("div", null,
      el("h4", { class: "play-title" }, el("a", { href: drop.url, target: "_blank", rel: "noopener" }, drop.title)),
      drop.subtitle ? el("p", { class: "play-subtitle" }, drop.subtitle) : null,
      el("p", { class: "play-unit" }, drop.unit),
      el("p", { class: "play-dates" }, drop.estimated ? drop.schedule : datesText(days, drop.season_end)),
    ),
    el("div", { class: "play-deal" },
      price ? el("p", { class: "play-price" }, price) : null,
      ...saleLines(view),
      actionLink(view),
    ),
  );
}

function isForecastOnly(views, moment) {
  return views.filter((view) => view.drop.online_sale_start === moment).every((view) => view.drop.estimated);
}

function groupNote(moment, isForecast) {
  if (!isForecast) return timeUntil(moment);
  return toInstant(moment) <= Date.now() ? "horário previsto já passou" : `${timeUntil(moment)} · previsão`;
}

function renderNext(views) {
  const [label, moment, detail] = nextOpeningText(views.filter((view) => !view.isOpen));
  const next = $("next");
  const text = `${label}|${moment}|${detail}`;
  // This area is announced by screen readers, so only touch it when it changes.
  if (next.dataset.text === text) return;
  next.dataset.text = text;
  next.replaceChildren(
    el("p", { class: "ticket-label" }, label),
    el("p", { class: "ticket-moment" }, moment),
    el("p", { class: "ticket-detail" }, detail),
  );
}

function nextOpeningText(upcoming) {
  if (!upcoming.length) {
    if (status.phase === "loading") return ["Próxima abertura", "Procurando…", "Consultando o site do Sesc."];
    if (status.problem && !data.drops.length) return ["Próxima abertura", "Sem dados agora", "Não foi possível consultar o site do Sesc."];
    return ["Próxima abertura", "Nenhuma prevista", "Novas peças costumam entrar na lista perto da abertura."];
  }
  const moment = upcoming.map((view) => view.drop.online_sale_start).sort()[0];
  const count = upcoming.filter((view) => view.drop.online_sale_start === moment).length;
  return [
    isForecastOnly(upcoming, moment) ? "Próxima abertura (previsão)" : "Próxima abertura",
    saleMoment(moment),
    `${timeUntil(moment)} · ${plural(count, "peça", "peças")}`,
  ];
}

function emptyMessage(query, choice) {
  if (status.phase === "loading") return "Procurando peças no site do Sesc…";
  if (status.problem && !data.drops.length) return "Nenhuma peça para mostrar agora.";
  const place = $("unit").selectedOptions[0].textContent.trim();
  if (!choice) return query ? "Nenhuma peça encontrada com essa busca." : "Nenhuma abertura prevista.";
  const found = query ? `Nenhuma peça encontrada em ${place} com essa busca.` : `Nenhuma abertura prevista em ${place}.`;
  return `${found} Experimente outra região.`;
}

function renderResults(views, query, choice) {
  const results = $("results");
  results.replaceChildren();
  if (!views.length) {
    results.append(el("p", { class: "empty" }, emptyMessage(query, choice)));
    return;
  }
  const waiting = views.filter((view) => !view.isOpen).length;
  results.append(el("h2", { class: "section-title" }, `Abrem em breve (${number(waiting)})`));
  const moments = [...new Set(views.map((view) => view.drop.online_sale_start))].sort();
  for (const moment of moments) {
    const isForecast = isForecastOnly(views, moment);
    results.append(el("h3", { class: "group-title" },
      saleMoment(moment),
      el("span", { class: "group-when", "data-moment": moment, "data-forecast": isForecast ? "yes" : "no" }, groupNote(moment, isForecast))));
    for (const view of views) {
      if (view.drop.online_sale_start === moment) results.append(playRow(view));
    }
  }
}

function dateTimeText(moment) {
  const date = new Date(moment);
  const time = new Intl.DateTimeFormat("pt-BR", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit" }).format(date);
  const day = new Intl.DateTimeFormat("pt-BR", { timeZone: TIME_ZONE, day: "numeric", month: "long" }).format(date);
  return `${day}, ${time}`;
}

function filteredViews() {
  const query = fold($("search").value);
  const choice = $("unit").value;
  return { query, choice, views: buildViews().filter((view) => matchesFilters(view, query, choice)) };
}

let openCount = 0;
let renderTimer = null;
let lastRender = 0;
let choicesSignature = null;

function render() {
  lastRender = Date.now();
  openCount = buildViews().filter((view) => view.isOpen).length;
  const { query, choice, views } = filteredViews();
  renderNext(views);
  renderResults(views, query, choice);
  renderStatus();
}

function progressText() {
  const { phase, done, total, readingBooklet } = status;
  if (phase !== "loading") return "";
  if (readingBooklet) return "Lendo o livreto Em Cartaz…";
  return total ? `Verificando peças no site do Sesc: ${number(done)} de ${number(total)}` : "Buscando a lista de peças no site do Sesc…";
}

function renderStatus() {
  const { problem, failed, updatedAt, bookletProblem } = status;
  $("progress").textContent = progressText();
  $("updated").textContent = updatedAt ? `Atualizado em ${dateTimeText(updatedAt)}.` : "";

  const programme = el("a", { href: PROGRAMME_URL, target: "_blank", rel: "noopener" }, "programação do Sesc");
  let message = null;
  if (problem === "offline") {
    message = updatedAt
      ? [`Não foi possível atualizar agora. Dados de ${dateTimeText(updatedAt)}. Confirme na `, programme, "."]
      : ["Não foi possível consultar o site do Sesc agora. Tente de novo mais tarde ou veja a ", programme, "."];
  } else if (problem === "partial") {
    message = [`${plural(failed, "peça não pôde ser verificada", "peças não puderam ser verificadas")} agora, então a lista pode estar incompleta. Tente recarregar mais tarde.`];
  } else if (bookletProblem) {
    message = ["Não foi possível ler o livreto Em Cartaz agora, então pode haver menos previsões. Tente recarregar mais tarde."];
  }
  $("problem").hidden = !message;
  $("problem").replaceChildren(...(message ?? []));
}

function update(dataset, nextStatus) {
  data = dataset;
  status = nextStatus;
  fillChoices();
  // At most one redraw per interval, however quickly updates arrive. The first
  // one is immediate, so saved plays appear straight away.
  const wait = status.phase === "done" ? 0 : lastRender + RENDER_EVERY_MS - Date.now();
  if (wait <= 0) {
    clearTimeout(renderTimer);
    renderTimer = null;
    render();
  } else {
    renderTimer ??= setTimeout(() => {
      renderTimer = null;
      render();
    }, wait);
  }
}

// The list of units only changes when a new listing arrives, so the choice is kept.
function fillChoices() {
  const signature = JSON.stringify(data.units);
  if (signature === choicesSignature) return;
  const select = $("unit");
  const chosen = choicesSignature === null ? DEFAULT_CHOICE : select.value;
  choicesSignature = signature;
  select.replaceChildren(el("option", { value: "" }, "Todas as regiões"));
  for (const [region, label] of Object.entries(data.regions)) {
    select.append(el("option", { value: `${REGION_PREFIX}${region}`, class: "is-region" }, label));
    const members = data.units
      .filter((unit) => unit.region === region)
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    for (const unit of members) select.append(el("option", { value: unit.slug }, `${UNIT_INDENT}${unit.name}`));
  }
  select.value = chosen;
  if (select.value !== chosen) select.value = DEFAULT_CHOICE;
}

fillChoices();
$("filters").addEventListener("submit", (event) => event.preventDefault());
$("search").addEventListener("input", render);
$("unit").addEventListener("change", render);

// The first update arrives right away, with any saved plays, and draws the page.
loadPlays({ client: new SescClient(), store: createStore(), readPdf: readPdfWords, onUpdate: update }).catch((error) => {
  console.error(error);
  update(data, { phase: "done", done: 0, total: 0, failed: 0, problem: "offline", updatedAt: data.generated_at });
});

// Keep the countdowns current, and offer the buy button as soon as a sale opens.
setInterval(() => {
  if (buildViews().filter((view) => view.isOpen).length !== openCount) {
    render();
    return;
  }
  renderNext(filteredViews().views);
  for (const label of document.querySelectorAll("[data-moment]")) {
    label.textContent = groupNote(label.dataset.moment, label.dataset.forecast === "yes");
  }
}, 30000);
