"""Client for the undocumented Sesc SP WordPress endpoints (see docs/sesc-api.md)."""

from __future__ import annotations

import http.client
import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from typing import Any, Callable

log = logging.getLogger(__name__)

SITE_URL = "https://www.sescsp.org.br"
BASE_URL = f"{SITE_URL}/wp-json/wp/v1"
USER_AGENT = "ticket-drop/0.1 (unofficial schedule viewer)"
TIMEOUT_SECONDS = 40
PAGE_SIZE = 300
MAX_PAGES = 20
MAX_FILE_BYTES = 64 * 1024 * 1024


class ApiError(RuntimeError):
    """The API failed, or returned something this client does not understand."""


class NotFound(ApiError):
    """The API answered 404. Normal for activities with no ticketed sessions."""


def _read_limited(response) -> bytes:
    data = response.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise ApiError(f"file is larger than {MAX_FILE_BYTES} bytes")
    return data


class SescApi:
    def __init__(self, delay=1.0, retries=3, opener=urllib.request.urlopen, sleep=time.sleep):
        self._delay = delay
        self._retries = retries
        self._opener = opener
        self._sleep = sleep
        self._last_request = None

    def list_units(self) -> list[dict]:
        units = self._get("/unidades-atividades")
        if not isinstance(units, list):
            raise ApiError(f"unexpected units response: {type(units).__name__}")
        return units

    def list_plays(self, start: date, end: date) -> list[dict]:
        """Return every theatre activity with a session between start and end."""
        return self._list_activities(start, end, {"linguagem": "teatro"})

    def list_shows(self, start: date, end: date) -> list[dict]:
        """Return every show of any kind with a session between start and end."""
        return self._list_activities(start, end, {"atividade": "shows-espetaculos-e-performances"})

    def get_detail(self, slug: str) -> dict | None:
        """Return an activity's sessions, or None if it has none to sell."""
        try:
            payload = self._get("/atividades/detail", {"slug": slug})
        except NotFound:
            return None
        if not isinstance(payload, dict) or "sessoes" not in payload:
            raise ApiError(f"unexpected detail response for {slug}: {str(payload)[:200]}")
        return payload

    def get_file(self, url: str) -> bytes:
        """Download a web page or file from the Sesc site."""
        if not url.startswith(f"{SITE_URL}/"):
            raise ApiError(f"refusing to download from outside the Sesc site: {url}")
        return self._fetch(url, "*/*", _read_limited)

    def _list_activities(self, start: date, end: date, filters: dict) -> list[dict]:
        items: list[dict] = []
        seen = 0
        for page in range(1, MAX_PAGES + 1):
            payload = self._get(
                "/atividades/filter",
                {
                    "tipo": "atividade",
                    **filters,
                    "data_inicial": start.isoformat(),
                    "data_final": end.isoformat(),
                    "ppp": PAGE_SIZE,
                    "page": page,
                    "dinamico": "true",
                    "sites": "true",
                },
            )
            if not isinstance(payload, dict) or not isinstance(payload.get("atividade"), list):
                raise ApiError(f"unexpected listing response: {str(payload)[:200]}")
            batch = payload["atividade"]
            seen += len(batch)
            # Listings can contain null rows, which the total still counts.
            items.extend(item for item in batch if isinstance(item, dict))
            total = (payload.get("total") or {}).get("value", 0)
            if len(batch) < PAGE_SIZE or seen >= total:
                return items
        raise ApiError(f"listing did not finish within {MAX_PAGES} pages")

    def _get(self, path: str, params: dict | None = None) -> Any:
        url = BASE_URL + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        return self._fetch(url, "application/json", json.load)

    def _fetch(self, url: str, accept: str, parse: Callable) -> Any:
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": accept})
        failure: Exception | None = None
        for attempt in range(1, self._retries + 1):
            self._wait_for_turn()
            try:
                with self._opener(request, timeout=TIMEOUT_SECONDS) as response:
                    return parse(response)
            except urllib.error.HTTPError as error:
                error.close()
                if error.code == 404:
                    raise NotFound(url) from error
                if error.code != 429 and error.code < 500:
                    raise ApiError(f"{url}: HTTP {error.code}") from error
                failure = error
            except (OSError, ValueError, http.client.HTTPException) as error:
                failure = error
            log.warning("Attempt %d failed for %s: %s", attempt, url, failure)
            if attempt < self._retries:
                self._sleep(2**attempt)
        raise ApiError(f"{url}: {failure}")

    def _wait_for_turn(self) -> None:
        """Keep at least `delay` seconds between requests to be gentle on the site."""
        if self._last_request is not None:
            remaining = self._delay - (time.monotonic() - self._last_request)
            if remaining > 0:
                self._sleep(remaining)
        self._last_request = time.monotonic()
