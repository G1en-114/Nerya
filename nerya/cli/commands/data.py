"""Local historical data and replay commands; no Agent boot or model required."""
from __future__ import annotations

import json
import sys

from .._common import _add_ws
from ...core.config import load_config
from ...skills.builtin.backtest.scripts.history_data import history_operation
from ...skills.builtin.backtest.scripts.backtest_run import run_strategy_backtest


def _progress(state):
    # Keep stdout machine-readable; interactive progress goes to stderr.
    print(json.dumps({"phase": state.get("phase") or state.get("status"),
        "market": state.get("market"), "timeframe": state.get("timeframe"),
        "rows": state.get("rows"), "cached_rows": state.get("cached_rows"),
        "missing_bars": state.get("missing_bars"),
        "bars_processed": state.get("bars_processed")}, ensure_ascii=False), file=sys.stderr, flush=True)


def cmd_data(args) -> int:
    try:
        config = load_config(args.workspace, profile=args.profile)
        out = history_operation(config, {**vars(args), "action": args.data_action},
                                progress=_progress if args.progress else None)
    except (ValueError, OSError, RuntimeError) as exc:
        out = {"ok": False, "error": type(exc).__name__, "message": str(exc)}
    print(json.dumps(out, ensure_ascii=False, allow_nan=False, default=str))
    return 0 if out["ok"] else 1


def cmd_replay(args) -> int:
    try:
        config = load_config(args.workspace, profile=args.profile)
        out = run_strategy_backtest(strategy_id=args.strategy_id, proposal_id=args.proposal_id,
            package_dir=args.package_dir, config_path=args.config, workspace=config.paths.root,
            preflight_only=args.preflight_only, data_mode=args.data_mode,
            progress=_progress if args.progress else None)
    except Exception as exc:
        out = {"ok": False, "error": type(exc).__name__, "message": str(exc),
               "phase": getattr(exc, "replay_phase", None), "failure_path": getattr(exc, "failure_path", None)}
    print(json.dumps(out, ensure_ascii=False, allow_nan=False, default=str))
    return 0 if out["ok"] else 1


def register(sub) -> None:
    parser = sub.add_parser("data", help="Download, inspect and reuse local historical candles")
    actions = parser.add_subparsers(dest="data_action", required=True)
    for name in ("download", "list", "inspect", "status"):
        p = actions.add_parser(name)
        _add_ws(p)
        p.add_argument("--data-dir")
        p.add_argument("--progress", action="store_true")
        if name in {"download", "inspect"}:
            p.add_argument("--markets", nargs="+", required=True)
            p.add_argument("--timeframes", nargs="+", required=True)
            p.add_argument("--start", help="Inclusive UTC start: YYYY-MM-DD or ISO-8601")
            p.add_argument("--end", help="Exclusive UTC end: YYYY-MM-DD or ISO-8601")
            p.add_argument("--days", type=int, default=180)
            p.add_argument("--timeout-seconds", type=float, default=300)
            p.add_argument("--max-requests", type=int, default=2048)
        if name == "status":
            p.add_argument("--job-id", required=True)
        p.set_defaults(func=cmd_data)
    p = sub.add_parser("backtest", help="Preflight and replay a strategy using local historical data")
    _add_ws(p)
    target = p.add_mutually_exclusive_group(required=True)
    target.add_argument("--strategy-id")
    target.add_argument("--proposal-id")
    target.add_argument("--package-dir")
    p.add_argument("--config", required=True, help="Workspace-relative replay configuration")
    p.add_argument("--data-mode", choices=["local", "download"], default="local")
    p.add_argument("--preflight-only", action="store_true")
    p.add_argument("--progress", action="store_true")
    p.set_defaults(func=cmd_replay)
