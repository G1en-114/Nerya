"""On-chain token OHLCV fetcher backed by GeckoTerminal's public API.

GeckoTerminal (https://api.geckoterminal.com) exposes a free, no-key REST
surface that returns candles for any DEX token / pool across the major
EVM chains and Solana. We prefer it over scrape-based alternatives because

* it's public and stable enough to ship without operator setup,
* it matches Nerya's "fetch real data, only fall back when unreachable"
  posture for other feeds (news RSS, DefiLlama, funding APIs).

If the service is unreachable we return an empty list rather than raising
— upstream skills should treat that as "no candles this tick" instead of
failing the agent turn.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlencode

from ..connectors.http import UrllibHttp
from ..core.truth import (
    degraded_envelope,
    live_envelope,
    tag_list_envelope,
)


_BASE = "https://api.geckoterminal.com/api/v2"


_CHAIN_SLUGS = {
    "ethereum": "eth", "eth": "eth",
    "bsc": "bsc", "bnb": "bsc",
    "polygon": "polygon_pos", "polygon_pos": "polygon_pos",
    "arbitrum": "arbitrum", "arbitrum_one": "arbitrum",
    "base": "base",
    "optimism": "optimism",
    "avalanche": "avax",
    "solana": "solana", "sol": "solana",
}


_TIMEFRAMES = {
    "1m": ("minute", 1),
    "5m": ("minute", 5),
    "15m": ("minute", 15),
    "30m": ("minute", 30),
    "1h": ("hour", 1),
    "4h": ("hour", 4),
    "1d": ("day", 1),
    "day": ("day", 1),
}


def _slug(chain: str) -> str | None:
    return _CHAIN_SLUGS.get((chain or "").lower())


def _timeframe(interval: str) -> tuple[str, int]:
    return _TIMEFRAMES.get((interval or "1h").lower(), ("hour", 1))


def supported_intervals() -> list[str]:
    """Return the on-chain kline intervals this provider can satisfy.

    Exposed as a registry-facing helper so the wallet skill can show
    operators the current set instead of hardcoding it in a manifest
    enum. Extending this list also automatically extends what the skill
    accepts.
    """
    return sorted(_TIMEFRAMES.keys(), key=lambda k: (
        0 if k.endswith("m") else 1 if k.endswith("h") else 2,
        int("".join(ch for ch in k if ch.isdigit()) or "0"),
        k,
    ))


def supported_chains() -> list[str]:
    """Return the chain aliases this provider understands."""
    return sorted(_CHAIN_SLUGS.keys())


def fetch_token_klines(
    chain: str,
    token_or_pool: str,
    *,
    interval: str = "1h",
    limit: int = 100,
    http: UrllibHttp | None = None,
    timeout_s: float = 10.0,
    start: int | None = None,
    end: int | None = None,
    token_mint: str | None = None,
) -> list[dict[str, Any]]:
    """Return ``limit`` most recent OHLCV bars for ``token_or_pool`` on ``chain``.

    GeckoTerminal only returns candles by pool address, so we first try the
    input as a pool; if that fails we look up the token's top pool and
    re-query. Each candle is returned as
    ``{"ts", "open", "high", "low", "close", "volume"}``.
    """
    slug = _slug(chain)
    chain_l = (chain or "").lower()
    if not slug or not token_or_pool:
        return tag_list_envelope(
            [],
            degraded_envelope(
                "onchain_klines",
                error="unsupported_chain_or_empty_token",
                venue=chain_l or "unknown",
            ),
        )
    if interval.lower() not in _TIMEFRAMES:
        raise ValueError(f"unsupported onchain interval: {interval}")
    tf, agg = _timeframe(interval)
    h = http or UrllibHttp()
    if '@' in token_or_pool:
        token_or_pool, selected_mint = token_or_pool.split('@', 1)
        token_mint = token_mint or selected_mint

    resolved = _pool_for(h, slug, token_or_pool, timeout_s=timeout_s)
    if not resolved:
        return tag_list_envelope(
            [],
            degraded_envelope(
                "onchain_klines",
                error="pool_not_found",
                venue=chain_l,
            ),
        )

    pool, side = resolved
    target = max(1,min(int(limit),10000))
    params = {"aggregate":agg, "limit":min(target,1000), "token":token_mint or side, "currency":"usd"}
    if end is not None:
        params["before_timestamp"] = int(end) + 1
    ohlcv = []
    seen = set()
    for _ in range((target+999)//1000+1):
        url = f"{_BASE}/networks/{slug}/pools/{pool}/ohlcv/{tf}?{urlencode(params)}"
        try:
            status,doc = h.request("GET",url,headers={"accept":"application/json"},timeout=timeout_s)
        except Exception as exc:
            return tag_list_envelope([],degraded_envelope("onchain_klines",error=type(exc).__name__,venue=chain_l))
        if status>=400 or not isinstance(doc,dict):
            return tag_list_envelope([],degraded_envelope("onchain_klines",error=f"http_{status}",venue=chain_l))
        page=(((doc.get("data") or {}).get("attributes") or {}).get("ohlcv_list")) or []
        fresh=[r for r in page if len(r)>=6 and int(r[0]) not in seen]
        if not fresh:break
        ohlcv.extend(fresh);seen.update(int(r[0]) for r in fresh)
        oldest=min(int(r[0]) for r in fresh)
        if len(ohlcv)>=target or len(page)<params["limit"] or (start is not None and oldest<=start):break
        params["before_timestamp"]=oldest
        params["limit"]=min(1000,target-len(ohlcv))
    out: list[dict[str, Any]] = []
    for row in ohlcv:
        if len(row) < 6:
            continue
        try:
            ts, o, hi, lo, c, v = row[:6]
            if (start is not None and int(ts) < start) or (end is not None and int(ts) > end):
                continue
            out.append({
                "ts": int(ts),
                "open": float(o),
                "high": float(hi),
                "low": float(lo),
                "close": float(c),
                "volume": float(v),
                'price_currency':'USD',
            })
        except Exception:
            continue
    out.sort(key=lambda r: r["ts"])
    out=out[-target:]
    if not out:
        return tag_list_envelope(
            [],
            degraded_envelope(
                "onchain_klines",
                error="empty_result",
                venue=chain_l,
            ),
        )
    return tag_list_envelope(
        out,
        live_envelope(source="geckoterminal", venue=chain_l),
    )


def _pool_for(
    http: UrllibHttp, slug: str, token_or_pool: str, *, timeout_s: float = 10.0,
) -> tuple[str, str] | None:
    """Return the pool address for ``token_or_pool`` on network ``slug``.

    Strategy:

    1. Assume ``token_or_pool`` is already a pool address, attempt a
       ``/pools/{addr}`` lookup — if it 200s we're done.
    2. Otherwise fetch ``/tokens/{addr}/pools?page=1`` and use the first
       result, which is typically the highest-volume pair for that token.
    """
    base = f"{_BASE}/networks/{slug}"
    try:
        status, _ = http.request(
            "GET", f"{base}/pools/{token_or_pool}",
            headers={"accept": "application/json"}, timeout=timeout_s,
        )
        if 200 <= status < 300:
            return token_or_pool, "base"
    except Exception:
        pass

    try:
        status, doc = http.request(
            "GET", f"{base}/tokens/{token_or_pool}/pools?page=1",
            headers={"accept": "application/json"}, timeout=timeout_s,
        )
    except Exception:
        return None
    if status >= 400 or not isinstance(doc, dict):
        return None
    items = doc.get("data") or []
    if not items:
        return None
    first = items[0] if isinstance(items, list) else items
    attrs = (first or {}).get("attributes") or {}
    addr = (attrs.get("address")
            or (first or {}).get("id", "").split("_", 1)[-1])
    relations = (first or {}).get("relationships") or {}
    quote_id = str(((relations.get("quote_token") or {}).get("data") or {}).get("id") or "")
    quoted_token = quote_id.split("_", 1)[-1]
    same = quoted_token == token_or_pool if slug == "solana" else quoted_token.lower() == token_or_pool.lower()
    return (addr, "quote" if same else "base") if addr else None


__all__ = ["fetch_token_klines"]
