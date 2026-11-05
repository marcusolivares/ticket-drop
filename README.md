# Ticket Drop

Find out when tickets for Sesc São Paulo plays go on sale.

Tickets for popular plays can sell out quickly, so it helps to know the moment they go on sale. Ticket Drop finds that moment for plays in the next 30 days, based on each play's premiere. It's a static page in Portuguese, called *Quando abre a estreia?*. Each visitor's browser fetches the data directly from Sesc when the page opens, so there's no server and nothing to schedule.

This is an unofficial project with no connection to Sesc. It only shows public information and links to Sesc's own site. It doesn't buy tickets, and it should stay that way.

## Branches

| Branch | Contents |
|---|---|
| `browser` | This version, which is the live site. |
| `master` | The earlier Python version, which also has calendar feeds. It works from a home connection, but Sesc refuses GitHub's servers, so it can't publish itself. |

## Run it locally

```
python -m http.server --directory web
```

Then open http://localhost:8000. Any static server works, but opening `index.html` directly doesn't, because browsers won't load JavaScript modules from a file.

Run the tests with Node 20 or newer. There's nothing to install:

```
node --test
```

## How it works

1. **List** theatre activities with a session in the next 30 days.
2. **Skip** plays that must already be on sale, using the date rule below. This cuts about a third of the requests.
3. **Fetch details** for the rest, which include sale times and prices. Cards appear as they arrive.
4. **Keep** each play's premiere sale, if it hasn't opened yet.
5. **Add forecasts** from the latest *Em Cartaz* booklet, for plays the API doesn't list yet.

A sale that opens while the page is open stays until the next reload and gains a buy button, so someone waiting for it doesn't lose the link.

### The sale rule

The booklets print the rule: sales open online on the Tuesday of the week before the premiere, at 17:00. A few open later than that, by at most 8 days in the data checked, so a play is only skipped once that margin has passed.

### Being gentle on Sesc

This code runs in every visitor's browser, so traffic grows with visitors. To keep it small:

- At most 3 requests run at once, at least 150 ms apart. A first visit makes about 50 requests and takes about 7 seconds.
- Results are saved on the device, so a returning visitor mostly makes one listing request.
- Temporary failures are retried with a pause. **After 3 failures in a row, all requests stop.** A blocked response can reach the browser as a plain network error, so counting failures is the only reliable signal.
- Nothing disguises these requests: browsers send the page's address with each one.

That suits a group of friends, but not wide sharing. If Sesc blocks these requests too, don't work around it.

| Saved on the device | Kept for |
|---|---|
| Listing | 10 minutes |
| Each play's card | 3 hours |
| A play the API didn't have | 30 minutes |
| Which booklet is the latest | 12 hours |
| The booklet's parsed entries | Until a new edition appears |

### When something fails

| What fails | What the visitor sees |
|---|---|
| **The list**, with saved data | The saved cards, and a note saying how old they are |
| **The list**, with nothing saved | An error with a link to Sesc's programme |
| **Some plays** | The rest of the cards, any saved cards for those plays, and a note saying how many couldn't be checked |
| **The booklet** | All the API plays, any forecasts saved on the device, and a short note |

### Forecasts from the booklet

The booklet can list plays days or weeks before the API does, so the page shows them early, clearly marked as forecasts. It doesn't print sale dates for each play, so the date is worked out from the rule above.

The API always wins: once it lists a play, the forecast is dropped and the real date is used. In the one comparison so far, 9 of 12 forecasts were right and 3 were a week off, including one that was a week too late, because the booklet's dates differed from the API's. That's why the page tells people to confirm with Sesc.

Forecasts are added last, so they never delay the main list. Booklets have ranged from 3 to 22 MB, so a booklet over 8 MB, or any booklet for a visitor with their browser's data saver on, waits for a button that states its size. Each device reads an edition once. `pdf.js` is only downloaded when a booklet is read.

Only the theatre section of *Em Cartaz* is read. It focuses on the capital, so there are few forecasts for other regions.

## Files

| Path | Contents |
|---|---|
| `web/index.html` | The page's markup and styles, in Portuguese |
| `web/app.js` | Everything the visitor sees and does |
| `web/load.js` | Fetches everything in order, using what's saved |
| `web/sesc.js` | HTTP client: pacing, retries, stopping after failures |
| `web/plays.js` | Turns API responses into cards |
| `web/booklet.js` | Parses the booklet and builds the forecasts |
| `web/pdf-words.js` | Reads a PDF into styled words, using `pdf.js` |
| `web/store.js` | Saves results on the device |
| `web/regions.js` | The fixed list of units and their regions |
| `web/vendor/pdfjs/` | An unmodified copy of [`pdf.js`](https://github.com/mozilla/pdf.js) 6.4.299 (`build/pdf.min.mjs` and `build/pdf.worker.min.mjs`) |
| `docs/sesc-api.md` | **Read this first.** What's known about the undocumented API |
| `.github/workflows/deploy.yml` | Tests and deploys on every push |

The fixed list of units needs updating if Sesc opens a new one. Until then, the new unit's plays appear under "Todas as regiões", but not under a region, and it gets no forecasts.

## Publishing

The included workflow publishes to GitHub Pages. To set it up:

1. Go to **Settings > Pages** and set **Source** to **GitHub Actions**.
2. Push to `master`.

Every push runs the tests and then deploys. The page gets its data when visitors open it, so there's no schedule.

## Limitations

- **The list can be incomplete.** Some plays reach the API only hours before their sale opens, and forecasts mostly cover the capital. The page says so and links to the *Em Cartaz* booklet.
- **Forecast dates can be wrong**, sometimes by a week. See [Forecasts from the booklet](#forecasts-from-the-booklet).
- **Plays leave the list once their sale opens**, even if they haven't premiered yet.
- **Only the premiere's sale is shown.** Sessions that open at a different time are left out, even on the same day, along with their dates and ticket counts. The card still says when the season ends.
- **Free plays with no ticket sale don't appear**, and neither do shows with no sub-category.
- **There are no calendar feeds.** Calendar apps need a file at a fixed address, which this version doesn't produce.
- **The API is undocumented** and could change at any time. If Sesc stops allowing these requests, the page can't update, and visitors only have what's saved on their device.
