"""Isolated result-presentation tests; no network, model or trading calls."""
from types import SimpleNamespace
import json
import pytest
from nerya.mcp.presentation import result_charts
from nerya.mcp.registry_bridge import _result_as_mcp_dict
from nerya.mcp.inbound_sessions import InboundTraceExecutor
from nerya.tools.types import ToolResult
from test_mcp_inbound_sessions import store, catalog, session, traces

pytestmark = pytest.mark.smoke
CHART = {'kind': 'chart', 'chart_id': 'unit-chart', 'chart_kind': 'line', 'title': 'UNIT ONLY',
         'series': [], 'instrument': {'market': 'BTC/USDT', 'venue': 'unit'},
         'source': {'skill': 'research', 'action': 'unit', 'as_of': '2026-09-23T00:00:00Z'}}

@pytest.mark.parametrize('result', [
    {'chart_blocks': [CHART]},
    {'content': [{'type': 'json', 'data': {'chart_blocks': [CHART]}}]},
    {'content': [{'type': 'shell', 'data': {'stdout': json.dumps({'chart_blocks': [CHART]})}}]},
    {'text': 'summary\n' + json.dumps({'chart_blocks': [CHART]})},
])
def test_native_inline_charts_survive_mcp_envelopes(result):
    assert result_charts(result, None) == [CHART]


def test_failed_results_never_promote_embedded_charts():
    assert result_charts({'ok': False, 'chart_blocks': [CHART]}, None) == []
    assert result_charts({'ok': True, 'result': {'ok': False, 'chart_blocks': [CHART]}}, None) == []


def test_bulk_markers_preserve_instrument_and_source(monkeypatch):
    import nerya.charting as charting
    import nerya.workspace.artifact_store as artifacts
    monkeypatch.setattr(artifacts, 'ArtifactStore', lambda paths: paths)
    monkeypatch.setattr(charting, 'load_chart_artifact', lambda store, cid: {**CHART,
        'series': [{'name': 'Price', 'type': 'line', 'data': []}], 'ui': {'height': 320}})
    result = result_charts({'text': '@@nerya:chart@@ unit-chart'}, SimpleNamespace(paths='UNIT'))
    assert result[0]['instrument'] == CHART['instrument']
    assert result[0]['source'] == CHART['source']
    assert result[0]['bulk_data_uri'] == 'nerya://chart/unit-chart'
    assert result[0]['series'][0]['data_uri'] == 'nerya://chart/unit-chart#series/Price'


def test_missing_artifact_cannot_turn_success_into_retry(monkeypatch):
    import nerya.charting as charting
    import nerya.workspace.artifact_store as artifacts
    monkeypatch.setattr(artifacts, 'ArtifactStore', lambda paths: paths)
    def missing(*args):
        raise FileNotFoundError('unit missing artifact')
    monkeypatch.setattr(charting, 'load_chart_artifact', missing)
    assert result_charts({'ok': True, 'text': '@@nerya:chart@@ missing'}, SimpleNamespace(paths='UNIT')) == []


def test_internal_executor_persists_structured_business_result_and_chart(store):
    result = ToolResult.from_json(tool_use_id='child-unit', name='script_run', data={'chart_blocks': [CHART], 'api_key': 'unit-secret'})
    executor = InboundTraceExecutor(SimpleNamespace(execute=lambda call: result))
    def run(**args):
        executor.execute(SimpleNamespace(id='child-unit', name='script_run', arguments={}))
        return {'ok': True, 'text': 'Completed'}
    store.catalog = catalog(run)
    sid = session(store)
    returned = store.call('echo', {'remote_session_id': sid, 'value': 1})
    assert returned['nerya_trace']['persisted']
    node = traces(store, sid)[0]['nodes'][0]
    assert node['status'] == 'succeeded'
    assert node['presentation_blocks'] == [CHART]
    parts = node['result']['content']
    assert next(p['data']['chart_blocks'] for p in parts if p['type'] == 'json') == [CHART]
    assert 'unit-secret' not in json.dumps(node)
    assert _result_as_mcp_dict(result)['content'] == parts or '***REDACTED***' in json.dumps(parts)
