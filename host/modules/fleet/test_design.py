"""Fleet Design writes the files the fleet runs on, so an unchanged save must leave them byte for byte, and Undo
must put a change back whole. Runs on copies of the real ops and skills files when they are there."""
import importlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

BIN = Path(__file__).parent / "bin"
REAL = Path.home() / ".appgeapanel"


class DesignTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        ops, skills = self.root / "ops", self.root / "skills/fleet"
        (ops / "runbooks").mkdir(parents=True)
        skills.mkdir(parents=True)
        if (REAL / "ops/scouts").is_dir():
            shutil.copytree(REAL / "ops/scouts", ops / "scouts")
            shutil.copy(REAL / "skills/fleet/kinds.md", skills)
        else:
            (ops / "scouts/abilities").mkdir(parents=True)
            (ops / "scouts/keeper.md").write_text("---\ntitle: K\nwho: a payer\n---\n\nAbilities, in `scouts/abilities/`:\n- `a`: A\n\nRest.\n")
            (ops / "scouts/abilities/a.md").write_text("---\ntitle: A?\nfamily: keeper\n---\n\nSteps.\n\n## Learned\n")
            (skills / "kinds.md").write_text("# Work kinds\n\n## fix\nWhen: A defect.\nRead: none\n- One.\n\n## text\nWhen: Strings.\nRead: none\n- Two.\n")
        (skills / "bots.md").write_text("# Bots\n\n## terra\nCharacter: The Workhorse.\nAngle: Code.\n- Note.\n")
        os.environ.update(FLEET_OPS=str(ops), FLEET_SKILLS=str(self.root / "skills"), PANEL_STATE_DIR=str(self.root / "state"))
        sys.path.insert(0, str(BIN))
        self.d = importlib.reload(importlib.import_module("design"))
        self.before = self.snapshot()

    def tearDown(self):
        sys.path.remove(str(BIN))
        shutil.rmtree(self.root)

    def snapshot(self):
        return {p: p.read_text() for p in sorted(self.root.rglob("*.md"))}

    def call(self, route, **req):
        reply = self.d.handle("POST", route, json.dumps(req))[1]
        self.assertNotIn("refused", reply, reply.get("refused"))
        return reply

    def test_unchanged_save_keeps_every_file(self):
        data = self.d.everything()
        for it in data["bots"] + data["kinds"] + data["lenses"] + data["routines"] + data["abilities"]:
            self.call("/design/save", type=it["type"], id=it["id"], meta=it["meta"], body=it["body"], sig=it["sig"])
        self.assertEqual(self.snapshot(), self.before)

    def test_new_ability_joins_its_lens_list_and_undo_removes_it(self):
        lens = next(lens for lens in self.d.everything()["lenses"] if self.d.LIST_HEAD.search(lens["body"]))
        self.call("/design/save", type="ability", id="zz-new", new=True, body="Steps.\n",
                  meta=[["title", "New?"], ["family", lens["id"]]])
        self.assertIn("- `zz-new`: New?", (self.d.SCOUTS / f"{lens['id']}.md").read_text())
        self.call("/design/undo")
        self.assertEqual(self.snapshot(), self.before)

    def test_stale_edit_is_refused(self):
        kind = self.d.everything()["kinds"][0]
        reply = self.d.handle("POST", "/design/save", json.dumps({**kind, "sig": "old"}))[1]
        self.assertIn("changed on disk", reply["refused"])


if __name__ == "__main__":
    unittest.main()
