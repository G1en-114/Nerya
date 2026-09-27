"""Isolated replay regressions. All candle values here are controlled fixtures."""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from nerya.core import yaml_io
from nerya.data.history_store import HistoryStore
from nerya.skills.builtin.backtest.scripts.backtest_run import run_strategy_backtest
from nerya.skills.builtin.backtest.scripts.config import BacktestConfig, BacktestConfigError
from nerya.skills.builtin.backtest.scripts.preflight import BacktestPreflightError

pytestmark = pytest.mark.smoke
T = 1700006400


def package(tmp_path, code="def run(ctx):\n    return ctx.result.hold(reason='test')\n", **settings):
    root = tmp_path / "strategies" / "pipeline_test"
    root.mkdir(parents=True)
    yaml_io.dump(tmp_path / "nerya.yml", {"runtime": {"live_trading_enabled": False}})
    yaml_io.dump(root / "strategy.yml", {"version": 1, "strategy_id": root.name,
        "title": "Pipeline fixture", "mode": "paper", "entrypoint": "main.py:run",
        "markets": ["BYBIT:BTCUSDT"], "accounts": ["fixture_account"],
        "execution_mode": "script", "schedule": {"type": "none", "enabled": False},
        "policy": {"allow_direct_order": True}})
    (root / "main.py").write_text(code)
    cfg = {"start_utc": str(T), "end_utc": str(T + 6 * 3600), "warmup_bars": 0,
           "data_mode": "local", "tf": "1h", **settings}
    yaml_io.dump(tmp_path / "replay.yml", cfg)
    return root


def rows(count=6):
    return [dict(ts=T + i * 3600, open=100+i, high=103+i, low=99+i, close=101+i, volume=10) for i in range(count)]


def seed(tmp_path, count=6):
    # A deterministic storage fixture; these rows are not presented as live or
    # market acceptance evidence. Separate external acceptance uses real data.
    HistoryStore(tmp_path / "artifacts/backtest_cache").put("BYBIT:BTCUSDT", "1h", rows(count), source="test_transport")


def replay(tmp_path, **kwargs):
    return run_strategy_backtest(strategy_id="pipeline_test", workspace=tmp_path, config_path="replay.yml", **kwargs)


@pytest.mark.parametrize("config", [{"unknown_key": 1}, {"allow_short": "false"}, {"tf": "1M"},
    {"initial_capital_usd": float("nan")}, {"fee_bps_by_venue": {"BYBIT": -1}}, {"warmup_bars": -1}])
def test_invalid_config_rejected(config):
    with pytest.raises(ValueError):
        BacktestConfig.from_raw(config)


@pytest.mark.parametrize("code, expected", [
    ("def run(ctx):\n return (\n", "syntax_error"),
    ("import definitely_missing_nerya_library\ndef run(ctx): pass\n", "dependency_missing"),
    ("def run(ctx):\n return ctx.trading.open_position(market='BYBIT:BTCUSDT', side='long', protection={'stop_loss': {'type':'atr','value':2.0}})\n", "unsupported_protection"),
])
def test_known_errors_before_network_or_execution(tmp_path, monkeypatch, code, expected):
    root = package(tmp_path, code, data_mode="download")
    def forbidden(*a, **kw):
        pytest.fail("preflight must run before network or candles")
    monkeypatch.setattr("nerya.skills.builtin.backtest.scripts.backtest_run.get_candles", forbidden)
    with pytest.raises(BacktestPreflightError) as failure:
        replay(tmp_path)
    assert expected in {row["code"] for row in failure.value.receipt["blockers"]}
    receipt = json.loads(Path(failure.value.failure_path).read_text())
    assert receipt["phase"] == "preflight" and receipt["status"] == "failed"
    assert not list(root.glob("backtests/**/metrics.json"))


def test_preflight_only_never_runs_user_top_level_code(tmp_path):
    marker = tmp_path / "should_not_exist"
    package(tmp_path, f"from pathlib import Path\nPath({str(marker)!r}).write_text('bad')\ndef run(ctx): pass\n")
    result = replay(tmp_path, preflight_only=True)
    assert result["ok"] and result["result_type"] == "backtest_preflight"
    assert not marker.exists()


def test_local_replay_receipts_source_and_data_snapshot(tmp_path, monkeypatch):
    package(tmp_path)
    seed(tmp_path)
    def forbidden(*a, **kw):
        pytest.fail("local replay cannot fetch network data")
    monkeypatch.setattr("nerya.skills.builtin.backtest.scripts.data_cache._source_fetch", forbidden)
    result = replay(tmp_path)
    assert result["ok"] and result["data_manifest"]["requested_window_complete"]
    folder = Path(result["run_path"])
    assert json.loads((folder / "run.json").read_text())["status"] == "completed"
    assert (folder / "source/pipeline_test/main.py").is_file()
    assert json.loads((folder / "replay_input.json").read_text())["candles_by_market"]["BYBIT:BTCUSDT"] == rows()
    assert not (folder / "failure.json").exists()


def test_incomplete_local_history_blocks_before_worker(tmp_path):
    root = package(tmp_path)
    seed(tmp_path, 4)
    with pytest.raises(BacktestPreflightError) as error:
        replay(tmp_path)
    assert error.value.reason == "backtest_data_incomplete"
    assert error.value.receipt["datasets"][0]["missing_bars"] == 2
    assert not list(root.glob("backtests/**/worker.log"))
    assert len(HistoryStore(tmp_path / "artifacts/backtest_cache").read("BYBIT:BTCUSDT", "1h", T, T + 6 * 3600)) == 4


def test_dynamic_failure_isolated_and_recorded(tmp_path):
    package(tmp_path, "def run(ctx):\n raise RuntimeError('controlled branch failure')\n")
    seed(tmp_path)
    with pytest.raises(RuntimeError) as error:
        replay(tmp_path)
    receipt = json.loads(Path(error.value.failure_path).read_text())
    assert receipt["phase"] == "replaying"
    assert "controlled branch failure" in receipt["error"]["message"]
    assert receipt["error"]["market"] == "BYBIT:BTCUSDT"


def test_hung_strategy_worker_is_stopped_by_parent_deadline(tmp_path):
    package(tmp_path, "def run(ctx):\n while True: pass\n", max_run_seconds=0.7)
    seed(tmp_path)
    start = time.monotonic()
    with pytest.raises(TimeoutError) as error:
        replay(tmp_path)
    assert time.monotonic() - start < 8
    assert Path(error.value.failure_path).exists()


def test_worker_does_not_fetch_current_data(tmp_path):
    package(tmp_path, "import socket\ndef run(ctx):\n socket.create_connection(('example.com', 443))\n")
    seed(tmp_path)
    with pytest.raises(RuntimeError, match="Network access is disabled"):
        replay(tmp_path)


def test_explicit_partial_research_is_not_full_coverage(tmp_path):
    package(tmp_path, coverage_policy="allow_partial")
    seed(tmp_path, 4)
    result = replay(tmp_path)
    assert result["ok"] and result["coverage_ok"] is False
    assert "NOT a complete" in result["coverage_message"]
