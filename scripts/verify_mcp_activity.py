"""Opt-in real local stdio/Tunnel-child acceptance. No models, mocks or trading.

One stable conversation key is reused across every run, restart and UI refresh.
This does NOT claim to exercise the OpenAI cloud transport.
"""
from __future__ import annotations
import argparse
import asyncio
import json
import sqlite3
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from nerya.core.config import load_config

KEY = "nerya-session-activity-acceptance-v2"
GOAL = "验收：连续会话与可读工作进展"


def snapshot(db, source):
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        return {row[0] for row in con.execute("SELECT session_id FROM agent_sessions WHERE source=?", (source,))}
    finally:
        con.close()


async def exercise(args):
    cfg = load_config(args.workspace)
    before = snapshot(cfg.paths.db, args.source)
    params = StdioServerParameters(command=sys.executable,
        args=["-m", "nerya.cli.app", "mcp", "serve", "--transport", "stdio", "--workspace", str(args.workspace)],
        env={"PYTHONPATH": str(Path(__file__).resolve().parents[1]),
             "NERYA_MCP_SOURCE": args.source, "NERYA_DISABLE_TUNNEL_RESTORE": "1"})
    async with stdio_client(params) as (reader, writer):
        async with ClientSession(reader, writer) as client:
            await client.initialize()
            listed = (await client.list_tools()).tools
            role = next(t for t in listed if t.name == "nerya_native_role_list")
            assert "remote_session_id" in role.inputSchema["required"]
            assert "activity" in role.inputSchema["properties"]
            assert any(t.name == "nerya_progress" for t in listed)
            denied = await client.call_tool("nerya_native_role_list", {})
            assert denied.isError and denied.structuredContent["error"]["code"] == "session_required"
            assert snapshot(cfg.paths.db, args.source) == before, "Missing-ID call created a thread"
            for _ in range(3):
                scan = await client.call_tool("nerya_session", {"action": "list", "query": GOAL})
                assert not scan.isError
            assert snapshot(cfg.paths.db, args.source) == before, "Session listing created a thread"
            opened = await client.call_tool("nerya_session", {"action": "open", "client_request_id": KEY, "title": GOAL})
            assert not opened.isError, opened
            sid = opened.structuredContent["remote_session_id"]
            for _ in range(5):
                repeat = await client.call_tool("nerya_session", {"action": "open", "client_request_id": KEY, "title": GOAL})
                assert repeat.structuredContent["remote_session_id"] == sid
                assert repeat.structuredContent["created"] is False
            report = {"workspace": str(args.workspace), "source": args.source, "session_id": sid,
                "coverage": "real local stdio MCP process; Tunnel child path, not OpenAI cloud",
                "missing_id_no_thread": True, "list_no_thread": True, "repeated_open_same_id": True,
                "created": opened.structuredContent["created"], "calls_this_run": []}
            if args.report.exists():
                previous = json.loads(args.report.read_text())
                assert previous["session_id"] == sid, "Session changed between processes"
                report["reused_across_processes"] = True
            async def call(name, arguments):
                result = await client.call_tool(name, {"remote_session_id": sid, **arguments})
                assert not result.isError, result
                receipt = result.structuredContent["nerya_trace"]
                assert receipt["remote_session_id"] == sid and receipt["persisted"]
                report["calls_this_run"].append(receipt["call_id"])
                return result.structuredContent
            await call("nerya_progress", {
                "activity": {"intent": GOAL}, "phase": "检查会话归属", "status": "running",
                "current": "开始检查：重复打开、查询和真实工具调用是否留在同一会话。",
                "result": ["缺少 ID 的调用已被拒绝，数据库没有新增会话。", "连续查询三次未创建线程；重复打开五次返回同一个 ID。"],
                "next": "调用真实角色列表工具，检查返回的会话与执行记录。"})
            first = await call("nerya_native_role_list", {
                "purpose": "只读查看本地角色，不调用模型，也不变更账户或交易。",
                "activity": {"next": "读取当前工作区 Agent 角色列表。"}})
            await call("nerya_native_role_list", {
                "activity": {"evidence": "第一次真实角色查询已成功，返回的会话 ID 与打开时一致。",
                             "next": "在同一会话再次读取角色列表，验证连续调用不拆分。"}})
            await call("nerya_progress", {"status": "completed", "phase": "验证完成",
                "current": "连续会话验收完成：两次真实工具调用与进展记录都写入同一线程。",
                "activity": {"conclusion": "连续调用没有创建额外会话；此验证覆盖本地 stdio/Tunnel 子进程，不代表云端已端到端验收。"},
                "result": ["两次真实只读工具调用均成功。", "缺少 ID 和查询会话不会创建线程。", "重复打开保持同一 ID；工具步骤与公开进展可一起回放。"]})
    after = snapshot(cfg.paths.db, args.source)
    assert after - before == ({sid} if sid not in before else set()), "Unexpected extra session"
    report["new_session_count"] = len(after - before)
    query = urllib.parse.urlencode({"session_id": sid, "full": "1"})
    url = args.base_url.rstrip("/") + "/api/proxy/agent/session/transcript?" + query
    with urllib.request.urlopen(url, timeout=20) as response:
        transcript = json.load(response)
    traces = [m.get("turn", {}).get("external_call") for m in transcript.get("messages", [])]
    assert traces and all(t and t["remote_session_id"] == sid for t in traces)
    turns = {t["turn_id"] for t in traces}
    assert len(turns) == 1, "One intent split into multiple tasks"
    assert [t["sequence"] for t in traces] == list(range(1, len(traces) + 1))
    native = [t for t in traces if t["tool"] == "nerya_native_role_list"]
    assert native and all(t["nodes"] and t["nodes"][0]["status"] == "succeeded" for t in native)
    report.update(total_entries=len(traces), task_count=len(turns), native_call_count=len(native),
                  public_activity_count=sum(bool(t.get("activity")) for t in traces))
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--source", choices=["mcp", "tunnel"], default="tunnel")
    parser.add_argument("--base-url", default="http://127.0.0.1:18380")
    args = parser.parse_args()
    assert (args.workspace / "nerya.yml").is_file()
    host = urllib.parse.urlsplit(args.base_url)
    assert host.scheme == "http" and host.hostname in {"127.0.0.1", "localhost", "::1"}
    asyncio.run(asyncio.wait_for(exercise(args), timeout=60))


if __name__ == "__main__":
    main()
