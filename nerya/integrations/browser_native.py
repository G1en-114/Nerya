"""Native browser capabilities, without access to personal profiles or secrets."""
from __future__ import annotations

from typing import Any

# Playwright's test defaults must not disable the work browser's extension or
# credential features. Keep its private transport and all sandbox/TLS checks.
NATIVE_DEFAULT_ARGS = [
    '--disable-extensions', '--disable-component-extensions-with-background-pages',
    '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--enable-automation', '--password-store=basic',
    '--use-mock-keychain',
]
NATIVE_PAGES = {
    'extensions': 'chrome://extensions/',
    'passwords': 'chrome://password-manager/passwords',
    'settings': 'chrome://settings/',
    'downloads': 'chrome://downloads/',
    'bookmarks': 'chrome://bookmarks/',
    'web_store': 'https://chromewebstore.google.com/',
}


def channel(value: Any = 'chromium') -> str:
    from .managed_browser import BrowserError
    if not isinstance(value, str) or value not in {'chromium', 'chrome'}:
        raise BrowserError('unsupported_browser_engine')
    return value


def launch_options(engine: str, paths: list[str]) -> dict[str, Any]:
    engine = channel(engine)
    # Branded Chrome no longer accepts command-line extension side-loading.
    # Its native manager owns installations; never disable those installations
    # with --disable-extensions-except when adding a local Chromium package.
    # Unified headless Chrome keeps the profile and extensions without a visible
    # desktop window. Normal browsing is rendered exclusively inside Nerya.
    args = ['--window-size=1280,800']
    if paths and engine == 'chromium':
        args.append('--load-extension=' + ','.join(paths))
    return {'channel': engine, 'headless': True, 'args': args,
            'ignore_default_args': NATIVE_DEFAULT_ARGS,
            'chromium_sandbox': True, 'ignore_https_errors': False,
            'viewport': {'width': 1280, 'height': 800}, 'timeout': 30000}


def destination(value: Any, engine: str) -> str | None:
    from .managed_browser import BrowserError
    if not isinstance(value, str) or value not in {'focus', *NATIVE_PAGES}:
        raise BrowserError('unsupported_native_browser_page')
    if value == 'web_store' and channel(engine) != 'chrome':
        raise BrowserError('chrome_required_for_web_store')
    return NATIVE_PAGES.get(value)
