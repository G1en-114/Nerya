"""Supervise the official OpenAI tunnel-client, not a custom tunnel protocol.

The OpenAI Tunnel path binds directly to Nerya's stdio MCP server.  This keeps
both MCP and its credentials off a public listener: the tunnel daemon makes the
outbound OpenAI connection and launches Nerya as a local child process.
"""
from __future__ import annotations

import importlib.util
import os
import platform
import re
import shlex
import shutil
import subprocess
import sys
import threading
import uuid
from pathlib import Path
from urllib.parse import urlsplit

_PROCESSES = {}
_LOCK = threading.RLock()
_ERRORS = {}
# The binary is host-wide, so coalesce install requests across workspaces.
_INSTALL = {"installing": False, "install_error": ""}


def _brew():
    if platform.system() not in {"Darwin", "Linux"}:
        return None
    candidates = [shutil.which("brew"), "/opt/homebrew/bin/brew", "/usr/local/bin/brew",
                  "/home/linuxbrew/.linuxbrew/bin/brew"]
    return next((str(p) for p in candidates if p and Path(p).is_file()
                 and os.access(p, os.X_OK)), None)


def installation_status():
    with _LOCK:
        return {**_INSTALL, "install_supported": bool(_brew()),
                "install_command": "brew install openai/tools/tunnel-client"}


def _install_worker(brew):
    error = "installFailed"
    # Package managers must not inherit the backend's Vault/model/tunnel keys.
    env = {k: v for k, v in os.environ.items() if k in {
        "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TEMP",
        "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
    }}
    env.update(HOMEBREW_NO_AUTO_UPDATE="1", HOMEBREW_NO_ENV_HINTS="1", CI="1")
    try:
        result = subprocess.run([brew, "install", "openai/tools/tunnel-client"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env=env, timeout=900, check=False)
        if result.returncode == 0:
            error = "installVerificationFailed"
            binary = executable()
            if binary:
                probe = subprocess.run([binary, "--version"], stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    env=env, timeout=15, check=False)
                if probe.returncode == 0:
                    error = ""
    except subprocess.TimeoutExpired:
        error = "installTimeout"
    except Exception:
        # Never publish package-manager output, environment or a traceback.
        error = "installFailed"
    finally:
        with _LOCK:
            _INSTALL.update(installing=False, install_error=error)


def install(config):
    """Explicit administrator action, never an implicit install or connection.

    The official tap includes the matching companion binary. Do not bypass
    macOS Gatekeeper to run the upstream unnotarized release archives.
    """
    with _LOCK:
        if _INSTALL["installing"] or (executable() and not _INSTALL["install_error"]):
            return {"ok": True, "installed": bool(executable()), **installation_status()}
        brew = _brew()
        if not brew:
            return {"ok": False, "error": "installRequiresHomebrew", "_status": 400}
        _INSTALL.update(installing=True, install_error="")
        try:
            threading.Thread(target=_install_worker, args=(brew,), daemon=True,
                             name="nerya-tunnel-install").start()
        except RuntimeError:
            _INSTALL.update(installing=False, install_error="installFailed")
            return {"ok": False, "error": "installFailed", "_status": 500}
        return {"ok": True, "installed": bool(executable()), **installation_status()}


def executable():
    found = shutil.which("tunnel-client")
    if found:
        return found
    for path in (Path("/opt/homebrew/bin/tunnel-client"), Path("/usr/local/bin/tunnel-client"),
                 Path("/home/linuxbrew/.linuxbrew/bin/tunnel-client")):
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
    return None


def status(config):
    key = str(config.paths.root.resolve())
    with _LOCK:
        item = _PROCESSES.get(key)
    running = bool(item and item[0].poll() is None)
    ready = False
    if running and item[1].exists() and not item[1].is_symlink():
        try:
            with item[1].open(encoding="utf-8") as stream:
                url = stream.read(1024).strip()
            parts = urlsplit(url)
            if parts.scheme == "http" and parts.hostname == "127.0.0.1" and parts.port:
                import httpx
                with httpx.Client(trust_env=False, timeout=1) as client:
                    ready = client.get(f"http://127.0.0.1:{parts.port}/readyz").status_code == 200
        except Exception:
            pass
    cfg = config.get("mcp.openai_tunnel", {}) or {}
    return {"installed": bool(executable()), "enabled": cfg.get("enabled") is True,
            "tunnel_id": str(cfg.get("tunnel_id", "")), "api_key_configured": bool(cfg.get("api_key_ref")),
            "running": running, "ready": ready,
            "error": _ERRORS.get(key, "") if not running else "",
            **installation_status(),
            "api_tool": {"type": "mcp", "server_label": "nerya", "tunnel_id": str(cfg.get("tunnel_id", ""))}}


def start(config, *, api_port=None):
    # api_port is retained for callers that also supervise the integrated HTTP
    # bridge.  The OpenAI Tunnel no longer depends on that listener.
    del api_port
    key = str(config.paths.root.resolve())
    cfg = config.get("mcp.openai_tunnel", {}) or {}
    with _LOCK:
        if key in _PROCESSES and _PROCESSES[key][0].poll() is None:
            return {"ok": True, **status(config)}
        try:
            if config.get("mcp.enabled") is not True or cfg.get("enabled") is not True:
                raise ValueError("Enable MCP and OpenAI Tunnel first")
            if not importlib.util.find_spec("mcp"):
                raise ValueError("Install the nerya[mcp] dependency first")
            tunnel_id = str(cfg.get("tunnel_id", ""))
            if not re.fullmatch(r"tunnel_[A-Za-z0-9_-]{8,128}", tunnel_id):
                raise ValueError("Enter a valid OpenAI Tunnel ID (tunnel_...)")
            binary = executable()
            if _INSTALL["installing"] or _INSTALL["install_error"]:
                raise ValueError("Finish installing and verifying tunnel-client before connecting")
            if not binary:
                raise ValueError("Official tunnel-client is not installed")
            ref = str(cfg.get("api_key_ref", ""))
            if not ref.startswith("vault://"):
                raise ValueError("Save the runtime API key in MCP settings first")
            from ..security.secrets import SecretVault
            api_key = SecretVault.open(config.paths.vault_enc).resolve(ref[8:], required_scope="mcp_tunnel")
            health_dir = config.paths.state / "openai-mcp-tunnel"
            health_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            if health_dir.is_symlink():
                raise ValueError("Tunnel state directory must not be a symlink")
            health_file = health_dir / (uuid.uuid4().hex + ".url")
            env = {k: v for k, v in os.environ.items() if k in {
                "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "SystemRoot", "USERPROFILE",
                "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"}}
            env.update(CONTROL_PLANE_API_KEY=api_key, CONTROL_PLANE_TUNNEL_ID=tunnel_id,
                       MCP_STARTUP_WAIT_TIMEOUT="30s")
            # tunnel-client must see its control-plane credentials, but the MCP
            # child must not inherit them.  Bootstrap through the same Python
            # interpreter, scrub tunnel-only variables, then run Nerya's CLI.
            env["NERYA_MCP_SOURCE"] = "tunnel"
            env["PYTHONPATH"] = str(Path(__file__).resolve().parents[2])
            bootstrap = (
                "import os,runpy;"
                "os.environ.pop('CONTROL_PLANE_API_KEY',None);"
                "os.environ.pop('CONTROL_PLANE_TUNNEL_ID',None);"
                "os.environ.pop('MCP_STARTUP_WAIT_TIMEOUT',None);"
                "runpy.run_module('nerya.cli.app',run_name='__main__')"
            )
            stdio_argv = [sys.executable, "-c", bootstrap, "mcp", "serve",
                          "--transport", "stdio", "--workspace", key]
            stdio_command = (subprocess.list2cmdline(stdio_argv) if os.name == "nt"
                             else shlex.join(stdio_argv))
            command = [binary, "run", "--mcp.command", stdio_command,
                       "--health.listen-addr", "127.0.0.1:0", "--health.url-file", str(health_file)]
            process = subprocess.Popen(command, env=env, cwd=str(config.paths.root),
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            _PROCESSES[key] = (process, health_file)
            _ERRORS.pop(key, None)
            return {"ok": True, **status(config)}
        except ValueError as exc:
            _ERRORS[key] = str(exc)
        except Exception:
            _ERRORS[key] = "Tunnel startup failed; check the installed client and Vault configuration"
    return {"ok": False, **status(config)}


def stop(config):
    key = str(config.paths.root.resolve())
    with _LOCK:
        item = _PROCESSES.pop(key, None)
    if item and item[0].poll() is None:
        item[0].terminate()
        try:
            item[0].wait(timeout=5)
        except subprocess.TimeoutExpired:
            item[0].kill()
            item[0].wait(timeout=5)
    # No pidfile scans or arbitrary process termination.
    return {"ok": True, **status(config)}


def restore(config, *, api_port):
    # Keep the public signature stable for local-server startup hooks.  The
    # tunnel-owned stdio MCP child does not use the API listener port.
    del api_port
    if os.environ.get("NERYA_DISABLE_TUNNEL_RESTORE", "").lower() in {"1", "true", "yes"}:
        return
    if config.get("mcp.enabled") is True and config.get("mcp.openai_tunnel.enabled") is True:
        # tunnel-client performs its own network reconnection while this child lives.
        start(config)
