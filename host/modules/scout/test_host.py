"""Exercise scheduling and the public one-shot protocol without a live board."""
from datetime import datetime, timedelta
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


HOST = Path(__file__).parent / "bin/host.py"
spec = importlib.util.spec_from_file_location("scout_host", HOST)
host = importlib.util.module_from_spec(spec)
# Loading the host in tests must also work in a read-only module bundle.
with patch.object(sys, "dont_write_bytecode", True):
    spec.loader.exec_module(host)


class ScoutTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.ops = self.root / "ops"
        (self.ops / "scouts").mkdir(parents=True)
        self.state = self.root / "state"
        self.environment = patch.dict(os.environ, {
            "SCOUT_OPS": str(self.ops), "PANEL_STATE_DIR": str(self.state)})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.current = datetime.fromisoformat("2026-10-25T09:00:00+03:00")

    def scout(self, scout_id="sample", fields="agent: codex\nevery: daily"):
        path = self.ops / "scouts" / (scout_id + ".md")
        path.write_text("---\ntitle: Sample\n" + fields + "\n---\n# Brief\n\nCheck this.\n", encoding="utf-8")
        return host.read_scout(path)

    def call(self, method, path, body=None):
        result = subprocess.run([sys.executable, "-B", str(HOST), method, path],
                                input=json.dumps(body) if body is not None else "",
                                text=True, capture_output=True, timeout=6)
        self.assertEqual(result.returncode, 0, result.stderr)
        header, payload = result.stdout.split("\n\n", 1)
        status, content_type = header.split("\n")
        self.assertEqual(content_type, "application/json")
        return int(status), json.loads(payload)

    def test_due_and_next_at(self):
        cases = [
            ("daily", "2026-10-25T07:00:00+03:00", None, False, "2026-10-25T08:00:00+03:00"),
            ("daily", "2026-10-25T08:00:00+03:00", None, True, None),
            ("daily", "2026-10-25T09:00:00+03:00", 1, False, "2026-10-26T08:00:00+03:00"),
            ("sunday", "2026-10-25T07:00:00+03:00", None, False, "2026-10-25T08:00:00+03:00"),
            ("sunday", "2026-10-25T09:00:00+03:00", None, True, None),
            ("sunday", "2026-10-25T09:00:00+03:00", 1, False, "2026-11-01T08:00:00+03:00"),
            ("sunday", "2026-10-26T09:00:00+03:00", None, False, "2026-11-01T08:00:00+03:00"),
            ("sunday", "2026-10-26T09:00:00+03:00", 8 * 24, True, None),
            ("sunday", "2026-10-31T09:00:00+03:00", 5 * 24, False, "2026-11-01T08:00:00+03:00"),
            ("3h", "2026-10-25T09:00:00+03:00", 3, True, None),
            ("3h", "2026-10-25T09:00:00+03:00", 1, False, "2026-10-25T11:00:00+03:00"),
            ("3h", "2026-10-25T09:00:00+03:00", None, True, None),
            ("manual", "2026-10-25T09:00:00+03:00", None, False, None),
        ]
        for every, timestamp, age, due, next_at in cases:
            with self.subTest(every=every, timestamp=timestamp, age=age):
                scout = self.scout(fields="agent: codex\nevery: " + every)
                current = datetime.fromisoformat(timestamp)
                last = {"at": (current - timedelta(hours=age)).isoformat()} if age is not None else None
                self.assertEqual(host.schedule(scout, last, current), (due, next_at))

    def test_run_past_midnight_counts_for_the_day_it_started(self):
        scout = self.scout(fields="agent: codex\nevery: daily")
        start = datetime.fromisoformat("2026-10-25T23:50:00+03:00")
        with patch.object(host, "now", return_value=start):
            host.record(scout["id"], "running", session="s")
        with patch.object(host, "now", return_value=start + timedelta(minutes=15)):
            last = host.record(scout["id"], "done")
        morning = datetime.fromisoformat("2026-10-26T09:00:00+03:00")
        self.assertEqual(host.schedule(scout, last, morning), (True, None))

    def test_invalid_scout_never_due(self):
        for fields in ("agent: codex\nrun: true", "every: daily", "agent: codex\nafter: 24"):
            with self.subTest(fields=fields):
                scout = self.scout(fields=fields + "\nevery: daily")
                self.assertTrue(scout["error"])
                self.assertEqual(host.schedule(scout, None, self.current), (False, None))

    def test_listing_and_stale(self):
        self.scout("zebra")
        self.scout("alpha", "agent: codex\nevery: 3h")
        self.scout("_rules")
        with patch.object(host, "now", return_value=self.current - timedelta(hours=2, minutes=1)):
            host.record("zebra", "running", session="session-1")
        with patch.object(host, "now", return_value=self.current):
            result = host.listing()
        self.assertEqual([s["id"] for s in result["scouts"]], ["alpha", "zebra"])
        self.assertEqual(result["now"], self.current.isoformat())
        self.assertEqual(result["next_due_at"], "2026-10-26T08:00:00+03:00")
        zebra = result["scouts"][1]
        self.assertEqual(zebra["last"]["status"], "stale")
        self.assertFalse(zebra["due"])
        self.assertEqual(zebra["summary"], "Check this.")
        self.assertEqual(host.read_json(self.state / "runs.json", {})["zebra"]["status"], "running")

    def fake_board(self):
        script = self.root / "fake board.py"
        self.args_file = self.root / "args.jsonl"
        script.write_text(
            "import json, sys\n"
            "with open(" + repr(str(self.args_file)) + ", 'a') as f:\n"
            "    f.write(json.dumps(sys.argv[1:]) + '\\n')\n"
            "if sys.argv[1] == 'json': print('{\"issues\": []}')\n", encoding="utf-8")
        os.environ["SCOUT_BOARD"] = shlex.join([sys.executable, str(script)])

    def test_script_run_files_finding(self):
        self.fake_board()
        self.scout(fields="run: printf 'FOUND A thing | why\\nall good\\n'")
        status, result = self.call("POST", "/run", {"id": "sample"})
        self.assertEqual(status, 200)
        self.assertEqual((result["found"], result["note"], result["status"]), (1, "all good", "done"))
        arguments = json.loads(self.args_file.read_text().strip())
        self.assertEqual(arguments, ["file", "A thing", "--body", "why\nFound by scout sample."])

    def test_failed_script(self):
        self.scout(fields="run: printf 'bad news\\n' >&2; exit 2")
        status, result = self.call("POST", "/run", {"id": "sample"})
        self.assertEqual(status, 200)
        self.assertEqual((result["status"], result["note"]), ("failed", "bad news"))

    def test_timeout_and_board_share_budget(self):
        scout = self.scout(fields="run: true")
        with patch.object(host, "command", return_value=(-9, "", "", True)):
            result = host.run_scout(scout)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["note"], "timed out after 50 s")
        with patch.object(host.time, "monotonic", side_effect=[100, 101, 102, 103]), \
                patch.object(host, "command", side_effect=[(0, "FOUND Title\n", "", False),
                                                         (0, "", "", False)]) as command:
            result = host.run_scout(scout)
        self.assertEqual(result["status"], "done")
        self.assertEqual(command.call_args_list[0].args[1], 48.5)
        self.assertEqual(command.call_args_list[1].args[1], 46.5)

    def test_command_timeout_returns_promptly(self):
        code, _, _, expired = host.command(["bash", "-c", "sleep 30 & wait"], 0.05)
        self.assertTrue(expired)
        self.assertNotEqual(code, 0)

    def test_record_cli(self):
        self.state.mkdir()
        (self.state / "board.json").write_text("{}")
        result = subprocess.run([sys.executable, "-B", str(HOST), "record", "sample",
                                 "--found", "2", "--note", "Two findings"],
                                text=True, capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "recorded sample\n")
        stored = json.loads((self.state / "runs.json").read_text())["sample"]
        self.assertEqual((stored["status"], stored["found"], stored["note"]), ("done", 2, "Two findings"))
        self.assertIsNotNone(datetime.fromisoformat(stored["at"]).utcoffset())
        self.assertFalse((self.state / "board.json").exists())

    def test_agent_start_record_and_prompt(self):
        self.scout()
        self.assertEqual(self.call("POST", "/run", {"id": "sample"})[0], 400)
        self.assertEqual(self.call("POST", "/run", {"id": "missing"})[0], 400)
        status, result = self.call("POST", "/start", {"id": "sample", "session": "abc"})
        self.assertEqual(status, 200)
        self.assertEqual((result["status"], result["session"]), ("running", "abc"))
        status, result = self.call("POST", "/record", {"id": "sample", "status": "done", "found": 1, "note": "Found it"})
        self.assertEqual(status, 200)
        self.assertEqual(result["session"], "abc")
        status, result = self.call("GET", "/prompt?id=sample")
        self.assertEqual(status, 200)
        self.assertNotIn("\n", result["prompt"])
        self.assertIn(str(HOST.resolve()), result["prompt"])
        self.assertIn(str(self.ops / "scouts/_rules.md"), result["prompt"])

    def test_start_if_due_goes_to_one_session(self):
        self.scout(fields="agent: claude\nevery: 3h")
        self.assertEqual(self.call("POST", "/start", {"id": "sample", "session": "a", "if_due": True})[0], 200)
        status, result = self.call("POST", "/start", {"id": "sample", "session": "b", "if_due": True})
        self.assertEqual((status, result["error"]), (409, "not due"))
        self.assertEqual(json.loads((self.state / "runs.json").read_text())["sample"]["session"], "a")

    def test_board_cache_and_refresh(self):
        self.fake_board()
        self.assertEqual(self.call("GET", "/board"), (200, {"issues": []}))
        self.call("GET", "/board")
        self.assertEqual(len(self.args_file.read_text().splitlines()), 1)
        self.call("GET", "/board?fresh=1")
        self.assertEqual(len(self.args_file.read_text().splitlines()), 2)
        os.utime(self.state / "board.json", (0, 0))
        self.call("GET", "/board")
        self.assertEqual(len(self.args_file.read_text().splitlines()), 3)
        os.environ["SCOUT_BOARD"] = "/no/such/command"
        status, result = self.call("GET", "/board?fresh=1")
        self.assertEqual(status, 200)
        self.assertTrue(result["error"])

    def test_builds(self):
        os.environ["SCOUT_BUILDS"] = str(self.root / "builds")
        status, result = self.call("GET", "/builds")
        self.assertEqual((status, result["running"], result["recent"]), (200, [], []))
        reviews = self.ops / "reviews"
        reviews.mkdir()
        header = "\t".join(host.BUILD_COLUMNS)
        old = "2026-10-01\tsol\tmedium\tpanel\t9\t0\tabc"
        rows = [header, old] + ["2026-10-%02d\tluna\tlow\tpanel\t%d\t4\ts\tedit\tfix\ttask %d" % (d, d, d)
                                 for d in range(2, 16)]
        (reviews / "builds.tsv").write_text("\n".join(rows) + "\n", encoding="utf-8")
        marker_dir = self.root / "builds"
        marker_dir.mkdir()
        mine = {"pid": os.getpid(), "builder": "sol", "started": "2026-10-29T12:00:00+02:00"}
        (marker_dir / "1.json").write_text(json.dumps(mine))
        (marker_dir / "2.json").write_text(json.dumps(dict(mine, pid=os.getpid(), started="2026-10-29T11:00:00+02:00")))
        dead = subprocess.Popen([sys.executable, "-c", "pass"])
        dead.wait()
        (marker_dir / "3.json").write_text(json.dumps(dict(mine, pid=dead.pid)))
        (marker_dir / "4.json").write_text("not json")
        status, result = self.call("GET", "/builds")
        self.assertEqual([m["started"] for m in result["running"]],
                         ["2026-10-29T11:00:00+02:00", "2026-10-29T12:00:00+02:00"])
        self.assertEqual(len(result["recent"]), 12)
        self.assertEqual(result["recent"][0]["task"], "task 15")
        self.assertEqual(result["recent"][0]["exit"], "4")
        (reviews / "builds.tsv").write_text(header + "\n" + old + "\n", encoding="utf-8")
        status, result = self.call("GET", "/builds")
        self.assertEqual(result["recent"], [dict(zip(host.BUILD_COLUMNS,
                         ["2026-10-01", "sol", "medium", "panel", "9", "0", "abc", "-", "-", "-"]))])

    def test_no_route(self):
        self.assertEqual(self.call("GET", "/missing"), (404, {"error": "no route"}))


if __name__ == "__main__":
    unittest.main()
