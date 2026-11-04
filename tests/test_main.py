import contextlib
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from ticket_drop import __main__ as cli
from ticket_drop.plays import CollectError

DATASET = {
    "generated_at": "2026-11-03T13:00:00-03:00",
    "window": {"start": "2026-11-03", "end": "2026-12-03", "days": 30},
    "regions": {"capital": "Capital e Grande SP"},
    "drops": [],
}


class BuildTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.out = Path(folder.name) / "site"
        for patcher in (
            mock.patch.object(cli.logging, "basicConfig"),
            mock.patch.object(cli, "log"),
            mock.patch.object(cli, "SescApi"),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def run_build(self, booklet_ok=True, on_github=True, collect_error=None, args=()):
        environment = {key: value for key, value in os.environ.items() if key != "GITHUB_ACTIONS"}
        if on_github:
            environment["GITHUB_ACTIONS"] = "true"
        printed = io.StringIO()
        with (
            mock.patch.dict(os.environ, environment, clear=True),
            mock.patch.object(cli, "collect", return_value=DATASET, side_effect=collect_error),
            mock.patch.object(cli, "add_booklet_estimates", return_value=booklet_ok) as self.add_estimates,
            contextlib.redirect_stdout(printed),
        ):
            code = cli.main(["--out", str(self.out), *args])
        return code, printed.getvalue()

    def test_a_booklet_failure_warns_on_github_and_still_publishes(self):
        code, printed = self.run_build(booklet_ok=False)
        self.assertEqual(code, 0)
        self.assertTrue(printed.startswith("::warning "))
        self.assertTrue((self.out / "index.html").exists())

    def test_a_good_build_does_not_warn(self):
        code, printed = self.run_build()
        self.assertEqual((code, printed), (0, ""))

    def test_a_booklet_failure_outside_github_only_logs(self):
        code, printed = self.run_build(booklet_ok=False, on_github=False)
        self.assertEqual((code, printed), (0, ""))
        self.assertTrue((self.out / "index.html").exists())

    def test_keeps_forecasts_from_the_output_folder_by_default(self):
        self.run_build()
        self.assertEqual(self.add_estimates.call_args.args[3], self.out / "plays.json")

    def test_can_keep_forecasts_from_the_published_page(self):
        url = "https://someone.github.io/ticket-drop/plays.json"
        self.run_build(args=["--previous", url])
        self.assertEqual(self.add_estimates.call_args.args[3], url)

    def test_an_api_failure_fails_the_run_and_writes_nothing(self):
        code, _ = self.run_build(collect_error=CollectError("boom"))
        self.assertEqual(code, 1)
        self.assertFalse(self.out.exists())


if __name__ == "__main__":
    unittest.main()
