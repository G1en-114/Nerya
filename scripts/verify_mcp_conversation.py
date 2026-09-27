"""Opt-in live conversation acceptance. Real local MCP calls; no mocks/models/trades.

Reads existing workspace Agent documentation only. Reuses one key per source across reruns.
Tunnel coverage is the real local stdio child, not an OpenAI cloud roundtrip.
"""
from __future__ import annotations
import argparse
import asyncio
import json
import shlex
import sqlite3
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from jsonschema import Draft202012Validator
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from nerya.core.config import load_config

KEY = "nerya-mcpx-conversation-display-v3"
TITLE = "对话式工具记录 · 真实文件与命令验收"

def session_ids(db, source):
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        return {row[0] for row in con.execute("SELECT session_id FROM agent_sessions WHERE source=?", (source,))}
    finally:
        con.close()

async def exercise(args):
    root = args.workspace.resolve()
    cfg = load_config(root)
    before = session_ids(cfg.paths.db, args.source)
    candidates = [root / "agents/main.agent.md", root / "agents/system.md"]
    paths = []
    for path in candidates:
        if path.is_file() and path.resolve().is_relative_to(root) and not path.is_symlink():
            relative = path.relative_to(root).as_posix()
            if relative not in paths:
                paths.append(relative)
        if len(paths) == 2:
            break
    assert len(paths) == 2, "Two existing workspace Agent docs are required; no mock files will be created"
    report = {"workspace": str(root), "source": args.source, "paths": paths, "title": TITLE,
              "coverage": "real local MCP stdio; Tunnel child only, no OpenAI cloud", "calls_this_run": []}
    params = StdioServerParameters(command=sys.executable,
        args=["-m", "nerya.cli.app", "mcp", "serve", "--transport", "stdio", "--workspace", str(root)],
        env={"PYTHONPATH": str(Path(__file__).resolve().parents[1]), "NERYA_MCP_SOURCE": args.source,
             "NERYA_DISABLE_TUNNEL_RESTORE": "1"})
    async with stdio_client(params) as (reader, writer):
        async with ClientSession(reader, writer) as client:
            await client.initialize()
            schemas = {tool.name: tool.inputSchema for tool in (await client.list_tools()).tools}
            opened = await client.call_tool("nerya_session", {"action": "open", "client_request_id": KEY, "title": TITLE})
            assert not opened.isError
            sid = opened.structuredContent["remote_session_id"]
            report["session_id"] = sid
            if args.report.exists():
                assert json.loads(args.report.read_text())["session_id"] == sid
            async def call(name, values):
                payload = {"remote_session_id": sid, **values}
                Draft202012Validator(schemas[name]).validate(payload)
                result = await client.call_tool(name, payload)
                assert not result.isError, f"{name}: {result.structuredContent}"
                receipt = result.structuredContent["nerya_trace"]
                assert receipt["remote_session_id"] == sid and receipt["persisted"]
                report["calls_this_run"].append(receipt["call_id"])
                return result.structuredContent
            if args.append:
                await call("nerya_native_read_file", {"path": paths[0], "offset": 24, "limit": 10,
                    "activity": {"next": "继续读取同一个 Agent 文档的后续行，检查页面能否直接追加工具记录。"}})
            else:
                await call("nerya_native_list_dir", {"path": str(Path(paths[0]).parent),
                    "activity": {"intent": "查看 Agent 文档、搜索工具使用规则，并核对文件行数。", "next": "先查看 agents 目录中有哪些文件。"}})
                await call("nerya_native_read_file", {"path": paths[0], "offset": 10, "limit": 14,
                    "activity": {"next": "读取 main.agent.md 第 11–24 行，查看具体工作规则。"}})
                # Deliberately omit activity: the actual file/line/output must still be visible.
                await call("nerya_native_read_file", {"path": paths[1], "offset": 10, "limit": 14})
                await call("nerya_native_grep", {"pattern": "tool", "path": paths[0], "max_results": 6,
                    "activity": {"evidence": "main.agent.md 和 system.md 都已读取成功。", "next": "在 main.agent.md 中搜索 tool，查看工具使用规则所在行。"}})
                command = "wc -l " + " ".join(shlex.quote(path) for path in paths)
                await call("nerya_native_run_shell", {"command": command, "cwd": ".",
                    "activity": {"next": "执行只读行数统计，直接核对命令和实际输出。"}})
                report["command"] = command
                await call("nerya_progress", {"status": "completed", "current": "已完成目录查看、两次文件读取、内容搜索和只读行数统计。"})
    after = session_ids(cfg.paths.db, args.source)
    report["new_sessions"] = len(after - before)
    report["same_session"] = (after - before) <= {sid}
    assert report["same_session"]
    url = args.base_url.rstrip("/") + "/api/proxy/agent/session/transcript?" + urllib.parse.urlencode({"session_id": sid, "full": "1"})
    with urllib.request.urlopen(url, timeout=20) as response:
        transcript = json.load(response)
    traces = [message["turn"]["external_call"] for message in transcript["messages"]]
    assert all(trace["remote_session_id"] == sid for trace in traces)
    report["call_count"] = len(traces)
    report["tool_count"] = sum(trace["tool"] != "nerya_progress" for trace in traces)
    report["native_steps"] = sum(len(trace.get("nodes", [])) for trace in traces)
    report["read_call_ids"] = [trace["call_id"] for trace in traces if trace["tool"] == "nerya_native_read_file"]
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--source", choices=["mcp", "tunnel"], default="tunnel")
    parser.add_argument("--base-url", default="http://127.0.0.1:18380")
    parser.add_argument("--append", action="store_true")
    args = parser.parse_args()
    host = urllib.parse.urlsplit(args.base_url)
    assert host.scheme == "http" and host.hostname in {"127.0.0.1", "localhost", "::1"}
    assert (args.workspace / "nerya.yml").is_file()
    asyncio.run(asyncio.wait_for(exercise(args), timeout=60))

if __name__ == "__main__":
    main()
