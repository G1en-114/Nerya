"""Opt-in local MCP/UI roundtrip; writes traces, never runs models or trades.

Tunnel coverage here is its local stdio child, not an OpenAI cloud request.
Run with --reuse after restarting the API to verify persisted session continuity.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def exercise(workspace: Path, source: str, ids: list[str], checkpoint) -> list[str]:
    params = StdioServerParameters(
        command=sys.executable,
        args=["-m", "nerya.cli.app", "mcp", "serve", "--transport", "stdio", "--workspace", str(workspace)],
        env={"PYTHONPATH": str(Path(__file__).resolve().parents[1]),
             "NERYA_MCP_SOURCE": source, "NERYA_DISABLE_TUNNEL_RESTORE": "1"},
    )
    async with stdio_client(params) as (reader, writer):
        async with ClientSession(reader, writer) as client:
            await client.initialize()
            names = {tool.name for tool in (await client.list_tools()).tools}
            assert {"nerya_session", "nerya_native_role_list", "nerya_native_role_get"} <= names
            if not ids:
                titles = (["MCP 会话验收 · A", "MCP 会话验收 · B"] if source == "mcp"
                          else ["Tunnel 本地链路验收"])
                for title in titles:
                    opened = await client.call_tool("nerya_session", {"action": "open", "title": title, "client_request_id": "roundtrip-v2:" + source + ":" + title})
                    assert not opened.isError, opened
                    sid = opened.structuredContent["remote_session_id"]
                    ids.append(sid)
                    checkpoint()
                    print(json.dumps({"opened": sid, "source": source}, ensure_ascii=False), flush=True)
            for sid in ids:
                result = await client.call_tool("nerya_native_role_list", {"remote_session_id": sid})
                assert not result.isError, result
                trace = result.structuredContent["nerya_trace"]
                assert trace["remote_session_id"] == sid and trace["source"] == source
                assert trace["persisted"] and trace["status"] == "succeeded"
            # Same session, another request; then a real schema-validation failure.
            again = await client.call_tool("nerya_native_role_list", {"remote_session_id": ids[0]})
            assert not again.isError
            invalid = await client.call_tool("nerya_native_role_get", {"remote_session_id": ids[0]})
            assert invalid.isError
            assert invalid.structuredContent["nerya_trace"]["remote_session_id"] == ids[0]
    return ids


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:18380")
    parser.add_argument("--reuse", action="store_true")
    args = parser.parse_args()
    assert (args.workspace / "nerya.yml").is_file(), "Explicit configured workspace required"
    host = urllib.parse.urlsplit(args.base_url)
    assert host.scheme == "http" and host.hostname in {"localhost", "127.0.0.1", "::1"}, "Local verification only"
    report = json.loads(args.report.read_text()) if args.reuse else {
        "workspace": str(args.workspace.resolve()), "sessions": {"mcp": [], "tunnel": []},
        "tunnel_coverage": "local stdio child, not OpenAI cloud",
    }
    assert report["workspace"] == str(args.workspace.resolve())
    args.report.parent.mkdir(parents=True, exist_ok=True)
    def checkpoint():
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    async def run():
        for source, ids in report["sessions"].items():
            await exercise(args.workspace.resolve(), source, ids, checkpoint)
    asyncio.run(asyncio.wait_for(run(), timeout=40))
    summaries = []
    for source, ids in report["sessions"].items():
        for sid in ids:
            query = urllib.parse.urlencode({"session_id": sid, "full": "1"})
            url = args.base_url.rstrip("/") + "/api/proxy/agent/session/transcript?" + query
            with urllib.request.urlopen(url, timeout=10) as response:
                transcript = json.load(response)
            assert transcript.get("ok"), transcript
            traces = [m.get("turn", {}).get("external_call") for m in transcript["messages"]]
            assert traces and all(t and t["remote_session_id"] == sid for t in traces), "Cross-session trace"
            native = [t for t in traces if t["tool"] == "nerya_native_role_list"]
            assert native and all(t["nodes"] and t["nodes"][0]["status"] == "succeeded" for t in native)
            summaries.append({"source": source, "session_id": sid, "calls": len(traces),
                              "native_steps": sum(len(t.get("nodes", [])) for t in traces),
                              "failures": sum(t["status"] == "failed" for t in traces),
                              "api_source": transcript.get("source", "")})
    report["summaries"] = summaries
    report["reused_after_restart"] = args.reuse
    checkpoint()
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
