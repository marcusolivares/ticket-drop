// The page: everything the visitor sees. Text from Sesc only reaches the page as text nodes.

import { forecastsFrom, isOutdated, loadBooklet } from "./load.js";
import { SITE_URL } from "./plays.js";
import { REGIONS, UNITS } from "./regions.js";

let drops = [];
let edition = null;
// "loading", "done" or "failed".
let status = "loading";

const TIME_ZONE = "America/Sao_Paulo";
const PROGRAMME_URL = `${SITE_URL}/programacao/?tipos=shows-espetaculos-e-performances&linguagens=teatro`;
const REGION_PREFIX = "region:";
const DEFAULT_CHOICE = `${REGION_PREFIX}capital`;
const UNIT_INDENT = "   ";
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const NEXT_LABEL = "Próxima abertura (previsão)";

const $ = (id) => document.getElementById(id);
const fold = (text) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const number = (value) => value.toLocaleString("pt-BR");
const plural = (count, one, many) => `${number(count)} ${count === 1 ? one : many}`;

// All dates are São Paulo local times without an offset.
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

function monthName([month, year]) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC", month: "long" }).format(Date.UTC(year, month - 1, 1));
}

function saleMoment(moment) {
  const days = daysBetween(todayInSaoPaulo(), moment.slice(0, 10));
  const day = days === 0 ? "Hoje" : days === 1 ? "Amanhã" : longDate(moment);
  return `${day}, ${clock(moment)}`;
}

function timeUntil(moment) {
  const minutes = Math.ceil((toInstant(moment) - Date.now()) / 6e4);
  if (minutes <= 0) return "horário previsto já passou";
  if (minutes < 60) return `daqui a ${plural(minutes, "minuto", "minutos")}`;
  if (minutes < 24 * 60) return `daqui a ${plural(Math.round(minutes / 60), "hora", "horas")}`;
  return `daqui a ${plural(daysBetween(todayInSaoPaulo(), moment.slice(0, 10)), "dia", "dias")}`;
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

// A sale whose time passes while the page is open stays until the next reload,
// so someone waiting for it doesn't lose the link at the moment they need it.
function buildViews() {
  const now = Date.now();
  return drops.map((drop) => ({ drop, hasPassed: toInstant(drop.online_sale_start) <= now }));
}

function matchesFilters(view, query, choice) {
  const { title, unit, unit_slug: unitSlug, region } = view.drop;
  if (choice.startsWith(REGION_PREFIX)) {
    if (region !== choice.slice(REGION_PREFIX.length)) return false;
  } else if (choice && unitSlug !== choice) {
    return false;
  }
  if (!query) return true;
  // Match the start of a word, so "cao" finds "Cão" but not "coração".
  return ` ${fold(`${title} ${unit}`)}`.includes(` ${query}`);
}

function el(tag, attributes, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes || {})) node.setAttribute(name, value);
  // Text from Sesc only ever reaches the page as text nodes.
  node.append(...children.filter((child) => child !== null && child !== undefined && child !== ""));
  return node;
}

const link = (href, text, attributes = {}) => el("a", { href, target: "_blank", rel: "noopener", ...attributes }, text);

function playRow({ drop }) {
  const price = priceText(drop);
  const moment = drop.online_sale_start;
  return el("article", { class: "play" },
    el("div", null,
      el("h4", { class: "play-title" }, link(drop.url, drop.title)),
      el("p", { class: "play-unit" }, drop.unit),
      el("p", { class: "play-dates" }, drop.schedule),
    ),
    el("div", { class: "play-deal" },
      price ? el("p", { class: "play-price" }, price) : null,
      el("p", { class: "play-stock is-warning" },
        `Previsão: ${shortDate(moment.slice(0, 10))}, ${clock(moment)} · Obtido no livreto, sujeito a mudanças. `,
        link(drop.confirm_url, "Confirme no Sesc")),
      link(drop.url, "Ver no livreto", { class: "play-action" }),
    ),
  );
}

function renderNext(views) {
  const [label, moment, detail] = nextOpeningText(views.filter((view) => !view.hasPassed));
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
    if (status === "loading") return [NEXT_LABEL, "Procurando…", "Lendo as previsões."];
    if (status === "failed") return [NEXT_LABEL, "Sem dados agora", "Não foi possível carregar as previsões."];
    return [NEXT_LABEL, "Nenhuma prevista", "As previsões vêm do livreto Em Cartaz, que sai uma vez por mês."];
  }
  const moment = upcoming.map((view) => view.drop.online_sale_start).sort()[0];
  const count = upcoming.filter((view) => view.drop.online_sale_start === moment).length;
  return [NEXT_LABEL, saleMoment(moment), `${timeUntil(moment)} · ${plural(count, "peça", "peças")}`];
}

function emptyMessage(query, choice) {
  if (status === "loading") return "Procurando peças…";
  if (status === "failed") return "Nenhuma peça para mostrar agora.";
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
  const waiting = views.filter((view) => !view.hasPassed).length;
  results.append(el("h2", { class: "section-title" }, `Abrem em breve (${number(waiting)})`));
  const moments = [...new Set(views.map((view) => view.drop.online_sale_start))].sort();
  for (const moment of moments) {
    results.append(el("h3", { class: "group-title" },
      saleMoment(moment),
      el("span", { class: "group-when", "data-moment": moment }, timeUntil(moment))));
    for (const view of views) {
      if (view.drop.online_sale_start === moment) results.append(playRow(view));
    }
  }
}

function filteredViews() {
  const query = fold($("search").value);
  const choice = $("unit").value;
  return { query, choice, views: buildViews().filter((view) => matchesFilters(view, query, choice)) };
}

let passedCount = 0;

function render() {
  passedCount = buildViews().filter((view) => view.hasPassed).length;
  const { query, choice, views } = filteredViews();
  renderNext(views);
  renderResults(views, query, choice);
  renderStatus();
}

function renderStatus() {
  $("progress").textContent = status === "loading" ? "Carregando as previsões…" : "";
  $("updated").textContent = edition ? `Previsões do livreto Em Cartaz de ${monthName(edition)} de ${edition[1]}.` : "";

  const programme = link(PROGRAMME_URL, "programação do Sesc");
  let message = null;
  if (status === "failed") {
    message = ["Não foi possível carregar as previsões agora. Tente de novo mais tarde ou veja a ", programme, "."];
  } else if (edition && isOutdated(edition)) {
    message = [`Estas previsões são do livreto de ${monthName(edition)}, e o deste mês ainda não foi lido aqui. Confira a `, programme, "."];
  }
  $("problem").hidden = !message;
  $("problem").replaceChildren(...(message ?? []));
}

// Every unit is offered, even with nothing to list, so none seems to be missing.
function fillChoices() {
  const select = $("unit");
  select.replaceChildren(el("option", { value: "" }, "Todas as regiões"));
  for (const [region, label] of Object.entries(REGIONS)) {
    select.append(el("option", { value: `${REGION_PREFIX}${region}`, class: "is-region" }, label));
    const members = Object.entries(UNITS)
      .filter(([, unit]) => unit.region === region)
      .sort(([, a], [, b]) => a.name.localeCompare(b.name, "pt-BR"));
    for (const [slug, unit] of members) select.append(el("option", { value: slug }, `${UNIT_INDENT}${unit.name}`));
  }
  select.value = DEFAULT_CHOICE;
}

fillChoices();
$("filters").addEventListener("submit", (event) => event.preventDefault());
$("search").addEventListener("input", render);
$("unit").addEventListener("change", render);
render();

loadBooklet()
  .then((booklet) => {
    drops = forecastsFrom(booklet);
    edition = booklet.edition;
    status = "done";
  })
  .catch((error) => {
    console.error(error);
    status = "failed";
  })
  .finally(render);

// Keep the countdowns current, and redraw when a predicted time passes.
setInterval(() => {
  if (buildViews().filter((view) => view.hasPassed).length !== passedCount) {
    render();
    return;
  }
  renderNext(filteredViews().views);
  for (const label of document.querySelectorAll("[data-moment]")) label.textContent = timeUntil(label.dataset.moment);
}, 30000);
