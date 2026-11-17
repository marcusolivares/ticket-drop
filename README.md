# Ticket Drop

Find out when tickets for Sesc São Paulo plays go on sale.

Tickets for popular plays can sell out quickly, so it helps to know the moment they go on sale. Ticket Drop forecasts that moment for plays premiering in the next 30 days. It's a static page in Portuguese, called *Quando abre a estreia?*.

The forecasts come from Sesc's monthly *Em Cartaz* booklet. A command on the maintainer's computer reads the booklet once per edition, and the page is published with what it found. Visitors' browsers ask Sesc for nothing.

This is an unofficial project with no connection to Sesc. It only shows public information and links to Sesc's own site. It doesn't buy tickets, and it should stay that way.

## Earlier versions

- **Up to commit `e477a43`,** this project was a Python script that also produced calendar feeds. Sesc refused GitHub's servers, so it couldn't publish itself.
- **Up to commit `5762a91`,** each visitor's browser read Sesc's API directly, which gave exact sale times, prices and ticket counts. Since 2026-11-06, Sesc refuses that API to everyone but its own site, including the maintainer's computer. Since 2026-11-17, other sites can't read the booklet in a browser either. See `docs/sesc-api.md`.

## Updating the booklet

Sesc publishes a new *Em Cartaz* each month, usually late in the month before. To pick it up:

```
node tools/update-booklet.js
```

It checks Sesc's archive page, and if there's a new edition, downloads it, reads its theatre section and saves the entries in `web/booklet.json`. Otherwise it says the file is already up to date, and downloads nothing. Then commit `web/booklet.json` and push it, which publishes it.

`pdf.js` prints warnings that it can't load `@napi-rs/canvas`. That's only needed to draw pages, not to read their text, so ignore them. `--force` reads the latest edition again, for example after a change to the parser.

If the command names units that aren't in `web/regions.js`, add them there, or their plays won't appear.

If nobody runs it, the page keeps showing the old edition's forecasts until their dates pass. Once the edition's month has ended, the page says the booklet may be out of date.

## Run it locally

```
python -m http.server --directory web
```

Then open http://localhost:8000. Any static server works, but opening `index.html` directly doesn't, because browsers won't load JavaScript modules from a file.

Run the tests with Node 20 or newer. There's nothing to install:

```
node --test
```

There's also a browser test, which needs Python and Chrome. It drives the real page in headless Chrome, with a fixed copy of the November 2026 booklet's entries and the clock moved to that month:

```
python tests/browser/run.py
```

Add `--screenshots DIR` to save how the page looks. It also downloads the real November booklet once, so that `node --test` can check the command still reads it the same way. Without it, that test is skipped.

## How it works

1. **On the maintainer's computer,** `tools/update-booklet.js` finds the latest booklet on Sesc's archive page, reads it with `pdf.js` and saves the theatre section's entries: unit, title, schedule and prices.
2. **In the visitor's browser,** the page loads `booklet.json` from its own site and works out a forecast for each ticketed play premiering in the next 30 days. A sale that has opened leaves the page, without waiting for a new edition.

A forecast whose time passes while the page is open stays until the next reload, so someone waiting for it doesn't lose the link.

### The sale rule

The booklets print the rule: sales open online on the Tuesday of the week before the premiere, at 17:00. Tested against the API on 2026-11-03, 142 of 155 activities opened in the week the rule predicts. A season goes on sale all at once, based on its premiere.

In the one comparison of booklet forecasts with the API, 9 of 12 were right and 3 were a week off, including one that was a week too late, because the booklet's dates differed from the API's. That's why the page tells people to confirm with Sesc.

### When something fails

| What fails | What the visitor sees |
|---|---|
| **`booklet.json` can't be loaded** | An error with a link to Sesc's programme |
| **The booklet is from a month that has ended** | Its forecasts, and a note that this month's booklet hasn't been read yet |
| **The command can't read a new edition** | Nothing changes. The command fails, and `booklet.json` keeps the old edition |

## Files

| Path | Contents |
|---|---|
| `web/index.html` | The page's markup and styles, in Portuguese |
| `web/app.js` | Everything the visitor sees and does |
| `web/load.js` | Loads `booklet.json` and builds the forecasts |
| `web/booklet.js` | Parses the booklet and builds the forecasts. The command uses it too |
| `web/booklet.json` | The latest booklet's entries, saved by the command |
| `web/plays.js` | São Paulo dates and the sale rule |
| `web/regions.js` | The fixed list of units and their regions |
| `tools/update-booklet.js` | The command that saves the latest booklet |
| `tools/pdf-words.js` | Reads a PDF into styled words, using `pdf.js` |
| `tools/vendor/pdfjs/` | An unmodified copy of [`pdf.js`](https://github.com/mozilla/pdf.js) 6.4.299 (`legacy/build/pdf.min.mjs` and `legacy/build/pdf.worker.min.mjs`) |
| `tests/` | Unit tests, run by `node --test` |
| `tests/browser/` | The browser test, with its fixed copy of the November booklet's entries |
| `docs/sesc-api.md` | **Read this first.** What's known about Sesc's site |
| `.github/workflows/deploy.yml` | Tests and deploys on every push |

## Publishing

The included workflow publishes `web/` to GitHub Pages. To set it up:

1. Go to **Settings > Pages** and set **Source** to **GitHub Actions**.
2. Push to `master`.

Every push runs the tests and then deploys.

## Limitations

- **Every date is a forecast**, and can be wrong, sometimes by a week. Sesc no longer lets other sites read exact sale times.
- **The list is incomplete.** *Em Cartaz* mostly covers the capital and Grande SP, and in one check only about half of the API's ticketed plays were in it. The November 2026 edition had no forecasts for the interior or the coast.
- **There are no prices or ticket counts from the API**, only the prices the booklet prints.
- **Plays leave the list once their forecast sale time passes**, even if they haven't premiered yet.
- **Free plays don't appear.**
- **New editions need the maintainer** to run the command and push.
- **There are no calendar feeds.** Calendar apps need a file at a fixed address, which this version doesn't produce.
