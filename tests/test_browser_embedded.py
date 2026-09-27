"""Embedded browser geometry and explicit operator-only dialog decisions."""
import threading
import time
from types import SimpleNamespace

import pytest

from nerya.integrations import managed_browser as browser
from nerya.integrations import browser_dialog
from test_managed_browser import running_worker  # noqa: F401

pytestmark = pytest.mark.smoke


@pytest.mark.parametrize('size', [(1440, 900), (1280, 800), (768, 1024), (390, 844), (240, 180), (3840, 3840)])
def test_viewport_changes_real_pages_without_taking_over(running_worker, size):
    worker, driver = running_worker
    viewport = dict(zip(('width', 'height'), size))
    result = worker.call('viewport', viewport)
    assert result['viewport'] == driver.page.viewport_size == viewport
    assert not result['human_control'] and not result['paused']
    revision = result['viewport_revision']
    assert worker.call('viewport', viewport)['viewport_revision'] == revision
    worker.call('new_tab')
    worker.call('status')
    assert all(page.viewport_size == viewport for page in driver.context.pages)


@pytest.mark.parametrize('size', [None, {}, {'width': True, 'height': 800}, {'width': 390.5, 'height': 800},
    {'width': 239, 'height': 800}, {'width': 390, 'height': 179}, {'width': 3841, 'height': 800}, {'width': 390, 'height': 3841}])
def test_invalid_geometry_has_no_effect(running_worker, size):
    worker, driver = running_worker
    with pytest.raises(browser.BrowserError, match='invalid_browser_viewport'):
        worker.call('viewport', size)
    assert driver.page.viewport_size == {'width': 1280, 'height': 800}
    assert worker.call('status')['viewport_revision'] == 0


def test_coordinate_actions_require_current_viewport(running_worker):
    worker, driver = running_worker
    worker.call('handoff', {'focus': False})
    before = worker.call('status')
    after = worker.call('viewport', {'width': 390, 'height': 844})
    body = {'control_id': before['control_id'], 'command': 'click', 'payload': {'x': 389, 'y': 843}}
    with pytest.raises(browser.BrowserError, match='browser_viewport_changed'):
        worker.call('human_command', {**body, 'expected_viewport_revision': before['viewport_revision']})
    assert driver.clicks == 0
    worker.call('human_command', {**body, 'expected_viewport_revision': after['viewport_revision']})
    assert driver.clicks == 1
    for point in ({'x': 390, 'y': 0}, {'x': 0, 'y': 844}, {'x': -1, 'y': 0}):
        with pytest.raises(browser.BrowserError, match='invalid_viewport_coordinates'):
            worker.call('human_command', {**body, 'payload': point})
    assert driver.clicks == 1


def test_resize_does_not_expose_protected_pages(running_worker):
    worker, driver = running_worker
    driver.extra_targets = [{'type': 'page', 'url': 'chrome://password-manager/passwords'}]
    with pytest.raises(browser.BrowserError, match='protected_browser_ui'):
        worker.call('viewport', {'width': 390, 'height': 844})
    assert worker.viewport_revision == 0


def dialog_fixture():
    worker = SimpleNamespace(human_control=True, control_id='operator-one', stopping=threading.Event(),
                             _protected_url=lambda url: not url.startswith('https://'))
    calls = []
    dialog = SimpleNamespace(type='prompt', message='Synthetic confirmation', default_value='draft',
        accept=lambda value='': calls.append(('accept', value)), dismiss=lambda: calls.append(('dismiss', '')))
    mailbox = browser_dialog.OperatorDialogs(worker)
    page = SimpleNamespace(url='https://example.test/')
    return worker, mailbox, page, dialog, calls


@pytest.mark.parametrize('accept', [True, False])
def test_only_current_operator_can_answer_dialog(accept):
    worker, mailbox, page, dialog, calls = dialog_fixture()
    thread = threading.Thread(target=mailbox.show, args=(page, dialog), daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 2
        while mailbox.read() is None and time.monotonic() < deadline:
            time.sleep(.01)
        pending = mailbox.read()
        assert pending and calls == []
        for token in ('', 'old-operator'):
            with pytest.raises(browser.BrowserError, match='browser_dialog_changed'):
                mailbox.respond({'dialog_id': pending['id'], 'control_id': token, 'accept': True})
        mailbox.respond({'dialog_id': pending['id'], 'control_id': worker.control_id, 'accept': accept, 'text': 'chosen'})
        thread.join(2)
        assert not thread.is_alive()
        assert calls == [('accept', 'chosen') if accept else ('dismiss', '')]
        assert mailbox.read() is None
        with pytest.raises(browser.BrowserError, match='browser_dialog_changed'):
            mailbox.respond({'dialog_id': pending['id'], 'control_id': worker.control_id, 'accept': True})
    finally:
        worker.stopping.set()
        thread.join(2)


def test_dialog_timeout_cancels_instead_of_auto_confirming(monkeypatch):
    _, mailbox, page, dialog, calls = dialog_fixture()
    monkeypatch.setattr(browser_dialog, 'HUMAN_DIALOG_TIMEOUT', .01)
    mailbox.show(page, dialog)
    assert calls == [('dismiss', '')] and mailbox.read() is None


def test_protected_dialog_is_not_copied_into_operator_surface():
    _, mailbox, page, dialog, calls = dialog_fixture()
    page.url = 'chrome://password-manager/passwords'
    mailbox.show(page, dialog)
    assert calls == [('dismiss', '')] and mailbox.read() is None
