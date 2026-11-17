// Runs in the page before the app, and reports what the page ends up showing.
// run.py fills in __CURRENT__.

// The test's booklet is the November 2026 edition, so the page has to think it's
// November, or the moment given by `?at=`.
const RealDate = Date;
const params = new URLSearchParams(location.search);
const CLOCK_OFFSET = RealDate.parse(params.get("at") ?? "__CURRENT__") - RealDate.now();
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(RealDate.now() + CLOCK_OFFSET);
  }

  static now() {
    return RealDate.now() + CLOCK_OFFSET;
  }
};

const violations = [];
const errors = [];
document.addEventListener("securitypolicyviolation", (event) => violations.push(`${event.violatedDirective} ${event.blockedURI}`));
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));

const text = (selector) => document.querySelector(selector)?.textContent ?? null;
const cards = () => [...document.querySelectorAll(".play")];

/** Try the search and region filter, then put them back. */
function interact(report) {
  const search = document.getElementById("search");
  const unit = document.getElementById("unit");
  const cardsFor = (control, value) => {
    control.value = value;
    control.dispatchEvent(new Event(control === search ? "input" : "change"));
    return cards();
  };
  report.search = cardsFor(search, "lorca").map((card) => card.querySelector(".play-title").textContent);
  cardsFor(search, "");
  report.interior = cardsFor(unit, "region:interior").length;
  report.coast = cardsFor(unit, "region:litoral").length;
  report.all = cardsFor(unit, "").length;
  report.unitChoices = [...unit.options].filter((option) => option.value && !option.value.startsWith("region:")).length;
  report.santana = [cardsFor(unit, "santana").length, text(".empty")];
  cardsFor(unit, "region:capital");
}

function finish() {
  const report = {
    title: text("h1"),
    background: getComputedStyle(document.body).backgroundColor,
    hero: text("#next").replace(/\s+/g, " "),
    choice: document.getElementById("unit").value,
    problem: document.getElementById("problem").hidden ? null : text("#problem"),
    empty: text(".empty"),
    updated: text("#updated"),
    cards: cards().length,
    origins: [...new Set(performance.getEntriesByType("resource").map((entry) => new URL(entry.name).origin))],
    violations,
    errors,
  };
  if (params.get("interact")) interact(report);
  report.forecasts = cards().map((card) => ({
    title: card.querySelector(".play-title").textContent,
    unit: card.querySelector(".play-unit").textContent,
    sale: card.querySelector(".play-stock").textContent,
  }));

  const output = document.createElement("pre");
  output.id = "test-output";
  output.textContent = JSON.stringify(report);
  document.body.append(output);
  // The server lets the page finish loading once this arrives.
  fetch("__done", { method: "POST" });
}

const started = RealDate.now();
const watcher = setInterval(() => {
  const settled = text("#progress") === "" && document.querySelector("#next p") && text("#next p + p") !== "Procurando…";
  if (!settled || RealDate.now() - started <= 300) return;
  clearInterval(watcher);
  finish();
}, 100);
