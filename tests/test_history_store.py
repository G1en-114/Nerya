from concurrent.futures import ThreadPoolExecutor

import pytest

from nerya.data.history_store import HistoryDataError, HistoryStore, coverage, normalize_row, timeframe_seconds
from nerya.skills.builtin.backtest.scripts.history_data import prepare_series

pytestmark = pytest.mark.smoke
T = 1_700_006_400  # UTC grid, hourly boundary.


def bars(start, count, step=3600):
    return [dict(ts=start + i * step, open=100, high=102, low=99, close=101, volume=3) for i in range(count)]


def test_units_validation_and_sample_isolation(tmp_path):
    store = HistoryStore(tmp_path)
    for mult in (1, 1000, 1_000_000):
        assert normalize_row({**bars(T, 1)[0], "ts": T * mult})["ts"] == T
    for bad in (float("nan"), float("inf"), -1):
        with pytest.raises(HistoryDataError):
            store.put("BINANCE:BTCUSDT", "1h", [{**bars(T, 1)[0], "close": bad}], source="test")
    with pytest.raises(HistoryDataError):
        store.put("BINANCE:BTCUSDT", "1h", [{**bars(T, 1)[0], "_envelope": {"mode": "mock"}}], source="test")
    with pytest.raises(HistoryDataError):
        store.put("MOCK:BTCUSDT", "1h", bars(T, 1), source="test")
    with pytest.raises(HistoryDataError):
        timeframe_seconds("1M")
    assert store.inventory() == []


def test_overlap_gap_fill_and_offline_reuse(tmp_path):
    store = HistoryStore(tmp_path)
    calls = []
    def fetch(market, *, start, end, **kwargs):
        calls.append((start, end))
        return bars(start, (end - start) // 3600 + 1)
    first, receipt = prepare_series(store, "BYBIT:BTCUSDT", "1h", T, T + 10 * 3600, fetch=fetch)
    assert len(first) == 10 and receipt["complete"]
    second, receipt = prepare_series(store, "BYBIT:BTCUSDT", "1h", T + 3600, T + 8 * 3600, fetch=fetch, offline=True)
    assert len(second) == 7 and receipt["requests"] == 0 and len(calls) == 1
    prepare_series(store, "BYBIT:BTCUSDT", "1h", T - 2 * 3600, T + 12 * 3600, fetch=fetch)
    assert calls[1:] == [(T - 2 * 3600, T - 1), (T + 10 * 3600, T + 12 * 3600 - 1)]


def test_internal_gap_and_partial_response_never_claim_complete(tmp_path):
    store = HistoryStore(tmp_path)
    store.put("BYBIT:ETHUSDT", "1h", bars(T, 2) + bars(T + 4 * 3600, 2), source="test")
    calls = []
    def short(market, *, start, end, **kwargs):
        calls.append((start, end))
        return bars(T + 2 * 3600, 1)
    rows, receipt = prepare_series(store, "BYBIT:ETHUSDT", "1h", T, T + 6 * 3600, fetch=short, retries=0)
    assert receipt["status"] == "incomplete" and receipt["missing_bars"] == 1
    assert len(rows) == 5
    assert len(calls) == 2
    rows, receipt = prepare_series(store, "BYBIT:ETHUSDT", "1h", T, T + 6 * 3600,
                                  fetch=lambda *a, **kw: bars(T + 3 * 3600, 1))
    assert receipt["complete"] and receipt["cached_rows"] == 5 and receipt["downloaded_rows"] == 1


def test_interrupted_download_commits_completed_segments(tmp_path):
    store = HistoryStore(tmp_path)
    calls = 0
    def fetch(market, *, start, end, **kwargs):
        nonlocal calls
        calls += 1
        if calls > 1:
            raise KeyboardInterrupt()
        return bars(start, (end - start) // 3600 + 1)
    with pytest.raises(KeyboardInterrupt):
        prepare_series(store, "BYBIT:BTCUSDT", "1h", T, T + 1100 * 3600, fetch=fetch)
    assert len(store.read("BYBIT:BTCUSDT", "1h", T, T + 1100 * 3600)) == 1000
    wanted = []
    def resumed(market, *, start, end, **kwargs):
        wanted.append(start)
        return bars(start, (end - start) // 3600 + 1)
    _, receipt = prepare_series(store, "BYBIT:BTCUSDT", "1h", T, T + 1100 * 3600, fetch=resumed)
    assert wanted == [T + 1000 * 3600] and receipt["complete"]


def test_concurrency_dedupes_and_separates_venues(tmp_path):
    store = HistoryStore(tmp_path)
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(lambda i: store.put("BINANCE:BTCUSDT", "1h", bars(T, 10), source="test"), range(3)))
    store.put("BINANCE_PERPETUAL:BTCUSDT", "1h", bars(T, 2), source="test")
    store.put("BINANCE:BTCUSDT", "4h", bars(T, 2, 14400), source="test")
    assert [row["rows"] for row in store.inventory()] == [10, 2, 2]
    assert coverage(bars(T, 2), T, T + 2 * 3600, "1h")["complete"]


def test_legacy_data_does_not_become_verified_history(tmp_path):
    import json
    legacy = tmp_path / "old"
    legacy.mkdir()
    (legacy / f"{T}_{T+3600}.parquet").write_text(json.dumps(bars(T, 2)))
    store = HistoryStore(tmp_path)
    assert store.migrate_legacy("BINANCE:BTCUSDT", "1h", legacy)["imported_rows"] == 2
    assert store.read("BINANCE:BTCUSDT", "1h", T, T + 7200) == []
    assert len(store.read("BINANCE:BTCUSDT", "1h", T, T + 7200, verified_only=False)) == 2
    assert store.migrate_legacy("BINANCE:BTCUSDT", "1h", legacy)["files"] == 0


def test_forming_bar_excluded_and_transactions_reject_bad_batch(tmp_path):
    store = HistoryStore(tmp_path)
    store.put("BYBIT:BTCUSDT", "1h", bars(T, 3), source="test", closed_before=T + 7200)
    assert len(store.read("BYBIT:BTCUSDT", "1h", T, T + 10800)) == 2
    with pytest.raises(HistoryDataError):
        store.put("BYBIT:BTCUSDT", "1h", [*bars(T + 7200, 1), {**bars(T + 10800, 1)[0], "volume": -3}], source="test")
    assert len(store.read("BYBIT:BTCUSDT", "1h", T, T + 18000)) == 2


def test_higher_timeframe_is_derived_from_complete_verified_local_history(tmp_path):
    store = HistoryStore(tmp_path)
    start = (T // (4 * 3600)) * (4 * 3600)
    source = []
    for i in range(8):
        price = 100 + i
        source.append({"ts": start + i * 3600, "open": price, "high": price + 2,
                       "low": price - 1, "close": price + 0.5, "volume": i + 1})
    store.put("BINANCE:BTCUSDT", "1h", source, source="real_fixture")

    network_calls = []
    rows4h, receipt = prepare_series(
        store, "BINANCE:BTCUSDT", "4h", start, start + 8 * 3600,
        fetch=lambda *a, **kw: network_calls.append((a, kw)) or [],
    )
    assert network_calls == []
    assert receipt["complete"] is True
    assert receipt["requests"] == 0
    assert receipt["derived_rows"] == 2
    assert receipt["derived_from_timeframe"] == "1h"
    assert receipt["downloaded_rows"] == 0
    assert [row["ts"] for row in rows4h] == [start, start + 4 * 3600]
    assert rows4h[0]["open"] == 100
    assert rows4h[0]["high"] == 105
    assert rows4h[0]["low"] == 99
    assert rows4h[0]["close"] == 103.5
    assert rows4h[0]["volume"] == 10


def test_local_resample_never_fabricates_partial_target_bucket(tmp_path):
    store = HistoryStore(tmp_path)
    start = (T // (4 * 3600)) * (4 * 3600)
    store.put("BINANCE:ETHUSDT", "1h", bars(start, 7), source="real_fixture")
    calls = []

    def fetch(_market, *, start, end, **_kwargs):
        calls.append((start, end))
        return bars(start, (end - start) // 14400 + 1, step=14400)

    rows4h, receipt = prepare_series(
        store, "BINANCE:ETHUSDT", "4h", start, start + 8 * 3600,
        fetch=fetch, retries=0,
    )
    assert receipt["complete"] is True
    assert receipt["derived_rows"] == 1
    assert calls == [(start + 4 * 3600, start + 8 * 3600 - 1)]
    assert len(rows4h) == 2


def test_mixed_period_provider_response_is_not_downsampled_by_dropping_rows(tmp_path):
    store = HistoryStore(tmp_path)
    start = T // 14400 * 14400
    with pytest.raises(HistoryDataError, match="off-grid"):
        prepare_series(store, "BINANCE:BTCUSDT", "4h", start, start + 14400,
                       fetch=lambda *a, **kw: bars(start, 4), retries=0)
    assert store.read("BINANCE:BTCUSDT", "4h", start, start + 14400) == []


def test_inspect_is_readonly_and_does_not_materialize_resampled_data(tmp_path):
    from types import SimpleNamespace
    from nerya.skills.builtin.backtest.scripts.history_data import history_operation
    cfg = SimpleNamespace(paths=SimpleNamespace(root=tmp_path, artifacts=tmp_path / "artifacts"))
    store = HistoryStore(cfg.paths.artifacts / "backtest_cache")
    start = T // 14400 * 14400
    store.put("BINANCE:BTCUSDT", "1h", bars(start, 8), source="test")
    before = store.path.read_bytes()
    result = history_operation(cfg, {"action":"inspect", "markets":["BINANCE:BTCUSDT"],
                                    "timeframes":["4h"], "start":start, "end":start+28800})
    assert result["status"] == "incomplete"
    assert store.available_timeframes("BINANCE:BTCUSDT") == ["1h"]
    assert store.path.read_bytes() == before
