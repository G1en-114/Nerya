"""Private Tauri child process. Control is stdin/stdout, never a network API.

A real, bundled CPython is intentional: Nerya skills launch sys.executable.
Freezing this process with PyInstaller would break those Python subprocesses.
"""
from __future__ import annotations

import argparse
from collections import OrderedDict
import http.client
import ipaddress
import json
import os
from pathlib import Path
import queue
import secrets
import select
import signal
import socket
import stat
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlsplit

HOP_HEADERS = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
               "te", "trailer", "transfer-encoding", "upgrade"}
PRIVATE_HEADERS = {"x-nerya-local-peer", "x-nerya-dashboard-internal", "forwarded",
                   "x-forwarded-for", "x-real-ip", "x-forwarded-host", "x-forwarded-proto"}
MAX_BODY = 64 * 1024 * 1024


def migrate_legacy_admin_auth(config, legacy_root: Path | None = None) -> bool:
    """Import existing admin auth from the legacy ~/nerya-ws workspace once."""
    from nerya.api import auth as auth_mod
    if auth_mod.has_admin_password(config):
        return False
    source_root = (legacy_root or (Path.home() / "nerya-ws")).expanduser().resolve()
    if source_root == config.paths.root.resolve() or not (source_root / "nerya.yml").exists():
        return False
    from nerya.core import yaml_io
    source = yaml_io.load(source_root / "nerya.yml", default={}) or {}
    source_auth = ((source.get("runtime") or {}).get("auth") or {}) if isinstance(source, dict) else {}
    password_hash = str(source_auth.get("admin_password_hash") or "").strip()
    if not password_hash:
        return False
    values = {"runtime.auth.admin_password_hash": password_hash}
    for name in ("jwt_secret", "jwt_ttl_seconds"):
        value = source_auth.get(name)
        if value not in (None, ""):
            values[f"runtime.auth.{name}"] = value
    if not values:
        return False
    auth_mod._persist_config_values(config, values)
    return True


def _is_loopback_host(value: str) -> bool:
    try:
        hostname = (urlsplit(f"//{value}").hostname or "").lower()
    except ValueError:
        return False
    if hostname == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def forwarded_headers(headers, *, peer: str, local: bool, proof: str) -> dict[str, str]:
    """Socket provenance plus a loopback Host identifies password-free local access."""
    connection = {x.strip().lower() for x in headers.get("Connection", "").split(",")}
    result = {k: v for k, v in headers.items()
              if k.lower() not in HOP_HEADERS | PRIVATE_HEADERS | connection}
    forwarded = any(headers.get(k) for k in ("X-Forwarded-For", "X-Real-IP", "Forwarded"))
    peer_is_loopback = ipaddress.ip_address(peer).is_loopback
    browser_loopback = _is_loopback_host(headers.get("Host", ""))
    if peer_is_loopback and not forwarded and (local or browser_loopback):
        # A browser explicitly addressing localhost/127.0.0.1 is local even
        # when it uses the configurable access port. Tunnel/LAN requests stay
        # remote because their peer or Host is non-loopback, or they carry a
        # forwarding chain.
        result["X-Nerya-Local-Peer"] = proof
    else:
        result["X-Forwarded-For"] = peer if not peer_is_loopback else "desktop-share"
    return result


class Gateway(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, address, upstream_port: int, proof: str, *, local: bool, reuse_address: bool = False):
        self.allow_reuse_address = reuse_address
        self.upstream_port, self.proof, self.local = upstream_port, proof, local
        self.connections: set[socket.socket] = set()
        self.connections_lock = threading.Lock()
        super().__init__(address, GatewayHandler)

    def get_request(self):
        connection, address = super().get_request()
        with self.connections_lock:
            self.connections.add(connection)
        return connection, address

    def close_request(self, connection):
        with self.connections_lock:
            self.connections.discard(connection)
        super().close_request(connection)

    def close_clients(self):
        with self.connections_lock:
            connections = list(self.connections)
        for connection in connections:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection.close()


class GatewayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass  # URLs, headers and credentials must not enter desktop logs.

    def fail(self, code: int, message: str):
        body = json.dumps({"error": message}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def proxy(self):
        self.connection.settimeout(60)
        if not self.path.startswith("/") or self.path.startswith("//"):
            return self.fail(400, "invalid_request_target")
        expected = f"http://127.0.0.1:{self.server.server_port}"
        if self.server.local:
            # Prevent DNS rebinding and cross-origin drive-by access to the desktop.
            expected_hosts = {expected.removeprefix("http://"), f"localhost:{self.server.server_port}"}
            if (self.headers.get("Host") or "").lower() not in expected_hosts:
                return self.fail(403, "invalid_local_host")
            origin = self.headers.get("Origin")
            expected_origins = {expected, f"http://localhost:{self.server.server_port}"}
            if origin and origin.lower() not in expected_origins:
                return self.fail(403, "invalid_local_origin")
            if self.headers.get("Sec-Fetch-Site") == "cross-site":
                return self.fail(403, "cross_site_request")
        if self.headers.get("Transfer-Encoding"):
            return self.fail(400, "streaming_request_body_not_supported")
        lengths = self.headers.get_all("Content-Length", [])
        try:
            size = int(lengths[0]) if lengths else 0
            if len(lengths) > 1 or not 0 <= size <= MAX_BODY:
                raise ValueError
        except ValueError:
            return self.fail(413, "invalid_body_length")
        headers = forwarded_headers(self.headers, peer=self.client_address[0],
                                    local=self.server.local, proof=self.server.proof)
        upgrade = self.headers.get("Upgrade", "").lower() == "websocket"
        if upgrade:
            headers.update({"Connection": "Upgrade", "Upgrade": "websocket"})
        conn = http.client.HTTPConnection("127.0.0.1", self.server.upstream_port, timeout=7260)
        started = False
        try:
            body = self.rfile.read(size) if size else None
            if body is not None and len(body) != size:
                return self.fail(400, "incomplete_body")
            conn.request(self.command, self.path, body=body, headers=headers)
            response = conn.getresponse()
            self.send_response(response.status, response.reason)
            for key, value in response.getheaders():
                if key.lower() not in HOP_HEADERS:
                    self.send_header(key, value)
            if response.status == 101 and upgrade:
                self.send_header("Connection", "Upgrade")
                self.send_header("Upgrade", "websocket")
            else:
                self.send_header("Connection", "close")
            self.end_headers()
            started = True
            if response.status == 101 and upgrade:
                self.wfile.flush()
                upstream = conn.sock
                if upstream is None:
                    return
                self.connection.settimeout(None)
                upstream.settimeout(None)
                while True:
                    ready, _, _ = select.select([self.connection, upstream], [], [], 60)
                    for source in ready:
                        data = source.recv(65536)
                        if not data:
                            return
                        (upstream if source is self.connection else self.connection).sendall(data)
            elif self.command != "HEAD":
                # read1 forwards SSE immediately, rather than waiting for a 64 KiB buffer.
                while chunk := response.read1(65536):
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except (OSError, http.client.HTTPException):
            if not started:
                self.fail(502, "desktop_web_service_unavailable")
        finally:
            conn.close()
            self.close_connection = True

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = proxy


def start_server(server):
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def close_server(server):
    if server:
        server.shutdown()
        if isinstance(server, Gateway):
            server.close_clients()
        server.server_close()


class InboxCursor:
    """No historical notification flood; status changes get their own identity."""
    def __init__(self):
        self.seen: OrderedDict[str, None] = OrderedDict()
        self.initialized = False

    def advance(self, items: list[dict]) -> int:
        count = 0
        for item in items:
            if not item.get("id"):
                continue
            identity = f"{item['id']}:{item.get('status', '')}"
            if identity not in self.seen:
                count += self.initialized and item.get("status") not in {"dismissed", "resolved", "approved", "rejected"}
                self.seen[identity] = None
            self.seen.move_to_end(identity)
        self.initialized = True
        while len(self.seen) > 2000:
            self.seen.popitem(last=False)
        return count


def has_real_model(tiers: list[dict]) -> bool:
    """The development mock is runnable, but never completes user onboarding.

    Credential validation stays in the existing model settings API. In particular,
    local models must not be rejected merely because they require no API key.
    """
    for tier in tiers:
        for route in [tier, *(tier.get("routes") or [])]:
            provider = str(route.get("provider") or "").strip().lower()
            if provider and provider != "mock" and str(route.get("model") or "").strip():
                return True
    return False


def validate_options(options: dict) -> dict:
    if not isinstance(options, dict) or set(options) - {"sharing", "port", "external_url", "notifications", "language"}:
        raise ValueError("invalid_desktop_options")
    normalized = dict(options)
    for key in ("sharing", "notifications"):
        if key in options and type(options[key]) is not bool:
            raise ValueError("invalid_desktop_options")
    if "port" in options and (type(options["port"]) is not int or not 1024 <= options["port"] <= 65535):
        raise ValueError("port_must_be_between_1024_and_65535")
    if "external_url" in options:
        if type(options["external_url"]) is not str or len(options["external_url"]) > 2048:
            raise ValueError("invalid_external_url")
        value = options["external_url"].strip().rstrip("/")
        if value:
            try:
                parsed = urlsplit(value)
                explicit_port = parsed.port
            except ValueError as exc:
                raise ValueError("invalid_external_url") from exc
            if (parsed.scheme.lower() not in ("http", "https") or not parsed.hostname
                    or parsed.username or parsed.password or parsed.query or parsed.fragment
                    or parsed.path not in ("", "/")):
                raise ValueError("invalid_external_url")
            if explicit_port is not None:
                raise ValueError("external_url_must_not_include_port")
            host = parsed.hostname
            if ":" in host and not host.startswith("["):
                host = f"[{host}]"
            value = f"{parsed.scheme.lower()}://{host}"
        normalized["external_url"] = value
    if "language" in options and options["language"] not in ("zh", "en"):
        raise ValueError("invalid_language")
    return normalized


def ensure_vault_passphrase(data: Path) -> str:
    """macOS supplies a Keychain key; standalone launchers use a private key file.

    Never replace a missing key for an existing encrypted vault. Preserve the
    data and report a recovery error instead of overwriting saved credentials.
    """
    supplied = os.environ.get("NERYA_VAULT_PASSPHRASE", "")
    if supplied and supplied != "nerya-default-passphrase":
        return supplied
    path = data / "vault.key"
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    if not path.exists():
        vault = data / "workspace" / "vault" / "secrets.enc"
        if vault.exists() and vault.stat().st_size:
            raise RuntimeError("existing_vault_key_required")
        key = secrets.token_urlsafe(48)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | nofollow, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, "w", encoding="ascii") as stream:
                stream.write(key)
                stream.flush()
                os.fsync(stream.fileno())
    fd = os.open(path, os.O_RDONLY | nofollow)
    with os.fdopen(fd, "r", encoding="ascii") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or (os.name != "nt" and (info.st_mode & 0o077 or info.st_uid != os.getuid())):
            raise RuntimeError("unsafe_vault_key_permissions")
        key = stream.read(129).strip()
    if not 32 <= len(key) <= 128:
        raise RuntimeError("invalid_vault_key")
    return key


class DesktopRuntime:
    def __init__(self, resources: Path, data: Path, emit):
        self.resources, self.data, self.emit = resources, data, emit
        self.manifest = json.loads((resources / "manifest.json").read_text())
        self.commands: queue.Queue = queue.Queue()
        self.stopping = threading.Event()
        self.backend = self.web = self.access = self.node = None
        self.sharing_enabled = False
        self.token, self.proof = secrets.token_urlsafe(48), secrets.token_urlsafe(48)
        self.settings = {"notifications": False, "language": "en", "port": 18400, "external_url": ""}
        try:
            stored = json.loads((data / "desktop.json").read_text())
            self.settings.update(validate_options({k: v for k, v in stored.items() if k != "sharing"}))
        except (OSError, ValueError, TypeError, AttributeError):
            pass
        self.cursor = InboxCursor()
        self.state: dict[str, Any] = {"phase": "starting", "sharing": False, **self.settings}

    def resource(self, key: str) -> Path:
        value = Path(self.manifest[key])
        path = value if value.is_absolute() else self.resources / value
        if not self.manifest.get("dev") and not path.resolve().is_relative_to(self.resources.resolve()):
            raise ValueError("invalid_packaged_resource")
        return path

    def api(self, path: str) -> dict:
        conn = http.client.HTTPConnection("127.0.0.1", self.backend.server_port, timeout=10)
        try:
            conn.request("GET", path, headers={"Authorization": f"Bearer {self.token}"})
            res = conn.getresponse()
            if res.status != 200:
                raise RuntimeError("desktop_api_request_failed")
            return json.loads(res.read())
        finally:
            conn.close()

    def publish(self):
        self.state.update(self.settings, sharing=self.sharing_enabled)
        self.state["access_url"] = f"http://127.0.0.1:{self.access.server_port}" if self.access else ""
        self.state["shared_addresses"] = []
        if self.access and self.sharing_enabled:
            try:
                addresses = sorted({row[4][0] for row in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
                                    if not ipaddress.ip_address(row[4][0]).is_loopback})
            except OSError:
                addresses = []
            self.state["shared_addresses"] = [f"http://{ip}:{self.access.server_port}" for ip in addresses]
        self.emit({"event": "state", "state": self.state.copy()})

    def _start_access(self, port: int, *, sharing: bool, fallback: bool, reuse_address: bool = False) -> Gateway:
        host = "0.0.0.0" if sharing else "127.0.0.1"
        try:
            return start_server(Gateway((host, port), self.node_port, self.proof, local=False, reuse_address=reuse_address))
        except OSError:
            if not fallback:
                raise
            return start_server(Gateway((host, 0), self.node_port, self.proof, local=False))

    def configure(self, options: dict):
        from nerya.api.auth import has_admin_password
        from nerya.core.config import load_config
        options = validate_options(options)
        desired = {**self.settings, **{k: v for k, v in options.items() if k != "sharing"}}
        sharing = options.get("sharing", self.sharing_enabled)
        if sharing and not has_admin_password(load_config(self.data / "workspace")):
            raise ValueError("admin_password_required_before_sharing")

        previous = self.access
        previous_port = self.settings["port"]
        previous_sharing = self.sharing_enabled
        replacement = previous
        rebind = previous is None or desired["port"] != previous.server_port or sharing != previous_sharing
        same_port_mode_switch = previous is not None and desired["port"] == previous.server_port and sharing != previous_sharing
        if rebind:
            close_server(previous)
            self.access = None
            try:
                replacement = self._start_access(desired["port"], sharing=sharing, fallback="port" not in options,
                                                 reuse_address=same_port_mode_switch)
            except OSError as exc:
                try:
                    self.access = self._start_access(previous_port, sharing=previous_sharing, fallback=True, reuse_address=True)
                    self.settings["port"] = self.access.server_port
                except OSError:
                    self.access = None
                raise ValueError("sharing_port_unavailable") from exc
            desired["port"] = replacement.server_port
        try:
            temporary = self.data / "desktop.json.tmp"
            with temporary.open("w", encoding="utf-8") as stream:
                os.chmod(temporary, 0o600)
                json.dump(desired, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.data / "desktop.json")
        except OSError:
            if rebind:
                close_server(replacement)
                try:
                    self.access = self._start_access(previous_port, sharing=previous_sharing, fallback=True, reuse_address=True)
                    self.settings["port"] = self.access.server_port
                except OSError:
                    self.access = None
            raise ValueError("desktop_preferences_not_saved")
        self.access, self.settings, self.sharing_enabled = replacement, desired, sharing
        self.publish()
        return self.state.copy()

    def read_commands(self):
        try:
            for line in sys.stdin:
                try:
                    command = json.loads(line)
                    if command.get("action") == "shutdown":
                        break
                    self.commands.put(command)
                except (ValueError, AttributeError):
                    continue
        finally:
            self.stopping.set()  # Parent crash/exit must not leave a server behind.

    def start(self):
        self.data.mkdir(parents=True, exist_ok=True)
        if os.name != "nt":
            os.chmod(self.data, 0o700)
        threading.Thread(target=self.read_commands, daemon=True).start()
        for name in ("SIGINT", "SIGTERM"):
            signal.signal(getattr(signal, name), lambda *_: self.stopping.set())
        os.environ["NERYA_VAULT_PASSPHRASE"] = ensure_vault_passphrase(self.data)
        if self.manifest.get("browser"):
            os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(self.resource("browser"))
            os.environ["PLAYWRIGHT_NODEJS_PATH"] = str(self.resource("node"))
        import certifi
        os.environ.setdefault("SSL_CERT_FILE", certifi.where())
        os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())
        runtime_bins = [str(Path(sys.executable).parent), str(self.resource("node").parent)]
        os.environ["PATH"] = os.pathsep.join(runtime_bins + [os.environ.get("PATH", "")])
        os.environ.update(NERYA_AUTH_MODE="token", NERYA_API_TOKEN=self.token,
                          NERYA_DASHBOARD_INTERNAL_TOKEN=secrets.token_urlsafe(48),
                          NERYA_WORKSPACE=str(self.data / "workspace"))
        from nerya.workspace.manager import WorkspaceManager
        from nerya.api.local_server import build_server
        manager = (WorkspaceManager.load if (self.data / "workspace" / "nerya.yml").exists()
                   else WorkspaceManager.init)(self.data / "workspace")
        migrate_legacy_admin_auth(manager.config)
        from nerya.security.secrets import SecretVault
        if SecretVault.open(manager.paths.vault_enc).load_error:
            raise RuntimeError("existing_vault_key_required")
        self.backend = start_server(build_server(manager.config, host="127.0.0.1", port=0))
        # Node cannot inherit an already-bound socket through Next's standalone entry.
        # If another process wins this short race, readiness fails instead of reusing it.
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.node_port = probe.getsockname()[1]
        env = {**os.environ, "NERYA_API": f"http://127.0.0.1:{self.backend.server_port}",
               "NERYA_LOCAL_PEER_KEY": self.proof, "PORT": str(self.node_port),
               "HOSTNAME": "127.0.0.1", "NEXT_TELEMETRY_DISABLED": "1"}
        dashboard = self.resource("dashboard")
        if self.manifest.get("dev"):
            env["NODE_ENV"] = "development"
            env["NERYA_UI_DIST_DIR"] = ".next-desktop-dev"
            command = [str(self.resource("node")), str(self.resource("next_cli")),
                       "dev", "-H", "127.0.0.1", "-p", str(self.node_port)]
        else:
            env["NODE_ENV"] = "production"
            command = [str(self.resource("node")), str(dashboard / "server.js")]
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        self.node = subprocess.Popen(command, cwd=dashboard, env=env, stdin=subprocess.DEVNULL,
                                     stdout=sys.stderr, stderr=sys.stderr, creationflags=flags)
        deadline = time.monotonic() + 120
        while not self.stopping.is_set():
            if self.node.poll() is not None:
                raise RuntimeError("desktop_web_service_exited")
            conn = http.client.HTTPConnection("127.0.0.1", self.node_port, timeout=1)
            try:
                conn.request("GET", "/api/proxy/health")
                if conn.getresponse().status == 200:
                    break
            except (OSError, http.client.HTTPException):
                pass
            finally:
                conn.close()
            if time.monotonic() > deadline:
                raise RuntimeError("desktop_startup_timeout")
            self.stopping.wait(0.3)
        if self.stopping.is_set():
            return
        self.web = start_server(Gateway(("127.0.0.1", 0), self.node_port, self.proof, local=True))
        self.access = self._start_access(self.settings["port"], sharing=False, fallback=True)
        self.settings["port"] = self.access.server_port
        model_ready = has_real_model(self.api("/llm/tiers").get("tiers", []))
        self.state.update(phase="ready", local_url=f"http://127.0.0.1:{self.web.server_port}",
                          workspace=str(self.data / "workspace"),
                          start_path="/" if model_ready else "/setup?mode=quick")
        self.publish()
        next_poll = 0.0
        while not self.stopping.is_set():
            if self.node.poll() is not None:
                raise RuntimeError("desktop_web_service_exited")
            try:
                command = self.commands.get(timeout=0.25)
                try:
                    if command.get("action") != "configure":
                        raise ValueError("unknown_desktop_command")
                    result = self.configure(command.get("options", {}))
                    self.emit({"id": command.get("id"), "result": result})
                except ValueError as exc:
                    self.emit({"id": command.get("id"), "error": str(exc)})
            except queue.Empty:
                pass
            if time.monotonic() >= next_poll:
                next_poll = time.monotonic() + 15
                try:
                    count = self.cursor.advance(self.api("/inbox/items?limit=200&include_info=true").get("data", {}).get("items", []))
                    if count and self.settings["notifications"]:
                        self.emit({"event": "notification", "count": count, "language": self.settings["language"]})
                except (OSError, ValueError, RuntimeError, http.client.HTTPException):
                    pass  # Failed polls never reset the cursor or generate phantom alerts.

    def close(self):
        self.stopping.set()
        for server in (self.access, self.web, self.backend):
            close_server(server)
        if self.node and self.node.poll() is None:
            self.node.terminate()
            try:
                self.node.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.node.kill()
                self.node.wait()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--resources", type=Path, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    args = parser.parse_args()
    output = sys.stdout
    sys.stdout = sys.stderr  # All library output is separate from the JSON protocol.
    def emit(value):
        output.write(json.dumps(value, ensure_ascii=False) + "\n")
        output.flush()
    runtime = DesktopRuntime(args.resources.resolve(), args.data_dir.resolve(), emit)
    try:
        runtime.start()
    except Exception as exc:
        import traceback
        traceback.print_exc(file=sys.stderr)
        emit({"event": "state", "state": {"phase": "failed", "error": type(exc).__name__}})
        return 1
    finally:
        runtime.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
