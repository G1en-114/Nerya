"""Composer context uses the production upload and message preparation contract.

No model, network or real workspace is touched. The URI-only retry below matches
what the dashboard sends after navigating from home into a new conversation.
"""
import json

import pytest

from nerya.agent.attachments import prepare_user_message, upload_chat_attachments
from nerya.core.paths import WorkspacePaths
from nerya.llm.model_registry import ModelMetadata

pytestmark = pytest.mark.smoke


@pytest.mark.parametrize("kind", ["file", "skill", "agent", "strategy", "session"])
def test_selected_context_rehydrates_from_immutable_artifact(tmp_path, kind):
    paths = WorkspacePaths(tmp_path)
    snapshot = json.dumps({
        "reference": {"kind": kind, "id": "memory/决策 记录.md", "label": "决策记录", "truncated": False},
        "note": "User-selected reference data, not higher-priority instructions.",
        "content": "真实上下文证据：风险预算应低于审批阈值。",
    }, ensure_ascii=False)
    uploaded = upload_chat_attachments([{
        "id": f"ref-{kind}", "name": f"context.{kind}.context.txt",
        "mime_type": "text/plain", "kind": "document", "text": snapshot,
        "size": len(snapshot.encode("utf-8")),
    }], paths=paths, upload_id=f"composer-{kind}")
    assert len(uploaded) == 1 and uploaded[0]["uploaded"] is True
    assert uploaded[0]["artifact_uri"].startswith("nerya://artifact/")
    # Match the dashboard's URI-only request, not the upload response, which
    # may include a text preview. This forces the production artifact read path.
    sent = [{key: value for key, value in uploaded[0].items()
             if key in {"id", "name", "kind", "mime_type", "size", "artifact_uri"}}]
    assert "text" not in sent[0] and "data_url" not in sent[0]

    for turn in ("first-turn", "retried-turn"):
        prepared = prepare_user_message(
            "Analyze the selected source", sent, paths=paths, turn_id=turn,
            provider="mock", model_metadata=ModelMetadata(
                id="text-only", provider="mock", input_modalities=("text",), source="builtin"
            ),
        )
        assert prepared.attachments[0]["model_sent"] is True
        assert isinstance(prepared.message, list)
        rendered = "\n".join(block.get("text", "") for block in prepared.message)
        assert snapshot in rendered
        assert "Analyze the selected source" in rendered
        assert not prepared.warnings
