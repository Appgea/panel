import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SPEC = importlib.util.spec_from_file_location(
    "revenuecat_host", Path(__file__).parent / "bin" / "host.py"
)
host = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(host)


class RevenueCatHostTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_unconfigured_project_has_a_setup_state(self):
        state = host.status_payload(str(self.root))
        self.assertEqual(state["status"], "needs_setup")
        self.assertFalse(state["configured"])
        self.assertNotIn("apiKey", state)

    def test_project_config_never_contains_the_api_key(self):
        config = host.save_config(str(self.root), {
            "project_id": "proj0a1b2c3d",
            "currency": "eur",
            "revenue_type": "proceeds",
            "apiKey": "sk_do_not_write_me",
        })
        saved = json.loads((self.root / ".panel" / "revenuecat.json").read_text())
        self.assertEqual(config["currency"], "EUR")
        self.assertNotIn("apiKey", saved)

    def test_dashboard_uses_cache_without_network(self):
        host.save_config(str(self.root), {"project_id": "proj0a1b2c3d"})
        cached = {
            "status": "ready", "cachedAt": host.time.time(), "revenue28d": 42,
        }
        path = host.cache_path("proj0a1b2c3d", "USD", "proceeds")
        with mock.patch.object(host, "CACHE_DIR", self.root / "cache"), mock.patch.dict(
            os.environ, {"REVENUECAT_API_V2_KEY": "sk_example_key_for_tests"}
        ):
            path = host.cache_path("proj0a1b2c3d", "USD", "proceeds")
            host.write_cache(path, cached)
            with mock.patch.object(host, "api_get") as api_get:
                data = host.load_dashboard(str(self.root))
        self.assertEqual(data["revenue28d"], 42)
        self.assertTrue(data["cached"])
        api_get.assert_not_called()

    def test_overview_metrics_are_keyed_for_the_ui(self):
        metrics = host.metric_map({"metrics": [
            {"id": "mrr", "name": "MRR", "value": 12.5, "unit": "$"},
            {"id": "active_trials", "name": "Active Trials", "value": 3},
        ]})
        self.assertEqual(metrics["mrr"]["value"], 12.5)
        self.assertEqual(metrics["active_trials"]["value"], 3)

    def test_existing_project_scoped_claude_mcp_key_is_reused(self):
        config = self.root / "claude.json"
        app_root = self.root / "apps"
        tavla = app_root / "Tavla"
        tavla.mkdir(parents=True)
        config.write_text(json.dumps({"projects": {str(app_root): {"mcpServers": {
            "revenuecat": {
                "url": "https://mcp.revenuecat.ai/mcp",
                "headers": {"Authorization": "Bearer sk_existing_local_key"},
            }
        }}}}))
        with mock.patch.dict(os.environ, {"CLAUDE_CONFIG_PATH": str(config)}, clear=True):
            key = host.claude_mcp_key(str(tavla))
        self.assertEqual(key, "sk_existing_local_key")

    def test_project_discovery_returns_identity_but_never_key(self):
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({"items": [
            {"id": "proj12345678", "name": "Pillow"},
        ]}).encode()
        with mock.patch.object(host, "claude_mcp_key", return_value="sk_existing_local_key"), \
             mock.patch.object(host.urllib.request, "urlopen", return_value=response):
            projects = host.discover_projects(str(self.root))
        self.assertEqual(projects, [{"id": "proj12345678", "name": "Pillow"}])
        self.assertNotIn("sk_existing_local_key", json.dumps(projects))

    def test_repository_local_mcp_key_is_reused(self):
        (self.root / ".mcp.json").write_text(json.dumps({"mcpServers": {
            "revenuecat": {"env": {"REVENUECAT_SECRET_KEY": "sk_repository_key"}},
        }}))
        key, source = host.local_mcp_key(str(self.root))
        self.assertEqual(key, "sk_repository_key")
        self.assertEqual(source, "project RevenueCat MCP")

    def test_the_vault_key_of_the_app_folder_wins_over_an_mcp_file(self):
        app = self.root / "Sagar"
        app.mkdir()
        (app / ".mcp.json").write_text(json.dumps({"mcpServers": {
            "revenuecat": {"env": {"REVENUECAT_SECRET_KEY": "sk_repository_key"}},
        }}))
        (self.root / "sagar_rc.env").write_text("OTHER=1\nRC_SECRET_KEY=sk_vault_key\n")
        with mock.patch.dict(os.environ, {"RC_SECRETS_DIR": str(self.root)}):
            self.assertEqual(host.local_mcp_key(str(app)), ("sk_vault_key", "vault"))

    def test_new_keys_are_sent_to_keychain_over_stdin_not_process_arguments(self):
        result = mock.Mock(returncode=0, stdout="", stderr="")
        with mock.patch.object(host, "keychain_available", return_value=True), \
             mock.patch.object(host.subprocess, "run", return_value=result) as run:
            host.save_api_key("proj12345678", "sk_example_key_for_tests")
        args = run.call_args.args[0]
        self.assertNotIn("sk_example_key_for_tests", args)
        self.assertEqual(run.call_args.kwargs["input"], "sk_example_key_for_tests\n")

    def test_new_key_is_rejected_when_keychain_is_unavailable(self):
        with mock.patch.object(host, "keychain_available", return_value=False):
            with self.assertRaisesRegex(ValueError, "Keychain is unavailable"):
                host.save_api_key("proj12345678", "sk_example_key_for_tests")

    def test_projects_can_be_discovered_directly_from_new_key(self):
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({"items": [
            {"id": "proj87654321", "name": "Pisti"},
        ]}).encode()
        with mock.patch.object(host.urllib.request, "urlopen", return_value=response):
            projects = host.projects_for_key("sk_new_read_only_key")
        self.assertEqual(projects, [{"id": "proj87654321", "name": "Pisti"}])


if __name__ == "__main__":
    unittest.main()
