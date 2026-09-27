"""Opt-in, headless embedded-browser checks; no personal profiles or credentials.

NERYA_NATIVE_BROWSER_TEST=1 .venv/bin/python -m pytest -m integration \
    tests/test_browser_native_live.py -q -s
Requires the declared browser extra and installed Chrome / Playwright Chromium.
Native keychain prompts must be completed by the operator on the host computer.
For synthetic rendering/input checks only, NERYA_BROWSER_FIXTURE_KEYCHAIN=1
uses Playwright's temporary test keychain. Such a run does NOT validate native
password or passkey storage and never changes production launch options.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
import base64
import struct
from concurrent.futures import ThreadPoolExecutor
import threading
import time

import pytest

from nerya.integrations import managed_browser as browser

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    os.environ.get('NERYA_NATIVE_BROWSER_TEST') != '1', reason='explicit native-browser opt-in required')]


@pytest.fixture
def local_page():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = b'''<!doctype html><meta charset="utf-8"><title>Nerya browser check</title>
                <style>body{margin:0;font:16px system-ui}input{position:absolute;left:20px;top:20px;width:400px;height:40px}</style>
                <input aria-label="Test input"><div style="height:2400px;padding-top:100px">Local browser fixture</div>
                <script>const input=document.querySelector('input');input.value=localStorage.getItem('test')||'';
                input.oninput=()=>localStorage.setItem('test',input.value);</script>'''
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}/'
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


class ProbeWorker(browser.ChromiumWorker):
    def _command(self, command, payload):
        if command == '_test_dialog':
            assert self.page.url.startswith('http://127.0.0.1:')
            return {'accepted': self.page.evaluate("confirm('Synthetic confirmation')")}
        if command == '_test_probe':
            # Test-only observation on this fixture; never evaluate native pages.
            assert self.page.url.startswith('http://127.0.0.1:')
            return self.page.evaluate('''async () => ({
                text: document.querySelector('input').value,
                y: window.scrollY,
                webauthn: typeof PublicKeyCredential === 'function',
                platformAuthenticator: typeof PublicKeyCredential === 'function'
                    ? await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable() : false
            })''')
        return super()._command(command, payload)


@pytest.mark.parametrize('engine', ['chrome', 'chromium'])
def test_native_browser_lifecycle(tmp_path, local_page, engine, monkeypatch):
    fixture_keychain = os.environ.get('NERYA_BROWSER_FIXTURE_KEYCHAIN') == '1'
    if fixture_keychain:
        from nerya.integrations import browser_native
        native_options = browser_native.launch_options

        def fixture_options(selected_engine, paths):
            options = native_options(selected_engine, paths)
            options['ignore_default_args'] = [flag for flag in options['ignore_default_args']
                if flag not in {'--password-store=basic', '--use-mock-keychain'}]
            return options

        monkeypatch.setattr(browser_native, 'launch_options', fixture_options)
    print({'fixture_keychain': fixture_keychain, 'passkey_storage_verified': False})
    browser.save_profile(tmp_path, 'work', [], engine=engine)
    worker = ProbeWorker(tmp_path, browser.load_profile(tmp_path, 'work'))

    def human(command, payload):
        state = worker.call('status')
        return worker.call('human_command', {
            'command': command, 'payload': payload, 'control_id': state['control_id']})

    try:
        worker.wait_ready()
        worker.call('handoff', {'focus': False})
        human('navigate', {'url': local_page})
        human('click', {'x': 80, 'y': 40})
        human('type', {'text': 'Nerya \u4e2d\u6587'})
        assert worker.call('_test_probe')['text'] == 'Nerya \u4e2d\u6587'
        human('press', {'key': 'ControlOrMeta+a'})
        human('type', {'text': 'persistent-test'})
        human('scroll', {'dx': 0, 'dy': 160})
        surface = worker.call('surface')
        assert surface['image'].startswith('data:image/png;base64,')
        assert not surface['sensitive']
        probe = worker.call('_test_probe')
        assert probe['text'] == 'persistent-test' and probe['webauthn']
        print(engine, {'webauthn': probe['webauthn'], 'platformAuthenticator': probe['platformAuthenticator']})
        for width, height in [(390, 844), (1440, 900), (1000, 600)]:
            worker.call('viewport', {'width': width, 'height': height})
            surface = worker.call('surface')
            png = base64.b64decode(surface['image'].split(',', 1)[1])
            assert struct.unpack('>II', png[16:24]) == (width, height)
            assert surface['viewport'] == {'width': width, 'height': height}
        for accept in (False, True):
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(worker.call, '_test_dialog', timeout=35)
                deadline = time.monotonic() + 8
                while worker.dialogs.read() is None and not pending.done() and time.monotonic() < deadline:
                    time.sleep(.02)
                dialog = worker.dialogs.read()
                assert dialog and not pending.done()
                worker.dialogs.respond({'dialog_id': dialog['id'], 'control_id': worker.control_id, 'accept': accept})
                assert pending.result(5)['accepted'] is accept
        for destination in ['extensions', 'passwords']:
            state = worker.call('native', {'destination': destination})
            assert state['human_control'] and state['sensitive'] and state['paused']
            assert 'image' not in worker.call('surface')
            human('navigate', {'url': local_page})
            assert not worker.call('status')['sensitive']
        worker.close()
        assert worker.done.wait(10)
        worker = ProbeWorker(tmp_path, browser.load_profile(tmp_path, 'work'))
        worker.wait_ready()
        worker.call('handoff', {'focus': False})
        human('navigate', {'url': local_page})
        assert worker.call('_test_probe')['text'] == 'persistent-test'
    finally:
        worker.close()
        assert worker.done.wait(10)
