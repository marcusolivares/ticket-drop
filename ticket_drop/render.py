"""Write the static site: the HTML page, the data as JSON, and the calendar feeds."""

from __future__ import annotations

import json
from pathlib import Path

from .ics import build_calendar, feed_name
from .plays import REGIONS

TEMPLATE = Path(__file__).with_name("template.html")
PLACEHOLDER = "__TICKET_DROP_DATA__"


def render_page(dataset: dict) -> str:
    # Escaping "<" stops text from the API from closing the <script> tag.
    payload = json.dumps(dataset, ensure_ascii=False).replace("<", "\\u003c")
    return TEMPLATE.read_text(encoding="utf-8").replace(PLACEHOLDER, payload)


def write_site(dataset: dict, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.html").write_text(render_page(dataset), encoding="utf-8")
    (out / "plays.json").write_text(
        json.dumps(dataset, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    for region in (None, *REGIONS):
        # Written as bytes because calendars need CRLF line endings on every platform.
        (out / feed_name(region)).write_bytes(build_calendar(dataset, region).encode("utf-8"))
