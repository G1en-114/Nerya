"""Opt-in real MCP acceptance client. No mocked tool replies, no model or trading calls.

The discovery mode only reads schemas. Subsequent modes use saved server-issued IDs.
"""
from __future__ import annotations
import argparse
import asyncio
import json
import sys
from pathlib import Path
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from jsonschema import Draft202012Validator

async def exercise(args):
    report = json.loads(args.report.read_text()) if args.report.exists() else {"workspace": str(args.workspace), "source": args.source}
    def save():
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    def find_values(value, key):
        if isinstance(value, str):
            try: value = json.loads(value)
            except ValueError: return []
        if isinstance(value, list): return [found for item in value for found in find_values(item, key)]
        if not isinstance(value, dict): return []
        return ([value[key]] if key in value else []) + [found for item in value.values() for found in find_values(item, key)]
    params = StdioServerParameters(command=sys.executable, args=["-m", "nerya.cli.app", "mcp", "serve", "--transport", "stdio", "--workspace", str(args.workspace)],
        env={"PYTHONPATH": str(Path(__file__).resolve().parents[1]), "NERYA_MCP_SOURCE": args.source, "NERYA_DISABLE_TUNNEL_RESTORE": "1", "NERYA_ALLOW_MOCK_DATA": "0"})
    async with stdio_client(params) as (reader, writer):
        async with ClientSession(reader, writer) as client:
            await client.initialize()
            tools = (await client.list_tools()).tools
            schemas = {tool.name: tool.inputSchema for tool in tools}
            if args.mode == "discover":
                selected = [tool.model_dump() for tool in tools if any(word in tool.name for word in ("strategy_generate", "research", "chart", "todo_write", "script_run", "skill_load", "proposals_show"))]
                report["tools"] = selected
                print(json.dumps(selected, ensure_ascii=False, indent=2))
            else:
                if not report.get("session_id"):
                    opened = await client.call_tool("nerya_session", {"action": "open", "client_request_id": "nerya-followup-shared-cards-acceptance-v1", "title": "外部会话 · 补充消息与原生卡片验收"})
                    assert not opened.isError, opened
                    report["session_id"] = opened.structuredContent["remote_session_id"]
                    save()
                sid = report["session_id"]
                async def call(name, values):
                    payload = {"remote_session_id": sid, **values}
                    Draft202012Validator(schemas[name]).validate(payload)
                    result = await client.call_tool(name, payload)
                    body = result.structuredContent
                    assert isinstance(body, dict), result
                    report.setdefault("calls", []).append({"tool": name, "result": body})
                    save()
                    return body
                if args.mode == "prepare":
                    await call("nerya_native_read_file", {"path": "agents/main.agent.md", "offset": 0, "limit": 8,
                        "activity": {"intent": "验证真实工具、策略和投研卡片，以及用户追加消息链路。", "next": "先读取当前工作区的 Agent 文档。"}})
                    await call("nerya_progress", {"current": "已读取真实工作区文档。下面逐项检查待办、搜索、命令和领域卡片。", "status": "running"})
                    await call('nerya_native_todo_write', {'todos': [{'id': 'cards', 'content': '检查真实策略与品种卡片', 'status': 'in_progress'}, {'id': 'followup', 'content': '检查会话补充消息回传', 'status': 'pending'}]})
                    await call('nerya_native_list_dir', {'path': 'agents'})
                    await call('nerya_native_grep', {'pattern': 'tool', 'path': 'agents/main.agent.md', 'max_results': 4})
                    await call('nerya_native_run_shell', {'command': 'wc -l agents/main.agent.md', 'cwd': '.'})
                    # A real local draft, never applied or started. The paper account reference
                    # is only an input to the draft; no account operation is executed.
                    if not report.get('proposal_id'):
                        proposal = await call('nerya_strategy_generate', {'strategy_id': 'ui_followup_acceptance',
                            'markets': ['binance:BTC/USDT'], 'accounts': ['paper'], 'mode': 'paper', 'strategy_class': 'trend',
                            'title': '界面验收草稿 · 不启动', 'prompt': '仅验证策略提案卡和工作流入口，不审批、不应用、不启动、不交易。'})
                        ids = find_values(proposal, 'proposal_id')
                        assert ids, 'A real proposal_id was not returned; inspect recorded result'
                        report['proposal_id'] = ids[0]
                        report['strategy_id'] = 'ui_followup_acceptance'
                        save()
                    await call('nerya_progress', {'current': '验收提案已写入本地提案区，尚未审批或启动。接下来获取真实市场 K 线。', 'status': 'running'})
                    if not report.get('chart_id'):
                        market = await call('nerya_native_script_run', {'skill_id': 'markets', 'name': 'get_candles.py',
                            'args': ['--json', json.dumps({'market': 'binance:BTC/USDT', 'interval': '1h', 'limit': 48, 'path': 'bulk', 'workspace': str(args.workspace)})], 'timeout_sec': 45})
                        blocks = [block for values in find_values(market, 'chart_blocks') if isinstance(values, list) for block in values]
                        assert blocks and market.get('ok') is not False, 'Real chart unavailable; inspect recorded tool result'
                        truths = find_values(market, 'truth')
                        assert 'mock' not in truths, 'Mock market data is forbidden in acceptance'
                        report['chart_id'] = blocks[0]['chart_id']
                        report['chart'] = blocks[0]
                        report['market_truth'] = truths
                        save()
                    await call('nerya_progress', {'current': '真实策略提案、品种 K 线、文件搜索、命令和待办结果均已返回，继续检查页面交互与消息回传。', 'status': 'running'})
                elif args.mode == "deliver":
                    result = await call("nerya_native_run_shell", {"command": "python3 -c \"import time; time.sleep(8); print('External follow-up checkpoint completed')\"", 
                        "activity": {"next": "执行无副作用的短暂等待，验证期间追加的消息随本次工具结果返回。"}})
                    assert result.get("ok") is not False, result
                    report["delivery"] = result["operator_control"]
                    assert report["delivery"]["requests"], "No actual user message was delivered"
                elif args.mode == "ack":
                    ids = [row["id"] for row in report["delivery"]["requests"]]
                    result = await call("nerya_native_read_file", {"path": "agents/main.agent.md", "offset": 8, "limit": 8, "acknowledge_requests": ids,
                        "activity": {"next": "已接收补充消息，继续只读检查，不启动策略。"}})
                    assert result.get("ok") is not False, result
                    assert not {r["id"] for r in result["operator_control"]["requests"]}.intersection(ids)
                    await call("nerya_progress", {"current": "已收到页面追加的消息。本次仅验证展示与只读工具，不审批、不启动策略、不交易。", "status": "completed"})
                    report["acknowledged"] = ids
                print(json.dumps({"session_id": sid, "mode": args.mode, "calls": len(report.get("calls", [])), "delivery": report.get("delivery"), "acknowledged": report.get("acknowledged")}, ensure_ascii=False, indent=2))
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--source", choices=["mcp", "tunnel"], default="tunnel")
    parser.add_argument("--mode", choices=["discover", "prepare", "deliver", "ack"], default="discover")
    options = parser.parse_args()
    assert (options.workspace / "nerya.yml").is_file()
    asyncio.run(asyncio.wait_for(exercise(options), 120))
