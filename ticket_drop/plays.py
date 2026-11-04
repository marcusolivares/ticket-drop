"""Turn raw API responses into the sale openings ("drops") the page displays."""

from __future__ import annotations

import html
import logging
import urllib.parse
from datetime import date, datetime, timedelta, timezone

from .api import SITE_URL, ApiError, SescApi

log = logging.getLogger(__name__)

# Brazil abolished daylight saving in 2019. A fixed offset also avoids needing
# tzdata on Windows.
SAO_PAULO = timezone(timedelta(hours=-3), "America/Sao_Paulo")

BUY_HOST = "centralrelacionamento.sescsp.org.br"
FREE_LABEL = "Atividade gratuita"
# Keys match the `description` field of the units endpoint.
REGIONS = {"capital": "Capital e Grande SP", "interior": "Interior", "litoral": "Litoral"}

# Above these shares of failures we assume the API changed, and refuse to
# overwrite the last good page with a mostly empty one.
MAX_ERROR_SHARE = 0.1
MAX_NOT_FOUND_SHARE = 0.5


class CollectError(RuntimeError):
    """The collected data looks wrong, so it should not be published."""


def clean_text(value: str | None) -> str:
    return " ".join(html.unescape(value or "").split())


def is_ticketed(item: dict) -> bool:
    return item.get("gratuito") != FREE_LABEL and not item.get("cancelado")


def slug_of(item: dict) -> str:
    return item["link"].rstrip("/").rsplit("/", 1)[-1]


def _buy_url(session: dict) -> str | None:
    url = html.unescape(session.get("urlCompra") or "")
    parts = urllib.parse.urlsplit(url)
    return url if parts.scheme == "https" and parts.hostname == BUY_HOST else None


def build_drop(item: dict, detail: dict, regions: dict, start: date, end: date) -> dict | None:
    """Build the record for an activity's premiere sale, or None if there's nothing to show.

    The first session sets the opening. Sessions that open at another time, whether
    later that day or in a later week, are left out.
    """
    first, last = start.isoformat(), end.isoformat()
    scheduled = sorted(detail.get("sessoes") or [], key=lambda s: s["dataInicialSessaoFmt"])
    if not scheduled:
        return None
    online_start = scheduled[0]["dataInicialVendaOnlineFmt"]
    sessions = [
        s
        for s in scheduled
        if s.get("dataInicialVendaOnlineFmt") == online_start and first <= s["dataInicialSessaoFmt"][:10] <= last
    ]
    if not online_start or not sessions:
        return None

    dates = {s["dataInicialSessaoFmt"][:10] for s in sessions}
    # The detail endpoint stops at 20 sessions. The listing still has every date,
    # so dates past the cap are added, without ticket counts.
    if str(detail.get("possuiMais20Sessoes")).lower() == "true":
        known = {s["dataInicialSessaoFmt"][:10] for s in scheduled}
        dates |= {day for day in item.get("datasSessoes") or [] if first <= day <= last and day not in known}

    unit = item["unidade"][0]
    unit_slug = unit["link"].rstrip("/").rsplit("/", 1)[-1]
    in_person = sorted({s["dataInicialVendaRedeFmt"] for s in sessions if s.get("dataInicialVendaRedeFmt")})
    full_prices = [s.get("valorInteira") or 0 for s in sessions]
    cheapest = sessions[full_prices.index(min(full_prices))]
    return {
        "id": f"{item['id']}-{online_start}",
        "title": clean_text(item["titulo"]),
        "subtitle": clean_text(item.get("complemento")),
        "url": SITE_URL + item["link"],
        "buy_url": next(filter(None, map(_buy_url, sessions)), None),
        "unit": clean_text(unit["name"]),
        "unit_slug": unit_slug,
        "region": regions.get(unit_slug, ""),
        "online_sale_start": online_start,
        "in_person_sale_start": in_person[0] if in_person else None,
        "price_full": min(full_prices),
        "price_half": cheapest.get("valorMeia") or 0,
        "price_member": cheapest.get("valorComerciario") or 0,
        "price_varies": len(set(full_prices)) > 1,
        "dates": sorted(dates),
        "season_end": (item.get("dataUltimaSessao") or "")[:10] or None,
        "sessions": [
            {
                "start": s["dataInicialSessaoFmt"],
                "online_left": int(s.get("qtdeIngressosWeb") or 0),
                "in_person_left": int(s.get("qtdeIngressosRede") or 0),
            }
            for s in sessions
        ],
    }


def collect(api: SescApi, now: datetime, days: int) -> dict:
    """Fetch the sale openings still to come, for plays in the next `days` days."""
    today = now.date()
    end = today + timedelta(days=days)
    regions = {unit["group_slug"]: unit.get("description", "") for unit in api.list_units()}
    listing = api.list_plays(today, end)
    ticketed = [item for item in listing if is_ticketed(item)]
    if not ticketed:
        raise CollectError("the listing returned no ticketed plays")
    log.info("Listed %d plays, %d possibly ticketed", len(listing), len(ticketed))

    drops: list[dict] = []
    not_found: list[str] = []
    errors: list[str] = []
    for index, item in enumerate(ticketed, 1):
        slug = item.get("link", "?")
        try:
            slug = slug_of(item)
            detail = api.get_detail(slug)
            if detail is None:
                not_found.append(slug)
            else:
                drop = build_drop(item, detail, regions, today, end)
                if drop:
                    drops.append(drop)
        except (ApiError, KeyError, TypeError, ValueError, IndexError) as error:
            log.warning("Skipping %s: %r", slug, error)
            errors.append(slug)
        if index % 20 == 0:
            log.info("Fetched %d of %d", index, len(ticketed))

    if len(errors) > len(ticketed) * MAX_ERROR_SHARE:
        raise CollectError(f"{len(errors)} of {len(ticketed)} plays failed, e.g. {errors[:3]}")
    if len(not_found) > len(ticketed) * MAX_NOT_FOUND_SHARE:
        raise CollectError(f"{len(not_found)} of {len(ticketed)} plays had no sessions")
    if not drops:
        raise CollectError("no sale openings were found")

    moment = now.strftime("%Y-%m-%dT%H:%M")
    upcoming = [drop for drop in drops if drop["online_sale_start"] > moment]
    upcoming.sort(key=lambda d: (d["online_sale_start"], d["unit"], d["title"]))
    log.info(
        "Found %d sale openings, %d still to open; %d not found, %d errors",
        len(drops), len(upcoming), len(not_found), len(errors),
    )
    return {
        "generated_at": now.isoformat(timespec="seconds"),
        "window": {"start": today.isoformat(), "end": end.isoformat(), "days": days},
        "regions": REGIONS,
        "drops": upcoming,
    }
