"""Offline chart fixtures only. These numbers are not user trading evidence."""
import csv
import json

import pytest

from nerya.skills.builtin.backtest.scripts.chart_artifacts import market_panels, market_indicator_panels, hydrate_market_details
from nerya.skills.builtin.backtest.scripts.config import load_config
from nerya.skills.builtin.backtest.scripts.engine import run_backtest
from nerya.skills.builtin.backtest.scripts.writers import write_csv_artifacts

pytestmark = pytest.mark.smoke
T = 1700000000
BTC, ETH = "FIXTURE:BTCUSDT", "FIXTURE:ETHUSDT"


def bar(market=BTC, time=T, price=100):
    return {"market": market, "ts": time, "open": price, "high": price + 2, "low": price - 2, "close": price + 1}


def write_csv(path, rows):
    with path.open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def test_markets_and_same_timestamp_fills_remain_separate():
    trades = [{"ts": T + 15, "market": BTC, "side": side, "price": 101} for side in ("buy", "sell")]
    trades.append({"ts": T + 15, "market": ETH, "side": "buy", "price": 11})
    panels = market_panels([bar(), bar(ETH, price=10)], trades, {"markets": [BTC, ETH], "tf": "1h"})
    assert [p["market"] for p in panels] == [BTC, ETH]
    assert [p["series"][0]["data"][0]["open"] for p in panels] == [100, 10]
    markers = panels[0]["series"][1]["data"]
    assert len(markers) == 2 and {m["text"] for m in markers} == {"B", "S"}
    assert [m["id"] for m in markers] == ["trade:0", "trade:1"]
    assert all(m["time"] == T and m["execution_ts"] == T + 15 for m in markers)
    assert panels[1]["series"][1]["data"][0]["id"] == "trade:2"


def test_markers_are_not_moved_across_missing_or_out_of_range_bars():
    times = [T - 1, T + 10, T + 3601, T + 7201, T + 10800]
    trades = [{"ts": time, "market": BTC, "side": "buy"} for time in times]
    panels = market_panels([bar(), bar(time=T + 7200)], trades, {"markets": [BTC], "tf": "1h"})
    assert [m["execution_ts"] for m in panels[0]["series"][1]["data"]] == [T + 10, T + 7201]


def test_gbs_requires_explicit_recorded_signal():
    signals = [{"ts": T + 5, "market": BTC, "signal_kind": kind, "price": 101} for kind in ("buy", "GBS", "gbs:entry")]
    panel = market_panels([bar()], [], {"markets": [BTC], "tf": "1h"}, signals)[0]
    assert panel["gbs_count"] == 2
    assert [m["kind"] for m in panel["series"][1]["data"]] == ["gbs", "gbs"]
    assert not market_panels([bar()], [{"ts": T, "side": "buy", "reason": "GBS mentioned in prose"}], {"markets": [BTC], "tf": "1h"})[0]["gbs_count"]


def test_missing_market_is_not_assigned_to_every_market():
    panels = market_panels([bar(), bar(ETH)], [{"ts": T, "side": "buy"}], {"markets": [BTC, ETH], "tf": "1h"})
    assert not any(panel["series"][1]["data"] for panel in panels)
    single = market_panels([bar()], [{"ts": T, "side": "buy"}], {"markets": [BTC], "tf": "1h"})
    assert len(single[0]["series"][1]["data"]) == 1


def test_invalid_candles_and_nonfinite_prices_do_not_reach_canvas():
    rows = [bar(), {**bar(time=T + 3600), "high": 1}, {**bar(time=T + 7200), "close": "NaN"}]
    panel = market_panels(rows, [], {"markets": [BTC], "tf": "1h"})[0]
    assert len(panel["series"][0]["data"]) == 1
    json.dumps(panel, allow_nan=False)


def test_legacy_chart_upgrade_keeps_performance_and_does_not_rewrite_evidence(tmp_path):
    write_csv(tmp_path / "ohlcv_indicators_portfolio.csv", [bar(), bar(ETH, price=10)])
    write_csv(tmp_path / "trades.csv", [{"ts": T, "market": BTC, "side": "buy", "price": 101}])
    chart = {"schema_version": "1.0", "meta": {"markets": [BTC, ETH], "tf": "1h", "verdict": "FAIL"},
        "panels": [{"id": name, "series": []} for name in ["price", "equity", "drawdown", "rsi", "missed"]],
        "summary_cards": [{"label": "total_return_pct", "value": -3.5}],
        "tables": [{"id": "trades", "columns": ["ts", "side"], "rows": [[T, "buy"]]}]}
    original = json.dumps(chart)
    (tmp_path / "chart.json").write_text(original)
    upgraded = hydrate_market_details(chart, tmp_path)
    assert len([p for p in upgraded["panels"] if p.get("type") == "candlestick"]) == 2
    assert upgraded["summary_cards"] == chart["summary_cards"]
    assert upgraded["meta"]["verdict"] == "FAIL"
    assert upgraded["tables"][0]["rows"][0][0] == "trade:0"
    assert json.dumps(chart) == original == (tmp_path / "chart.json").read_text()
    assert hydrate_market_details(upgraded, tmp_path) is upgraded


def test_custom_chart_is_not_reinterpreted(tmp_path):
    custom = {"meta": {}, "panels": [{"id": "research", "type": "line"}]}
    assert hydrate_market_details(custom, tmp_path) is custom


def test_indicators_and_chat_overlays_keep_their_market(tmp_path):
    from nerya.skills.builtin.backtest.scripts.render_chart import render_chart
    rows = [{**bar(), "rsi_14": 70}, {**bar(ETH, price=10), "rsi_14": 30}]
    prices = market_panels(rows, [], {"markets": [BTC, ETH]})
    indicators = market_indicator_panels(rows, prices)
    assert [p["series"][0]["data"][0]["value"] for p in indicators] == [70, 30]
    write_csv(tmp_path / "ohlcv_indicators_portfolio.csv", rows)
    write_csv(tmp_path / "trades.csv", [{"ts": T, "market": BTC, "side": "buy", "price": 101}])
    write_csv(tmp_path / "equity.csv", [{"ts": T, "equity": 1000}])
    (tmp_path / "metrics.json").write_text(json.dumps({"markets": [BTC, ETH], "tf": "1h", "initial_capital_usd": 1000}))
    chart = render_chart(tmp_path)
    blocks = [b for b in chart.get("chart_blocks", []) if b.get("chart_kind") == "candlestick"]
    assert len(blocks) == 2
    assert len(blocks[0]["overlays"]) == 1 and blocks[0]["overlays"][0]["text"] == "B"
    assert not blocks[1].get("overlays", [])


def test_engine_persists_sdk_signals_without_creating_orders(tmp_path):
    cfg = load_config(markets=[BTC], overrides={"warmup_bars": 0, "tf": "1h"})
    def observe(ctx):
        ctx.trading.signal(market=BTC, signal_kind="gbs", confidence=.8,
            reasoning_ref="explicit fixture signal", payload={"price": 101, "position": "belowBar"})
        return {"status": "hold", "reason": "fixture, no order"}
    result = run_backtest(None, cfg, candles_by_market={BTC: [bar(), bar(time=T + 3600)]}, run_fn=observe)
    assert len(result.signals) == 2 and not result.trades
    assert all(row["signal_kind"] == "gbs" and row["market"] == BTC for row in result.signals)
    paths = write_csv_artifacts(result, tmp_path)
    with paths["signals"].open() as stream:
        rows = list(csv.DictReader(stream))
    assert len(rows) == 2 and rows[0]["price"] == "101"
