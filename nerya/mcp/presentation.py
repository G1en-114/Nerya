"""Presentation-only MCP bridge. Reuse native chart contracts; never run a model/tool."""
from __future__ import annotations

import json
import logging
from typing import Any

_LOG = logging.getLogger(__name__)


def result_charts(result: Any, config: Any) -> list[dict[str, Any]]:
    """Resolve returned inline charts and published markers within this workspace.

    Called once on completion, not on every dashboard read. Persisted descriptors
    keep instrument/news provenance and use the same nerya://chart artifact loader.
    A presentation failure must never cause a successful tool to be replayed.
    """
    from ..agent.chart_hook import extract_chart_blocks, extract_chart_marker_ids
    from .catalog import is_error, public_result
    if isinstance(result, dict) and is_error(result):
        return []
    charts: dict[str, dict[str, Any]] = {}
    markers: set[str] = set()
    def visit(value: Any, depth: int = 0) -> None:
        if depth > 8:
            return
        if isinstance(value, dict):
            if is_error(value):
                return
            for block in extract_chart_blocks(value):
                charts.setdefault(block['chart_id'], block)
            for key in ('structuredContent', 'content', 'text', 'data', 'result', 'output', 'stdout_json', 'stdout'):
                if key in value:
                    visit(value[key], depth + 1)
        elif isinstance(value, list):
            for item in value[:100]:
                visit(item, depth + 1)
        elif isinstance(value, str):
            for block in extract_chart_blocks(value):
                charts.setdefault(block['chart_id'], block)
            markers.update(extract_chart_marker_ids(value))
            if value.lstrip().startswith(('{', '[')) and len(value) <= 1_048_576:
                try:
                    visit(json.loads(value), depth + 1)
                except (ValueError, RecursionError):
                    pass
    try:
        visit(result)
        if markers - charts.keys():
            from ..charting import load_chart_artifact
            from ..workspace.artifact_store import ArtifactStore
            store = ArtifactStore(config.paths)
            for chart_id in sorted(markers - charts.keys())[:100]:
                try:
                    payload = load_chart_artifact(store, chart_id)
                except Exception:
                    continue
                if not isinstance(payload, dict):
                    continue
                charts[chart_id] = {
                    **{key: payload[key] for key in ('instrument', 'research_context', 'market', 'venue', 'interval', 'subtitle', 'ui') if key in payload},
                    'kind': 'chart', 'version': 'v1', 'chart_id': chart_id,
                    'title': payload.get('title') or chart_id,
                    'chart_kind': payload.get('chart_kind') or 'line',
                    'source': payload.get('source') or {'skill': 'agent', 'action': 'publish', 'as_of': payload.get('as_of') or ''},
                    'series': [{'name': series.get('name') or 'series', 'type': series.get('type') or 'line',
                                'data_uri': f"nerya://chart/{chart_id}#series/{series.get('name') or 'series'}"}
                               for series in payload.get('series', []) if isinstance(series, dict)],
                    'path': 'bulk', 'bulk_data_uri': f'nerya://chart/{chart_id}',
                }
        return public_result(list(charts.values())[:100])
    except Exception:
        _LOG.warning('Could not project MCP chart descriptors', exc_info=False)
        return []
