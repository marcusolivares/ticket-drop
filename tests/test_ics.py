import unittest

from ticket_drop.ics import build_calendar, feed_name

GENERATED_AT = "2026-11-04T06:17:00-03:00"


def drop(title="Cão", opens="2026-11-10T17:00", region="capital", unit="Consolação", online_left=20, **overrides):
    return {
        "title": title,
        "unit": unit,
        "region": region,
        "url": "https://www.sescsp.org.br/programacao/cao",
        "online_sale_start": opens,
        "dates": ["2026-11-19", "2026-11-20"],
        "sessions": [{"start": "2026-11-19T20:00", "online_left": online_left, "in_person_left": 5}],
        **overrides,
    }


def calendar(*drops, region=None):
    return build_calendar({"generated_at": GENERATED_AT, "drops": list(drops)}, region)


def unfolded(text):
    return text.replace("\r\n ", "")


class FeedNameTests(unittest.TestCase):
    def test_names(self):
        self.assertEqual(feed_name(), "calendar.ics")
        self.assertEqual(feed_name("interior"), "calendar-interior.ics")


class FormatTests(unittest.TestCase):
    def test_uses_crlf_line_endings_only(self):
        text = calendar(drop())
        self.assertTrue(text.endswith("END:VCALENDAR\r\n"))
        self.assertNotIn("\n", text.replace("\r\n", ""))

    def test_lines_fit_in_75_bytes_without_splitting_characters(self):
        text = calendar(drop(title="Peça com ção e acentuação " * 12))
        for line in text.split("\r\n"):
            self.assertLessEqual(len(line.encode("utf-8")), 75)
        self.assertIn("Peça com ção e acentuação " * 2, unfolded(text))

    def test_escapes_special_characters(self):
        text = unfolded(calendar(drop(title="Sim, não; talvez \\ agora")))
        self.assertIn("Sim\\, não\\; talvez \\\\ agora", text)

    def test_converts_sao_paulo_time_to_utc(self):
        text = calendar(drop())
        self.assertIn("DTSTART:20261110T200000Z\r\n", text)
        self.assertIn("DTEND:20261110T203000Z\r\n", text)
        self.assertIn("DTSTAMP:20261104T091700Z\r\n", text)

    def test_sets_a_reminder(self):
        self.assertIn("TRIGGER:-PT1H\r\n", calendar(drop()))

    def test_empty_calendar_is_still_well_formed(self):
        text = calendar()
        self.assertTrue(text.startswith("BEGIN:VCALENDAR\r\n"))
        self.assertNotIn("VEVENT", text)


class EventTests(unittest.TestCase):
    def test_one_play_is_named_in_the_summary(self):
        self.assertIn("SUMMARY:Abre a venda: Cão\r\n", calendar(drop()))

    def test_groups_plays_opening_at_the_same_moment(self):
        text = unfolded(calendar(drop(), drop(title="Surda", unit="Ipiranga")))
        self.assertEqual(text.count("BEGIN:VEVENT"), 1)
        self.assertIn("SUMMARY:Abre a venda de 2 peças\r\n", text)
        self.assertIn("Cão · Consolação · 19 a 20 nov", text)
        self.assertIn("Surda · Ipiranga", text)

    def test_separates_different_moments_in_order(self):
        text = calendar(drop(opens="2026-11-17T17:00"), drop(title="Surda"))
        self.assertEqual(text.count("BEGIN:VEVENT"), 2)
        self.assertLess(text.index("DTSTART:20261110"), text.index("DTSTART:20261117"))

    def test_mentions_the_opening_time(self):
        self.assertIn("a partir das 12h30", unfolded(calendar(drop(opens="2026-11-10T12:30"))))

    def test_flags_plays_with_no_online_tickets(self):
        self.assertIn("sem ingressos on-line listados", unfolded(calendar(drop(online_left=0))))

    def test_dates_across_months_name_both(self):
        text = unfolded(calendar(drop(dates=["2026-11-28", "2026-12-03"])))
        self.assertIn("28 nov a 3 dez", text)

    def test_uid_is_stable_and_differs_by_feed(self):
        self.assertIn("UID:2026-11-10T1700-capital@ticket-drop\r\n", calendar(drop(), region="capital"))
        self.assertIn("UID:2026-11-10T1700-all@ticket-drop\r\n", calendar(drop()))


class EstimatedPlayTests(unittest.TestCase):
    def estimate(self, title="Reality Show"):
        return drop(title=title, unit="Pompeia", online_left=0, estimated=True, dates=["2026-11-19"], sessions=[])

    def test_says_it_is_a_forecast(self):
        text = unfolded(calendar(self.estimate()))
        self.assertIn("SUMMARY:Previsão de abertura: Reality Show\r\n", text)
        self.assertIn("Reality Show · Pompeia · a partir de 19 nov · previsão obtida no livreto\\, sujeita a mudanças", text)
        self.assertNotIn("sem ingressos", text)

    def test_counts_several_forecasts(self):
        text = unfolded(calendar(self.estimate(), self.estimate("Surda")))
        self.assertIn("SUMMARY:Previsão: abre a venda de 2 peças\r\n", text)

    def test_a_mix_is_a_regular_event_with_confirmed_plays_first(self):
        text = unfolded(calendar(self.estimate(), drop(unit="Santana")))
        self.assertIn("SUMMARY:Abre a venda de 2 peças\r\n", text)
        self.assertLess(text.index("Cão · Santana"), text.index("Reality Show · Pompeia"))


class RegionTests(unittest.TestCase):
    def test_keeps_only_the_region(self):
        drops = [drop(), drop(title="Otelo", unit="Bauru", region="interior")]
        text = unfolded(calendar(*drops, region="interior"))
        self.assertIn("Otelo", text)
        self.assertNotIn("Cão", text)
        self.assertIn("X-WR-CALNAME:Quando Abre: Interior\r\n", text)

    def test_no_region_includes_everything(self):
        drops = [drop(), drop(title="Otelo", unit="Bauru", region="interior")]
        text = unfolded(calendar(*drops))
        self.assertIn("Otelo", text)
        self.assertIn("Cão", text)
        self.assertIn("X-WR-CALNAME:Quando Abre\r\n", text)


if __name__ == "__main__":
    unittest.main()
