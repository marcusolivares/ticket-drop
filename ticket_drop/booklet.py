"""Estimate sale openings from the monthly Em Cartaz booklet, for plays not in the API yet.

The booklet is a PDF with no structured data, but each kind of text has its own
font, which has held across the editions checked. The sale date is not in the
booklet: it's worked out from the rule the booklet prints, so it's only a forecast.
The API always wins: a play stops being estimated as soon as the API lists it.
"""

from __future__ import annotations

import difflib
import io
import json
import logging
import re
import unicodedata
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

from .api import SITE_URL, TIMEOUT_SECONDS, USER_AGENT, SescApi
from .plays import clean_text

log = logging.getLogger(__name__)

ARCHIVE_URL = f"{SITE_URL}/editorial/emcartaz/"
BOOKLET_LINK = re.compile(re.escape(SITE_URL) + r"/wp-content/uploads/[^\"'\s<>]+\.pdf")
PROGRAMME_URL = f"{SITE_URL}/programacao/?tipos=shows-espetaculos-e-performances&linguagens=teatro&unidades="

# (font weight, size) of each kind of text.
SECTION_STYLE = ("Black", 11.0)
UNIT_STYLE = ("Medium", 10.0)
MAIN_TITLE_STYLE = ("Bold", 10.0)
SUB_TITLE_STYLE = ("SemiBold", 10.0)
SCHEDULE_STYLE = ("SemiBold", 8.5)
CAPTION_STYLE = ("Regular", 10.0)

THEATRE_SECTION = "TEATRO"
SALE_TIME = "17:00"
# Far fewer entries than the 36 to 50 seen so far means the layout has changed.
MIN_ENTRIES = 10
MONTHS = [
    "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
    "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
]
DATE_PATTERNS = [
    re.compile(r"\bDe (\d{1,2})/(\d{1,2}) a"),
    re.compile(r"\bDe (\d{1,2}) a \d{1,2}/(\d{1,2})"),
    re.compile(r"\bDias? (\d{1,2})(?:(?:, | e | a )\d{1,2})*/(\d{1,2})"),
]
PRICE_PATTERN = re.compile(r"R\$\s?(\d+(?:,\d{2})?)")
FREE_WORD = "GRÁTIS"


class BookletError(RuntimeError):
    """The booklet couldn't be read, or doesn't look as expected."""


def normalize(text: str) -> str:
    plain = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", plain).strip()


def latest_booklet_url(archive_html: str) -> str:
    """Return the newest booklet. The archive page lists them newest first."""
    match = BOOKLET_LINK.search(archive_html)
    if not match:
        raise BookletError("no booklet link found on the archive page")
    return match.group(0)


def read_words(pdf: bytes) -> list[dict]:
    try:
        import pdfplumber
    except ImportError as error:
        raise BookletError("pdfplumber isn't installed: pip install -r requirements.txt") from error
    words = []
    with pdfplumber.open(io.BytesIO(pdf)) as document:
        for number, page in enumerate(document.pages, 1):
            for word in page.extract_words(extra_attrs=["fontname", "size"], use_text_flow=True):
                words.append({**word, "page": number})
            page.close()
    return words


def _style(word: dict) -> tuple[str, float]:
    return word["fontname"].rsplit("-", 1)[-1], round(word["size"], 1)


def text_runs(words: list[dict]) -> list[tuple[int, tuple, str]]:
    """Merge consecutive words of the same style into (page, style, text)."""
    runs: list[tuple[int, tuple, str]] = []
    for word in words:
        style = _style(word)
        if runs and runs[-1][1] == style:
            page, _, text = runs[-1]
            runs[-1] = (page, style, f"{text} {word['text']}")
        else:
            runs.append((word["page"], style, word["text"]))
    return runs


def find_edition(runs: list[tuple]) -> tuple[int, int]:
    """Return the (month, year) printed in the page headers."""
    for _, _, text in runs:
        match = re.search(r"EM CARTAZ \| (\S+) (\d{4})", text)
        if match and normalize(match.group(1)) in MONTHS:
            return MONTHS.index(normalize(match.group(1))) + 1, int(match.group(2))
    raise BookletError("no edition header found")


def parse_entries(runs: list[tuple]) -> list[dict]:
    """Return the entries of the theatre section, in reading order."""
    entries: list[dict] = []
    section = None
    unit = None
    for index, (page, style, text) in enumerate(runs):
        following = runs[index + 1][1] if index + 1 < len(runs) else None
        if style == SECTION_STYLE:
            # Page numbers share this style, so ignore anything that's only digits.
            heading = re.sub(r"\d+", "", text).strip()
            if heading:
                section = heading
        elif section != THEATRE_SECTION:
            continue
        elif style == UNIT_STYLE:
            unit = text
        elif style in (MAIN_TITLE_STYLE, SUB_TITLE_STYLE):
            # A photo caption looks like a title, followed by a "Unit - dates" line.
            if following != CAPTION_STYLE:
                entries.append(
                    {"unit": unit, "title": clean_text(text), "is_main": style == MAIN_TITLE_STYLE, "schedule": "", "page": page}
                )
        elif style == SCHEDULE_STYLE and entries:
            entries[-1]["schedule"] = f"{entries[-1]['schedule']} {text}".strip()
    return entries


def first_date(schedule: str, edition: tuple[int, int]) -> date | None:
    """Return the first date in a schedule, or None if it has none or is already running."""
    if schedule.startswith("Até"):
        return None
    found = [
        (match.start(), int(match.group(1)), int(match.group(2)))
        for pattern in DATE_PATTERNS
        for match in pattern.finditer(schedule)
    ]
    if not found:
        return None
    _, day, month = min(found)
    edition_month, year = edition
    # A December edition can list January dates.
    if month < edition_month - 6:
        year += 1
    try:
        return date(year, month, day)
    except ValueError:
        return None


def parse_price(schedule: str) -> dict | str | None:
    """Return the prices, the word "free", or None if the entry doesn't say."""
    found = [float(value.replace(",", ".")) for value in PRICE_PATTERN.findall(schedule)]
    if found:
        # Prices come in threes: full, half, Credencial Plena.
        trios = [found[index:index + 3] for index in range(0, len(found), 3)]
        full, half, member = (min(trios, key=lambda trio: trio[0]) + [0, 0])[:3]
        return {"full": full, "half": half, "member": member, "varies": len({trio[0] for trio in trios}) > 1}
    return "free" if FREE_WORD in schedule else None


def schedule_text(schedule: str) -> str:
    """Return a schedule without its prices."""
    cut = re.split(r"R\$|" + FREE_WORD, schedule, maxsplit=1)[0]
    return clean_text(cut)


def estimated_sale(premiere: date) -> date:
    """Return the Tuesday of the week before, as the booklet's sale table does."""
    monday = premiere - timedelta(days=premiere.weekday())
    return monday - timedelta(days=6)


def same_play(first: str, second: str) -> bool:
    a, b = normalize(first), normalize(second)
    if a == b or (len(a) > 5 and len(b) > 5 and (a in b or b in a)):
        return True
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.85


def _shows_by_unit(shows: list[dict]) -> dict[str, list[str]]:
    by_unit: dict[str, list[str]] = {}
    for show in shows:
        name = normalize((show.get("unidade") or [{}])[0].get("name"))
        by_unit.setdefault(name, []).append(show["titulo"])
    return by_unit


def _in_api(title: str, unit: str, shows_by_unit: dict[str, list[str]]) -> bool:
    return any(same_play(title, listed) for listed in shows_by_unit.get(normalize(unit), []))


def build_estimates(entries, edition, shows, units, booklet_url, now: datetime, end: date) -> list[dict]:
    """Return a drop for each ticketed play whose sale is still to come and isn't in the API."""
    units_by_name = {normalize(unit["name"]): unit for unit in units}
    shows_by_unit = _shows_by_unit(shows)

    drops = []
    series_unit = None
    series_price = None
    for entry in entries:
        premiere = first_date(entry["schedule"], edition)
        is_running = entry["schedule"].startswith("Até")
        price = parse_price(entry["schedule"])
        unit_key = normalize(entry["unit"])
        if entry["is_main"]:
            # A main title with no dates heads a series, whose plays share its price.
            is_series = premiere is None and not is_running
            series_price = price if is_series else None
            series_unit = unit_key if is_series else None
        elif price is None and unit_key == series_unit:
            price = series_price

        if premiere is None or price == "free" or not now.date() <= premiere <= end:
            continue
        sale = estimated_sale(premiere)
        if sale.isoformat() + "T" + SALE_TIME <= now.strftime("%Y-%m-%dT%H:%M"):
            continue
        if _in_api(entry["title"], entry["unit"], shows_by_unit):
            continue
        unit = units_by_name.get(unit_key)
        if unit is None:
            log.warning("Skipping %s: unknown unit %r", entry["title"], entry["unit"])
            continue
        price = price or {"full": None, "half": None, "member": None, "varies": False}
        drops.append(
            {
                "id": f"booklet-{unit['group_slug']}-{normalize(entry['title']).replace(' ', '-')}",
                "estimated": True,
                "title": entry["title"],
                "subtitle": "",
                "url": f"{booklet_url}#page={entry['page']}",
                "confirm_url": PROGRAMME_URL + unit["group_slug"],
                "buy_url": None,
                "unit": clean_text(unit["name"]),
                "unit_slug": unit["group_slug"],
                "region": unit.get("description", ""),
                "online_sale_start": f"{sale.isoformat()}T{SALE_TIME}",
                "in_person_sale_start": None,
                "price_full": price["full"],
                "price_half": price["half"],
                "price_member": price["member"],
                "price_varies": price["varies"],
                "dates": [premiere.isoformat()],
                "schedule": schedule_text(entry["schedule"]),
                "season_end": None,
                "sessions": [],
            }
        )
    return drops


def collect_estimates(api: SescApi, now: datetime, end: date) -> list[dict]:
    booklet_url = latest_booklet_url(api.get_file(ARCHIVE_URL).decode("utf-8", "replace"))
    runs = text_runs(read_words(api.get_file(booklet_url)))
    edition = find_edition(runs)
    entries = parse_entries(runs)
    if len(entries) < MIN_ENTRIES:
        raise BookletError(f"only {len(entries)} theatre entries found, so the layout may have changed")
    log.info("Read %d theatre entries from the %02d/%d booklet", len(entries), *edition)
    shows = api.list_shows(now.date(), end)
    return build_estimates(entries, edition, shows, api.list_units(), booklet_url, now, end)


def load_published(source: str | Path) -> dict:
    """Read a plays.json written by an earlier build, from a URL or a file."""
    if str(source).startswith(("https://", "http://")):
        request = urllib.request.Request(str(source), headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return json.load(response)
    return json.loads(Path(source).read_text(encoding="utf-8"))


def reuse_estimates(published: dict, shows: list[dict], now: datetime, end: date) -> list[dict]:
    """Return the forecasts of an earlier build that still apply.

    They leave once the API lists the play or their sale time passes, so if the
    booklet stays unreadable they run out instead of going stale.
    """
    moment = now.strftime("%Y-%m-%dT%H:%M")
    shows_by_unit = _shows_by_unit(shows)
    return [
        drop
        for drop in published["drops"]
        if drop.get("estimated")
        and drop["online_sale_start"] > moment
        and drop["dates"][0] <= end.isoformat()
        and not _in_api(drop["title"], drop["unit"], shows_by_unit)
    ]


def _published_estimates(source: str | Path | None, api: SescApi, now: datetime, end: date) -> list[dict]:
    """Return what can be kept from the last published page, or nothing if that fails too."""
    if not source:
        return []
    try:
        estimates = reuse_estimates(load_published(source), api.list_shows(now.date(), end), now, end)
    except Exception as error:
        log.warning("Couldn't keep the last published forecasts: %r", error)
        return []
    log.info("Kept %d forecasts from the last published page", len(estimates))
    return estimates


def add_booklet_estimates(dataset: dict, api: SescApi, now: datetime, published: str | Path | None = None) -> bool:
    """Add estimated openings to the dataset, and return whether the booklet could be read.

    If it couldn't, keep the forecasts of the last published page that still apply.
    """
    end = date.fromisoformat(dataset["window"]["end"])
    booklet_read = True
    try:
        estimates = collect_estimates(api, now, end)
        log.info("Added %d estimated sale openings from the booklet", len(estimates))
    except Exception as error:
        # Reading a third-party PDF can fail in many ways, and none of them should
        # stop the page from publishing what the API provided.
        log.warning("Couldn't read the booklet: %r", error)
        booklet_read = False
        estimates = _published_estimates(published, api, now, end)
    if estimates:
        dataset["drops"].extend(estimates)
        dataset["drops"].sort(
            key=lambda d: (d["online_sale_start"], bool(d.get("estimated")), d["unit"], d["title"])
        )
    return booklet_read
