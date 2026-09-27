"""Opt-in main-workspace acceptance: candidates + historical replay, never activation.

Unlike verify_strategy_lifecycle.py, this does not create/reset accounts, copy
packages into strategies/, promote, start schedules, or run live/paper orders.
Runtime/model checks are independently recorded by the isolated lifecycle test.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import urllib.parse
import urllib.request

from jsonschema import Draft202012Validator
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from nerya.core import yaml_io
from nerya.core.config import load_config
from nerya.trading.accounts import get_account_profile
from strategy_e2e_cases import case
from verify_strategy_lifecycle import native_data


async def verify(args: argparse.Namespace) -> bool:
    root = args.workspace.resolve()
    config = load_config(root)
    assert config.get("runtime.live_trading_enabled") is False
    assert get_account_profile(config.paths, args.account).mode == "paper"
    # Changes to these operator settings are never part of this test.
    protected = [root / "nerya.yml", config.paths.accounts_file]
    before = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
    report = json.loads(args.report.read_text()) if args.report.is_file() else {
        "workspace": str(root), "base_url": args.base_url, "cases": {}, "created_at": time.time(),
        "scope": "actual native MCP candidate creation, Skill reads, validation, historical replay, main dashboard",
    }
    assert report["workspace"] == str(root)
    def save() -> None:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str) + "\n")

    env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1]), NERYA_DISABLE_TUNNEL_RESTORE="1")
    if args.system_network:
        # Explicit test-process option only. Match macOS's current network
        # settings rather than an inherited shell proxy; never mutate the
        # operator's environment, workspace settings, or proxy service.
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            env.pop(name, None)
        report["network"] = "system network; inherited proxy variables omitted only for this acceptance subprocess"
    params = StdioServerParameters(command=sys.executable, args=["-m", "nerya.cli.app", "mcp", "serve", "--transport", "stdio", "--workspace", str(root)], env=env)
    async with stdio_client(params) as (reader, writer):
        async with ClientSession(reader, writer) as client:
            await client.initialize()
            schemas = {tool.name: tool.inputSchema for tool in (await client.list_tools()).tools}
            for mode in ("script", "gated", "event"):
                source = case(mode)
                strategy_id = source["strategy_id"].replace("qa_", "qa_primary_", 1)
                row = report["cases"].setdefault(mode, {"strategy_id": strategy_id, "title": source["title"], "calls": []})
                if not row.get("session_id"):
                    opened = await client.call_tool("nerya_session", {"action": "open", "client_request_id": f"primary-strategy-acceptance-{strategy_id}-{report['created_at']}", "title": source["title"] + " · 主服务验收"})
                    assert not opened.isError
                    row["session_id"] = opened.structuredContent["remote_session_id"]
                    save()
                async def call(name: str, payload: dict) -> dict:
                    actual = {"remote_session_id": row["session_id"], **payload}
                    Draft202012Validator(schemas[name]).validate(actual)
                    response = await client.call_tool(name, actual)
                    outer = response.structuredContent
                    assert isinstance(outer, dict) and not response.isError and outer.get("ok") is not False, str(outer)[:1500]
                    decoded = native_data(outer)
                    assert decoded.get("ok") is not False, json.dumps(decoded, ensure_ascii=False)[:1500]
                    row["calls"].append({"tool": name, "ok": True, "call_id": outer.get("nerya_trace", {}).get("call_id")})
                    save()
                    return decoded
                try:
                    for skill in ("strategy_author", "backtest"):
                        loaded = await call("nerya_native_skill_view", {"skill_id": skill})
                        assert "SKILL.md" in json.dumps(loaded) or skill in json.dumps(loaded)
                    if not row.get("proposal_id"):
                        args_create = {k:v for k,v in source.items() if k != "files"}
                        args_create.update(strategy_id=strategy_id, accounts=[args.account])
                        created = await call("nerya_native_strategy_draft_proposal", args_create)
                        row["proposal_id"] = created["proposal_id"]
                        row["strategy_root"] = created["proposal_paths"]["strategy_root"]
                        save()
                    for name, contents in source["files"].items():
                        if name == "strategy.yml":
                            manifest = yaml_io.loads(contents)
                            manifest.update(strategy_id=strategy_id, accounts=[args.account])
                            contents = yaml_io.dumps(manifest)
                        contents = contents.replace("隔离验收候选", "主服务验收候选（不自动上线）")
                        path = f"{row['strategy_root']}/{name}"
                        await call("nerya_native_read_file", {"path": path})
                        if (root / path).read_text() != contents:
                            await call("nerya_native_write_file", {"path": path, "contents": contents})
                    # Use the supported preset without requesting an extra
                    # workspace file. Optional settings-file approval is not
                    # necessary for a standard replay and is never bypassed.
                    row["validation"] = await call("nerya_native_strategy_validate", {"proposal_id": row["proposal_id"]})
                    row["submitted"] = await call("nerya_native_strategy_submit_proposal", {"proposal_id": row["proposal_id"], "note": "18380 main-service acceptance only. Keep pending; do not activate or promote."})
                    replay_args = {"proposal_id": row["proposal_id"], "engine": "native", "preset": "default", "allow_mock": False}
                    if args.config:
                        # An existing read-only evaluation profile; no new
                        # settings file is written into the main workspace.
                        replay_args["config_path"] = str(args.config.resolve(strict=True))
                        report["replay_config"] = replay_args["config_path"]
                    result = await call("nerya_native_strategy_backtest", replay_args)
                    row["backtest"] = result
                    metrics = json.loads(Path(result["raw_metrics_file"]).read_text())
                    assert metrics["provenance"]["data_kind"] == "historical"
                    assert metrics["provenance"]["source_changed_during_run"] is False
                    assert metrics["replay"]["errors"] == 0
                    assert not (config.paths.strategies / strategy_id).exists(), "QA must remain a candidate, not an installed strategy"
                    payload = json.dumps({"strategy_id": strategy_id, "proposal_id": row["proposal_id"], "ts": result["backtest_ts"]}).encode()
                    request = urllib.request.Request(args.base_url + "/api/proxy/strategy/backtests/chart", data=payload, headers={"Content-Type": "application/json"})
                    with urllib.request.urlopen(request, timeout=30) as response:
                        chart = json.load(response)
                    assert chart.get("ok") and chart.get("chart"), str(chart)[:1500]
                    row["main_chart_api"] = True
                    row["ok"] = True
                    row.pop("error", None)
                    print("PRIMARY_OK", mode, row["session_id"], row["proposal_id"], metrics["verdict"], metrics["replay"], flush=True)
                except Exception as exc:
                    row["ok"] = False
                    row["error"] = f"{type(exc).__name__}: {exc}"
                    print("PRIMARY_FAILED", mode, row["error"], flush=True)
                finally:
                    save()
    report["operator_settings_unchanged"] = before == {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in protected}
    report["ok"] = report["operator_settings_unchanged"] and all(r.get("ok") for r in report["cases"].values())
    save()
    return report["ok"]


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--account", required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:18380")
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--config", type=Path, help="Existing read-only replay config (optional)")
    parser.add_argument("--system-network", action="store_true", help="Use OS network settings in this test subprocess instead of inherited proxy variables")
    args = parser.parse_args()
    url = urllib.parse.urlsplit(args.base_url)
    assert url.scheme == "http" and url.hostname in {"127.0.0.1", "localhost", "::1"}
    raise SystemExit(0 if asyncio.run(asyncio.wait_for(verify(args), timeout=600)) else 1)
