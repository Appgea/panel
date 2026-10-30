"""A report's old day folder survives a send: media is never pruned by age alone."""
import datetime
import importlib.util
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("keep_media", HERE / "keep_media.py")
keep_media = importlib.util.module_from_spec(spec)
spec.loader.exec_module(keep_media)


class KeepMediaTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "reports"
        self.root.mkdir()
        old_day = datetime.date.today() - datetime.timedelta(days=200)
        self.old = self.root / old_day.isoformat() / "abc123"
        self.old.mkdir(parents=True)
        self.old_shot = self.old / "shot.png"
        self.old_shot.write_bytes(b"old")
        previous = keep_media.ROOT
        keep_media.ROOT = str(self.root)
        self.addCleanup(setattr, keep_media, "ROOT", previous)

    def test_a_report_pointing_at_an_old_day_folder_survives_a_send(self):
        payload = {"images": [{"path": str(self.old_shot)}]}
        keep_media.keep_media(payload)
        self.assertTrue(self.old.is_dir(), "the old day folder was deleted")
        self.assertTrue(self.old_shot.is_file(), "the old picture was deleted")
        kept = Path(payload["images"][0]["path"])
        self.assertNotEqual(kept, self.old_shot, "the send must copy, not reuse the old path")
        self.assertTrue(kept.is_file(), "the kept copy was not written")


if __name__ == "__main__":
    unittest.main()
