"""Exercise the real desktop runtime in a disposable workspace, without an LLM.

Usage: agent/.venv/bin/python agent/desktop/scripts/smoke.py [--resources DIR]
Works with development manifests and relocated release resources alike.
"""
from __future__ import annotations
import argparse
import http.client
import json
import os
from pathlib import Path
import queue
import secrets
import socket
import subprocess
import tempfile
import threading
import time
from urllib.parse import urlsplit


def assert_equal(actual, expected, label):
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")
    print(f"PASS {label}", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--resources", type=Path, default=Path(__file__).resolve().parents[1] / "runtime")
    parser.add_argument("--access-port", type=int, default=18400, help="Use 0 for an isolated available port while the real app is running")
    parser.add_argument("--browser-settings", action="store_true", help="Exercise actual login and settings UI with the bundled browser")
    args = parser.parse_args()
    resources = args.resources.resolve()
    manifest = json.loads((resources / "manifest.json").read_text())
    python = resources / manifest["python"]
    # The child cannot see Homebrew, nvm, shell startup files, model keys or
    # developer environment variables. Only bundled runtimes are available.
    env = {key: os.environ[key] for key in ("SystemRoot", "WINDIR", "TMP", "TEMP") if key in os.environ}
    env.update(PATH="/usr/bin:/bin" if os.name != "nt" else os.environ.get("SystemRoot", "C:\\Windows") + "\\System32",
               PYTHONPATH=os.pathsep.join(str(resources / p) for p in manifest["python_paths"]),
               PYTHONNOUSERSITE="1", PYTHONDONTWRITEBYTECODE="1", PYTHONUTF8="1")
    events = queue.Queue()
    def read_output(stream):
        for line in stream:
            try:
                events.put(json.loads(line))
            except ValueError:
                continue
        events.put({"eof": True})
    def wait_event(predicate, timeout=180):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            event = events.get(timeout=max(0.01, deadline - time.monotonic()))
            if event.get("eof") or event.get("state", {}).get("phase") == "failed":
                raise RuntimeError(f"desktop runtime failed: {event}")
            if predicate(event):
                return event
        raise TimeoutError("desktop event timeout")
    serial = 0
    def configure(options):
        nonlocal serial
        serial += 1
        process.stdin.write(json.dumps({"id": serial, "action": "configure", "options": options}) + "\n")
        process.stdin.flush()
        return wait_event(lambda event: event.get("id") == serial, timeout=30)
    def request(port, endpoint, *, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=90)
        try:
            values = dict(headers or {})
            if body is not None:
                values["Content-Type"] = "application/json"
            conn.request("POST" if body is not None else "GET", endpoint,
                         body=json.dumps(body) if body is not None else None, headers=values)
            response = conn.getresponse()
            data = response.read()
            try:
                value = json.loads(data)
            except ValueError:
                value = data.decode(errors="replace")
            return response.status, value
        finally:
            conn.close()
    with tempfile.TemporaryDirectory(prefix="nerya-desktop-smoke-") as directory:
        data = Path(directory)
        env.update(HOME=str(data), USERPROFILE=str(data), XDG_CONFIG_HOME=str(data / "config"),
                   APPDATA=str(data / "roaming"), LOCALAPPDATA=str(data / "local"))
        for name in ("config", "roaming", "local"):
            (data / name).mkdir()
        initial_port = args.access_port
        if initial_port == 0:
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                initial_port = probe.getsockname()[1]
        if args.access_port != 18400:
            (data / "data").mkdir()
            (data / "data/desktop.json").write_text(json.dumps({"port": initial_port}))
        if manifest.get("browser"):
            browser_env = {**env, "PLAYWRIGHT_BROWSERS_PATH": str(resources / manifest["browser"])}
            subprocess.run([str(python), "-c", "from playwright.sync_api import sync_playwright; p=sync_playwright().start(); b=p.chromium.launch(headless=True); page=b.new_page(); page.set_content('<title>Nerya offline</title>'); assert page.title() == 'Nerya offline'; b.close(); p.stop()"],
                           env=browser_env, cwd=data, check=True, timeout=60)
            print("PASS bundled browser launches without browser cache or extra dependencies", flush=True)
        with (data / "runtime.log").open("w+") as log:
            process = subprocess.Popen([str(python), "-u", str(resources / "runtime_host.py"),
                                        "--resources", str(resources), "--data-dir", str(data / "data")],
                                       env=env, cwd=data, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=log, text=True, encoding="utf-8", bufsize=1)
            threading.Thread(target=read_output, args=(process.stdout,), daemon=True).start()
            try:
                state = wait_event(lambda event: event.get("state", {}).get("phase") == "ready")["state"]
                port = urlsplit(state["local_url"]).port
                assert_equal(state["sharing"], False, "LAN sharing disabled on first launch")
                assert_equal(state["port"], initial_port, "stable access listens on the configured port")
                assert_equal(state["access_url"], f"http://127.0.0.1:{initial_port}", "stable local access URL is published")
                assert_equal(request(initial_port, "/login")[0], 200, "stable port renders the login page")
                assert_equal(request(initial_port, "/api/proxy/workspace")[0], 200, "loopback browser is trusted on the stable port")
                assert_equal(request(initial_port, "/api/proxy/workspace", headers={"Host":"nerya.example.test"})[0], 401, "public Host does not inherit loopback trust")
                assert_equal(request(initial_port, "/api/proxy/auth/status")[1].get("local_access"), True, "loopback access reports socket-local trust")
                assert_equal(request(initial_port, "/api/proxy/auth/status",headers={"X-Forwarded-For":"203.0.113.10"})[1].get("local_access"), False, "forwarded requests remain remote")
                assert_equal(request(port, "/api/proxy/auth/status")[1].get("local_access"), True, "desktop socket reports trusted local access")
                assert_equal(state["start_path"], "/setup?mode=quick", "first launch opens model setup")
                assert_equal(request(port, "/api/proxy/workspace")[0], 200, "private desktop UI remains trusted without manual service configuration")
                assert_equal(request(port, "/setup?mode=quick")[0], 200, "model configuration page renders")
                assert_equal(request(port, "/settings")[0], 200, "login settings remain a valid Web page")
                redirect_status, redirect_body = request(port, "/desktop")
                # Next may prerender a client redirect instead of an HTTP redirect.
                redirected = redirect_status in (307, 308) or (
                    redirect_status == 200 and isinstance(redirect_body, str)
                    and "NEXT_REDIRECT;replace;/settings#access;307;" in redirect_body)
                assert_equal(redirected, True, "old desktop URL redirects to login settings")
                assert_equal(list((data / "data/workspace/strategies").iterdir()), [], "installed runtime initializes zero strategies")
                assert_equal((resources / "app/nerya/workspace/bootstrap.py").exists(), False, "no legacy strategy seeder in packaged source")
                fake_key = "desktop-smoke-not-a-real-secret-" + secrets.token_hex(8)
                code, llm = request(port, "/api/proxy/llm/config", body={"providers": [{
                    "provider": "desktop_smoke", "kind": "chat_completions",
                    "base_url": "http://127.0.0.1:9/v1", "provider_key": fake_key,
                }]})
                assert_equal((code, llm.get("ok")), (200, True), "model key saves without vault environment configuration")
                vault = data / "data/workspace/vault/secrets.enc"
                assert_equal(vault.exists() and fake_key.encode() not in vault.read_bytes(), True, "model key is encrypted at rest")
                with socket.socket() as probe:
                    probe.bind(("127.0.0.1", 0))
                    access_port = probe.getsockname()[1]
                access = configure({"external_url": "https://nerya.example.test", "port": access_port})
                assert_equal(access.get("result", {}).get("external_url"), "https://nerya.example.test", "external access URL is persisted")
                assert_equal(access.get("result", {}).get("port"), access_port, "external access port is persisted")
                assert_equal(access.get("result", {}).get("access_url"), f"http://127.0.0.1:{access_port}", "local access follows configured port")
                assert_equal(request(access_port, "/login")[0], 200, "configured local access port is live immediately")
                stored = json.loads((data / "data/desktop.json").read_text())
                assert_equal((stored.get("external_url"), stored.get("port")), ("https://nerya.example.test", access_port), "external access settings survive desktop persistence")
                denied = configure({"sharing": True})
                assert_equal(denied.get("error"), "admin_password_required_before_sharing", "password required before sharing")
                password = secrets.token_urlsafe(24)
                code, saved = request(port, "/api/proxy/auth/admin/password", body={"new_password": password})
                assert_equal((code, saved.get("ok")), (200, True), "administrator password can be set locally")
                if args.browser_settings:
                    if not manifest.get("browser"):
                        raise AssertionError("settings browser smoke requires packaged browser resources")
                    browser_test = Path(__file__).with_name("settings_browser_smoke.py").resolve()
                    subprocess.run([str(python), str(browser_test)], env=browser_env, cwd=data, text=True,
                                   input=json.dumps({"private_url": state["local_url"], "access_url": f"http://127.0.0.1:{access_port}",
                                                     "workspace": str(data / "data/workspace"), "password": password}),
                                   check=True, timeout=240)
                with socket.socket() as probe:
                    probe.bind(("127.0.0.1", 0))
                    shared_port = probe.getsockname()[1]
                shared = configure({"sharing": True, "port": shared_port})
                assert_equal(shared.get("result", {}).get("sharing"), True, "sharing opens selected listener")
                for headers, label in [({"Host":"nerya.example.test"}, "unauthenticated remote sharing is blocked"),
                                       ({"Host": "localhost", "X-Forwarded-For": "127.0.0.1", "X-Nerya-Local-Peer": "forged"}, "spoofed local provenance is blocked")]:
                    assert_equal(request(shared_port, "/api/proxy/workspace", headers=headers)[0], 401, label)
                code, logged_in = request(shared_port, "/api/proxy/auth/login", body={"password": password},headers={"Host":"nerya.example.test"})
                assert_equal((code, logged_in.get("ok")), (200, True), "remote administrator login succeeds")
                token = logged_in.get("token") or logged_in.get("access_token")
                if not token:
                    raise AssertionError("login did not provide a session token")
                assert_equal(request(shared_port, "/api/proxy/workspace", headers={"Host":"nerya.example.test","Authorization": f"Bearer {token}"})[0], 200, "authenticated remote access succeeds")
                stopped = configure({"sharing": False}).get("result", {})
                assert_equal(stopped.get("sharing"), False, "LAN sharing can be stopped")
                assert_equal(stopped.get("access_url"), f"http://127.0.0.1:{shared_port}", "stopping LAN sharing keeps stable local access")
                assert_equal(request(shared_port, "/login")[0], 200, "local access remains live after LAN sharing stops")
                process.stdin.close()  # Simulate parent exit/crash, not an HTTP shutdown endpoint.
                assert_equal(process.wait(timeout=15), 0, "parent pipe closure stops runtime cleanly")
                with socket.socket() as probe:
                    assert_equal(probe.connect_ex(("127.0.0.1", port)) != 0, True, "private desktop service closes with parent")
                    assert_equal(probe.connect_ex(("127.0.0.1", shared_port)) != 0, True, "stable access port closes with parent")
            except BaseException:
                log.flush()
                log.seek(0)
                print(log.read()[-16000:])
                raise
            finally:
                if process.poll() is None:
                    try:
                        process.stdin.close()
                        process.wait(timeout=15)
                    except (OSError, subprocess.TimeoutExpired):
                        process.kill()
                        process.wait()
                process.stdout.close()
    print("Desktop runtime smoke checks passed.")


if __name__ == "__main__":
    main()
