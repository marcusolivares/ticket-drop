// Runs in the page before the app, and reports what the page ends up showing.
// run.py fills in __API__ and __CLOCK_OFFSET__.

// The recorded responses are from one day, so the page has to think it's that day.
const RealDate = Date;
const CLOCK_OFFSET = __CLOCK_OFFSET__;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(RealDate.now() + CLOCK_OFFSET);
  }

  static now() {
    return RealDate.now() + CLOCK_OFFSET;
  }
};

const API = "__API__";
const PREFIX = "quando-abre:v1:";
const MINUTE_MS = 60 * 1000;
const params = new URLSearchParams(location.search);
const violations = [];
const errors = [];
document.addEventListener("securitypolicyviolation", (event) => violations.push(`${event.violatedDirective} ${event.blockedURI}`));
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));

// Each visit has a new Chrome profile, because Chrome can exit before it has written
// localStorage. So saved results travel through the mock instead.
const saved = new XMLHttpRequest();
saved.open("GET", `${API}/__storage`, false);
saved.send();
for (const [key, value] of Object.entries(JSON.parse(saved.responseText))) localStorage.setItem(key, value);

for (const name of (params.get("age") ?? "").split(",").filter(Boolean)) {
  const entry = JSON.parse(localStorage.getItem(PREFIX + name));
  if (name === "listing") entry.savedAt -= 11 * MINUTE_MS;
  if (name === "plays") for (const play of Object.values(entry.entries)) play.savedAt -= 181 * MINUTE_MS;
  localStorage.setItem(PREFIX + name, JSON.stringify(entry));
}

const text = (selector) => document.querySelector(selector)?.textContent ?? null;
const cards = () => [...document.querySelectorAll(".play")];

const cardCounts = [];
const countCards = setInterval(() => cardCounts.push(cards().length), 50);

/** Try the search and region filter, then put them back. */
function interact(report) {
  const search = document.getElementById("search");
  const unit = document.getElementById("unit");
  const cardsFor = (control, value) => {
    control.value = value;
    control.dispatchEvent(new Event(control === search ? "input" : "change"));
    return cards();
  };
  report.search = cardsFor(search, "farinha").map((card) => card.querySelector(".play-title").textContent);
  cardsFor(search, "");
  report.interior = cardsFor(unit, "region:interior").length;
  report.coast = cardsFor(unit, "region:litoral").length;
  report.all = cardsFor(unit, "").length;
  report.unitChoices = [...unit.options].filter((option) => option.value && !option.value.startsWith("region:")).length;
  report.santana = [cardsFor(unit, "santana").length, text(".empty")];
  cardsFor(unit, "region:capital");
}

function finish() {
  clearInterval(countCards);
  const report = {
    title: text("h1"),
    background: getComputedStyle(document.body).backgroundColor,
    hero: text("#next").replace(/\s+/g, " "),
    choice: document.getElementById("unit").value,
    problem: document.getElementById("problem").hidden ? null : text("#problem"),
    empty: text(".empty"),
    cards: cards().length,
    farinha: cards().find((card) => card.textContent.includes("Farinha"))?.innerText.replace(/\s+/g, " ") ?? "",
    progressButton: Boolean(document.querySelector("#progress button")),
    cardCounts,
    violations,
    errors,
  };
  if (params.get("interact")) interact(report);
  report.forecasts = cards()
    .filter((card) => card.textContent.includes("Previsão"))
    .map((card) => ({
      title: card.querySelector(".play-title").textContent,
      unit: card.querySelector(".play-unit").textContent,
      sale: [...card.querySelectorAll(".play-stock")].map((line) => line.textContent).join(" "),
    }));

  const output = document.createElement("pre");
  output.id = "test-output";
  output.textContent = JSON.stringify(report);
  document.body.append(output);
  // The mock lets the page finish loading once this arrives.
  fetch(`${API}/__storage`, { method: "POST", body: JSON.stringify({ ...localStorage }) });
}

const started = RealDate.now();
const watcher = setInterval(() => {
  const settled = text("#progress") === "" && document.querySelector("#next p") && text("#next p + p") !== "Procurando…";
  if (!settled || RealDate.now() - started <= 300) return;
  clearInterval(watcher);
  finish();
}, 100);
