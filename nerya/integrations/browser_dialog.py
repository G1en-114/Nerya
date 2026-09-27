"""Ephemeral operator-only web dialogs. No dialog text enters Agent traces."""
from __future__ import annotations

import secrets
import threading
import time
from typing import Any

HUMAN_DIALOG_TIMEOUT = 25.0  # Finish before the enclosing browser action timeout.


class OperatorDialogs:
    def __init__(self, worker: Any) -> None:
        self.worker = worker
        self.lock = threading.Lock()
        self.ready = threading.Event()
        self.pending: dict[str, Any] | None = None
        self.answer: dict[str, Any] | None = None
        self.control_id = ''

    def read(self) -> dict[str, Any] | None:
        with self.lock:
            if not self.worker.human_control or self.control_id != self.worker.control_id:
                return None
            return dict(self.pending) if self.pending else None

    def respond(self, payload: dict[str, Any]) -> dict[str, Any]:
        from .managed_browser import BrowserError
        if type(payload.get('accept')) is not bool:
            raise BrowserError('invalid_dialog_response')
        text = payload.get('text', '')
        if not isinstance(text, str) or len(text) > 10000:
            raise BrowserError('invalid_dialog_response')
        with self.lock:
            if (not self.pending or self.answer is not None
                    or payload.get('dialog_id') != self.pending['id']
                    or not self.worker.human_control
                    or payload.get('control_id') != self.control_id
                    or self.worker.control_id != self.control_id):
                raise BrowserError('browser_dialog_changed')
            self.answer = {'accept': payload['accept'], 'text': text}
            self.ready.set()
        return {'ok': True}

    def show(self, page: Any, dialog: Any) -> None:
        from .managed_browser import public_url
        if not self.worker.human_control or page is None or self.worker._protected_url(page.url):
            dialog.dismiss()
            return
        with self.lock:
            self.control_id = self.worker.control_id
            self.answer = None
            self.ready.clear()
            self.pending = {'id': secrets.token_urlsafe(16), 'type': str(dialog.type),
                            'message': str(dialog.message)[:2000],
                            'default_value': str(getattr(dialog, 'default_value', ''))[:2000],
                            'url': public_url(page.url)}
        deadline = time.monotonic() + HUMAN_DIALOG_TIMEOUT
        try:
            # HTTP handlers can answer this mailbox without touching Playwright or
            # waiting behind the action which raised the dialog. Only its owner
            # thread accepts/dismisses it; disconnects and shutdown fail closed.
            while not self.ready.wait(.1):
                if self.worker.stopping.is_set() or time.monotonic() >= deadline:
                    break
            with self.lock:
                answer = self.answer
            if answer and answer['accept'] and not self.worker.stopping.is_set():
                if dialog.type == 'prompt':
                    dialog.accept(answer['text'])
                else:
                    dialog.accept()
            else:
                dialog.dismiss()
        finally:
            with self.lock:
                self.pending = None
                self.answer = None
                self.ready.clear()
