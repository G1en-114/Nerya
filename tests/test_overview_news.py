"""The overview feed is bounded, cached, read-only and never substitutes mock news."""
from concurrent.futures import ThreadPoolExecutor

import pytest

from nerya.api import routes_market

pytestmark = pytest.mark.smoke


def handler():
    return next(fn for method, path, fn in routes_market.routes() if (method, path) == ("GET", "/market/news"))


def row(link, date="Mon, 21 Sep 2026 01:00:00 GMT", **extra):
    return {"title": "Fixture headline", "source": "fixture", "link": link, "published_at": date, **extra}


def test_sorted_deduplicated_safe_and_cached(monkeypatch):
    calls = []
    clock = [1000.0]
    monkeypatch.setattr(routes_market, "time", lambda: clock[0])

    def fetch(**kwargs):
        calls.append(kwargs)
        return [row("https://example.com/old", "Sun, 20 Sep 2026 01:00:00 GMT"),
                row("https://example.com/new", "2026-09-21T02:00:00Z"),
                row("https://example.com/new"), row("javascript:alert(1)"),
                row("https://user:password@example.com/secret"), row("https://[bad"),
                row("https://example.com/mock", _envelope={"mode": "mock"}),
                row("https://example.com/undated", "invalid")]

    monkeypatch.setattr(routes_market, "fetch_news", fetch)
    news = handler()
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda _: news(None, {}), range(3)))
    result = results[0]
    assert result["ok"]
    assert [item["link"] for item in result["items"]] == ["https://example.com/new", "https://example.com/old", "https://example.com/undated"]
    assert result["items"][0]["published_at"] == "2026-09-21T02:00:00+00:00"
    assert calls == [{"limit": 90, "allow_mock": False}]
    assert all("_sort_ts" not in item for item in result["items"])
    clock[0] += 301
    news(None, {})
    assert len(calls) == 2


def test_empty_and_failure_are_not_success_or_cached(monkeypatch):
    monkeypatch.setattr(routes_market, "fetch_news", lambda **_: [])
    news = handler()
    assert news(None, {})["ok"] is False

    def fail(**_):
        raise RuntimeError("private upstream credential")

    monkeypatch.setattr(routes_market, "fetch_news", fail)
    result = news(None, {})
    assert result["error"] == "news_fetch_failed"
    assert "credential" not in str(result)
    monkeypatch.setattr(routes_market, "fetch_news", lambda **_: [row("https://example.com/recovered")])
    assert news(None, {})["ok"] is True


def test_bounded_feed_and_read_scope(monkeypatch):
    monkeypatch.setattr(routes_market, "fetch_news", lambda **_: [row(f"https://example.com/{n}") for n in range(100)])
    assert len(handler()(None, {})["items"]) == 30
    from nerya.api.route_scopes import required_scope
    assert required_scope("GET", "/market/news") == "read:runtime"
