"""Repair the inspected AlphaTrend v2 candidate and replay exact archived datasets.

Opt-in local maintenance. Never promotes, schedules, calls a model or contacts an
exchange. Original candidate and reports remain untouched. Run from agent/.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


RUN = '''# @nerya.step run | 按触发市场决策 | 定时事件扫描全量，K线事件只处理对应市场；每品种去重。
def _save_state(ctx, key, value):
    previous = ctx.state.get(key)
    if not ctx.state.compare_and_set(key, expect=previous, new_value=value):
        raise RuntimeError("strategy state changed concurrently")


def _run_market(ctx, market):
    preset = _params(ctx)
    bars = _closed_candles(ctx, market, preset)
    minimum = max(_pos_int(preset["sma_filter_window"]),
                  _pos_int(preset["macd_slow"]) + _pos_int(preset["macd_signal"]) + 1,
                  _pos_int(preset["atr_window"]) + 1)
    if len(bars) < minimum:
        return ctx.result.hold(reason="skip_warmup", metadata={"market": market, "bars": len(bars)})
    last_key = "alphatrend:last_closed:" + market
    stamp = bars[-1][0]
    previous = ctx.state.get(last_key)
    if previous == stamp:
        return ctx.result.hold(reason="skip_duplicate_candle", metadata={"market": market})
    sig = _signal([b[4] for b in bars], [b[2] for b in bars], [b[3] for b in bars], preset)
    if not ctx.state.compare_and_set(last_key, expect=previous, new_value=stamp):
        return ctx.result.hold(reason="skip_duplicate_candle", metadata={"market": market})

    key = "alphatrend_v3:" + market
    state = dict(ctx.state.get(key) or {})
    positions = ctx.portfolio.positions(market)
    position = positions[0] if positions else None
    qty = float(position.get("size", 0)) if position else 0.0
    close = float(sig["close"])
    stop_mult = float(preset["atr_stop_multiplier"])
    trail_mult = float(preset["trailing_atr_multiplier"])
    if qty:
        # Only settled portfolio data establishes entry direction and price.
        side = "long" if qty > 0 else "short"
        entry = float(position.get("avg_price") or 0)
        if state.get("side") != side or state.get("entry") != entry:
            state = {"entry": entry, "side": side, "atr": float(state.get("atr") or sig["atr"]),
                     "extreme": entry, "stop_moved": False}
        atr = float(state.get("atr") or sig["atr"])
        extreme = max(float(state.get("extreme") or entry), close) if qty > 0 else min(float(state.get("extreme") or entry), close)
        armed = bool(state.get("stop_moved")) or ((extreme - entry) if qty > 0 else (entry - extreme)) >= atr * trail_mult
        stop = entry - atr * stop_mult if qty > 0 else entry + atr * stop_mult
        if armed:
            stop = max(entry, extreme - atr * trail_mult) if qty > 0 else min(entry, extreme + atr * trail_mult)
        state.update(extreme=extreme, stop_moved=armed, stop_price=stop)
        _save_state(ctx, key, state)
        reversal = sig["death"] if qty > 0 else sig["golden"]
        stopped = close <= stop if qty > 0 else close >= stop
        if reversal or stopped:
            # Keep protection state until the portfolio confirms the exit.
            reason = "macd_reversal" if reversal else "trailing_stop" if armed else "atr_stop"
            return ctx.trading.close_position(market=market, side=side, confidence=.8,
                reasoning_ref=f"AlphaTrend {reason}: market={market}, close={close}, entry={entry}, stop={stop}")
        return ctx.result.hold(reason="skip_holding", metadata={"market": market, "stop_price": stop})

    # A rejected/pending entry is not a position. Clear stale exit/entry state.
    if state:
        _save_state(ctx, key, {})
    side = "long" if sig["golden"] and sig["above_sma"] else "short" if sig["death"] and sig["below_sma"] else ""
    if not side:
        return ctx.result.hold(reason="skip_no_signal", metadata={"market": market, "sig": sig})
    receipt = ctx.trading.open_position(market=market, side=side,
        sizing={"method": "fixed_usd", "fixed_usd": float(preset["per_market_stake_usd"])},
        confidence=.65 if side == "long" else .62,
        reasoning_ref=f"AlphaTrend open_{side}: market={market}, close={close}, ATR={sig['atr']}")
    if receipt.get("status") in {"submitted", "filled", "partial"}:
        _save_state(ctx, key, {"atr": sig["atr"], "pending_intent": receipt.get("intent_id")})
    return receipt


def run(ctx: StrategyContext) -> StrategyResult:
    triggered = ctx.trigger.get("market")
    universe = tuple(ctx.config.markets)
    if triggered and triggered not in universe:
        return ctx.result.error(message="Trigger market is outside the configured universe", kind="market_mismatch")
    markets = (triggered,) if triggered else universe
    actions = []
    receipts = []
    for market in markets:
        try:
            result = _run_market(ctx, market)
        except Exception as exc:
            return ctx.result.error(message=f"AlphaTrend {market}: {type(exc).__name__}: {exc}",
                                    kind="alphatrend_error", metadata={"actions": actions})
        raw_status = result.get("status", "unknown") if isinstance(result, dict) else result.status
        status = getattr(raw_status, "value", raw_status)
        reason = result.get("reason", "") if isinstance(result, dict) else result.reason
        actions.append((market, status, reason))
        receipts.append(result)
    if len(receipts) == 1:
        return receipts[0]
    submitted = sum(status == "submitted" for _, status, _ in actions)
    filled = sum(status in {"filled", "partial"} for _, status, _ in actions)
    rejected = sum(status == "rejected" for _, status, _ in actions)
    reason = f"AlphaTrend: submitted={submitted}, filled={filled}, rejected={rejected}, markets={len(markets)}"
    builder = ctx.result.ok if submitted or filled or rejected else ctx.result.hold
    return builder(reason=reason, metadata={"actions": actions})
'''


def repair_source(source: str) -> str:
    marker = "# @nerya.step run | 单市场决策"
    if marker not in source or "market = ctx.config.markets[0]  # 引擎逐市场注入" not in source:
        raise ValueError("Source differs from inspected AlphaTrend v2; review it instead of applying a blind replacement")
    head = source[:source.index(marker)]
    head = "\n".join(line for line in head.splitlines() if not line.startswith("# @nerya."))
    head = head.replace('p = p.get("alpha_trend_params", {}) if isinstance(p, dict) else {}',
                        'p = dict(p.get("alpha_trend_params", {})) if isinstance(p, dict) else {}')
    return ('# @nerya.version 1\n# @nerya.title AlphaTrend 多品种执行与持仓修复（v3）\n'
            '# @nerya.description SMA+MACD 信号不变；按触发品种处理，按已成交持仓维护双向ATR保护。\n'
            '# @nerya.logic K线事件读取ctx.trigger.market；定时事件遍历完整markets并逐品种去重。订单入队不代表成交。\n'
            '# @nerya.rationale 修复markets[0]误用、CAS初始None、未成交即记仓位和移动止盈不可达条件。\n'
            '# @nerya.scope 仅main.py的触发路由、去重和持仓生命周期；保留市场、信号参数与风险限额。\n'
            '# @nerya.validation tests/test_alphatrend_order_repair.py覆盖触发品种、定时扫描、重复事件与双向移动止损；须核对回测订单对账。\n'
            '# @nerya.input 已收盘K线、策略参数、真实模拟账本持仓。\n'
            '# @nerya.output submitted/filled/rejected保持独立；无信号和重复事件返回hold。\n'
            '# @nerya.risk 仅按收盘价检查止损，不能模拟盘中逐笔保护；历史模拟不等于实盘。\n'
            + head.lstrip() + "\n\n" + RUN)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--proposal-id", required=True)
    parser.add_argument("--strategy-id", required=True)
    parser.add_argument("--source-run", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--stage", action="store_true")
    args = parser.parse_args()
    from nerya.core.paths import WorkspacePaths
    from nerya.core import yaml_io
    from nerya.strategies.workflow_service import source_files, view_workflow, propose_workflow
    from nerya.strategies.workflow_graph import package_revision
    from nerya.strategies.package import load_package_from_dir
    from nerya.strategies.verification import replay_provenance
    from nerya.skills.builtin.backtest.scripts.config import load_config
    from nerya.skills.builtin.backtest.scripts.engine import run_backtest
    from nerya.skills.builtin.backtest.scripts.metrics import assemble_metrics
    from nerya.skills.builtin.backtest.scripts.writers import create_run_dir, write_csv_artifacts
    from nerya.skills.builtin.backtest.scripts.render_chart import render_chart
    from nerya.skills.builtin.backtest.scripts.report import render_report
    from nerya.skills.builtin.backtest.scripts.backtest_run import _apply_coverage_gate

    paths = WorkspacePaths(args.workspace.resolve())
    files, _ = source_files(paths, args.strategy_id, args.proposal_id)
    fixed = repair_source(files["main.py"])
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "original-main.py").write_text(files["main.py"])
    (args.out / "fixed-main.py").write_text(fixed)
    old_root = paths.proposals / args.proposal_id / "after" / "strategies" / args.strategy_id
    source_run = old_root / "backtests" / args.source_run
    previous_metrics = json.loads((source_run / "metrics.json").read_text())
    cfg = load_config(config_path=source_run / "config.yml")
    datasets = {}
    matches = {}
    for dataset in previous_metrics["provenance"]["datasets"]:
        venue, symbol = dataset["market"].split(":", 1)
        candidates = paths.artifacts / "backtest_cache" / "candles" / venue / symbol / dataset["timeframe"]
        for path in sorted(candidates.glob("*.parquet")):
            rows = json.loads(path.read_text())
            digest = hashlib.sha256()
            for row in rows:
                digest.update(json.dumps(row, ensure_ascii=False, sort_keys=True, default=str).encode())
                digest.update(b"\n")
            if digest.hexdigest() == dataset["sha256"]:
                datasets.setdefault(dataset["market"], {})[dataset["timeframe"]] = rows
                matches[dataset["market"]] = {"sha256": dataset["sha256"], "rows": len(rows)}
                break
        else:
            raise ValueError(f"No exact archived dataset matches {dataset['market']}; no network or synthetic fallback")
    if not args.stage:
        print(json.dumps({"preview": True, "datasets": matches, "out": str(args.out)}, ensure_ascii=False))
        return
    view = view_workflow(paths, args.strategy_id, args.proposal_id)
    node = next(n for n in view["strategy"]["nodes"] if n.get("binding", {}).get("file") == "main.py" and n.get("editable"))
    staged = propose_workflow(paths, {"strategy_id": args.strategy_id, "proposal_id": args.proposal_id,
        "base_revision": package_revision(files), "changes": [{"node_id": node["id"], "content": fixed}]})
    if not staged.get("ok"):
        raise RuntimeError(json.dumps(staged))
    record = {"source_proposal_id": args.proposal_id, "source_run": args.source_run,
              "proposal_id": staged["proposal_id"], "strategy_id": args.strategy_id,
              "datasets_exact_match": matches, "validation": staged["validation"]}
    record_path = args.out / "repair-record.json"
    record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2))
    package = load_package_from_dir(paths.proposals / staged["proposal_id"] / "after" / "strategies" / args.strategy_id)
    run_dir = create_run_dir(package.root, kind="repair")
    record["out_dir"] = str(run_dir)
    record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2))
    provenance = replay_provenance(package, cfg, datasets, proposal_id=staged["proposal_id"], allow_mock=False)
    provenance.update(replayed_from={"proposal_id": args.proposal_id, "run": args.source_run, "exact_dataset_hashes": True}, source_changed_during_run=False)
    result = run_backtest(package.root, cfg, candles_by_market={m: by_tf[cfg.tf] for m, by_tf in datasets.items()},
        timeframe_candles_by_market=datasets, strategy_config=package.manifest.asdict(), artefacts_dir=run_dir)
    metrics = assemble_metrics(result)
    metrics.update(provenance=provenance, requested_window_days=cfg.window_days, timeframe_fallback=False, missing_timeframes={})
    _apply_coverage_gate(metrics, cfg)
    outputs = write_csv_artifacts(result, run_dir)
    yaml_io.dump(run_dir / "config.yml", cfg.asdict())
    (run_dir / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2, default=str))
    (run_dir / "report.md").write_text(render_report(metrics, result, cfg.asdict(), outputs))
    chart = render_chart(run_dir)
    assert metrics["replay"]["order_accounting_ok"]
    assert metrics["replay"]["orders_filled"] > 0
    assert len({t["market"] for t in result.trades}) > 1
    assert len([p for p in chart["panels"] if p.get("type") == "candlestick"]) == len(cfg.markets)
    record.update(backtest_ts=run_dir.name, replay=metrics["replay"], per_market=metrics["per_market"],
        metrics={key: metrics[key] for key in ("total_return_pct", "max_drawdown_pct", "benchmark_buy_hold_return_pct", "total_trades", "verdict", "flags", "start_utc", "end_utc")},
        max_open_trades=cfg.max_open_trades, chart_market_count=len(cfg.markets), verified=True)
    record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2))
    print(json.dumps(record, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
