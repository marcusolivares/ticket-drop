"""Command line entry point: python -m ticket_drop"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime
from pathlib import Path

from .api import ApiError, SescApi
from .booklet import add_booklet_estimates
from .plays import SAO_PAULO, CollectError, collect
from .render import write_site

log = logging.getLogger("ticket_drop")


def _warn_on_github(message: str) -> None:
    """Show a warning on the workflow run's page. Elsewhere, the log is enough."""
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print(f"::warning title=Ticket Drop::{message}", flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m ticket_drop",
        description="Build a static page showing when tickets for Sesc SP plays go on sale.",
    )
    parser.add_argument("--days", type=int, default=30, help="how many days ahead to look (default: 30)")
    parser.add_argument("--out", type=Path, default=Path("site"), help="output folder (default: site)")
    parser.add_argument("--input", type=Path, help="re-render this saved plays.json without calling the API")
    parser.add_argument(
        "--previous",
        help="the last published plays.json, as a URL or file, to keep its forecasts if the booklet "
        "can't be read (default: the one in the output folder)",
    )
    args = parser.parse_args(argv)
    if args.days < 1:
        parser.error("--days must be at least 1")

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    if args.input:
        dataset = json.loads(args.input.read_text(encoding="utf-8"))
    else:
        api = SescApi()
        now = datetime.now(SAO_PAULO)
        try:
            dataset = collect(api, now, args.days)
        except (ApiError, CollectError) as error:
            # A non-zero exit stops the publish step, so the last good page stays up.
            log.error("Nothing written: %s", error)
            return 1
        if not add_booklet_estimates(dataset, api, now, args.previous or args.out / "plays.json"):
            _warn_on_github(
                "The booklet couldn't be read, so the page has no new forecasts and keeps only those "
                "from the last published page. The build log has the details."
            )

    write_site(dataset, args.out)
    log.info("Wrote %s", args.out / "index.html")
    return 0


if __name__ == "__main__":
    sys.exit(main())
