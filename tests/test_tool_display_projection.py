"""The UI retains native types; provider transcript and compaction stay unchanged."""
import json
import pytest

from nerya.agent.tool_projection import project_tool_results, tool_display_result
from nerya.tools.types import ToolResult, ToolResultPart

pytestmark = pytest.mark.smoke


def test_diff_and_json_keep_types_without_changing_provider_observation():
    result = ToolResult(tool_use_id="edit-1", name="edit_file", content=[
        ToolResultPart.diff_part(diff="--- a/main.py\n+++ b/main.py\n@@ -1 +1 @@\n-old\n+new\n", path="main.py"),
        ToolResultPart.json_part({"lines_after": 1}),
    ])
    provider = {"type": "tool_result", "tool_use_id": "edit-1", "content": [{"type": "text", "text": "provider observation"}]}
    projection = project_tool_results([result], render_tool_result=lambda _: provider, rendered_tool_result_text=lambda _: None)
    block = projection.event_blocks[0]
    assert projection.transcript_blocks == (provider,)
    assert block["result"] == result.text()
    assert [part["type"] for part in block["display_result"]["content"]] == ["diff", "json"]
    assert block["display_result"]["content"][0]["metadata"]["path"] == "main.py"


def test_display_does_not_bypass_compaction_or_copy_large_payloads():
    result = ToolResult(tool_use_id="x", name="read_file", content=[ToolResultPart.json_part({"rows": ["x" * 64000]})])
    assert tool_display_result(result, {}) is None
    result.content = [ToolResultPart.json_part({"count": 2})]
    assert tool_display_result(result, {"compaction": {"raw_ref": "call:x"}}) is None
    assert tool_display_result(ToolResult(tool_use_id="x", name="read_file", content=[ToolResultPart.text_part("plain text")]), {}) is None


def test_display_redacts_credentials_and_excludes_media_payloads():
    result = ToolResult(tool_use_id="x", name="fixture", content=[
        ToolResultPart.json_part({"api_key": "private-fixture-credential", "count": 3}),
        ToolResultPart(type="image", data="fixture-image-bytes", media_type="image/png"),
    ])
    display = tool_display_result(result, {})
    assert display["content"][0]["data"]["count"] == 3
    assert display["content"][0]["data"]["api_key"]["__redacted__"] is True
    assert "private-fixture-credential" not in json.dumps(display)
    assert "fixture-image-bytes" not in json.dumps(display)
