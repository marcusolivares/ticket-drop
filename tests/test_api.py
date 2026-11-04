import io
import json
import unittest
import urllib.error
import urllib.parse
from datetime import date

from ticket_drop import api as api_module
from ticket_drop.api import PAGE_SIZE, USER_AGENT, ApiError, SescApi


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def respond(payload):
    return FakeResponse(json.dumps(payload).encode())


def http_error(code):
    return urllib.error.HTTPError("https://example.test", code, "error", {}, io.BytesIO())


class FakeOpener:
    """Plays back a list of responses, where an exception is raised instead."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests = []

    def __call__(self, request, timeout=None):
        self.requests.append(request)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return respond(response)


def make_api(opener):
    return SescApi(delay=0, opener=opener, sleep=lambda seconds: None)


class ListPlaysTests(unittest.TestCase):
    def listing_page(self, count, total):
        return {"atividade": [{"id": n} for n in range(count)], "total": {"value": total}}

    def test_requests_theatre_for_the_date_range(self):
        opener = FakeOpener(self.listing_page(1, 1))
        make_api(opener).list_plays(date(2026, 11, 3), date(2026, 12, 3))
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(opener.requests[0].full_url).query)
        self.assertEqual(query["linguagem"], ["teatro"])
        self.assertEqual(query["data_inicial"], ["2026-11-03"])
        self.assertEqual(query["data_final"], ["2026-12-03"])

    def test_identifies_itself(self):
        opener = FakeOpener(self.listing_page(1, 1))
        make_api(opener).list_plays(date(2026, 11, 3), date(2026, 12, 3))
        self.assertEqual(opener.requests[0].get_header("User-agent"), USER_AGENT)

    def test_follows_pages_until_complete(self):
        opener = FakeOpener(self.listing_page(PAGE_SIZE, PAGE_SIZE + 2), self.listing_page(2, PAGE_SIZE + 2))
        items = make_api(opener).list_plays(date(2026, 11, 3), date(2026, 12, 3))
        self.assertEqual(len(items), PAGE_SIZE + 2)
        self.assertEqual(len(opener.requests), 2)

    def test_drops_null_rows(self):
        # A real listing had 559 rows, the last two of them null.
        page = {"atividade": [{"id": 1}, None, None], "total": {"value": 3}}
        items = make_api(FakeOpener(page)).list_plays(date(2026, 11, 3), date(2026, 12, 3))
        self.assertEqual(items, [{"id": 1}])

    def test_null_rows_count_towards_the_total(self):
        rows = [{"id": n} for n in range(PAGE_SIZE - 1)] + [None]
        opener = FakeOpener({"atividade": rows, "total": {"value": PAGE_SIZE}})
        items = make_api(opener).list_plays(date(2026, 11, 3), date(2026, 12, 3))
        self.assertEqual(len(items), PAGE_SIZE - 1)
        self.assertEqual(len(opener.requests), 1)

    def test_rejects_an_error_returned_as_a_string(self):
        # The API really does this: HTTP 200 with an error message as the body.
        opener = FakeOpener("Erro ao pesquisar documentos")
        with self.assertRaises(ApiError):
            make_api(opener).list_plays(date(2026, 11, 3), date(2026, 12, 3))


class ListShowsTests(unittest.TestCase):
    def test_requests_all_shows(self):
        opener = FakeOpener({"atividade": [], "total": {"value": 0}})
        make_api(opener).list_shows(date(2026, 11, 3), date(2026, 12, 3))
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(opener.requests[0].full_url).query)
        self.assertEqual(query["atividade"], ["shows-espetaculos-e-performances"])
        self.assertNotIn("linguagem", query)


class RawOpener:
    def __init__(self, data):
        self.data = data
        self.requests = []

    def __call__(self, request, timeout=None):
        self.requests.append(request)
        return FakeResponse(self.data)


class GetFileTests(unittest.TestCase):
    URL = "https://www.sescsp.org.br/wp-content/uploads/booklet.pdf"

    def test_returns_the_bytes(self):
        self.assertEqual(make_api(RawOpener(b"%PDF")).get_file(self.URL), b"%PDF")

    def test_refuses_other_sites(self):
        opener = RawOpener(b"x")
        with self.assertRaises(ApiError):
            make_api(opener).get_file("https://example.com/booklet.pdf")
        self.assertEqual(opener.requests, [])

    def test_refuses_lookalike_hosts(self):
        with self.assertRaises(ApiError):
            make_api(RawOpener(b"x")).get_file("https://www.sescsp.org.br.example.com/booklet.pdf")

    def test_refuses_oversized_files(self):
        original = api_module.MAX_FILE_BYTES
        api_module.MAX_FILE_BYTES = 3
        self.addCleanup(setattr, api_module, "MAX_FILE_BYTES", original)
        with self.assertRaises(ApiError):
            make_api(RawOpener(b"12345")).get_file(self.URL)


class GetDetailTests(unittest.TestCase):
    def test_returns_the_payload(self):
        detail = make_api(FakeOpener({"sessoes": []})).get_detail("cao")
        self.assertEqual(detail, {"sessoes": []})

    def test_returns_none_on_404_without_retrying(self):
        opener = FakeOpener(http_error(404))
        self.assertIsNone(make_api(opener).get_detail("missing"))
        self.assertEqual(len(opener.requests), 1)

    def test_rejects_an_unknown_shape(self):
        with self.assertRaises(ApiError):
            make_api(FakeOpener({"unexpected": True})).get_detail("cao")

    def test_retries_server_errors(self):
        opener = FakeOpener(http_error(503), {"sessoes": []})
        self.assertEqual(make_api(opener).get_detail("cao"), {"sessoes": []})
        self.assertEqual(len(opener.requests), 2)

    def test_retries_network_errors(self):
        opener = FakeOpener(urllib.error.URLError("reset"), {"sessoes": []})
        self.assertEqual(make_api(opener).get_detail("cao"), {"sessoes": []})

    def test_gives_up_after_the_retry_limit(self):
        opener = FakeOpener(http_error(500), http_error(500), http_error(500))
        with self.assertRaises(ApiError):
            make_api(opener).get_detail("cao")
        self.assertEqual(len(opener.requests), 3)

    def test_does_not_retry_client_errors(self):
        opener = FakeOpener(http_error(403))
        with self.assertRaises(ApiError):
            make_api(opener).get_detail("cao")
        self.assertEqual(len(opener.requests), 1)


if __name__ == "__main__":
    unittest.main()
