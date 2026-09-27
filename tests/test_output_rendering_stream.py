"""Offline model -> native envelopes -> streaming projection contract tests."""
import pytest

from nerya.agent.loop import LoopConfig
from nerya.agent.streaming import StreamingEventBus, thinking_event_fields
from nerya.llm.messages import MessagesResponse
from test_agent_loop_context_recovery import _make_loop

pytestmark = pytest.mark.smoke


def test_thinking_delta_and_snapshot_keep_one_identity_and_all_text():
    text = "研究数据🙂" * 1200
    bus = StreamingEventBus()
    captured = []
    unsubscribe = bus.subscribe(captured.append)
    try:
        bus.publish("turn.step", **thinking_event_fields({
            "kind": "thinking_delta", "stream_id": "fixture:1:1", "text": text[:100],
        }))
        bus.publish("turn.step", **thinking_event_fields({
            "kind": "thinking", "stream_id": "fixture:1:1", "text": text,
        }))
    finally:
        unsubscribe()
    assert [event["mode"] for event in captured] == ["append", "replace"]
    assert [event["completed"] for event in captured] == [False, True]
    assert captured[0]["stream_id"] == captured[1]["stream_id"]
    assert captured[1]["step"]["detail"]["text"] == text


def test_legacy_and_retry_thinking_do_not_gain_fabricated_streams():
    retry = {"state": "waiting", "attempt": 2}
    result = thinking_event_fields({"kind": "thinking", "text": "", "retry": retry})
    assert result["mode"] == "legacy"
    assert result["stream_id"] is None
    assert result["step"]["detail"]["retry"] == retry


def test_actual_loop_tags_final_reasoning_with_its_delta_stream_id():
    class Gateway:
        def call_messages(self, **kwargs):
            callback = kwargs["on_event"]
            callback({"type": "thinking_delta", "text": "先验证", "stream_mode": "stream"})
            callback({"type": "thinking_delta", "text": "来源。", "stream_mode": "stream"})
            callback({"type": "text_delta", "text": "已检查。", "stream_mode": "stream"})
            return MessagesResponse(content=[
                {"type": "thinking", "thinking": "先验证来源。"},
                {"type": "text", "text": "已检查。"},
            ], stop_reason="end_turn", stream_mode="stream")

    loop = _make_loop(Gateway(), config=LoopConfig(max_iterations=2))
    result = loop.run(system="fixture", user_message="inspect sources")
    blocks = [envelope.block for envelope in result.blocks]
    thoughts = [block for block in blocks if block["kind"] in {"thinking", "thinking_delta"}]
    assert len(thoughts) == 3
    assert len({block["stream_id"] for block in thoughts}) == 1
    assert thoughts[-1]["text"] == "先验证来源。"
    assert result.final_text == "已检查。"
