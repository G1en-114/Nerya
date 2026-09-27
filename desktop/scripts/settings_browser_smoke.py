"""Called by smoke.py --browser-settings. All writes target its disposable workspace.

The browser performs real form login and uses the bundled production dashboard;
no mocked requests, injected Tauri globals, real model calls or user credentials.
"""
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from playwright.sync_api import sync_playwright, expect


def main():
    options = json.load(sys.stdin)
    private_url, access_url = options["private_url"], options["access_url"]
    expected_root = str(Path(options["workspace"]).resolve())
    assert "nerya-desktop-smoke-" in expected_root, "Refusing non-smoke workspace"
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(locale="en-US", viewport={"width": 1400, "height": 960})
        page = context.new_page()
        errors, bad_requests = [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("response", lambda response: bad_requests.append((urlsplit(response.url).path, response.status))
                if "/api/proxy/" in response.url and response.status >= 400 else None)

        def clean(label):
            alerts = [text.strip() for text in page.locator('[role="alert"]').all_text_contents() if text.strip()]
            assert not alerts, f"{label}: visible errors: {alerts}"
            assert not errors, f"{label}: browser exceptions: {errors}"
            assert not bad_requests, f"{label}: failed API requests: {bad_requests}"
            print(f"PASS UI {label}", flush=True)

        def request_from(page, endpoint, body=None):
            result = page.evaluate("""async ({endpoint, body}) => {
                const token = localStorage.getItem('nerya.admin_jwt.v1');
                const headers = {'Content-Type': 'application/json'};
                if (token) headers.Authorization = 'Bearer ' + token;
                const response = await fetch('/api/proxy' + endpoint, {
                    method: body === null ? 'GET' : 'POST', headers,
                    body: body === null ? undefined : JSON.stringify(body), cache: 'no-store'
                });
                return {status: response.status, value: await response.json()};
            }""", {"endpoint": endpoint, "body": body})
            assert result["status"] == 200, f"{endpoint}: HTTP {result['status']}"
            assert result["value"].get("ok") is not False, f"{endpoint}: operation failed"
            return result["value"]

        def login():
            page.locator('input[type="password"]').fill(options["password"])
            page.locator('button[type="submit"]').click()
            page.wait_for_url(re.compile(r"/settings(?:[?#].*)?$"))
            expect(page.get_by_test_id("primary-model-settings")).to_be_visible()
            expect(page.locator('fieldset')).to_be_enabled()

        page.goto(access_url + "/settings#models")
        page.wait_for_url(re.compile(r"/login\?next="))
        assert parse_qs(urlsplit(page.url).query)["next"] == ["/settings#models"]
        expect(page.locator('input[type="password"]')).to_be_enabled()
        clean("anonymous localhost redirects before loading protected settings")
        login()
        clean("password form login returns to fully loaded model settings")
        browser_root = str(Path(request_from(page, "/workspace")["root"]).resolve())
        assert browser_root == expected_root, (browser_root, expected_root)

        # Observe the same private gateway used by the native WebView in a fresh,
        # token-free browser context. The server supplies the trust, not a mock.
        desktop_context = browser.new_context(locale="en-US")
        desktop = desktop_context.new_page()
        private_trace = []
        desktop.on("pageerror", lambda error: private_trace.append({"error": str(error)}))
        def trace_private(response):
            endpoint = urlsplit(response.url).path
            if "/api/proxy/" in endpoint:
                item = {"path": endpoint, "status": response.status}
                if endpoint.endswith("/auth/status"):
                    item["auth_status"] = response.json()
                private_trace.append(item)
        desktop.on("response", trace_private)
        desktop.goto(private_url + "/settings#models")
        try:
            expect(desktop.get_by_test_id("primary-model-settings")).to_be_visible(timeout=15000)
        except Exception:
            print(json.dumps({"private_url": desktop.url, "trace": private_trace,
                              "body": desktop.locator("body").inner_text()[:700]}, ensure_ascii=False), flush=True)
            raise
        expect(desktop.locator('fieldset')).to_be_enabled()
        desktop_root = str(Path(request_from(desktop, "/workspace")["root"]).resolve())
        assert desktop_root == expected_root, (desktop_root, expected_root)
        assert request_from(desktop, "/auth/status")["local_access"] is True
        assert request_from(page, "/auth/status")["local_access"] is False
        assert request_from(page, "/llm/config") == request_from(desktop, "/llm/config")
        print("PASS both entries use the same workspace and model configuration", flush=True)

        # Exercise the identical settings endpoint in both directions, without
        # sending any requests to the fake provider or enabling a model route.
        for writer, reader, provider in [(page, desktop, "browser_parity"), (desktop, page, "desktop_parity")]:
            request_from(writer, "/llm/config", {"providers": [{"provider": provider, "kind": "chat_completions",
                                                                 "base_url": "http://127.0.0.1:9/v1"}]})
            left = request_from(writer, "/llm/config")
            right = request_from(reader, "/llm/config")
            assert left == right and provider in json.dumps(right)
            print(f"PASS cross-entry settings save/readback: {provider}", flush=True)

        # Real user navigation through every currently exposed settings section.
        sections = ["models", "access", "runtime", "mcp", "interface"]
        for section in sections:
            page.locator(f"#settings-tab-{section}").click()
            expect(page.locator(f"#settings-tab-{section}")).to_have_attribute("aria-current", "page")
            page.wait_for_load_state("networkidle", timeout=15000)
            expect(page.locator('fieldset.settings-flat')).to_be_enabled()
            # Await data-owning independent panels through their normal endpoint.
            if section == "mcp":
                expect(page.locator('input[type="password"]')).to_be_attached()
            page.wait_for_load_state("networkidle", timeout=15000)
            clean("settings section " + section)
        for route in ["/web-search", "/env-vault", "/gateway"]:
            page.goto(access_url + route)
            expect(page.locator('main h1').first).to_be_visible()
            if route != "/gateway":
                expect(page.locator('fieldset.settings-flat')).to_be_enabled()
            page.wait_for_load_state("networkidle", timeout=15000)
            clean("settings integration " + route)

        # Logout is an actual UI action, not just removing storage in the test.
        page.goto(access_url + "/settings#access")
        expect(page.locator('fieldset.settings-flat')).to_be_enabled()
        page.get_by_role("button", name=re.compile(r"Clear current login|清除当前登录", re.I)).click()
        page.wait_for_url(re.compile(r"/login\?next="))
        assert page.evaluate("localStorage.getItem('nerya.admin_jwt.v1')") is None
        print("PASS UI logout on localhost redirects and clears credentials", flush=True)

        # Deliberately seed corrupt/expired state only in this isolated browser.
        for token, expiry in [("invalid-token-fixture", None), ("expired-token-fixture", 1)]:
            page.evaluate("""({token, expiry}) => {
                localStorage.setItem('nerya.admin_jwt.v1', token);
                if (expiry) localStorage.setItem('nerya.admin_jwt_expires_at.v1', String(expiry));
                else localStorage.removeItem('nerya.admin_jwt_expires_at.v1');
            }""", {"token": token, "expiry": expiry})
            bad_requests.clear()
            page.goto(access_url + "/settings#models")
            page.wait_for_url(re.compile(r"/login\?next="))
            expect(page.locator('input[type="password"]')).to_be_enabled()
            assert not page.get_by_test_id("primary-model-settings").count()
            assert not any(path.startswith('/api/proxy/llm/') for path, _ in bad_requests)
            print(f"PASS rejected session recovers without settings request flood: {token}", flush=True)
        assert not errors, errors
        desktop_context.close()
        context.close()
        browser.close()
    print("Settings browser smoke checks passed.", flush=True)


if __name__ == "__main__":
    main()
