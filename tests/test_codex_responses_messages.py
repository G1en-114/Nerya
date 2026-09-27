from __future__ import annotations

import json
from copy import deepcopy

import pytest

from nerya.core.config import Config, DEFAULT_CONFIG
from nerya.core.paths import WorkspacePaths
from nerya.llm import messages as messages_mod
from nerya.llm.gateway import LLMGateway
from nerya.llm.messages import CodexResponsesMessagesBackend, MessagesRequest

pytestmark = pytest.mark.smoke


class _FakeSSE:
    def __init__(self, events: list[dict]):
        self.lines = [
            ("data: " + json.dumps(event) + "\n").encode()
            for event in events
        ]

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def __iter__(self):
        return iter(self.lines)


def _config(tmp_path) -> Config:
    data = deepcopy(DEFAULT_CONFIG)
    data["runtime"]["mock_mode"] = False
    data["llm"]["tiers"] = {
        "medium": {
            "provider": "openai-codex",
            "model": "gpt-6-sol",
            "reasoning_effort": "medium",
            "allowed_tasks": ["agent.loop"],
        }
    }
    return Config(paths=WorkspacePaths(tmp_path), data=data)


def test_codex_render_input_preserves_function_call_correlation():
    instructions, items = messages_mod._codex_render_input(
        system="system",
        messages=[
            {"role": "user", "content": "first"},
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "checking"},
                    {
                        "type": "tool_use",
                        "id": "call_123",
                        "name": "echo",
                        "input": {"value": "A"},
                    },
                ],
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "call_123",
                        "content": [{"type": "text", "text": "A"}],
                    },
                    {"type": "text", "text": "continue"},
                ],
            },
        ],
    )

    assert instructions == "system"
    assert items == [
        {
            "role": "user",
            "content": [{"type": "input_text", "text": "first"}],
        },
        {
            "role": "assistant",
            "content": [{"type": "output_text", "text": "checking"}],
        },
        {
            "type": "function_call",
            "call_id": "call_123",
            "name": "echo",
            "arguments": '{"value": "A"}',
        },
        {
            "type": "function_call_output",
            "call_id": "call_123",
            "output": "A",
        },
        {
            "role": "user",
            "content": [{"type": "input_text", "text": "continue"}],
        },
    ]


def test_codex_sse_normalizes_text_and_function_call(monkeypatch):
    captured = {}
    events = [
        {"type": "response.created", "response": {"id": "resp_1"}},
        {"type": "response.output_text.delta", "delta": "looking "},
        {"type": "response.output_text.delta", "delta": "up"},
        {
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "id": "fc_1",
                "call_id": "call_abc",
                "name": "market_lookup",
                "arguments": '{"symbol":"BTC/USDT"}',
                "status": "completed",
            },
        },
        {
            "type": "response.completed",
            "response": {
                "id": "resp_1",
                "status": "completed",
                "usage": {
                    "input_tokens": 21,
                    "output_tokens": 7,
                    "total_tokens": 28,
                },
            },
        },
    ]

    def fake_urlopen(request, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        return _FakeSSE(events)

    monkeypatch.setattr(messages_mod.urllib.request, "urlopen", fake_urlopen)

    backend = CodexResponsesMessagesBackend(
        api_key="oauth-test",
        account_id="acct-test",
        model="gpt-6-sol",
        reasoning_effort="medium",
    )
    response = backend(
        MessagesRequest(
            system="system",
            messages=[{"role": "user", "content": "research BTC"}],
            tools=[
                {
                    "name": "market_lookup",
                    "description": "lookup market",
                    "input_schema": {
                        "type": "object",
                        "properties": {"symbol": {"type": "string"}},
                    },
                }
            ],
            tool_choice={"type": "tool", "name": "market_lookup"},
            metadata={"session_id": "sess-test"},
        )
    )

    assert response.text() == "looking up"
    assert response.stop_reason == "tool_use"
    assert response.usage == {"input_tokens": 21, "output_tokens": 7}
    assert response.tool_uses() == [
        {
            "type": "tool_use",
            "id": "call_abc",
            "name": "market_lookup",
            "input": {"symbol": "BTC/USDT"},
        }
    ]

    request = captured["request"]
    assert request.full_url == "https://chatgpt.com/backend-api/codex/responses"
    headers = {k.lower(): v for k, v in request.header_items()}
    assert headers["chatgpt-account-id"] == "acct-test"
    assert headers["session-id"] == "sess-test"
    body = json.loads(request.data)
    assert body["stream"] is True
    assert body["store"] is False
    assert body["tools"][0] == {
        "type": "function",
        "name": "market_lookup",
        "description": "lookup market",
        "parameters": {
            "type": "object",
            "properties": {"symbol": {"type": "string"}},
        },
        "strict": False,
    }
    assert body["tool_choice"] == {
        "type": "function",
        "name": "market_lookup",
    }
    assert body["reasoning"] == {"effort": "medium"}


def test_gateway_routes_openai_codex_to_responses_backend(monkeypatch, tmp_path):
    from nerya.llm import oauth_login

    cfg = _config(tmp_path)
    cfg.paths.provider_auth.parent.mkdir(parents=True, exist_ok=True)
    cfg.paths.provider_auth.write_text(
        json.dumps(
            {
                "version": 1,
                "records": [
                    {
                        "provider": "openai-codex",
                        "kind": "oauth",
                        "actor_id": "default",
                        "metadata": {"account_id": "acct-live"},
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        oauth_login,
        "resolve_oauth_token",
        lambda *_args, **_kwargs: "oauth-live",
    )

    backend = LLMGateway(cfg)._resolve_messages_backend("medium")

    assert isinstance(backend, CodexResponsesMessagesBackend)
    assert backend.api_key == "oauth-live"
    assert backend.account_id == "acct-live"
    assert backend.model == "gpt-6-sol"
    assert backend.base_url == "https://chatgpt.com/backend-api/codex"
