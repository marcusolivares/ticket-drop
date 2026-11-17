# Ticket Drop

A static page in Portuguese, "Quando abre a estreia?", that forecasts when tickets for Sesc São Paulo plays go on sale. The forecasts come from Sesc's monthly *Em Cartaz* booklet, which a command on the maintainer's computer reads into `web/booklet.json`. It's live at https://marcusolivares.github.io/ticket-drop/.

Read `README.md` for how it works, and `docs/sesc-api.md` before changing anything that talks to Sesc.

## Commands

- `node --test`: the unit tests, with nothing to install. Run them before every commit.
- `node tools/update-booklet.js`: saves the latest booklet's entries in `web/booklet.json`. It downloads from Sesc, so run it only when asked or when checking for a new edition.
- `python tests/browser/run.py`: the real page in headless Chrome, with a fixed copy of the November 2026 booklet. Run it after changing anything in `web/`.
  - `--screenshots DIR` saves desktop and phone images. Look at them after visual changes.
- `python -m http.server --directory web`: serves the page locally, with the current `web/booklet.json`.

## Rules

- **A push to `master` goes live.** Every push deploys through Actions, so commit and push only when asked.
- **Commits are atomic and follow Conventional Commits,** and each one passes the tests on a clean copy.
- **There's no build step and there are no runtime dependencies.** `web/` is plain ES modules. `tools/vendor/pdfjs/` is an unmodified copy of `pdf.js`.
- **The page's text is in Brazilian Portuguese.** Code, comments and docs are in English.
- **Text from Sesc only reaches the page as text nodes,** through `el()` in `web/app.js`. Keep the Content-Security-Policy in `web/index.html` as tight as it is.
- **The project only reads public data.** Never automate buying tickets, or call Sesc's write, seat-holding or order routes.
- **Visitors' browsers ask Sesc for nothing.** Only the booklet command does, from the maintainer's computer, with an honest User-Agent.
- **Don't work around Sesc's blocks.** That means no disguised requests, proxies or hopping between hosts, and no copying what Sesc's own pages send. If Sesc refuses, the command fails and says so.

## What's caught this project out

- **Sesc refuses this project almost everywhere.** Since 2026-11-06, its activity routes refuse every client but its own pages. Since 2026-11-17, its booklet routes send no CORS headers. A script on the maintainer's computer can still read the booklet. Nothing automated here can check the live site, so ask the maintainer.
- **Check real response headers, and send what a browser sends.** A `curl` without `Origin` showed the booklet route answering `200`, but browsers couldn't read it, because it had stopped sending `Access-Control-Allow-Origin`. Earlier, a size check passed every test but failed for real visitors, because Sesc compresses PDFs and then sends no `Content-Length`. Use `curl` with `Origin` and `Accept-Encoding`.
- **Sesc's data has surprises.** The booklet's printed dates can differ from the API's, captions look like titles, and sidebars can break sections. `docs/sesc-api.md` has the details.
- **`pdf.js` has two builds.** `tools/vendor/pdfjs/` holds the `legacy` one, which `pdf.js` recommends for Node, so keep using it when updating it.
- **The list of units in `web/regions.js` is fixed,** so a new Sesc unit has to be added by hand. The booklet command names units that are missing.
