import json

import pytest

from nerya.skills.builtin.llm.scripts.gwdc_efficiency import call_once, summarize, usage_counts, report

pytestmark = pytest.mark.smoke


def test_anthropic_cache_tokens_are_counted_once_and_missing_is_unknown():
    counts = usage_counts({"input_tokens": 100, "output_tokens": 20,
                           "cache_read_input_tokens": 30, "cache_creation_input_tokens": 10})
    assert counts["input"] == 140
    assert counts["total"] == 160
    assert usage_counts({"input_tokens": 100}) is None
    assert usage_counts({"input_tokens": True, "output_tokens": 20}) is None
    assert usage_counts({"input_tokens": -1, "output_tokens": 20}) is None


def test_failures_and_unknown_attempts_are_not_dropped():
    rows = [
        {"attempt_id": "a", "flow_id": "explain_allowed", "status": "failed", "usage": {"input_tokens": 10, "output_tokens": 2}},
        {"attempt_id": "b", "flow_id": "explain_allowed", "status": "completed", "usage": {"input_tokens": 20, "output_tokens": 4}},
        {"attempt_id": "c", "flow_id": "explain_allowed", "status": "started", "usage": None},
    ]
    f = summarize(rows)[0]
    assert f["attempts"] == 3 and f["completed"] == 1
    assert f["unknown_usage_attempts"] == 1 and f["known_total_tokens"] == 36
    assert f["energy_scenarios_j"]["base"] == 4.5
    with pytest.raises(ValueError, match="Duplicate"):
        summarize(rows + [rows[0]])


def test_public_audit_excludes_credentials_and_reuses_completed_request(tmp_path):
    class Vault:
        def resolve(self, *args, **kwargs):
            return "private-test-credential"

    class Transport:
        calls = 0

        def post_json_with_headers(self, url, *, headers, body, timeout):
            self.calls += 1
            assert headers["x-api-key"] == "private-test-credential"
            return 200, {"id": "test-response", "model": body["model"], "stop_reason": "end_turn",
                         "usage": {"input_tokens": 17, "output_tokens": 3},
                         "content": [{"type": "text", "text": "A recorded paper fill."}]}, {"set-cookie": "do-not-export"}

    transport = Transport()
    args = dict(flow={"flow_id": "explain_allowed", "source": {"status": "filled"}},
                model="deepseek-v4.1-flash", vault=Vault(), output=tmp_path, transport=transport)
    call_once(**args)
    call_once(**args)
    assert transport.calls == 1
    data = next((tmp_path / "attempts").glob("*.json")).read_text()
    assert "private-test-credential" not in data and "do-not-export" not in data
    assert json.loads(data)["counts"]["total"] == 20
    summary = report(tmp_path)
    assert not summary["all_flows_completed_with_reported_usage"]
    assert summary["energy_measured"] is False
