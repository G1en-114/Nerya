"""The managed Chromium runtime is the only browser exposed by Nerya."""
from .routes_browser_desktop import routes as desktop_routes


def routes():
    return desktop_routes()
