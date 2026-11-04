import json
import re
import tempfile
import unittest
from pathlib import Path

from ticket_drop.render import PLACEHOLDER, render_page, write_site

DATASET = {
    "generated_at": "2026-11-03T13:00:00-03:00",
    "window": {"start": "2026-11-03", "end": "2026-12-03", "days": 30},
    "regions": {"capital": "Capital e Grande SP"},
    "drops": [
        {
            "title": "</script><script>alert(1)</script> Cão",
            "unit": "Consolação",
            "region": "capital",
            "url": "https://www.sescsp.org.br/programacao/cao",
            "online_sale_start": "2026-11-10T17:00",
            "dates": ["2026-11-19"],
            "sessions": [{"start": "2026-11-19T20:00", "online_left": 20, "in_person_left": 5}],
        }
    ],
}


def embedded_json(page):
    return re.search(r'<script id="data" type="application/json">(.*?)</script>', page, re.S).group(1)


class RenderTests(unittest.TestCase):
    def test_fills_the_placeholder(self):
        self.assertNotIn(PLACEHOLDER, render_page(DATASET))

    def test_api_text_cannot_close_the_script_tag(self):
        self.assertNotIn("<script>alert", render_page(DATASET))

    def test_embedded_data_round_trips(self):
        self.assertEqual(json.loads(embedded_json(render_page(DATASET))), DATASET)

    def test_writes_the_page_and_data(self):
        with tempfile.TemporaryDirectory() as folder:
            out = Path(folder) / "nested" / "site"
            write_site(DATASET, out)
            self.assertIn("Quando Abre", (out / "index.html").read_text(encoding="utf-8"))
            self.assertEqual(json.loads((out / "plays.json").read_text(encoding="utf-8")), DATASET)

    def test_writes_a_calendar_per_region_with_crlf_on_every_platform(self):
        with tempfile.TemporaryDirectory() as folder:
            out = Path(folder)
            write_site(DATASET, out)
            for name in ["calendar.ics", "calendar-capital.ics", "calendar-interior.ics", "calendar-litoral.ics"]:
                content = (out / name).read_bytes()
                self.assertTrue(content.startswith(b"BEGIN:VCALENDAR\r\n"), name)
                self.assertNotIn(b"\r\r\n", content, name)
            self.assertIn(b"VEVENT", (out / "calendar-capital.ics").read_bytes())
            self.assertNotIn(b"VEVENT", (out / "calendar-interior.ics").read_bytes())


if __name__ == "__main__":
    unittest.main()
