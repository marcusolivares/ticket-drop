# Ticket Drop

A static page in Portuguese, "Quando abre a estreia?", that shows when tickets for Sesc São Paulo plays go on sale. Each visitor's browser fetches the data from Sesc's undocumented API. It's live at https://marcusolivares.github.io/ticket-drop/.

Read `README.md` for how it works, and `docs/sesc-api.md` before changing anything that talks to Sesc.

## Commands

- `node --test`: the unit tests, with nothing to install. Run them before every commit.
- `python tests/browser/run.py`: the real page in headless Chrome against a mock of the API. Run it after changing anything in `web/`.
  - `--large-booklets` also reads the real 16 and 22 MB editions.
  - `--screenshots DIR` saves desktop and phone images. Look at them after visual changes.
- `python -m http.server --directory web`: serves the page locally. It calls the real API.

## Rules

- **A push to `master` goes live.** Every push deploys through Actions, so commit and push only when asked.
- **Commits are atomic and follow Conventional Commits,** and each one passes the tests on a clean copy.
- **There's no build step and there are no runtime dependencies.** `web/` is plain ES modules, and `web/vendor/pdfjs/` is an unmodified copy of `pdf.js`.
- **The page's text is in Brazilian Portuguese.** Code, comments and docs are in English.
- **API text only reaches the page as text nodes,** through `el()` in `web/app.js`. Keep the Content-Security-Policy in `web/index.html` as tight as it is.
- **The project only reads public data.** Never automate buying tickets, or call Sesc's write, seat-holding or order routes.
- **Don't work around Sesc's blocks.** That means no disguised requests, proxies or hopping between hosts. Keep the pacing and the stop after repeated failures in `web/sesc.js`. If Sesc refuses, the page says so.

## What's caught this project out

- **Nothing automated can reach the real API from a browser.** Sesc refuses GitHub's servers and headless Chrome, so a check against it needs the maintainer. Ask them to open the live page and paste any console errors.
- **The mock can hide real behaviour.** A size check passed every test but failed for every real visitor, because Sesc sends compressed PDFs to clients that accept them, with no `Content-Length`. When something depends on response headers, also check the real ones with `curl`, sending the headers a browser sends (`Accept-Encoding`, `Origin`).
- **Sesc's data has surprises.** Listings can have null rows or rows with no unit, and a play's sessions can open at different times. Only the premiere counts. `docs/sesc-api.md` has the details.
- **Visitors' results are saved in `localStorage`** under `quando-abre:v1:`. If the saved shape changes, change the version in `web/store.js`.
- **The list of units in `web/regions.js` is fixed,** so a new Sesc unit has to be added by hand.
