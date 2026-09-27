"""Opt-in real MCP/API/market/model acceptance in a marked isolated workspace.

Creates actual candidate proposals and persisted MCP conversations. Prices come
from the configured historical provider (allow_mock=False). Model checks invoke
the real Agent runtime once per Agent case; replay statistics never claim those
answers are historical trading performance. No production workspace is touched.
"""
from __future__ import annotations
import argparse
import asyncio
import csv
import json
import os
from pathlib import Path
import runpy
import sys
import time
from datetime import datetime, timezone
import urllib.parse
import urllib.request

from jsonschema import Draft202012Validator
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from nerya.core.config import load_config
from nerya.core import yaml_io
from nerya.strategies.package import load_package, load_package_from_dir

CASES = runpy.run_path(str(Path(__file__).with_name("strategy_e2e_cases.py")))


async def exercise(args):
    root = args.workspace.resolve()
    assert (root / ".strategy-e2e-isolated").is_file(), "Explicit isolated workspace marker is required"
    config = load_config(root)
    assert config.get("runtime.live_trading_enabled") is False
    yaml_io.dump(config.paths.accounts_file, {"accounts":[{"id":"paper_qa", "venue":"mock", "exchange":"mock", "mode":"paper",
        "status":"active", "initial_balance_usd":10000, "permissions":{"place_order":True}}]})
    from nerya.trading.virtual_ledger import open_ledger
    ledger = open_ledger(config.paths, "paper_qa", 10000).snapshot()
    if ledger["cash_usd"] == 0 and not ledger["positions"] and ledger["trade_count"] == 0:
        # A previously unfunded TEST account is initialized through the public
        # paper-account service. No live account and no risk rule is modified.
        from nerya.trading.accounts import reset_paper_account
        reset_paper_account(config.paths, "paper_qa", initial_balance_usd=10000, operator="isolated_acceptance")
    previous = json.loads(args.report.read_text()) if args.report.is_file() else {}
    assert not previous or previous.get("workspace") == str(root)
    report = {"workspace":str(root), "created_at":time.time(), "live_trading_enabled":False,
        "creation":"real native MCP proposal/validation calls; explicit acceptance source packages",
        "data":"real historical provider, allow_mock=false", "cases":dict(previous.get("cases",{}))}
    def save():
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str)+"\n")
    env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1]), NERYA_MCP_SOURCE="mcp", NERYA_DISABLE_TUNNEL_RESTORE="1")
    params = StdioServerParameters(command=sys.executable, args=["-m","nerya.cli.app","mcp","serve","--transport","stdio","--workspace",str(root)], env=env)
    async with stdio_client(params) as (reader, writer):
        async with ClientSession(reader, writer) as client:
            await client.initialize()
            schemas = {t.name:t.inputSchema for t in (await client.list_tools()).tools}
            print("AVAILABLE", [name for name in schemas if "strategy_" in name or name.endswith("skill")], flush=True)
            for mode in args.modes:
                values = CASES["case"](mode)
                entry = report["cases"][mode] = {**previous.get("cases",{}).get(mode,{}), "strategy_id":values["strategy_id"],"title":values["title"]}
                opened = await client.call_tool("nerya_session", {"action":"open", "client_request_id":f"strategy-lifecycle-{mode}-{args.run_key}","title":values["title"]+" · 端到端验收"})
                assert not opened.isError, str(opened)
                sid = opened.structuredContent["remote_session_id"]
                entry["session_id"] = sid
                async def call(name, payload):
                    actual = {"remote_session_id":sid, **payload}
                    Draft202012Validator(schemas[name]).validate(actual)
                    response = await client.call_tool(name, actual)
                    data = response.structuredContent
                    assert data is not None, str(response)
                    assert not response.isError and data.get("ok") is not False, json.dumps(data,ensure_ascii=False)[:3000]
                    decoded = native_data(data)
                    assert decoded.get("ok") is not False, json.dumps(decoded,ensure_ascii=False)[:3000]
                    return decoded
                try:
                    if args.verify_skills:
                        read_skill = "nerya_native_skill_view"
                        assert read_skill in schemas, "Native Skill reference reader not exposed"
                        entry["skill_reads"] = []
                        for skill, filename, needle in [("strategy_author", "SKILL.md", "Finite"),
                                ("backtest", "SKILL.md", "Match the evidence"),
                                ("backtest", "references/config_schema.md", "tf")]:
                            loaded = await call(read_skill, {"skill_id":skill, "file":filename})
                            if skill == "backtest":
                                assert needle in json.dumps(loaded), f"Stale or incorrect {skill}/{filename}"
                            entry["skill_reads"].append({"skill":skill, "file":filename, "ok":True})
                    # Resume the existing candidate, never repeat a successful
                    # create just because later validation or presentation failed.
                    created = native_data(entry["created"]) if entry.get("created") else await call("nerya_native_strategy_draft_proposal", {key:value for key,value in values.items() if key != "files"})
                    entry["created"] = created
                    pid = created["proposal_id"]
                    entry["proposal_id"] = pid
                    package_root = config.paths.proposals / pid / "after" / "strategies" / values["strategy_id"]
                    for filename, content in values["files"].items():
                        path = (package_root / filename).relative_to(root).as_posix()
                        await call("nerya_native_read_file", {"path":path})
                        if (package_root / filename).read_text() != content:
                            await call("nerya_native_write_file", {"path":path, "contents":content})
                    checked = await call("nerya_native_strategy_validate", {"proposal_id":pid})
                    entry["validation"] = checked
                    entry["submitted"] = await call("nerya_native_strategy_submit_proposal", {"proposal_id":pid, "note":"Isolated lifecycle acceptance; candidate remains inactive."})
                    result = await call("nerya_native_strategy_backtest", {"proposal_id":pid,"engine":"native","config_path":"qa-replay.yml","allow_mock":False})
                    entry["backtest"] = result
                    metrics = json.loads(Path(result["raw_metrics_file"]).read_text())
                    chart = json.loads((Path(result["out_dir"]) / "chart.json").read_text())
                    assert metrics["provenance"]["data_kind"] == "historical", "No sample data accepted"
                    assert metrics["provenance"]["source_changed_during_run"] is False
                    assert metrics["replay"]["errors"] == 0
                    curve = next(p for p in chart["panels"] if p["id"] == "equity")["series"][0]["data"]
                    assert curve[-1]["value"] == metrics["final_equity_usd"]
                    assert all(a["time"] < b["time"] for a,b in zip(curve,curve[1:]))
                    entry["verified_metrics"] = {k:metrics.get(k) for k in ["verdict","evaluation_mode","performance_evidence","total_return_pct","max_drawdown_pct","total_trades","start_utc","end_utc","replay"]}
                    entry["backtest_ok"] = True
                    # A separate executable fixture copy for actual runtime testing;
                    # the real candidate stays pending and is never promoted here.
                    candidate = load_package_from_dir(config.paths.proposals / pid / "after" / "strategies" / values["strategy_id"])
                    target = config.paths.strategy(values["strategy_id"])
                    if target.exists():
                        existing = load_package(config.paths, values["strategy_id"])
                        assert existing.content_hash == candidate.content_hash or args.refresh_fixtures, "Existing acceptance package differs; use explicit --refresh-fixtures only in this marked isolated workspace"
                    if not target.exists() or args.refresh_fixtures:
                        for filename in candidate.files:
                            source = candidate.root / filename
                            dest = target / filename
                            dest.parent.mkdir(parents=True, exist_ok=True)
                            dest.write_bytes(source.read_bytes())
                    assert not yaml_io.load(target / "strategy.yml")["schedule"]["enabled"]
                    entry["execution_copy"] = str(target)
                    if args.model_check or mode == "script":
                        entry["runtime"] = await asyncio.to_thread(runtime_check, config, mode, result)
                        entry["runtime_ok"] = True
                    qs = urllib.parse.urlencode({"session_id":sid,"full":"1"})
                    with urllib.request.urlopen(args.base_url.rstrip("/")+"/api/proxy/agent/session/transcript?"+qs,timeout=30) as response:
                        transcript = json.load(response)
                    assert transcript.get("ok") and len(transcript.get("messages",[])) >= 3
                    entry["transcript_messages"] = len(transcript["messages"])
                    entry["ok"] = True
                    entry.pop("error",None)
                    print("CASE_OK",mode,json.dumps(entry["verified_metrics"],ensure_ascii=False),flush=True)
                except Exception as exc:
                    entry["ok"] = False
                    entry["runtime_ok"] = False
                    entry["error"] = f"{type(exc).__name__}: {exc}"
                    print("CASE_FAILED",mode,entry["error"],flush=True)
                save()
    report["ok"] = all(row.get("ok") for row in report["cases"].values())
    save()
    return report["ok"]


def native_data(envelope):
    parts = envelope.get("content", [])
    if len(parts) == 1 and parts[0].get("type") == "json" and isinstance(parts[0].get("data"),dict):
        return parts[0]["data"]
    return envelope


def runtime_check(config, mode, result):
    sid = result["strategy_id"]
    if mode == "script":
        from nerya.strategies.runner import StrategyRunner
        out = StrategyRunner(config).run_tick(sid, operator="isolated_e2e", note="manual paper-only acceptance; schedules remain off")
        data = out.asdict()
        assert not data.get("error") and data.get("status") in {"ok","hold","filled","partial"}, str(data)[:2500]
        return data
    from nerya.triggers.runtime import TriggerRuntime
    with (Path(result["out_dir"])/"ohlcv_indicators_portfolio.csv").open() as fh:
        rows = [{key:(int(float(row[key])) if key=="ts" else float(row[key])) for key in ["ts","open","high","low","close","volume"]} for row in csv.DictReader(fh)]
    # Choose a genuinely qualifying historical window, not invented prices or
    # a hidden force-dispatch flag. Persist exactly which market event was used.
    indexes = [i for i in range(8,len(rows)) if sum(b["close"] for b in rows[i-2:i+1])/3 > sum(b["close"] for b in rows[i-7:i+1])/8]
    assert indexes, "No qualifying historical trend event; gated model execution cannot be claimed"
    if mode == "gated":
        from nerya.strategies.context import build_strategy_context
        context = build_strategy_context(config=config, package=load_package(config.paths,sid), skills=None)
        last = context.state.get("last_signal")
        indexes = [i for i in indexes if rows[i]["ts"] != last]
        assert indexes, "No new qualifying recorded candle to test without resetting deduplication state"
    at = indexes[-1] if mode == "gated" else len(rows)-1
    observed = rows[max(0,at-39):at+1]
    runtime = TriggerRuntime.boot(config)
    cutoff = datetime.fromtimestamp(observed[-1]["ts"]+3600,timezone.utc).isoformat().replace("+00:00","Z")
    event = runtime.from_payload({"source":"manual", "kind":"market.candle_closed", "target":"skill:strategy.agent_task", "strategy_id":sid,
        "payload":{"market":CASES["MARKET"],"timeframe":"1h","candles":observed,"historical":True,"closed_at_unix":observed[-1]["ts"]+3600,"closed_at_utc":cutoff}})
    out = runtime.emit(event)
    data = out.asdict()
    assert out.status == "executed", str(data)[:2500]
    assert out.result.get("final_text"), str(data)[:2500]
    from nerya.strategies.agent_execution import task_output_error
    assert not task_output_error(out.result["final_text"]), "Plain-text tool protocol is not a completed Agent task"
    assert cutoff in out.result["final_text"], "Final response did not retain the canonical provided market cutoff"
    assert str(out.result.get("stopped_reason")) not in {"error","max_iterations","deadline"}, str(data)[:2500]
    assert out.result.get("iterations",0) > 0
    if mode == "gated":
        # New event id, same historical candle: the SCRIPT must dedupe before
        # any model is called, not merely the router rejecting duplicate ids.
        duplicate = runtime.from_payload({"source":"manual", "kind":"market.candle_closed", "target":"skill:strategy.agent_task","strategy_id":sid,"payload":event.payload})
        skipped = runtime.emit(duplicate)
        assert skipped.status == "skipped", str(skipped.asdict())[:2000]
        data["duplicate_check"] = skipped.asdict()
    data["data_window"] = {"first_ts":observed[0]["ts"],"last_ts":observed[-1]["ts"],"rows":len(observed),"source":"historical backtest artifact"}
    return data


if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace",type=Path,required=True)
    parser.add_argument("--report",type=Path,required=True)
    parser.add_argument("--base-url",default="http://127.0.0.1:18580")
    parser.add_argument("--model-check",action="store_true")
    parser.add_argument("--verify-skills",action="store_true")
    parser.add_argument("--refresh-fixtures",action="store_true",help="Update only inactive qa_* execution copies in the marked isolated workspace")
    parser.add_argument("--modes",nargs="+",choices=["script","gated","event"],default=["script","gated","event"])
    parser.add_argument("--run-key",default=str(int(time.time())))
    args=parser.parse_args()
    url=urllib.parse.urlsplit(args.base_url)
    assert url.scheme=="http" and url.hostname in {"localhost","127.0.0.1","::1"}
    raise SystemExit(0 if asyncio.run(asyncio.wait_for(exercise(args),timeout=900)) else 1)
