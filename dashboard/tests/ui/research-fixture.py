"""Generate clearly labelled UI fixtures via the actual Research Skill and chart hook."""
import argparse
import json
import math
from pathlib import Path
from nerya.agent.chart_hook import extract_chart_blocks
from nerya.charting.composer import load_chart_artifact
from nerya.core.paths import WorkspacePaths
from nerya.skills.builtin.research.scripts.publish_visuals import publish_visuals
from nerya.workspace.artifact_store import ArtifactStore


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    output = Path(parser.parse_args().output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    stamp = '2026-09-20T12:00:00Z'
    source = {'skill': 'research', 'action': 'acceptance_fixture', 'as_of': stamp, 'artifact_path': str(output / 'input.json')}
    instruments, charts, candles = [], [], {}
    for symbol, name, base, phase in [('BTC', 'Bitcoin', 64000, 0), ('ETH', 'Ethereum', 3200, 1.7)]:
        item = {'market': f'BINANCE:{symbol}/USDT', 'venue': 'binance', 'name': name + ' · 合成验收数据', 'interval': '1h', 'news_status': 'ok', 'news_as_of': stamp,
                'news': [{'title': name + ' 研究引用与数据质量检查 · TEST FIXTURE', 'source': 'TEST FIXTURE · 非真实新闻', 'url': f'https://example.com/test/{symbol.lower()}', 'published_at': '2026-09-20T11:00:00Z', 'summary': '用于验证品种匹配、发布时间和原文链接，不能用于投资决策。'}]}
        instruments.append(item)
        rows = []
        for i in range(160):
            opening = base * (1 + i * .0008 + .015 * math.sin(i / 9 + phase))
            close = opening + base * .003 * math.sin(i / 2 + phase)
            rows.append({'time': 1789329600 + i * 3600, 'open': round(opening, 2), 'high': round(max(opening, close) + base * .002, 2), 'low': round(min(opening, close) - base * .002, 2), 'close': round(close, 2), 'volume': round(300 + 100 * (1 + math.sin(i / 7)), 2)})
        candles[symbol] = rows
        charts.append({'title': symbol + '/USDT · TEST FIXTURE', 'chart_kind': 'candlestick', 'instrument': item, 'source': source,
                       'caption': '合成验收数据 · 非实时行情。指标由这里的 OHLCV 计算。', 'series': [{'type': 'candlestick', 'name': 'OHLC', 'data': rows}]})
    flows = [{'time': 1789329600 + i * 3600, 'inflow': 28 + 8 * math.sin(i / 8) + i * .08, 'outflow': 27 + 11 * math.sin(i / 10 + 1)} for i in range(160)]
    charts.append({'title': '资金流拆解 · TEST FIXTURE · 百万美元', 'chart_kind': 'multi', 'source': source,
                   'caption': '合成验收数据：净流入 = 流入 − 流出。单位为百万美元，仅验证图表，不代表实际资金流。',
                   'series': [{'name': label, 'type': kind, 'color': color, 'data': [{'time': r['time'], 'value': round(r['inflow'] - r['outflow'] if key == 'net' else r[key], 3)} for r in flows]} for key, label, kind, color in [('inflow', '流入', 'line', '#51b8dd'), ('outflow', '流出', 'line', '#e2aa5b'), ('net', '净流入', 'histogram', '#699c89')]]})
    charts.append({'title': 'BTC / ETH 归一化趋势 · TEST FIXTURE', 'chart_kind': 'multi', 'source': source,
                   'caption': '合成验收数据：共同起点 = 100；严格对齐同一小时采样。曲线为相对变化，不是价格。',
                   'series': [{'name': symbol + ' · 基点 100', 'type': 'line', 'color': color, 'data': [{'time': r['time'], 'value': round(100 * r['close'] / candles[symbol][0]['close'], 3)} for r in candles[symbol]]} for symbol, color in [('BTC', '#dfad56'), ('ETH', '#58bcd7')]]})
    payload = {'instruments': instruments, 'charts': charts}
    (output / 'input.json').write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
    result = publish_visuals(payload, output / 'workspace')
    blocks = extract_chart_blocks(json.dumps(result))
    assert len(blocks) == 4 and result['receipt']['bulk_verified']
    store = ArtifactStore(WorkspacePaths(root=output / 'workspace'))
    fixture = {'stamp': stamp, 'result': result, 'blocks': blocks, 'artifacts': {b['chart_id']: load_chart_artifact(store, b['chart_id']) for b in blocks}}
    (output / 'fixture.json').write_text(json.dumps(fixture, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(result['receipt']))


if __name__ == '__main__':
    main()
