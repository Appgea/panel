#!/usr/bin/env python3
"""Read-only RevenueCat dashboard module using the API v2 Charts & Metrics surface.

CGI-argv protocol:
    host.py METHOD PATH[?query]

The webview never receives a stored credential. Per-project config contains only the RevenueCat
project id and display preferences; newly entered API keys live in macOS Keychain or Windows Credential Manager (or arrive
through an existing local MCP connection / REVENUECAT_API_V2_KEY).
"""

from __future__ import annotations

import hashlib
import concurrent.futures
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULE_ROOT = HERE.parent


def _panel_state_dir(name: str, legacy: "dict[str, Path] | None" = None) -> Path:
    """The module's writable directory.

    Panel hands it over as PANEL_STATE_DIR; a bare CLI run resolves the same place itself. It is
    never inside the module's own folder: once Panel is installed that folder lives in a signed
    app bundle and is read-only, so a cache write there succeeds on the machine it was written on
    and fails on every other one. Any legacy in-module directory is moved across once, because
    `secrets/` holds credentials a user would otherwise have to re-enter.
    """
    root = os.environ.get("PANEL_STATE_DIR")
    target = Path(root) if root else Path.home() / ".appgeapanel" / "state" / name
    target.mkdir(parents=True, exist_ok=True)
    for sub, old in (legacy or {}).items():
        if old.is_dir() and not (target / sub).exists():
            try:
                old.rename(target / sub)
            except OSError:
                pass
    return target


_STATE = _panel_state_dir(
    "revenuecat",
    {"secrets": MODULE_ROOT / "secrets", "cache": MODULE_ROOT / "cache"},
)
SECRETS_DIR = _STATE / "secrets"
CACHE_DIR = _STATE / "cache"
KEYCHAIN_SERVICE = "com.appgea.panel.revenuecat"
API_ROOT = "https://api.revenuecat.com/v2"
CACHE_SECONDS = 300
PROJECT_ID = re.compile(r"^proj[A-Za-z0-9_-]{4,}$")
ALLOWED_CURRENCIES = {
    "USD", "EUR", "GBP", "AUD", "CAD", "JPY", "BRL", "KRW", "CNY", "MXN",
    "INR", "SEK", "NOK", "DKK", "PLN",
}
ALLOWED_REVENUE_TYPES = {"revenue", "revenue_net_of_taxes", "proceeds"}


def respond(status: int, body, ctype: str = "application/json") -> None:
    payload = json.dumps(body, separators=(",", ":")).encode() if isinstance(body, (dict, list)) else str(body).encode()
    sys.stdout.buffer.write(f"{status}\n{ctype}\n\n".encode())
    sys.stdout.buffer.write(payload)


def project_config_path(root: str) -> Path:
    return Path(root).expanduser().resolve() / ".panel" / "revenuecat.json"


def load_config(root: str) -> dict:
    if not root:
        return {}
    try:
        data = json.loads(project_config_path(root).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def clean_config(data: dict) -> dict:
    project_id = str(data.get("project_id") or "").strip()
    currency = str(data.get("currency") or "USD").strip().upper()
    revenue_type = str(data.get("revenue_type") or "proceeds").strip()
    return {
        "version": 1,
        "project_id": project_id,
        "currency": currency if currency in ALLOWED_CURRENCIES else "USD",
        "revenue_type": revenue_type if revenue_type in ALLOWED_REVENUE_TYPES else "proceeds",
    }


def save_config(root: str, data: dict) -> dict:
    if not root or not Path(root).expanduser().is_dir():
        raise ValueError("selected project folder does not exist")
    config = clean_config(data)
    if not PROJECT_ID.match(config["project_id"]):
        raise ValueError("RevenueCat project id must start with 'proj'")
    path = project_config_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return config


def secret_path(project_id: str) -> Path:
    safe = hashlib.sha256(project_id.encode()).hexdigest()[:24]
    return SECRETS_DIR / f"{safe}.key"


def keychain_available() -> bool:
    if sys.platform == "win32":
        return True
    return sys.platform == "darwin" and bool(shutil.which("security"))


def storage_target() -> str:
    return "Windows Credential Manager" if sys.platform == "win32" else "macOS Keychain"


def _wincred():
    """advapi32's Cred* calls and the CREDENTIALW layout, built only on Windows."""
    import ctypes
    from ctypes import wintypes

    class Credential(ctypes.Structure):
        _fields_ = [
            ("Flags", wintypes.DWORD),
            ("Type", wintypes.DWORD),
            ("TargetName", wintypes.LPWSTR),
            ("Comment", wintypes.LPWSTR),
            ("LastWritten", wintypes.FILETIME),
            ("CredentialBlobSize", wintypes.DWORD),
            ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
            ("Persist", wintypes.DWORD),
            ("AttributeCount", wintypes.DWORD),
            ("Attributes", ctypes.c_void_p),
            ("TargetAlias", wintypes.LPWSTR),
            ("UserName", wintypes.LPWSTR),
        ]

    advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    advapi.CredReadW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.POINTER(Credential)),
    ]
    advapi.CredReadW.restype = wintypes.BOOL
    advapi.CredWriteW.argtypes = [ctypes.POINTER(Credential), wintypes.DWORD]
    advapi.CredWriteW.restype = wintypes.BOOL
    advapi.CredFree.argtypes = [ctypes.c_void_p]
    advapi.CredFree.restype = None
    return ctypes, Credential, advapi


CRED_TYPE_GENERIC = 1
CRED_PERSIST_LOCAL_MACHINE = 2


def _wincred_target(project_id: str) -> str:
    return f"{KEYCHAIN_SERVICE}:{project_id}"


def _wincred_read(project_id: str) -> str:
    ctypes, Credential, advapi = _wincred()
    found = ctypes.POINTER(Credential)()
    if not advapi.CredReadW(_wincred_target(project_id), CRED_TYPE_GENERIC, 0, ctypes.byref(found)):
        return ""
    try:
        blob = ctypes.string_at(found.contents.CredentialBlob, found.contents.CredentialBlobSize)
        return blob.decode("utf-8", "replace").strip()
    finally:
        advapi.CredFree(found)


def _wincred_write(project_id: str, key: str) -> None:
    ctypes, Credential, advapi = _wincred()
    blob = key.encode("utf-8")
    buffer = (ctypes.c_ubyte * len(blob)).from_buffer_copy(blob)
    credential = Credential()
    credential.Type = CRED_TYPE_GENERIC
    credential.TargetName = _wincred_target(project_id)
    credential.Comment = "Read-only RevenueCat Charts & Metrics API key"
    credential.CredentialBlobSize = len(blob)
    credential.CredentialBlob = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte))
    credential.Persist = CRED_PERSIST_LOCAL_MACHINE
    credential.UserName = project_id
    if not advapi.CredWriteW(ctypes.byref(credential), 0):
        raise RuntimeError("Windows Credential Manager could not save the RevenueCat key")


def keychain_api_key(project_id: str) -> str:
    if not keychain_available() or not project_id:
        return ""
    if sys.platform == "win32":
        return _wincred_read(project_id)
    result = subprocess.run(
        ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", project_id, "-w"],
        text=True,
        capture_output=True,
        timeout=10,
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def save_keychain_api_key(project_id: str, key: str) -> None:
    if not keychain_available():
        raise ValueError("macOS Keychain is unavailable")
    if sys.platform == "win32":
        _wincred_write(project_id, key)
        return
    # `-w` as the final option prompts on stdin, keeping the secret out of process arguments.
    result = subprocess.run(
        [
            "security", "add-generic-password", "-U",
            "-s", KEYCHAIN_SERVICE,
            "-a", project_id,
            "-l", f"Panel RevenueCat · {project_id}",
            "-j", "Read-only RevenueCat Charts & Metrics API key",
            "-w",
        ],
        input=key + "\n",
        text=True,
        capture_output=True,
        timeout=20,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("macOS Keychain could not save the RevenueCat key")


def claude_mcp_key(root: str) -> str:
    """Reuse an existing local RevenueCat MCP credential without ever returning it to the UI.

    Claude scopes MCP servers by project path. Walk from the selected project toward its parents,
    so a project can inherit a RevenueCat connection recorded at its workspace root.
    """
    config_path = Path(os.environ.get("CLAUDE_CONFIG_PATH") or (Path.home() / ".claude.json"))
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    projects = config.get("projects") or {}
    if not isinstance(projects, dict) or not root:
        return ""
    lexical = Path(root).expanduser().absolute()
    resolved = lexical.resolve()
    candidates = [lexical, *lexical.parents, resolved, *resolved.parents]
    seen = set()
    for candidate in candidates:
        if str(candidate) in seen:
            continue
        seen.add(str(candidate))
        project = projects.get(str(candidate)) or {}
        servers = project.get("mcpServers") or {}
        revenuecat = servers.get("revenuecat") or {}
        if "revenuecat" not in str(revenuecat.get("url") or "").lower():
            continue
        authorization = str((revenuecat.get("headers") or {}).get("Authorization") or "").strip()
        if authorization.lower().startswith("bearer "):
            return authorization[7:].strip()
    return ""


def project_mcp_key(root: str) -> str:
    """Read an existing repository-local RevenueCat MCP credential in-process."""
    if not root:
        return ""
    try:
        config = json.loads((Path(root).expanduser().resolve() / ".mcp.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    servers = config.get("mcpServers") or {}
    revenuecat = servers.get("revenuecat") or {} if isinstance(servers, dict) else {}
    authorization = str((revenuecat.get("headers") or {}).get("Authorization") or "").strip()
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    env = revenuecat.get("env") or {}
    for name in ("REVENUECAT_SECRET_KEY", "REVENUECAT_API_V2_KEY", "REVENUECAT_API_KEY"):
        key = str(env.get(name) or "").strip()
        if key:
            return key
    return ""


def local_mcp_key(root: str) -> tuple[str, str]:
    key = project_mcp_key(root)
    if key:
        return key, "project RevenueCat MCP"
    key = claude_mcp_key(root)
    return (key, "local RevenueCat MCP") if key else ("", "")


def resolve_api_key(project_id: str, root: str = "") -> tuple[str, str]:
    env = os.environ.get("REVENUECAT_API_V2_KEY") or os.environ.get("REVENUECAT_API_KEY")
    if env:
        return env.strip(), "environment"
    key = keychain_api_key(project_id)
    if key:
        return key, storage_target()
    # Compatibility with the first module prototype. New credentials are never written here.
    try:
        key = secret_path(project_id).read_text(encoding="utf-8").strip()
        if key:
            return key, "legacy Panel storage"
    except OSError:
        pass
    return local_mcp_key(root)


def api_key(project_id: str, root: str = "") -> str:
    return resolve_api_key(project_id, root)[0]


def save_api_key(project_id: str, key: str) -> None:
    key = key.strip()
    if len(key) < 16 or not key.startswith("sk_"):
        raise ValueError("Enter a RevenueCat API v2 secret key beginning with 'sk_'")
    save_keychain_api_key(project_id, key)


def status_payload(root: str) -> dict:
    config = clean_config(load_config(root))
    project_id = config["project_id"]
    key, source = resolve_api_key(project_id, root) if project_id else ("", "")
    return {
        "status": "ready" if project_id and key else "needs_setup",
        "configured": bool(project_id),
        "hasKey": bool(project_id and key),
        "keySource": source,
        "projectId": project_id,
        "currency": config["currency"],
        "revenueType": config["revenue_type"],
        "secureStorageReady": keychain_available(),
        "storageTarget": storage_target(),
    }


def validate_connection(project_id: str, key: str, currency: str) -> None:
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        checks = [
            pool.submit(api_get, project_id, key, "metrics/overview", {"currency": currency}),
            pool.submit(api_get, project_id, key, "charts/revenue/options"),
        ]
        for check in checks:
            check.result()


def api_get(project_id: str, key: str, path: str, params: dict | None = None) -> dict:
    query = urllib.parse.urlencode(params or {})
    url = f"{API_ROOT}/projects/{urllib.parse.quote(project_id)}/{path}"
    if query:
        url += "?" + query
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            data = json.loads(response.read().decode("utf-8"))
            return data if isinstance(data, dict) else {}
    except urllib.error.HTTPError as error:
        messages = {
            401: "RevenueCat rejected the API key",
            403: "API key is missing Charts & Metrics read permission",
            404: "RevenueCat project was not found",
            423: "RevenueCat project is locked",
            429: "RevenueCat rate limit reached; try again shortly",
        }
        raise RuntimeError(messages.get(error.code, f"RevenueCat returned HTTP {error.code}")) from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"RevenueCat is unreachable: {error.reason}") from error


def projects_for_key(key: str) -> list[dict]:
    """List project identity metadata for the credential scoped to ``root``.

    This is deliberately a local host-only discovery helper. It never includes the
    credential in its return value and requires RevenueCat's read-only projects scope.
    """
    if not key:
        return []
    request = urllib.request.Request(
        f"{API_ROOT}/projects?limit=100",
        headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        messages = {
            401: "RevenueCat rejected the API key",
            403: "API key is missing Projects read permission",
            429: "RevenueCat rate limit reached; try again shortly",
        }
        raise RuntimeError(messages.get(error.code, f"RevenueCat returned HTTP {error.code}")) from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"RevenueCat is unreachable: {error.reason}") from error
    projects = data.get("items") or [] if isinstance(data, dict) else []
    return [
        {"id": str(project["id"]), "name": str(project.get("name") or "")}
        for project in projects
        if isinstance(project, dict) and PROJECT_ID.match(str(project.get("id") or ""))
    ]


def discover_projects(root: str) -> list[dict]:
    key, _source = local_mcp_key(root)
    return projects_for_key(key)


def cache_path(project_id: str, currency: str, revenue_type: str) -> Path:
    key = hashlib.sha256(f"{project_id}:{currency}:{revenue_type}".encode()).hexdigest()[:24]
    return CACHE_DIR / f"{key}.json"


def read_cache(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if time.time() - float(data.get("cachedAt", 0)) <= CACHE_SECONDS:
            data["cached"] = True
            return data
    except (OSError, ValueError, TypeError):
        pass
    return None


def write_cache(path: Path, data: dict) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)


def metric_map(overview: dict) -> dict:
    result = {}
    for metric in overview.get("metrics") or []:
        if isinstance(metric, dict) and metric.get("id"):
            result[str(metric["id"])] = {
                "name": metric.get("name") or metric["id"],
                "value": metric.get("value"),
                "unit": metric.get("unit") or "",
                "period": metric.get("period") or "",
                "updatedAt": metric.get("last_updated_at_iso8601") or metric.get("last_updated_at"),
            }
    return result


def load_dashboard(root: str, force: bool = False) -> dict:
    config = clean_config(load_config(root))
    project_id = config["project_id"]
    key = api_key(project_id, root) if project_id else ""
    if not project_id or not key:
        return status_payload(root)

    cache = cache_path(project_id, config["currency"], config["revenue_type"])
    if not force:
        cached = read_cache(cache)
        if cached:
            return cached

    today = date.today()
    current_start = today - timedelta(days=27)
    previous_end = current_start - timedelta(days=1)
    previous_start = previous_end - timedelta(days=27)
    base = {"currency": config["currency"]}
    revenue_base = {**base, "revenue_type": config["revenue_type"]}
    requests = {
        "overview": ("metrics/overview", base),
        "current": ("metrics/revenue", {
            **revenue_base, "start_date": current_start.isoformat(), "end_date": today.isoformat(),
        }),
        "previous": ("metrics/revenue", {
            **revenue_base, "start_date": previous_start.isoformat(), "end_date": previous_end.isoformat(),
        }),
        "chart": ("charts/revenue", {
            **base,
            "start_date": (today - timedelta(days=89)).isoformat(),
            "end_date": today.isoformat(),
            "selectors": json.dumps({"revenue_type": config["revenue_type"]}, separators=(",", ":")),
        }),
    }
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {
            name: pool.submit(api_get, project_id, key, path, params)
            for name, (path, params) in requests.items()
        }
        answers = {name: future.result() for name, future in futures.items()}
    overview = answers["overview"]
    current = answers["current"]
    previous = answers["previous"]
    chart = answers["chart"]
    current_value = float(current.get("value") or 0)
    previous_value = float(previous.get("value") or 0)
    change = None if previous_value == 0 else ((current_value - previous_value) / previous_value) * 100
    payload = {
        "status": "ready",
        "configured": True,
        "hasKey": True,
        "projectId": project_id,
        "currency": config["currency"],
        "revenueType": config["revenue_type"],
        "period": {"start": current_start.isoformat(), "end": today.isoformat(), "partialToday": True},
        "revenue28d": current_value,
        "previousRevenue28d": previous_value,
        "changePercent": change,
        "metrics": metric_map(overview),
        "chart": chart,
        "fetchedAt": int(time.time() * 1000),
        "cachedAt": time.time(),
        "cached": False,
    }
    write_cache(cache, payload)
    return payload


def main() -> None:
    if len(sys.argv) < 3:
        return respond(400, {"error": "usage: host.py METHOD PATH"})
    method, raw_path = sys.argv[1].upper(), sys.argv[2]
    parsed = urllib.parse.urlsplit(raw_path)
    query = urllib.parse.parse_qs(parsed.query)
    value = lambda name, default="": (query.get(name) or [default])[0]
    root = value("root")

    if method == "GET" and parsed.path == "/status":
        return respond(200, status_payload(root))
    if method == "GET" and parsed.path == "/discover":
        try:
            projects = discover_projects(root)
            _key, source = local_mcp_key(root)
            return respond(200, {
                "ok": bool(projects),
                "keySource": source if projects else "",
                "projects": projects,
            })
        except RuntimeError as error:
            return respond(200, {"ok": False, "projects": [], "error": str(error)})
    if method == "GET" and parsed.path == "/probe":
        state = status_payload(root)
        if state["status"] != "ready":
            return respond(200, {**state, "ok": False})
        try:
            config = clean_config(load_config(root))
            key = api_key(config["project_id"], root)
            api_get(config["project_id"], key, "metrics/overview", {"currency": config["currency"]})
            api_get(config["project_id"], key, "charts/revenue/options")
            return respond(200, {
                "ok": True,
                "status": "ready",
                "projectId": config["project_id"],
                "keySource": state["keySource"],
                "permissions": ["overview:read", "charts:read"],
            })
        except RuntimeError as error:
            return respond(200, {**state, "ok": False, "status": "error", "error": str(error)})
    if method == "GET" and parsed.path == "/warm":
        try:
            data = load_dashboard(root, force=True)
            if data.get("status") != "ready":
                return respond(200, {"ok": False, **data})
            chart = data.get("chart") or {}
            return respond(200, {
                "ok": True,
                "status": "ready",
                "projectId": data.get("projectId"),
                "keySource": status_payload(root).get("keySource"),
                "metricIds": sorted((data.get("metrics") or {}).keys()),
                "chartPeriods": len(chart.get("values") or []),
                "cached": True,
            })
        except (ValueError, RuntimeError) as error:
            return respond(200, {"ok": False, "status": "error", "error": str(error)})
    if method == "GET" and parsed.path == "/dashboard":
        try:
            return respond(200, load_dashboard(root, value("refresh") == "1"))
        except (ValueError, RuntimeError) as error:
            state = status_payload(root)
            state.update({"status": "error", "error": str(error)})
            return respond(200, state)
    if method == "POST" and parsed.path == "/connect":
        try:
            body = json.loads(sys.stdin.buffer.read() or b"{}")
            root = str(body.get("root") or "")
            if not root or not Path(root).expanduser().is_dir():
                raise ValueError("selected project folder does not exist")
            config = clean_config(body)
            key = str(body.get("apiKey") or "").strip()
            if len(key) < 16 or not key.startswith("sk_"):
                raise ValueError("Enter a RevenueCat API v2 secret key beginning with 'sk_'")
            projects = projects_for_key(key)
            if not projects:
                raise ValueError("RevenueCat key did not return a project")
            existing = config["project_id"]
            selected = next((project for project in projects if project["id"] == existing), None)
            if selected is None and len(projects) == 1:
                selected = projects[0]
            if selected is None:
                raise ValueError("RevenueCat key can access multiple projects; reconnect from a configured project")
            config["project_id"] = selected["id"]
            validate_connection(config["project_id"], key, config["currency"])
            save_api_key(config["project_id"], key)
            save_config(root, config)
            return respond(200, {"ok": True, **status_payload(root)})
        except (OSError, ValueError, RuntimeError) as error:
            return respond(200, {"ok": False, "error": str(error)})
    return respond(404, {"error": f"no such route: {method} {parsed.path}"})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        respond(500, {"error": f"{type(error).__name__}: {error}"})
