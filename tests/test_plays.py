import unittest
from datetime import date, datetime

from ticket_drop.api import ApiError
from ticket_drop.plays import SAO_PAULO, CollectError, build_drop, clean_text, collect, is_ticketed

START = date(2026, 11, 3)
END = date(2026, 12, 3)
NOW = datetime(2026, 11, 3, 13, 0, tzinfo=SAO_PAULO)
REGIONS = {"pompeia": "capital"}


def listing(**overrides):
    return {
        "id": 1,
        "titulo": "A Hora e Vez",
        "complemento": "",
        "link": "/programacao/a-hora-e-vez",
        "gratuito": "",
        "cancelado": "",
        "unidade": [{"name": "Pompeia", "link": "/unidades/pompeia"}],
        "dataUltimaSessao": "2026-12-20T17:30",
        "datasSessoes": ["2026-11-12", "2026-11-13"],
        **overrides,
    }


def session(start="2026-11-12T19:30", online="2026-11-03T17:00", **overrides):
    return {
        "dataInicialSessaoFmt": start,
        "dataInicialVendaOnlineFmt": online,
        "dataInicialVendaRedeFmt": "2026-11-04T17:00",
        "qtdeIngressosWeb": 21,
        "qtdeIngressosRede": 9,
        "valorInteira": 50,
        "valorMeia": 25,
        "valorComerciario": 15,
        "urlCompra": "https://centralrelacionamento.sescsp.org.br/?path=detalhes-atividade&amp;unidade=5&amp;id=1",
        **overrides,
    }


def detail(*sessions, capped="false"):
    return {"possuiMais20Sessoes": capped, "sessoes": list(sessions)}


class CleanTextTests(unittest.TestCase):
    def test_decodes_entities_and_collapses_whitespace(self):
        self.assertEqual(clean_text("Show &#8211; Fat\xa0 Family \xa0"), "Show – Fat Family")

    def test_handles_missing_value(self):
        self.assertEqual(clean_text(None), "")


class IsTicketedTests(unittest.TestCase):
    def test_excludes_free_and_cancelled(self):
        self.assertTrue(is_ticketed(listing()))
        self.assertTrue(is_ticketed(listing(gratuito="Retirada de ingresso")))
        self.assertFalse(is_ticketed(listing(gratuito="Atividade gratuita")))
        self.assertFalse(is_ticketed(listing(cancelado="1")))


class BuildDropTests(unittest.TestCase):
    def build(self, item=None, info=None):
        return build_drop(item or listing(), info or detail(session()), REGIONS, START, END)

    def test_builds_a_drop(self):
        drop = self.build()
        self.assertEqual(drop["url"], "https://www.sescsp.org.br/programacao/a-hora-e-vez")
        self.assertEqual(drop["unit"], "Pompeia")
        self.assertEqual(drop["region"], "capital")
        self.assertEqual(drop["online_sale_start"], "2026-11-03T17:00")
        self.assertEqual(drop["in_person_sale_start"], "2026-11-04T17:00")
        self.assertEqual(drop["dates"], ["2026-11-12"])
        self.assertEqual(drop["sessions"][0]["online_left"], 21)
        self.assertEqual(drop["season_end"], "2026-12-20")

    def test_no_sessions_gives_nothing(self):
        self.assertIsNone(self.build(info=detail()))

    def test_unescapes_the_buy_link(self):
        self.assertTrue(self.build()["buy_url"].endswith("?path=detalhes-atividade&unidade=5&id=1"))

    def test_rejects_buy_links_on_other_hosts(self):
        drop = self.build(info=detail(session(urlCompra="https://example.com/?x=1")))
        self.assertIsNone(drop["buy_url"])

    def test_ignores_sessions_outside_the_window(self):
        info = detail(session(start="2026-11-01T19:30"), session(start="2026-12-04T19:30"))
        self.assertIsNone(self.build(info=info))

    def test_keeps_sessions_on_the_window_edges(self):
        info = detail(session(start="2026-11-03T19:30"), session(start="2026-12-03T19:30"))
        self.assertEqual(self.build(info=info)["dates"], ["2026-11-03", "2026-12-03"])

    def test_the_premiere_sets_the_opening(self):
        # A real case: Sesc sells this play's last session from 08:00 and the rest from 17:00.
        item = listing(dataUltimaSessao="2026-11-29T18:00")
        info = detail(
            session(start="2026-11-20T18:00", online="2026-11-10T17:00"),
            session(start="2026-11-21T20:00", online="2026-11-10T17:00"),
            session(start="2026-11-29T18:00", online="2026-11-10T08:00"),
        )
        drop = self.build(item=item, info=info)
        self.assertEqual(drop["online_sale_start"], "2026-11-10T17:00")
        self.assertEqual(drop["dates"], ["2026-11-20", "2026-11-21"])
        self.assertEqual(len(drop["sessions"]), 2)
        self.assertEqual(drop["season_end"], "2026-11-29")

    def test_the_premiere_wins_even_when_most_sessions_disagree(self):
        info = detail(
            session(start="2026-11-20T18:00", online="2026-11-10T08:00"),
            session(start="2026-11-21T18:00", online="2026-11-10T17:00"),
            session(start="2026-11-22T18:00", online="2026-11-10T17:00"),
        )
        drop = self.build(info=info)
        self.assertEqual(drop["online_sale_start"], "2026-11-10T08:00")
        self.assertEqual(drop["dates"], ["2026-11-20"])

    def test_finds_the_premiere_whatever_order_the_api_uses(self):
        info = detail(
            session(start="2026-11-13T19:30", online="2026-11-10T17:00"),
            session(start="2026-11-12T19:30", online="2026-11-03T17:00"),
        )
        self.assertEqual(self.build(info=info)["online_sale_start"], "2026-11-03T17:00")

    def test_leaves_out_later_sale_batches(self):
        info = detail(session(), session(start="2026-11-20T19:30", online="2026-11-10T17:00"))
        drop = self.build(info=info)
        self.assertEqual(drop["online_sale_start"], "2026-11-03T17:00")
        self.assertEqual(drop["dates"], ["2026-11-12"])

    def test_a_later_batch_of_a_running_season_is_not_a_premiere(self):
        info = detail(
            session(start="2026-11-01T19:30", online="2026-10-20T17:00"),
            session(start="2026-11-12T19:30", online="2026-11-03T17:00"),
        )
        self.assertIsNone(self.build(info=info))

    def test_a_premiere_with_no_sale_time_gives_nothing(self):
        self.assertIsNone(self.build(info=detail(session(online=None))))

    def test_a_later_session_with_no_sale_time_is_left_out(self):
        info = detail(session(), session(start="2026-11-20T19:30", online=None))
        self.assertEqual(self.build(info=info)["dates"], ["2026-11-12"])

    def test_a_missing_sale_field_is_an_error(self):
        broken = session()
        del broken["dataInicialVendaOnlineFmt"]
        with self.assertRaises(KeyError):
            self.build(info=detail(broken))

    def test_merges_sessions_and_uses_earliest_in_person(self):
        info = detail(
            session(start="2026-11-07T16:00", dataInicialVendaRedeFmt="2026-11-07T15:00"),
            session(start="2026-11-08T16:00", dataInicialVendaRedeFmt="2026-11-08T15:00"),
        )
        self.assertEqual(self.build(info=info)["in_person_sale_start"], "2026-11-07T15:00")

    def test_reports_the_cheapest_price_when_they_vary(self):
        info = detail(
            session(valorInteira=90, valorMeia=45, valorComerciario=27),
            session(start="2026-11-13T19:30", valorInteira=60, valorMeia=30, valorComerciario=18),
        )
        drop = self.build(info=info)
        self.assertEqual((drop["price_full"], drop["price_half"], drop["price_member"]), (60, 30, 18))
        self.assertTrue(drop["price_varies"])

    def test_handles_free_ticketed_sessions(self):
        info = detail(session(valorInteira=None, valorMeia=None, valorComerciario=None))
        self.assertEqual(self.build(info=info)["price_full"], 0)

    def test_fills_dates_past_the_session_cap_from_the_listing(self):
        item = listing(datasSessoes=["2026-11-12", "2026-11-20", "2026-12-20"])
        drop = self.build(item=item, info=detail(session(), capped="true"))
        self.assertEqual(drop["dates"], ["2026-11-12", "2026-11-20"])
        self.assertEqual(len(drop["sessions"]), 1)

    def test_filling_dates_does_not_restore_left_out_sessions(self):
        item = listing(datasSessoes=["2026-11-12", "2026-11-13", "2026-11-20"])
        info = detail(session(), session(start="2026-11-13T19:30", online="2026-11-10T17:00"), capped="true")
        self.assertEqual(self.build(item=item, info=info)["dates"], ["2026-11-12", "2026-11-20"])

    def test_does_not_fill_dates_when_not_capped(self):
        item = listing(datasSessoes=["2026-11-12", "2026-11-20"])
        self.assertEqual(self.build(item=item)["dates"], ["2026-11-12"])


class FakeApi:
    def __init__(self, plays, details):
        self.plays = plays
        self.details = details

    def list_units(self):
        return [{"group_slug": "pompeia", "description": "capital"}]

    def list_plays(self, start, end):
        return self.plays

    def get_detail(self, slug):
        result = self.details.get(slug)
        if isinstance(result, Exception):
            raise result
        return result


def many_plays(count):
    return [listing(id=n, link=f"/programacao/play-{n}") for n in range(count)]


class CollectTests(unittest.TestCase):
    def test_builds_the_dataset(self):
        plays = many_plays(2) + [listing(id=9, link="/programacao/free", gratuito="Atividade gratuita")]
        api = FakeApi(plays, {f"play-{n}": detail(session()) for n in range(2)})
        dataset = collect(api, NOW, 30)
        self.assertEqual(len(dataset["drops"]), 2)
        self.assertEqual(dataset["window"], {"start": "2026-11-03", "end": "2026-12-03", "days": 30})
        self.assertEqual(dataset["generated_at"], "2026-11-03T13:00:00-03:00")
        self.assertEqual(dataset["regions"]["capital"], "Capital e Grande SP")

    def test_lists_a_play_once_when_its_sessions_open_at_different_times(self):
        info = detail(
            session(start="2026-11-12T19:30", online="2026-11-03T17:00"),
            session(start="2026-11-13T19:30", online="2026-11-03T14:00"),
        )
        dataset = collect(FakeApi(many_plays(1), {"play-0": info}), NOW, 30)
        self.assertEqual([d["online_sale_start"] for d in dataset["drops"]], ["2026-11-03T17:00"])

    def test_skips_plays_with_nothing_in_the_window(self):
        details = {"play-0": detail(session()), "play-1": detail(session(start="2026-12-20T19:30"))}
        self.assertEqual(len(collect(FakeApi(many_plays(2), details), NOW, 30)["drops"]), 1)

    def test_keeps_only_sales_still_to_open(self):
        details = {
            "play-0": detail(session(online="2026-10-27T17:00")),
            "play-1": detail(session(online="2026-11-03T13:00")),
            "play-2": detail(session(online="2026-11-03T13:01")),
        }
        dataset = collect(FakeApi(many_plays(3), details), NOW, 30)
        self.assertEqual([d["online_sale_start"] for d in dataset["drops"]], ["2026-11-03T13:01"])

    def test_nothing_left_to_open_is_not_an_error(self):
        details = {"play-0": detail(session(online="2026-10-27T17:00"))}
        self.assertEqual(collect(FakeApi(many_plays(1), details), NOW, 30)["drops"], [])

    def test_tolerates_a_few_missing_plays(self):
        details = {f"play-{n}": detail(session()) for n in range(19)}
        details["play-19"] = ApiError("boom")
        self.assertEqual(len(collect(FakeApi(many_plays(20), details), NOW, 30)["drops"]), 19)

    def test_fails_when_nothing_is_listed(self):
        with self.assertRaises(CollectError):
            collect(FakeApi([], {}), NOW, 30)

    def test_fails_when_many_requests_error(self):
        details = {f"play-{n}": ApiError("boom") for n in range(5)}
        with self.assertRaises(CollectError):
            collect(FakeApi(many_plays(5), details), NOW, 30)

    def test_fails_when_most_plays_have_no_sessions(self):
        with self.assertRaises(CollectError):
            collect(FakeApi(many_plays(5), {}), NOW, 30)

    def test_fails_when_the_session_format_changes(self):
        details = {f"play-{n}": detail({"renamed": "field"}) for n in range(5)}
        with self.assertRaises(CollectError):
            collect(FakeApi(many_plays(5), details), NOW, 30)


if __name__ == "__main__":
    unittest.main()
