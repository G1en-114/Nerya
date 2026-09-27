"""No external providers: real adapter -> Agent retry -> HTTP error boundary."""
from copy import deepcopy
from email.utils import formatdate
from types import SimpleNamespace
from unittest.mock import Mock
import http.client
import json
import threading
import time

import pytest

from nerya.agent.loop import LoopConfig
from nerya.agent.provider_errors import is_context_overflow_error, is_transient_error
from nerya.api import local_server
from nerya.core.errors import LLMError
from nerya.harness.cancellation import CancelToken
from nerya.llm.adapters._base import _post_with_retry
from nerya.llm.messages import MessagesRequest, OpenAIMessagesBackend, _make_llm_error
from nerya.llm.retry import parse_retry_after, retry_delay
from test_agent_loop_context_recovery import _make_loop

pytestmark = pytest.mark.smoke


def failure(status=429, headers=None, code=None):
    return _make_llm_error(provider="sensenova", status=status,
        doc={"error": {"message": "rpm exhausted", "code": code}},
        resp_headers=headers or {"X-Request-ID": "rate-limit-fixture"})


def success(tool=False):
    message = {"role": "assistant", "content": "recovered"}
    if tool:
        message = {"role": "assistant", "content": None, "tool_calls": [{
            "id": "read-once", "type": "function",
            "function": {"name": "read_status", "arguments": "{}"},
        }]}
    return {"choices": [{"message": message, "finish_reason": "tool_calls" if tool else "stop"}]}


class Transport:
    def __init__(self, statuses, headers=None, tool_first=False, code=None):
        self.statuses = statuses
        self.headers = headers or {}
        self.tool_first = tool_first
        self.code = code
        self.requests = []

    def post_json_with_headers(self, _url, **kwargs):
        index = len(self.requests)
        self.requests.append(deepcopy(kwargs["body"]))
        status = self.statuses[min(index, len(self.statuses) - 1)]
        doc = success(self.tool_first and index == 0) if status == 200 else {
            "error": {"message": "rpm exhausted", "code": self.code}}
        return status, doc, self.headers


class Gateway:
    def __init__(self, transport):
        self.backend = OpenAIMessagesBackend(api_key="test-key", model="test-model",
            base_url="https://provider.invalid", transport=transport, provider_name="sensenova")

    def call_messages(self, **kwargs):
        fields = {k: v for k, v in kwargs.items() if k in MessagesRequest.__dataclass_fields__}
        return self.backend(MessagesRequest(**fields))


def make_loop(transport, **overrides):
    config = dict(max_iterations=4, llm_retry_full_jitter=False,
        llm_retry_base_delay=2.0, llm_retry_max_delay=60.0)
    config.update(overrides)
    return _make_loop(Gateway(transport), config=LoopConfig(**config))


@pytest.mark.parametrize("headers,expected", [
    ({"Retry-After": "75"}, 75), ({"retry-after-ms": "1500"}, 1.5),
    ({"RETRY-AFTER": "0"}, 0), ({"Retry-After": "-1"}, None),
    ({"Retry-After": "NaN"}, None), ({"Retry-After": "Infinity"}, None),
    ({"Retry-After": "bad date"}, None),
])
def test_retry_after_headers(headers, expected):
    assert parse_retry_after(headers) == expected


def test_http_date_and_exponential_cap():
    assert parse_retry_after({"Retry-After": formatdate(1120, usegmt=True)}, now=1000) == 120
    assert [retry_delay(i, jitter=False) for i in range(1, 9)] == [2, 4, 8, 16, 32, 60, 60, 60]
    assert retry_delay(2, headers={"Retry-After": "90"}) == 90
    assert retry_delay(1, base_delay=0) == 0
    for i in range(1, 9):
        nominal = retry_delay(i, jitter=False)
        assert nominal / 2 <= retry_delay(i) <= nominal


def test_typed_rate_limit_not_quota_or_context_overflow():
    exc = failure()
    assert is_transient_error(exc)
    assert exc.request_id == "rate-limit-fixture"
    assert not is_transient_error(failure(code="insufficient_quota"))
    assert not is_transient_error(failure(headers={"X-Should-Retry": "false"}))
    assert not is_transient_error(failure(status=401))
    assert not is_transient_error(failure(status=403))
    assert not is_transient_error(failure(status=422))
    exc.args = ("too many tokens per minute",)
    assert is_transient_error(exc) and not is_context_overflow_error(exc)


def test_real_adapter_retries_same_request_and_emits_recovery(monkeypatch):
    waits = []
    monkeypatch.setattr(time, "sleep", waits.append)
    transport = Transport([429, 429, 429, 200])
    loop = make_loop(transport)
    result = loop.run(system="system", user_message="summarise")
    assert result.final_text == "recovered"
    assert waits == [2, 4, 8]
    assert len(transport.requests) == 4
    assert all(request == transport.requests[0] for request in transport.requests)
    assert result.extra_llm_attempts_by_reason == {"transient_retry": 3}
    states = [envelope.block["retry"]["state"] for envelope in result.blocks if "retry" in envelope.block]
    assert states == ["waiting", "requesting", "waiting", "requesting", "waiting", "requesting", "recovered"]


def test_rate_limit_after_tool_does_not_rewrite_or_reexecute(monkeypatch):
    waits = []
    monkeypatch.setattr(time, "sleep", waits.append)
    transport = Transport([200, 429, 429, 200], tool_first=True)
    result = make_loop(transport).run(system="system", user_message="read status then summarise")
    assert result.final_text == "recovered"
    assert result.tool_calls == 1
    assert waits == [2, 4]
    assert transport.requests[1] == transport.requests[2] == transport.requests[3]
    assert result.extra_llm_attempts_by_reason == {"transient_retry": 2}


def test_retry_after_is_not_cut_to_local_cap(monkeypatch):
    waits = []
    monkeypatch.setattr(time, "sleep", waits.append)
    transport = Transport([429, 200], headers={"Retry-After": "90"})
    assert make_loop(transport).run(system="s", user_message="u").final_text == "recovered"
    assert waits == [90]


def test_budget_exhaustion_remains_429(monkeypatch):
    waits = []
    monkeypatch.setattr(time, "sleep", waits.append)
    transport = Transport([429])
    with pytest.raises(LLMError) as caught:
        make_loop(transport, max_extra_llm_attempts_per_turn=2).run(system="s", user_message="u")
    assert len(transport.requests) == 3 and waits == [2, 4]
    assert caught.value.status_code == 429
    assert caught.value.retry_exhausted == "attempt_budget"
    response = local_server._rate_limit_response(caught.value)
    assert response["error"] == "rate_limited" and "trace" not in response


def test_deadline_does_not_issue_early_retry(monkeypatch):
    waits = []
    monkeypatch.setattr(time, "sleep", waits.append)
    transport = Transport([429], headers={"Retry-After": "90"})
    with pytest.raises(LLMError) as caught:
        make_loop(transport, max_wall_seconds=30).run(system="s", user_message="u")
    assert caught.value.status_code == 429
    assert caught.value.retry_exhausted == "deadline"
    assert len(transport.requests) == 1 and not waits


@pytest.mark.parametrize("elapsed", [119.9, 121.0])
def test_late_rate_limit_after_tool_is_not_a_fake_success(monkeypatch, elapsed):
    now = [time.time()]
    monkeypatch.setattr(time, "time", lambda: now[0])
    transport = Transport([200, 429], tool_first=True)
    post = transport.post_json_with_headers
    def delayed_post(*args, **kwargs):
        if transport.requests:
            now[0] += elapsed
        return post(*args, **kwargs)
    transport.post_json_with_headers = delayed_post
    with pytest.raises(LLMError) as caught:
        make_loop(transport, max_wall_seconds=120).run(system="s", user_message="read status then summarise")
    assert caught.value.status_code == 429
    assert caught.value.retry_exhausted == "deadline"
    assert len(transport.requests) == 2


def test_operator_cancel_wins_over_a_late_http_failure(monkeypatch):
    now = [time.time()]
    monkeypatch.setattr(time, "time", lambda: now[0])
    token = CancelToken()
    transport = Transport([200, 429], tool_first=True)
    post = transport.post_json_with_headers

    def cancelled_post(*args, **kwargs):
        if transport.requests:
            now[0] += 121
            token.cancel("operator stopped")
        return post(*args, **kwargs)

    transport.post_json_with_headers = cancelled_post
    result = make_loop(transport, max_wall_seconds=120).run(
        system="s", user_message="read status then summarise", cancel_token=token,
    )
    assert result.stop_reason == "cancelled"
    assert result.tool_calls == 1
    assert len(transport.requests) == 2


def test_cancel_during_backoff_sends_no_more_requests():
    token = CancelToken()
    waits = []
    def wait(delay):
        waits.append(delay)
        token.cancel("operator stopped")
        return True
    token.wait = wait
    transport = Transport([429, 200])
    result = make_loop(transport).run(system="s", user_message="u", cancel_token=token)
    assert result.stop_reason == "cancelled"
    assert len(transport.requests) == 1 and waits == [2]


def test_unbound_transport_keeps_retry_and_respects_header(monkeypatch):
    waits = []
    monkeypatch.setattr(time, "sleep", waits.append)
    transport = Transport([429, 200], headers={"Retry-After": "75"})
    status, _, _ = _post_with_retry(transport, "https://provider.invalid", headers={},
        body={}, timeout=1, provider_name="unbound-fixture", api_key="test")
    assert status == 200 and waits == [75]


def test_quota_does_not_retry(monkeypatch):
    waits = []
    monkeypatch.setattr(time, "sleep", waits.append)
    transport = Transport([429], code="insufficient_quota")
    with pytest.raises(LLMError) as caught:
        make_loop(transport).run(system="s", user_message="u")
    assert len(transport.requests) == 1 and not waits
    assert local_server._rate_limit_response(caught.value)["retryable"] is False


@pytest.mark.parametrize("method", ["GET", "POST"])
def test_real_http_boundary_returns_429_without_trace(monkeypatch, tmp_path, method):
    # A private ephemeral socket and fake startup services, never the live workspace.
    from nerya.api.auth import AuthResult
    from nerya.data_sources import sync_contributors
    from nerya.mcp import bridge, openai_tunnel
    from nerya.strategies import continuous
    monkeypatch.setattr(local_server, "_collect_routes", lambda: None)
    monkeypatch.setattr(local_server.InternalClient, "from_config", Mock(return_value=Mock()))
    monkeypatch.setattr(local_server.routes_gateway, "launch_configured_gateways_on_start", lambda _: None)
    monkeypatch.setattr(local_server.routes_network, "launch_configured_tunnels_on_start", lambda _: None)
    monkeypatch.setattr(sync_contributors, "install_default_contributors", lambda: None)
    monkeypatch.setattr(sync_contributors, "seed_additional_rows", lambda _: None)
    monkeypatch.setattr(openai_tunnel, "restore", lambda *a, **k: None)
    monkeypatch.setattr(continuous, "get_continuous_supervisor", Mock(return_value=Mock()))
    monkeypatch.setattr(bridge, "handle_http", lambda *a: False)
    monkeypatch.setattr(local_server, "_memory_request_client", lambda *a: None)
    monkeypatch.setattr(local_server, "_cors_headers", lambda _: [])
    monkeypatch.setattr(local_server.auth_mod, "check_request", lambda *a, **k: AuthResult(ok=True))
    monkeypatch.setattr(local_server.auth_mod, "authorize_route", lambda *a, **k: AuthResult(ok=True))
    def handler(*args):
        raise failure(headers={"Retry-After": "90", "X-Request-ID": "http-fixture"})
    monkeypatch.setattr(local_server, "_match", lambda *a: (handler, {}))
    server = local_server.build_server(SimpleNamespace(paths=SimpleNamespace(root=tmp_path)),
        port=0, start_cron=False, start_continuous=False)
    server.mcp_config = None
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    connection = http.client.HTTPConnection(*server.server_address, timeout=5)
    try:
        connection.request(method, "/test", body="{}" if method == "POST" else None)
        response = connection.getresponse()
        body = json.loads(response.read())
        assert response.status == 429
        assert response.getheader("Retry-After") == "90"
        assert response.getheader("Cache-Control") == "no-store"
        assert body["request_id"] == "http-fixture"
        assert body["error"] == "rate_limited"
        assert "trace" not in body and "LLMError" not in json.dumps(body)
    finally:
        connection.close()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
