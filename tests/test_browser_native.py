"""Offline coverage of the operator's browser, with no personal credentials."""
import json
from pathlib import Path

import pytest

from nerya.integrations import managed_browser as browser
from nerya.integrations.browser_native import channel, destination, launch_options
from test_managed_browser import FakeDriver, running_worker as _running_worker

running_worker = _running_worker  # Register the shared pytest fixture.

pytestmark = pytest.mark.smoke


@pytest.mark.parametrize('engine', ['chromium', 'chrome'])
def test_native_launch_preserves_extensions_and_system_keychain(engine):
    options = launch_options(engine, ['/safe/local-extension'])
    assert options['channel'] == engine
    assert options['headless'] is True
    assert options['chromium_sandbox'] is True
    assert options['ignore_https_errors'] is False
    ignored = options['ignore_default_args']
    assert {'--disable-extensions', '--password-store=basic', '--use-mock-keychain', '--disable-sync'} <= set(ignored)
    assert not any(arg.startswith('--disable-extensions-except') for arg in options['args'])
    assert any(arg.startswith('--load-extension=') for arg in options['args']) == (engine == 'chromium')
    assert not any(arg.startswith('--remote-debugging-port') for arg in options['args'])
    assert browser.capabilities(engine)['chrome_web_store_install'] == (engine == 'chrome')
    assert browser.capabilities(engine)['virtual_authenticator'] is False


@pytest.mark.parametrize('value', [None, {}, [], '', '../chrome', 'safari', 'Chrome'])
def test_engine_is_an_allowlist(value):
    with pytest.raises(browser.BrowserError, match='unsupported_browser_engine'):
        channel(value)


def test_engine_persists_without_reusing_existing_chromium_profile(tmp_path):
    directory = browser.profile_directory(tmp_path, 'work')
    old = directory / 'chromium'
    old.mkdir()
    (old / 'existing-session').write_text('synthetic')
    browser.save_profile(tmp_path, 'work', [], engine='chrome')
    browser.save_profile(tmp_path, 'work', [])
    assert browser.load_profile(tmp_path, 'work')['engine'] == 'chrome'
    assert (old / 'existing-session').read_text() == 'synthetic'
    launches = []
    def factory():
        driver = FakeDriver()
        original = driver.chromium.launch_persistent_context
        def launch(path, **options):
            launches.append((path, options))
            return original(path, **options)
        driver.chromium.launch_persistent_context = launch
        return driver
    worker = browser.ChromiumWorker(tmp_path, browser.load_profile(tmp_path, 'work'), factory=factory)
    try:
        worker.wait_ready()
        assert Path(launches[0][0]) == directory / 'chrome'
        assert launches[0][1]['channel'] == 'chrome'
    finally:
        worker.close()
        assert worker.done.wait(3)


def test_old_profile_keeps_its_engine(tmp_path):
    directory = browser.profile_directory(tmp_path, 'work')
    (directory / 'settings.json').write_text(json.dumps({'id':'work','version':1,'extensions':[]}))
    assert browser.load_profile(tmp_path, 'work')['engine'] == 'chromium'


@pytest.mark.parametrize('value', ['file:///private', 'chrome://settings', 'eval', {}, 1])
def test_native_destination_cannot_be_arbitrary(value):
    with pytest.raises(browser.BrowserError, match='unsupported_native_browser_page'):
        destination(value, 'chrome')


def test_chrome_store_is_not_advertised_on_chromium():
    with pytest.raises(browser.BrowserError, match='chrome_required_for_web_store'):
        destination('web_store', 'chromium')
    assert destination('web_store', 'chrome') == 'https://chromewebstore.google.com/'


def test_native_manager_pauses_agent_and_never_exposes_pixels(running_worker):
    worker, driver = running_worker
    result = worker.call('native', {'destination':'passwords'})
    assert result['human_control'] and result['paused'] and result['sensitive']
    assert worker.interrupted.is_set()
    assert 'image' not in worker.call('surface')
    with pytest.raises(browser.BrowserError):
        worker.call('network_detail', {'id':'anything'})
    with pytest.raises(browser.BrowserError, match='protected_browser_ui_use_native_window'):
        worker.call('human_command', {'control_id':result['control_id'], 'command':'type', 'payload':{'text':'must-not-be-inserted'}})
    before = len(driver.context.pages)
    worker.call('native', {'destination':'passwords'})
    assert len(driver.context.pages) == before
    current = worker.call('status')
    worker.call('human_command', {'control_id':current['control_id'], 'command':'navigate', 'payload':{'url':'https://example.test/'}})
    assert not worker.call('status')['sensitive']


def test_embedded_handoff_does_not_raise_native_window(running_worker):
    worker, driver = running_worker
    raised = []
    driver.page.bring_to_front = lambda: raised.append(True)
    worker.call('handoff', {'focus':False})
    assert not raised
    worker.call('native', {'destination':'focus'})
    assert raised


def test_stale_page_or_control_never_receives_input(running_worker):
    worker, driver = running_worker
    worker.call('handoff', {'focus':False})
    state = worker.call('status')
    body = {'control_id':state['control_id'], 'command':'click', 'payload':{'x':10,'y':10}}
    for guard in ({'expected_tab_id':'missing'}, {'expected_url':'https://changed.test/'}):
        with pytest.raises(browser.BrowserError, match='browser_(tab|page)_changed'):
            worker.call('human_command', {**body, **guard})
    assert driver.clicks == 0
    worker.call('handoff', {'focus':False})
    with pytest.raises(browser.BrowserError, match='human_control_changed'):
        worker.call('human_command', body)
    assert driver.clicks == 0


@pytest.mark.parametrize('human,agent', [(True, False), (False, False), (False, True)])
def test_unmanaged_dialog_keeps_operator_confirmation(human, agent):
    from types import SimpleNamespace
    calls = []
    worker = browser.ChromiumWorker.__new__(browser.ChromiumWorker)
    worker.human_control = human
    worker.agent_controller = object() if agent else None
    worker.dialogs = SimpleNamespace(show=lambda *_: calls.append('embedded'))
    dialog = SimpleNamespace(page=SimpleNamespace(bring_to_front=lambda: calls.append('focus')),
                             dismiss=lambda: calls.append('dismiss'))
    worker._unmanaged_dialog(dialog)
    assert calls == ([] if agent else ['embedded'] if human else ['dismiss'])


@pytest.mark.parametrize('key', ['Delete','Home','End','PageDown','Shift+ArrowLeft','ControlOrMeta+a','ControlOrMeta+z','ControlOrMeta+Shift+z'])
def test_operator_keyboard_editing(running_worker, key):
    worker, _driver = running_worker
    worker.call('handoff', {'focus':False})
    state = worker.call('status')
    assert worker.call('human_command', {'control_id':state['control_id'], 'command':'press', 'payload':{'key':key}})['ok']
