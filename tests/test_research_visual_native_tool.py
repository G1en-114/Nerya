"""Execute the actual native tool and Skill in an isolated test workspace."""
import json
from pathlib import Path

from nerya.agent.chart_hook import extract_chart_blocks
from nerya.tools.native.skill import SkillIndex, script_run_handler
from nerya.tools.types import ToolCall
from test_research_visual_publication import fixture_payload


def test_native_script_run_preserves_full_research_publication(tmp_path):
    root = Path(__file__).resolve().parents[1] / "nerya/skills/builtin"
    payload = fixture_payload()
    # Long, valid evidence exercises the native runner's bounded stdout path.
    for i in range(10):
        payload["instruments"][0]["news"].append({
            "title": f"TEST FIXTURE source {i}", "url": f"https://example.com/fixture/{i}",
            "source": "TEST FIXTURE", "published_at": "2026-09-20T00:00:00Z",
            "summary": "Offline evidence for native tool regression. " * 10,
        })
    path = tmp_path / "evidence.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    call = ToolCall(name="script_run", arguments={
        "skill_id": "research", "name": "publish_visuals.py",
        "args": ["--input", str(path), "--workspace", str(tmp_path)], "timeout_sec": 20,
    })
    result = script_run_handler(call, skill_index=SkillIndex([root]), cwd=tmp_path)
    assert not result.is_error
    envelope = next(part.data for part in result.content if part.type == "json")
    assert envelope["exit_code"] == 0
    publication = envelope["stdout_json"]
    assert publication["ok"] and publication["receipt"]["bulk_verified"]
    blocks = extract_chart_blocks(publication)
    assert len(blocks) == 2
    assert len(publication["research_context"]["instruments"]) == 1
    assert len(publication["research_context"]["instruments"][0]["news"]) == 11
    for block in blocks:
        artifact = tmp_path / "artifacts/charts" / (block["chart_id"] + ".json")
        assert json.loads(artifact.read_text())["series"][0]["data"]
