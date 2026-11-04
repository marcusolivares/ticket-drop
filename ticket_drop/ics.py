"""Build calendar feeds with one event per sale opening, listing the plays that open then."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone

from .plays import REGIONS, SAO_PAULO

MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"]
EVENT_LENGTH = timedelta(minutes=30)
REMINDER = "-PT1H"
REFRESH_INTERVAL = "PT6H"
MAX_LINE_BYTES = 75


def feed_name(region: str | None = None) -> str:
    return f"calendar-{region}.ics" if region else "calendar.ics"


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def _fold(line: str) -> str:
    """Wrap a line at 75 bytes, as RFC 5545 requires, without splitting a character."""
    lines = []
    current = ""
    size = 0
    for char in line:
        width = len(char.encode("utf-8"))
        if size + width > MAX_LINE_BYTES:
            lines.append(current)
            current = " "
            size = 1
        current += char
        size += width
    lines.append(current)
    return "\r\n".join(lines)


def _utc(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _short_date(day: str) -> str:
    return f"{int(day[8:10])} {MONTHS[int(day[5:7]) - 1]}"


def _dates_text(days: list[str]) -> str:
    first, last = days[0], days[-1]
    if first == last:
        return _short_date(first)
    start = str(int(first[8:10])) if first[:7] == last[:7] else _short_date(first)
    return f"{start} a {_short_date(last)}"


def _clock(moment: datetime) -> str:
    return f"{moment.hour}h" if not moment.minute else f"{moment.hour}h{moment.minute:02d}"


def _play_text(drop: dict) -> str:
    if drop.get("estimated"):
        when = f"a partir de {_short_date(drop['dates'][0])}"
        return f"{drop['title']} · {drop['unit']} · {when} · previsão obtida no livreto, sujeita a mudanças\n{drop['url']}"
    text = f"{drop['title']} · {drop['unit']} · {_dates_text(drop['dates'])}"
    if not any(session["online_left"] for session in drop["sessions"]):
        text += " · sem ingressos on-line listados"
    return f"{text}\n{drop['url']}"


def _summary(drops: list[dict]) -> str:
    if all(drop.get("estimated") for drop in drops):
        if len(drops) == 1:
            return f"Previsão de abertura: {drops[0]['title']}"
        return f"Previsão: abre a venda de {len(drops)} peças"
    if len(drops) == 1:
        return f"Abre a venda: {drops[0]['title']}"
    return f"Abre a venda de {len(drops)} peças"


def _event(moment: str, drops: list[dict], region: str | None, stamp: str) -> list[str]:
    start = datetime.fromisoformat(moment).replace(tzinfo=SAO_PAULO)
    summary = _summary(drops)
    intro = f"Venda on-line a partir das {_clock(start)}. Calendário não oficial: confirme no site do Sesc."
    description = "\n\n".join([intro, *map(_play_text, drops)])
    return [
        "BEGIN:VEVENT",
        # Stable across builds, so calendar apps update the event instead of duplicating it.
        f"UID:{moment.replace(':', '')}-{region or 'all'}@ticket-drop",
        f"DTSTAMP:{stamp}",
        f"DTSTART:{_utc(start)}",
        f"DTEND:{_utc(start + EVENT_LENGTH)}",
        f"SUMMARY:{_escape(summary)}",
        f"DESCRIPTION:{_escape(description)}",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        f"TRIGGER:{REMINDER}",
        f"DESCRIPTION:{_escape(summary)}",
        "END:VALARM",
        "END:VEVENT",
    ]


def build_calendar(dataset: dict, region: str | None = None) -> str:
    """Return a calendar for one region, or for all of them."""
    name = f"Quando Abre: {REGIONS[region]}" if region else "Quando Abre"
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Ticket Drop//Quando Abre//PT",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        f"X-WR-CALNAME:{_escape(name)}",
        f"REFRESH-INTERVAL;VALUE=DURATION:{REFRESH_INTERVAL}",
        f"X-PUBLISHED-TTL:{REFRESH_INTERVAL}",
    ]
    moments = defaultdict(list)
    for drop in dataset["drops"]:
        if region is None or drop["region"] == region:
            moments[drop["online_sale_start"]].append(drop)
    stamp = _utc(datetime.fromisoformat(dataset["generated_at"]))
    for moment in sorted(moments):
        ordered = sorted(moments[moment], key=lambda d: (bool(d.get("estimated")), d["unit"], d["title"]))
        lines.extend(_event(moment, ordered, region, stamp))
    lines.append("END:VCALENDAR")
    return "\r\n".join(map(_fold, lines)) + "\r\n"
