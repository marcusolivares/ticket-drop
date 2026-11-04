# Ticket Drop

Find out when tickets for Sesc São Paulo plays go on sale.

Tickets for popular plays can sell out quickly, so it helps to know the moment they go on sale. Ticket Drop finds that moment for plays in the next 30 days, based on each play's premiere. It builds a static page in Portuguese, called *Quando Abre*, and calendar feeds that friends can subscribe to.

This is an unofficial project with no connection to Sesc. It only shows public information and links to Sesc's own site. It doesn't buy tickets, and it should stay that way.

## Quick start

You need Python (tested on 3.14).

```
python -m pip install -r requirements.txt
python -m ticket_drop
```

This takes about a minute and a half, because it waits a second between requests. Then open `site/index.html`.

The only dependency is `pdfplumber`, which reads the booklet. Without it, the build can't add new forecasts.

| Option | Purpose |
|---|---|
| `--days 45` | Look further ahead (default: 30). |
| `--out folder` | Write somewhere other than `site/`. |
| `--input site/plays.json` | Re-render from saved data without calling the API. Useful when working on the page. |
| `--previous <url or file>` | The last published `plays.json`, to keep its forecasts if the booklet can't be read (default: the one in the output folder). |

Run the tests with:

```
python -m unittest discover -s tests
```

## How it works

1. **List** theatre activities with a session in the window.
2. **Fetch details** for each ticketed play, which include sale times and prices.
3. **Keep** each play's premiere sale, if it hasn't opened yet.
4. **Add forecasts** from the latest *Em Cartaz* booklet, for plays the API doesn't list yet.
5. **Write** the site: `index.html` with the data embedded, `plays.json`, and the calendar feeds.

The browser also compares each sale time with the clock, so a sale that has opened since the last build isn't listed. If one opens while the page is open, it stays until the next reload and gains a buy button, so someone waiting for it doesn't lose the link.

If the API data looks wrong, such as too many failures or nothing found, the command exits with an error and writes nothing, so the last good page stays online. If the booklet can't be read, the command logs a warning and keeps the forecasts from the last published page, except those the API now lists or whose sale time has passed. New forecasts wait until the booklet can be read again. On GitHub, the warning also appears on the run's page.

### Forecasts from the booklet

The booklet can list plays days or weeks before the API does, so the page shows them early, clearly marked as forecasts. It doesn't print sale dates for each play, so the date is worked out from the rule it does print: the Tuesday of the week before the premiere, at 17:00.

The API always wins: once it lists a play, the forecast is dropped and the real date is used. In the one comparison so far, 9 of 12 forecasts were right and 3 were a week off, including one that was a week too late, because the booklet's dates differed from the API's. That's why the page tells people to confirm with Sesc.

Only the theatre section of *Em Cartaz* is read. It focuses on the capital, so there are few forecasts for other regions. The unit guides use other layouts and aren't read.

| Path | Contents |
|---|---|
| `ticket_drop/api.py` | HTTP client: pacing, retries, response checks |
| `ticket_drop/plays.py` | Turns API responses into sale openings, with sanity checks |
| `ticket_drop/booklet.py` | Reads the booklet and builds the forecasts |
| `ticket_drop/ics.py` | Builds the calendar feeds |
| `ticket_drop/render.py` | Writes the site files |
| `ticket_drop/template.html` | The page: Portuguese text, styles and browser logic |
| `docs/sesc-api.md` | **Read this first.** What's known about the undocumented API |
| `.github/workflows/publish.yml` | Scheduled build and deploy |

## Calendar feeds

There's one feed for each region, plus one for everything:

| File | Covers |
|---|---|
| `calendar-capital.ics` | Capital e Grande SP |
| `calendar-interior.ics` | Interior |
| `calendar-litoral.ics` | Litoral |
| `calendar.ics` | All regions |

Each sale opening is one event, with a one-hour reminder and the plays opening at that time, with forecasts marked as such. The page's links follow the selected region. The Google Agenda and Apple/Outlook links only appear once the page is on a public address; the `.ics` download works anywhere.

Calendar apps control two things this project can't:

- **Refresh rate:** feeds ask to be refreshed every 6 hours, but apps decide for themselves, and Google can take a day or more. A play added shortly before its sale may not reach subscribers in time.
- **Reminders:** some apps ignore or remove reminders in subscribed calendars, so people may need to set their own.

## Publishing

The included workflow publishes to GitHub Pages. To set it up:

1. Push the project to GitHub. A free account needs a public repository for Pages.
2. Go to **Settings > Pages** and set **Source** to **GitHub Actions**.
3. Go to the **Actions** tab, then run **Publish** manually.

It then runs every day, and again on Tuesdays shortly before 17:00 in São Paulo. A failed run sends you an email from GitHub, and the last good page stays online. If only the booklet fails, the run still passes and the page updates, keeping the forecasts it already had. That shows as a warning on the run's page, but GitHub doesn't email you about warnings, so check the Actions tab now and then.

On public repositories, GitHub turns off scheduled workflows after 60 days without repository activity. It warns you first, and you can turn them back on from the Actions tab.

## Limitations

- **The list can be incomplete.** Some plays reach the API only hours before their sale opens, and forecasts mostly cover the capital. The page says so and links to the *Em Cartaz* booklet.
- **Forecast dates can be wrong**, sometimes by a week. See [Forecasts from the booklet](#forecasts-from-the-booklet).
- **Plays leave the list once their sale opens**, even if they haven't premiered yet.
- **Only the premiere's sale is shown.** Sessions that open at a different time are left out, even on the same day, along with their dates and ticket counts. The card still says when the season ends.
- **Free plays with no ticket sale don't appear**, and neither do shows with no sub-category.
- **The API is undocumented** and could change at any time.
