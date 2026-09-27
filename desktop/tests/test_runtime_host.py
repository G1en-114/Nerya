"""Offline security and lifecycle regression tests: no model calls or user data."""
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import time
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / "runtime_host.py"
spec = importlib.util.spec_from_file_location("runtime_host", MODULE)
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class AuthMigrationTests(unittest.TestCase):
    def test_legacy_admin_auth_migrates_once_without_overwrite(self):
        from nerya.api import auth
        from nerya.workspace.manager import WorkspaceManager
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legacy = WorkspaceManager.init(root / "nerya-ws")
            desktop = WorkspaceManager.init(root / "desktop")
            auth.set_admin_password(legacy.config, "legacy-password")
            self.assertTrue(host.migrate_legacy_admin_auth(desktop.config, legacy.paths.root))
            self.assertTrue(auth.verify_admin_password(desktop.config, "legacy-password"))
            auth.set_admin_password(desktop.config, "desktop-password")
            self.assertFalse(host.migrate_legacy_admin_auth(desktop.config, legacy.paths.root))
            self.assertTrue(auth.verify_admin_password(desktop.config, "desktop-password"))


class ModelSetupTests(unittest.TestCase):
    def test_mock_does_not_complete_setup(self):
        self.assertFalse(host.has_real_model([]))
        self.assertFalse(host.has_real_model([{"provider": "mock", "model": "mock-model"}]))
        self.assertFalse(host.has_real_model([{"provider": "openai", "model": ""}]))

    def test_real_and_keyless_local_models_are_recognized(self):
        self.assertTrue(host.has_real_model([{"provider": "ollama", "model": "local-model"}]))
        self.assertTrue(host.has_real_model([{"routes": [{"provider": "custom", "model": "configured-model"}]}]))


class OptionsTests(unittest.TestCase):
    def test_valid_options(self):
        value = {"sharing": True, "port": 18400, "external_url": "https://nerya.example.com/", "notifications": False, "language": "zh"}
        expected = {**value, "external_url": "https://nerya.example.com"}
        self.assertEqual(host.validate_options(value), expected)

    def test_invalid_options(self):
        for value in ({"port": True}, {"port": 1023}, {"port": 65536}, {"port": "1234"},
                      {"external_url": "ftp://example.com"}, {"external_url": "https://example.com:8443"},
                      {"external_url": "https://user@example.com"}, {"external_url": "https://example.com/path"},
                      {"sharing": "yes"}, {"notifications": 1}, {"language": "other"}, {"token": "secret"}, []):
            with self.subTest(value=value), self.assertRaises(ValueError):
                host.validate_options(value)

    def test_private_keys_never_published(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "manifest.json").write_text("{}")
            events = []
            runtime = host.DesktopRuntime(root, root, events.append)
            runtime.publish()
            text = json.dumps(events)
            self.assertNotIn(runtime.token, text)
            self.assertNotIn(runtime.proof, text)
            self.assertFalse(runtime.state["sharing"])

    def test_saved_sharing_never_reopens_on_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "manifest.json").write_text("{}")
            (root / "desktop.json").write_text(json.dumps({"sharing": True, "port": 19000, "external_url": "http://nerya.lan", "notifications": True}))
            runtime = host.DesktopRuntime(root, root, lambda _: None)
            self.assertFalse(runtime.state["sharing"])
            self.assertTrue(runtime.settings["notifications"])
            self.assertEqual(runtime.settings["port"], 19000)
            self.assertEqual(runtime.settings["external_url"], "http://nerya.lan")


class SharingTests(unittest.TestCase):
    def test_sharing_switch_keeps_port_after_serving_real_connections(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "manifest.json").write_text("{}")
            runtime = host.DesktopRuntime(root, root, lambda _: None)
            runtime.node_port = 1
            runtime.settings["port"] = 0
            with patch("nerya.api.auth.has_admin_password", return_value=True), patch("nerya.core.config.load_config"):
                try:
                    first = runtime.configure({"sharing": True})
                    port = first["port"]
                    for sharing in (False, True, False):
                        # Exercise an actual response/server-initiated close so
                        # Linux leaves a TIME_WAIT socket, unlike bind-only tests.
                        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                        conn.request("GET", "/", headers={"Transfer-Encoding": "chunked"})
                        response = conn.getresponse()
                        self.assertEqual(response.status, 400)
                        response.read()
                        conn.close()
                        state = runtime.configure({"sharing": sharing})
                        self.assertEqual(state["port"], port)
                        self.assertEqual(state["access_url"], first["access_url"])
                        if host.sys.platform == "linux":
                            self.assertTrue(runtime.access.socket.getsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR))
                finally:
                    runtime.close()

    @unittest.skipUnless(os.name == "nt", "Windows exclusive listener semantics")
    def test_windows_listener_is_exclusive_even_when_reuse_requested(self):
        gateway = host.Gateway(("127.0.0.1", 0), 1, "proof", local=True, reuse_address=True)
        self.addCleanup(gateway.server_close)
        self.assertFalse(gateway.allow_reuse_address)
        self.assertEqual(gateway.socket.getsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE), 1)

    def test_switch_selects_free_port_and_explicit_conflict_is_not_silenced(self):
        with tempfile.TemporaryDirectory() as directory, socket.socket() as occupied:
            root = Path(directory)
            (root / "manifest.json").write_text("{}")
            runtime = host.DesktopRuntime(root, root, lambda _: None)
            runtime.node_port = 1
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            port = occupied.getsockname()[1]
            runtime.settings["port"] = port
            with patch("nerya.api.auth.has_admin_password", return_value=True), patch("nerya.core.config.load_config"):
                try:
                    state = runtime.configure({"sharing": True})
                    self.assertTrue(state["sharing"])
                    self.assertNotEqual(state["port"], port)
                    stopped = runtime.configure({"sharing": False})
                    self.assertFalse(stopped["sharing"])
                    self.assertIsNotNone(runtime.access)
                    self.assertEqual(stopped["access_url"], f"http://127.0.0.1:{runtime.access.server_port}")
                    with self.assertRaisesRegex(ValueError, "sharing_port_unavailable"):
                        runtime.configure({"sharing": True, "port": port})
                finally:
                    runtime.close()


class InboxCompatibilityTests(unittest.TestCase):
    def test_info_reminders_are_opt_in_without_changing_web_defaults(self):
        from nerya.api import routes_inbox
        messages = [{"id": "reminder", "text": "Check workspace", "severity": "info"}]
        with patch.object(routes_inbox, "_read_messages", return_value=messages):
            self.assertEqual(routes_inbox._collect_items(None, types=["notification"]), [])
            items = routes_inbox._collect_items(None, types=["notification"], include_info=True)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["type"], "notification")


class CursorTests(unittest.TestCase):
    def test_history_is_silent_and_only_new_updates_notify(self):
        cursor = host.InboxCursor()
        first = [{"id": "a", "status": "pending"}]
        self.assertEqual(cursor.advance(first), 0)
        self.assertEqual(cursor.advance(first), 0)
        self.assertEqual(cursor.advance(first + [{"id": "b", "status": "pending"}]), 1)
        self.assertEqual(cursor.advance([]), 0)
        self.assertEqual(cursor.advance(first), 0)
        self.assertEqual(cursor.advance([{"id": "a", "status": "resolved"}]), 0)
        self.assertEqual(cursor.advance([{"id": "a", "status": "failed"}]), 1)

    def test_cursor_is_bounded(self):
        cursor = host.InboxCursor()
        cursor.advance([])
        cursor.advance([{"id": str(i)} for i in range(3000)])
        self.assertEqual(len(cursor.seen), 2000)


class ProvenanceTests(unittest.TestCase):
    def test_only_private_socket_can_assert_locality(self):
        self.assertEqual(host.forwarded_headers({}, peer="127.0.0.1", local=True, proof="real"), {"X-Nerya-Local-Peer": "real"})
        for peer, local in (("192.0.2.2", False), ("127.0.0.1", False), ("::1", False)):
            headers = {"Host": "localhost", "X-Nerya-Local-Peer": "forged", "X-Forwarded-For": "127.0.0.1", "X-Real-IP": "127.0.0.1", "Authorization": "Bearer user-token"}
            forwarded = host.forwarded_headers(headers, peer=peer, local=local, proof="real")
            self.assertNotIn("X-Nerya-Local-Peer", forwarded)
            self.assertNotEqual(forwarded["X-Forwarded-For"], "127.0.0.1")
            self.assertEqual(forwarded["Authorization"], "Bearer user-token")

    def test_loopback_browser_on_access_listener_receives_proof(self):
        for request_host in ("127.0.0.1:18400", "localhost:18400"):
            with self.subTest(request_host=request_host):
                forwarded = host.forwarded_headers({"Host": request_host}, peer="127.0.0.1", local=False, proof="real")
                self.assertEqual(forwarded["X-Nerya-Local-Peer"], "real")
                self.assertNotIn("X-Forwarded-For", forwarded)

    def test_forwarded_request_never_receives_proof(self):
        forwarded = host.forwarded_headers({"X-Forwarded-For": "127.0.0.1"}, peer="127.0.0.1", local=True, proof="real")
        self.assertNotIn("X-Nerya-Local-Peer", forwarded)

    def test_hop_headers_and_internal_assertions_are_removed(self):
        forwarded = host.forwarded_headers({"Connection": "x-extra", "x-extra": "remove", "X-Nerya-Dashboard-Internal": "spoof"}, peer="192.0.2.1", local=False, proof="real")
        self.assertNotIn("x-extra", forwarded)
        self.assertNotIn("X-Nerya-Dashboard-Internal", forwarded)


class Echo(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path == "/sse":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            try:
                self.wfile.write(b"data: first\n\n")
                self.wfile.flush()
                time.sleep(1)
                self.wfile.write(b"data: second\n\n")
                self.wfile.flush()
            except OSError:
                pass
            return
        data = json.dumps(dict(self.headers)).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.upstream = host.start_server(ThreadingHTTPServer(("127.0.0.1", 0), Echo))
        self.gateway = host.start_server(host.Gateway(("127.0.0.1", 0), self.upstream.server_port, "proof", local=True))
        self.addCleanup(host.close_server, self.upstream)
        self.addCleanup(host.close_server, self.gateway)

    def get(self, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.gateway.server_port, timeout=2)
        self.addCleanup(conn.close)
        conn.request("GET", "/", headers=headers or {})
        response = conn.getresponse()
        return response.status, json.loads(response.read())

    def test_local_access_provenance(self):
        status, headers = self.get()
        self.assertEqual(status, 200)
        self.assertEqual(headers["X-Nerya-Local-Peer"], "proof")

    def test_localhost_alias_is_allowed(self):
        port = self.gateway.server_port
        status, headers = self.get({"Host": f"localhost:{port}", "Origin": f"http://localhost:{port}"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["X-Nerya-Local-Peer"], "proof")

    def test_dns_rebinding_and_cross_origin_are_rejected(self):
        for headers in ({"Host": "evil.example"}, {"Origin": "https://evil.example"}, {"Sec-Fetch-Site": "cross-site"}):
            with self.subTest(headers=headers):
                self.assertEqual(self.get(headers)[0], 403)

    def test_public_socket_cannot_spoof_local_host(self):
        self.gateway.local = False
        status, headers = self.get({"Host": "127.0.0.1", "X-Nerya-Local-Peer": "proof", "X-Forwarded-For": "127.0.0.1"})
        self.assertEqual(status, 200)
        self.assertNotIn("X-Nerya-Local-Peer", headers)
        self.assertEqual(headers["X-Forwarded-For"], "desktop-share")

    def test_sse_is_delivered_without_buffering(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.gateway.server_port, timeout=2)
        self.addCleanup(conn.close)
        started = time.monotonic()
        conn.request("GET", "/sse")
        response = conn.getresponse()
        self.assertEqual(response.readline(), b"data: first\n")
        self.assertLess(time.monotonic() - started, 0.8)

    def test_stopping_gateway_revokes_existing_connections(self):
        connection = socket.create_connection(("127.0.0.1", self.gateway.server_port), timeout=2)
        self.addCleanup(connection.close)
        # An idle accepted connection must be closed when sharing is disabled.
        deadline = time.monotonic() + 2
        while not self.gateway.connections and time.monotonic() < deadline:
            time.sleep(0.01)
        self.gateway.close_clients()
        self.assertEqual(connection.recv(1), b"")


if __name__ == "__main__":
    unittest.main()
