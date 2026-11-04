import io
import json
import logging
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from unittest import mock

from ticket_drop.api import USER_AGENT
from ticket_drop.booklet import (
    add_booklet_estimates,
    build_estimates,
    estimated_sale,
    find_edition,
    first_date,
    latest_booklet_url,
    load_published,
    parse_entries,
    parse_price,
    reuse_estimates,
    same_play,
    schedule_text,
    text_runs,
)
from ticket_drop.plays import SAO_PAULO

NOW = datetime(2026, 11, 4, 12, 0, tzinfo=SAO_PAULO)
END = date(2026, 12, 4)
EDITION = (11, 2026)
BOOKLET_URL = "https://www.sescsp.org.br/wp-content/uploads/2026/10/em-cartaz.pdf"
UNITS = [
    {"name": "Pompeia", "group_slug": "pompeia", "description": "capital"},
    {"name": "24 de Maio", "group_slug": "24-de-maio", "description": "capital"},
]


def words_of(text, weight, size, page=1):
    return [{"text": word, "fontname": f"LORBCC+Informative-{weight}", "size": size, "page": page} for word in text.split()]


def section(text, page=1):
    return words_of(text, "Black", 11.0, page)


def unit(text, page=1):
    return words_of(text, "Medium", 10.0, page)


def title(text, page=1):
    return words_of(text, "Bold", 10.0, page)


def sub_title(text, page=1):
    return words_of(text, "SemiBold", 10.0, page)


def schedule(text, page=1):
    return words_of(text, "SemiBold", 8.5, page)


def description(text, page=1):
    return words_of(text, "Regular", 8.5, page)


def caption(text, page=1):
    return words_of(text, "Regular", 10.0, page)


def entries_from(*word_lists):
    return parse_entries(text_runs([word for words in word_lists for word in words]))


def entry(name="Reality Show", when="De 19/11 a 13/12. Quintas a sábados, 20h. R$70 R$35 R$21", place="POMPEIA", is_main=True, page=28):
    return {"unit": place, "title": name, "is_main": is_main, "schedule": when, "page": page}


def build(*entries, shows=(), now=NOW):
    return build_estimates(list(entries), EDITION, list(shows), UNITS, BOOKLET_URL, now, END)


def show(name, place="Pompeia"):
    return {"titulo": name, "unidade": [{"name": place}]}


class LatestBookletTests(unittest.TestCase):
    def test_takes_the_first_link(self):
        page = f'<a href="{BOOKLET_URL}">nov</a><a href="https://www.sescsp.org.br/wp-content/uploads/2026/09/old.pdf">out</a>'
        self.assertEqual(latest_booklet_url(page), BOOKLET_URL)

    def test_ignores_links_outside_the_site(self):
        with self.assertRaises(RuntimeError):
            latest_booklet_url('<a href="https://example.com/wp-content/uploads/x.pdf">x</a>')


class ParseEntriesTests(unittest.TestCase):
    def test_reads_unit_title_schedule_and_page(self):
        entries = entries_from(section("TEATRO"), unit("POMPEIA"), title("Reality Show", 28), description("Dez performers."), schedule("De 19/11 a 13/12.", 28))
        self.assertEqual(entries, [{"unit": "POMPEIA", "title": "Reality Show", "is_main": True, "schedule": "De 19/11 a 13/12.", "page": 28}])

    def test_ignores_other_sections(self):
        entries = entries_from(section("MÚSICA"), unit("POMPEIA"), title("Um Show"), schedule("Dia 5/11."), section("TEATRO"), title("Uma Peça"), schedule("Dia 6/11."), section("DANÇA"), title("Uma Dança"))
        self.assertEqual([e["title"] for e in entries], ["Uma Peça"])

    def test_page_numbers_do_not_end_the_section(self):
        entries = entries_from(section("TEATRO"), unit("POMPEIA"), title("Primeira"), section("25"), title("Segunda"))
        self.assertEqual([e["title"] for e in entries], ["Primeira", "Segunda"])

    def test_page_number_merged_with_the_heading_still_counts(self):
        entries = entries_from(section("TEATRO 24"), unit("POMPEIA"), title("Primeira"))
        self.assertEqual([e["title"] for e in entries], ["Primeira"])

    def test_photo_captions_are_not_titles(self):
        # A real case: this caption interrupted A Avó Inventada, and took its dates.
        entries = entries_from(
            section("TEATRO"), unit("VILA MARIANA"), title("A Avó Inventada"), description("Espetáculo inspirado"),
            sub_title("Fôlego"), caption("Santo Amaro – Até 13/12"), description("e memória."), schedule("Dia 11/11. Quarta, 20h30."),
        )
        self.assertEqual([e["title"] for e in entries], ["A Avó Inventada"])
        self.assertEqual(entries[0]["schedule"], "Dia 11/11. Quarta, 20h30.")

    def test_joins_schedule_pieces(self):
        entries = entries_from(section("TEATRO"), unit("POMPEIA"), title("Peça"), schedule("Dia 5/11."), words_of("A12", "SemiBold", 6.0), schedule("R$50 R$25 R$15"))
        self.assertEqual(entries[0]["schedule"], "Dia 5/11. R$50 R$25 R$15")

    def test_joins_a_title_across_lines(self):
        entries = entries_from(section("TEATRO"), unit("POMPEIA"), title("Os Amores de Lorca,"), title("ou o Amor"))
        self.assertEqual(entries[0]["title"], "Os Amores de Lorca, ou o Amor")

    def test_marks_sub_titles(self):
        entries = entries_from(section("TEATRO"), unit("POMPEIA"), sub_title("Do Ventre à Cabeça"))
        self.assertFalse(entries[0]["is_main"])


class FindEditionTests(unittest.TestCase):
    def test_reads_the_header(self):
        runs = text_runs(words_of("EM CARTAZ | MARÇO 2027", "Medium", 6.0))
        self.assertEqual(find_edition(runs), (3, 2027))

    def test_fails_without_a_header(self):
        with self.assertRaises(RuntimeError):
            find_edition(text_runs(words_of("Outra coisa", "Medium", 6.0)))


class FirstDateTests(unittest.TestCase):
    def test_formats_seen_in_the_booklet(self):
        cases = {
            "De 19/11 a 13/12. Quintas a sábados, 20h.": date(2026, 11, 19),
            "De 25 a 27/11. Quarta a sexta, 15h.": date(2026, 11, 25),
            "Dia 17/11. Terça, 19h30.": date(2026, 11, 17),
            "Dias 7 e 8/11. Sábado e domingo, 16h.": date(2026, 11, 7),
            "Dias 7, 8 e 9/11.": date(2026, 11, 7),
            "De 31/10 a 2/11.": date(2026, 10, 31),
        }
        for text, expected in cases.items():
            self.assertEqual(first_date(text, EDITION), expected, text)

    def test_takes_the_earliest_mention(self):
        text = "Dia 11/11. Quarta, 20h30. De 12/11 a 5/12. Quintas a sábados."
        self.assertEqual(first_date(text, EDITION), date(2026, 11, 11))

    def test_running_seasons_have_no_first_date(self):
        self.assertIsNone(first_date("Até 14/11. Quintas a sábados, 20h. De 1 a 15/11.", EDITION))

    def test_no_date(self):
        self.assertIsNone(first_date("R$50 R$25 R$15", EDITION))

    def test_impossible_date(self):
        self.assertIsNone(first_date("Dia 31/11.", EDITION))

    def test_december_edition_rolls_into_january(self):
        self.assertEqual(first_date("Dia 8/1.", (12, 2026)), date(2027, 1, 8))


class ParsePriceTests(unittest.TestCase):
    def test_reads_full_half_and_member(self):
        self.assertEqual(parse_price("Dia 5/11. R$70 R$35 R$21"), {"full": 70, "half": 35, "member": 21, "varies": False})

    def test_reads_cents(self):
        self.assertEqual(parse_price("R$30,50 R$15,25 R$9")["full"], 30.5)

    def test_uses_the_cheapest_when_prices_vary(self):
        price = parse_price("Dia 5/11. R$60 R$30 R$18 Dia 6/11. R$30 R$15 R$9")
        self.assertEqual((price["full"], price["half"], price["member"], price["varies"]), (30, 15, 9, True))

    def test_free(self):
        self.assertEqual(parse_price("Dia 5/11. GRÁTIS."), "free")

    def test_not_stated(self):
        self.assertIsNone(parse_price("Dia 5/11."))


class ScheduleTextTests(unittest.TestCase):
    def test_removes_prices(self):
        self.assertEqual(schedule_text("De 19/11 a 13/12. Quintas, 20h. R$70 R$35 R$21 (às sextas)."), "De 19/11 a 13/12. Quintas, 20h.")


class EstimatedSaleTests(unittest.TestCase):
    def test_matches_the_table_printed_in_the_november_booklet(self):
        table = {
            date(2026, 11, 2): date(2026, 10, 27),
            date(2026, 11, 8): date(2026, 10, 27),
            date(2026, 11, 9): date(2026, 11, 3),
            date(2026, 11, 22): date(2026, 11, 10),
            date(2026, 11, 23): date(2026, 11, 17),
            date(2026, 12, 6): date(2026, 11, 24),
        }
        for premiere, sale in table.items():
            self.assertEqual(estimated_sale(premiere), sale, premiere)


class SamePlayTests(unittest.TestCase):
    def test_ignores_accents_and_case(self):
        self.assertTrue(same_play("CÃO", "Cão"))

    def test_small_differences_match(self):
        self.assertTrue(same_play("A Hora e a Vez", "A Hora e Vez"))

    def test_shortened_titles_match(self):
        self.assertTrue(same_play("Os Amores de Lorca, ou o Amor Dorme no Peito do Poeta", "Os Amores de Lorca"))

    def test_different_plays_do_not_match(self):
        self.assertFalse(same_play("Reality Show", "Rei Menino"))

    def test_short_titles_need_to_be_equal(self):
        self.assertFalse(same_play("Cão", "A Coleção de Cão e Gato"))


class BuildEstimatesTests(unittest.TestCase):
    def test_builds_a_forecast(self):
        drop = build(entry())[0]
        self.assertTrue(drop["estimated"])
        self.assertEqual(drop["online_sale_start"], "2026-11-10T17:00")
        self.assertEqual(drop["url"], f"{BOOKLET_URL}#page=28")
        self.assertTrue(drop["confirm_url"].endswith("unidades=pompeia"))
        self.assertEqual((drop["unit"], drop["unit_slug"], drop["region"]), ("Pompeia", "pompeia", "capital"))
        self.assertEqual((drop["price_full"], drop["price_half"], drop["price_member"]), (70, 35, 21))
        self.assertEqual(drop["dates"], ["2026-11-19"])
        self.assertEqual(drop["schedule"], "De 19/11 a 13/12. Quintas a sábados, 20h.")
        self.assertIsNone(drop["buy_url"])

    def test_matches_booklet_unit_names_in_capitals(self):
        self.assertEqual(build(entry(place="24 DE MAIO"))[0]["unit"], "24 de Maio")

    def test_skips_a_play_the_api_already_lists(self):
        self.assertEqual(build(entry(), shows=[show("Reality Show")]), [])

    def test_keeps_a_play_the_api_lists_at_another_unit(self):
        self.assertEqual(len(build(entry(), shows=[show("Reality Show", "24 de Maio")])), 1)

    def test_skips_free_plays(self):
        self.assertEqual(build(entry(when="De 19/11 a 13/12. GRÁTIS.")), [])

    def test_skips_running_seasons(self):
        self.assertEqual(build(entry(when="Até 14/11. R$60 R$30 R$18")), [])

    def test_skips_entries_without_dates(self):
        self.assertEqual(build(entry(when="R$50 R$25 R$15")), [])

    def test_skips_sales_already_open(self):
        self.assertEqual(build(entry(when="De 10/11 a 13/12. R$60 R$30 R$18")), [])

    def test_keeps_a_sale_opening_later_today(self):
        now = datetime(2026, 11, 3, 16, 59, tzinfo=SAO_PAULO)
        self.assertEqual(len(build(entry(when="De 10/11 a 13/12. R$60 R$30 R$18"), now=now)), 1)

    def test_skips_a_sale_opening_this_minute(self):
        now = datetime(2026, 11, 3, 17, 0, tzinfo=SAO_PAULO)
        self.assertEqual(build(entry(when="De 10/11 a 13/12. R$60 R$30 R$18"), now=now), [])

    def test_skips_premieres_past_the_window(self):
        self.assertEqual(build(entry(when="De 5/12 a 13/12. R$60 R$30 R$18")), [])

    def test_skips_unknown_units(self):
        logging.disable(logging.WARNING)
        self.addCleanup(logging.disable, logging.NOTSET)
        self.assertEqual(build(entry(place="UNIDADE NOVA")), [])

    def test_keeps_a_play_with_no_price_stated(self):
        drop = build(entry(when="De 19/11 a 13/12."))[0]
        self.assertIsNone(drop["price_full"])

    def test_sub_title_inherits_the_series_price(self):
        series = entry(name="TEATRO MÍNIMO", when="R$50 R$25 R$15")
        play = entry(name="Peça para os Homens", when="De 20/11 a 13/12. Sextas, 21h.", is_main=False)
        self.assertEqual(build(series, play)[0]["price_full"], 50)

    def test_sub_title_inherits_a_free_series(self):
        series = entry(name="PARA A FAMÍLIA", when="GRÁTIS.")
        play = entry(name="Hoje Tem Festa", when="De 20 a 22/11.", is_main=False)
        self.assertEqual(build(series, play), [])

    def test_own_price_beats_the_series_price(self):
        series = entry(name="TEATRO MÍNIMO", when="R$50 R$25 R$15")
        play = entry(name="Circo Secreto", when="Dia 20/11. GRÁTIS.", is_main=False)
        self.assertEqual(build(series, play), [])

    def test_series_price_does_not_leak_to_another_unit(self):
        series = entry(name="TEATRO MÍNIMO", when="R$50 R$25 R$15")
        play = entry(name="Outra Peça", when="De 20/11 a 13/12.", place="24 DE MAIO", is_main=False)
        self.assertIsNone(build(series, play)[0]["price_full"])

    def test_series_ends_at_the_next_main_title(self):
        series = entry(name="TEATRO MÍNIMO", when="R$50 R$25 R$15")
        main = entry(name="Outra Peça", when="De 20/11 a 13/12. R$70 R$35 R$21")
        play = entry(name="Terceira", when="De 20/11 a 13/12.", is_main=False)
        self.assertIsNone(build(series, main, play)[1]["price_full"])


class FailingApi:
    def get_file(self, url):
        raise RuntimeError("boom")


def published_drop(name="Reality Show", opens="2026-11-10T17:00", place="Pompeia", premiere="2026-11-19", estimated=True):
    drop = {"title": name, "unit": place, "online_sale_start": opens, "dates": [premiere]}
    return {**drop, "estimated": True} if estimated else drop


class ReuseEstimatesTests(unittest.TestCase):
    def reuse(self, *drops, shows=()):
        return reuse_estimates({"drops": list(drops)}, list(shows), NOW, END)

    def test_keeps_a_forecast_still_to_come(self):
        drop = published_drop()
        self.assertEqual(self.reuse(drop), [drop])

    def test_ignores_plays_that_came_from_the_api(self):
        self.assertEqual(self.reuse(published_drop(estimated=False)), [])

    def test_drops_a_forecast_whose_time_has_passed(self):
        self.assertEqual(self.reuse(published_drop(opens="2026-11-04T12:00")), [])

    def test_drops_a_forecast_past_the_window(self):
        self.assertEqual(self.reuse(published_drop(premiere="2026-12-05")), [])

    def test_drops_a_forecast_the_api_now_lists(self):
        self.assertEqual(self.reuse(published_drop(), shows=[show("Reality Show")]), [])

    def test_keeps_a_forecast_when_the_title_is_listed_at_another_unit(self):
        drop = published_drop()
        self.assertEqual(self.reuse(drop, shows=[show("Reality Show", "Belenzinho")]), [drop])


class LoadPublishedTests(unittest.TestCase):
    def test_reads_a_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "plays.json"
            path.write_text('{"drops": []}', encoding="utf-8")
            self.assertEqual(load_published(path), {"drops": []})

    def test_reads_a_url(self):
        url = "https://someone.github.io/ticket-drop/plays.json"
        with mock.patch("ticket_drop.booklet.urllib.request.urlopen", return_value=io.BytesIO(b'{"drops": []}')) as opener:
            self.assertEqual(load_published(url), {"drops": []})
        request = opener.call_args.args[0]
        self.assertEqual(request.full_url, url)
        self.assertEqual(request.get_header("User-agent"), USER_AGENT)


class UnreadableBookletApi:
    """The booklet can't be downloaded, but the listing still works."""

    def __init__(self, shows=()):
        self.shows = list(shows)

    def get_file(self, url):
        raise OSError("no booklet today")

    def list_shows(self, start, end):
        return self.shows


class AddEstimatesTests(unittest.TestCase):
    def setUp(self):
        logging.disable(logging.WARNING)
        self.addCleanup(logging.disable, logging.NOTSET)
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.path = Path(folder.name) / "plays.json"
        self.dataset = {
            "window": {"end": "2026-12-04"},
            "drops": [published_drop("Cão", "2026-11-17T17:00", estimated=False)],
        }

    def titles(self):
        return [drop["title"] for drop in self.dataset["drops"]]

    def publish(self, *drops):
        self.path.write_text(json.dumps({"drops": list(drops)}), encoding="utf-8")

    def test_any_failure_leaves_the_dataset_unchanged(self):
        dataset = {"window": {"end": "2026-12-04"}, "drops": [{"title": "Cão"}]}
        self.assertFalse(add_booklet_estimates(dataset, FailingApi(), NOW))
        self.assertEqual(dataset["drops"], [{"title": "Cão"}])

    def test_a_failure_keeps_the_last_published_forecasts_in_order(self):
        self.publish(published_drop())
        self.assertFalse(add_booklet_estimates(self.dataset, UnreadableBookletApi(), NOW, self.path))
        self.assertEqual(self.titles(), ["Reality Show", "Cão"])

    def test_a_failure_does_not_keep_a_forecast_the_api_now_lists(self):
        self.publish(published_drop())
        api = UnreadableBookletApi([show("Reality Show")])
        self.assertFalse(add_booklet_estimates(self.dataset, api, NOW, self.path))
        self.assertEqual(self.titles(), ["Cão"])

    def test_kept_forecasts_can_be_kept_again_the_next_day(self):
        self.publish(published_drop())
        add_booklet_estimates(self.dataset, UnreadableBookletApi(), NOW, self.path)
        self.path.write_text(json.dumps(self.dataset), encoding="utf-8")
        self.dataset["drops"] = [published_drop("Cão", "2026-11-17T17:00", estimated=False)]
        add_booklet_estimates(self.dataset, UnreadableBookletApi(), NOW, self.path)
        self.assertEqual(self.titles(), ["Reality Show", "Cão"])

    def test_a_missing_published_file_leaves_the_dataset_unchanged(self):
        self.assertFalse(add_booklet_estimates(self.dataset, UnreadableBookletApi(), NOW, self.path))
        self.assertEqual(self.titles(), ["Cão"])

    def test_a_corrupt_published_file_leaves_the_dataset_unchanged(self):
        self.path.write_text("<html>Not found</html>", encoding="utf-8")
        self.assertFalse(add_booklet_estimates(self.dataset, UnreadableBookletApi(), NOW, self.path))
        self.assertEqual(self.titles(), ["Cão"])

    def test_a_failing_listing_leaves_the_dataset_unchanged(self):
        self.publish(published_drop())
        self.assertFalse(add_booklet_estimates(self.dataset, FailingApi(), NOW, self.path))
        self.assertEqual(self.titles(), ["Cão"])

    def test_adds_the_estimates_in_order(self):
        estimate = published_drop("Previsão")
        with mock.patch("ticket_drop.booklet.collect_estimates", return_value=[estimate]):
            self.assertTrue(add_booklet_estimates(self.dataset, UnreadableBookletApi(), NOW, self.path))
        self.assertEqual(self.titles(), ["Previsão", "Cão"])

    def test_a_readable_booklet_does_not_fetch_the_published_page(self):
        with (
            mock.patch("ticket_drop.booklet.collect_estimates", return_value=[]),
            mock.patch("ticket_drop.booklet.load_published") as load,
        ):
            add_booklet_estimates(self.dataset, UnreadableBookletApi(), NOW, self.path)
        load.assert_not_called()


if __name__ == "__main__":
    unittest.main()
