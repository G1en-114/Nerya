"""Resolve a ranked crypto universe onto one venue in a single bounded call.

The public ranking is fetched once from CoinGecko, then matched against one
venue catalogue returned by :mod:`list_symbols`.  This is intentionally a
skill script so Agent turns do not spend dozens of tool calls re-discovering
the same market-cap list and probing symbols one by one.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .list_symbols import run as list_symbols


_COINGECKO = "https://api.coingecko.com/api/v3/coins/markets"


def run(
    *,
    venue: str,
    count: int = 10,
    quote: str = "USDT",
    rank_by: str = "market_cap",
    exclude_stablecoins: bool = False,
    timeout_s: float = 6.0,
) -> dict[str, Any]:
    venue = str(venue or "").strip().lower()
    quote = str(quote or "USDT").strip().upper()
    count = max(1, min(int(count or 10), 50))
    timeout_s = max(0.5, min(float(timeout_s or 6.0), 15.0))
    if not venue:
        return {"ok": False, "error": "venue is required", "markets": []}
    if rank_by != "market_cap":
        return {"ok": False, "error": "rank_by currently supports market_cap only", "markets": []}

    catalogue = list_symbols(venue=venue)
    if catalogue.get("error"):
        return {
            "ok": False,
            "error": f"venue_catalog_unavailable: {catalogue['error']}",
            "venue": venue,
            "markets": [],
        }
    active: dict[str, dict[str, Any]] = {}
    for row in catalogue.get("symbols") or []:
        if not isinstance(row, dict) or not row.get("active", True):
            continue
        if str(row.get("quote") or "").upper() != quote:
            continue
        typ = str(row.get("type") or "spot").lower()
        if typ not in {"spot", "cash", ""}:
            continue
        base = str(row.get("base") or "").upper()
        if base and base not in active:
            active[base] = row

    # Ask for extra rows so unsupported/self-quoted assets can be skipped while
    # still returning the requested number of tradable markets.
    per_page = min(250, max(30, count * 5))
    query = urlencode({
        "vs_currency": "usd",
        "order": "market_cap_desc",
        "per_page": per_page,
        "page": 1,
        "sparkline": "false",
    })
    request = Request(
        f"{_COINGECKO}?{query}",
        headers={"Accept": "application/json", "User-Agent": "Nerya/1.0 ranked-universe"},
    )
    try:
        with urlopen(request, timeout=timeout_s) as response:  # noqa: S310 - fixed HTTPS host
            ranking = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        return {
            "ok": False,
            "error": f"ranking_source_unavailable: {type(exc).__name__}: {exc}",
            "venue": venue,
            "source": "coingecko",
            "markets": [],
            "should_retry": False,
        }
    if not isinstance(ranking, list):
        return {"ok": False, "error": "ranking_source_invalid", "venue": venue, "markets": []}

    stable_ids = {
        "tether", "usd-coin", "dai", "first-digital-usd", "usds", "paypal-usd",
        "true-usd", "frax", "ethena-usde", "usdd", "binance-usd",
    }
    markets: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for rank_row in ranking:
        if not isinstance(rank_row, dict):
            continue
        symbol = str(rank_row.get("symbol") or "").upper()
        coin_id = str(rank_row.get("id") or "")
        if not symbol or symbol in seen:
            continue
        seen.add(symbol)
        rank = rank_row.get("market_cap_rank")
        base = {
            "rank": rank,
            "coin_id": coin_id,
            "name": rank_row.get("name"),
            "symbol": symbol,
            "market_cap_usd": rank_row.get("market_cap"),
        }
        if exclude_stablecoins and coin_id in stable_ids:
            skipped.append({**base, "reason": "stablecoin_excluded"})
            continue
        venue_row = active.get(symbol)
        if venue_row is None:
            skipped.append({**base, "reason": "no_active_quote_market"})
            continue
        exchange_id = str(venue_row.get("id") or "").strip()
        exchange_symbol = str(venue_row.get("symbol") or "").strip()
        if not exchange_id:
            exchange_id = exchange_symbol.replace("/", "").replace(":", "")
        markets.append({
            **base,
            "market": f"{venue.upper()}:{exchange_id}",
            "exchange_symbol": exchange_symbol,
            "quote": quote,
        })
        if len(markets) >= count:
            break

    return {
        "ok": len(markets) == count,
        "venue": venue,
        "quote": quote,
        "rank_by": rank_by,
        "requested_count": count,
        "count": len(markets),
        "markets": markets,
        "market_ids": [row["market"] for row in markets],
        "venue_mapping_complete": len(markets) == count,
        "needs_symbol_validation": False,
        "next_action_hint": (
            "Use market_ids directly. Do not call list_symbols or another ranking source "
            "when venue_mapping_complete is true."
        ),
        "skipped": skipped,
        "source": "coingecko",
        "source_url": _COINGECKO,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "error": None if len(markets) == count else "insufficient_tradable_ranked_assets",
    }
