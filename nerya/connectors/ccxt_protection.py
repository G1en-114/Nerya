"""Market-specific CCXT protection capabilities, with verified adapter exceptions."""
from __future__ import annotations


def protection_routes(client, market: dict, *, order_type: str, side: str, legs: list[str]) -> dict[str, str]:
    """Choose attached / standalone / local independently for each requested leg."""
    feature = getattr(client, "feature_value", None)
    if not callable(feature):
        return {leg: "local" for leg in legs}
    symbol = market["symbol"]
    venue = client.id
    contract = bool(market.get("contract"))
    result = {}
    for leg in legs:
        key = "stopLoss" if leg == "stop_loss" else "takeProfit"
        attached = feature(symbol, "createOrder", key)
        attached = attached is True or isinstance(attached, dict)
        standalone = feature(symbol, "createOrder", key + "Price") is True
        # 4.5.x metadata is not always as specific as its request builder.
        if venue == "bybit" and market.get("spot") and order_type == "market":
            attached = False
        if venue == "bybit" and market.get("spot") and order_type == "stop":
            attached = False
        if venue in ("kucoin", "kucoineu", "kucoinfutures") and order_type in ("stop", "stop_limit"):
            attached = False  # classic builder prioritizes the entry trigger
        if venue == "bitget" and market.get("spot"):
            attached = standalone = False
        if venue == "bitmart":
            attached = False  # 4.5.64 builder handles only scalar TP/SL
        if contract and venue in ("bitmex", "deribit"):
            standalone = True  # builders implement generic trigger / SL-TP scalars
        if venue in ("kucoin", "kucoineu", "kucoinfutures") and side == "sell":
            # The classic attached builder maps SL to down and TP to up
            # regardless of entry side. Independent exits are side-aware.
            attached = False
        if venue == "hyperliquid":
            # 4.5.64's attached batch reuses the primary cloid on both legs.
            # Use independently tracked native exits with unique ids instead.
            attached = False
        # Independent spot exits can lock the same inventory twice; without
        # a native OCO/reduce-only contract they cannot safely emulate a bracket.
        standalone = standalone and contract
        result[leg] = "attached" if attached else "standalone" if standalone else "local"
    return result


def supports_standalone(client, market: dict, kind: str) -> bool:
    feature = getattr(client, "feature_value", None)
    if not callable(feature) or not market.get("contract"):
        return False
    key = "stopLossPrice" if kind == "stop_loss" else "takeProfitPrice"
    return feature(market["symbol"], "createOrder", key) is True or client.id in ("bitmex", "deribit")


def conditional_query_params(venue: str, market: dict, kind: str) -> dict:
    if venue == "bitmart":
        return {"stopLossTakeProfit": True}
    if venue == "htx":
        return {"stopLoss" if kind == "stop_loss" else "takeProfit": True}
    if venue in ("binance", "binanceusdm", "binancecoinm", "gate", "gateio", "okx", "okxus", "bitget") and market.get("contract"):
        return {"trigger": True}
    return {}
