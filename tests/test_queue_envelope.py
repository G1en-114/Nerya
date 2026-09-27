from copy import deepcopy
import json
from types import SimpleNamespace

import pytest

from nerya.agent.attachments import upload_chat_attachments
from nerya.agent.command_runtime import CommandRuntime
from nerya.agent.command_store import CommandError
from nerya.core.config import Config, DEFAULT_CONFIG
from nerya.core.paths import WorkspacePaths


@pytest.fixture
def runtime(tmp_path, monkeypatch):
    from nerya.llm.gateway import LLMGateway
    monkeypatch.setattr(LLMGateway, "effective_model_metadata",
        lambda self, tier, provider_override=None, model_override=None:
            (provider_override or "fixture", model_override or "default", SimpleNamespace(context_window=8192)))
    return CommandRuntime(Config(paths=WorkspacePaths(root=tmp_path), data=deepcopy(DEFAULT_CONFIG)),
                          lambda *_: pytest.fail("No execution during queue edits"), epoch="queue-edit-test")


def submit(runtime):
    body = {"command_id": "command-envelope", "session_id": "session-envelope", "_auth_actor_id": "operator",
            "request": {"source": "user_chat", "work_mode": "execute", "payload": {"text": "original"}}}
    return body, runtime.submit(body, start=False)["command"]


def edit(runtime, command, request):
    return runtime.control({"session_id": command["session_id"], "command_id": command["command_id"],
        "action": "edit", "expected_revision": command["revision"], "request": request})["commands"][0]


def stored(runtime):
    with runtime.store.transaction() as con:
        return dict(con.execute("SELECT * FROM agent_commands WHERE command_id='command-envelope'").fetchone())


def test_envelope_edit_is_atomic_and_old_ack_cannot_undo_it(runtime):
    body, command = submit(runtime)
    before = stored(runtime)
    file = upload_chat_attachments([{"id": "evidence", "name": "evidence.txt", "text": "fixture"}],
                                   paths=runtime.config.paths, upload_id="fixture")[0]
    file.pop("text", None)  # The composer sends the saved reference, not preview bytes.
    file["reference"] = {"kind": "file", "id": "notes.md", "captured_at": "2026-09-26"}
    changed = edit(runtime, command, {"payload": {"text": "edited", "attachments": [file]},
        "model_provider": "fixture-b", "model_id": "model-b", "reasoning_effort": "high",
        "work_mode": "plan", "permission_mode": "default", "max_iterations": 6})
    after = stored(runtime)
    for key in ("fingerprint", "actor_id", "turn_id", "command_id", "position", "created_at"):
        assert before[key] == after[key]
    assert changed["revision"] == command["revision"] + 1
    assert changed["input"] == changed["context"]["input_text"] == "edited"
    assert changed["attachments"][0]["artifact_uri"] == changed["context"]["attachments"][0]["artifact_uri"]
    assert changed["context"]["references"] == [file["reference"]]
    assert changed["context"]["requested_model"]["model_id"] == "model-b"
    assert changed["context"]["accepted_model"]["model"] == "model-b"
    assert changed["context"]["work_mode"] == "plan"
    assert changed["context"]["run_settings"]["max_iterations"] == 6
    assert "actual_model" not in changed["context"]
    ack = runtime.submit(body, start=False)
    assert ack["duplicate"] and ack["command"] == changed
    with pytest.raises(CommandError, match="revision_conflict"):
        edit(runtime, command, {"payload": {"text": "stale"}})
    assert stored(runtime) == after
    claimed = runtime.store.claim(command["session_id"], "owner")
    assert json.loads(claimed["request_json"])["payload"]["attachments"] == [file]
    running = runtime.store.snapshot(command["session_id"], command["command_id"])["command"]
    with pytest.raises(CommandError, match="already_claimed"):
        edit(runtime, running, {"payload": {"text": "too late"}})


def test_goal_mode_survives_queue_edit(runtime):
    _, command = submit(runtime)
    changed = edit(runtime, command, {"work_mode": "goal"})
    assert changed["context"]["work_mode"] == "goal"
    claimed = runtime.store.claim(command["session_id"], "owner")
    assert json.loads(claimed["request_json"])["work_mode"] == "goal"


@pytest.mark.parametrize("patch", [
    {"actor_id": "other"}, {"_auth_actor_id": "other"}, {"source": "approval_continue"},
    {"strategy_id": "other"}, {"strategy_proposal_id": "other"}, {"turn_id": "other"},
    {"resume_turn_id": "other"}, {"approval_id": "other"}, {"plan_id": "other"},
    {"interaction_id": "other"}, {"run_only": True}, {"evidence_contract": {}},
    {"payload": {"text": "x", "approval_state": "approved"}},
    {"payload": {"text": "x", "channel": "other"}},
])
def test_out_of_scope_fields_rejected_without_partial_write(runtime, patch):
    _, command = submit(runtime)
    before = stored(runtime)
    with pytest.raises(CommandError, match="invalid_command_edit"):
        edit(runtime, command, patch)
    assert stored(runtime) == before


@pytest.mark.parametrize("patch", [
    {"payload": {"text": 1}}, {"payload": {"attachments": ["not a file"]}},
    {"payload": {"attachments": [{}] * 9}}, {"model_id": {}},
    {"max_iterations": -1}, {"max_wall_seconds": True}, {"permission_mode": "unsafe"},
    {"work_mode": "invalid"}, {"reasoning_effort": []},
])
def test_submit_and_edit_share_validation(runtime, patch):
    body, command = submit(runtime)
    with pytest.raises(CommandError) as edited:
        edit(runtime, command, patch)
    request = {**body["request"], **patch}
    request["payload"] = {"text": "valid", **patch.get("payload", {})}
    with pytest.raises(CommandError) as submitted:
        runtime.submit({**body, "command_id": "command-invalid", "request": request}, start=False)
    assert edited.value.code == submitted.value.code


@pytest.mark.parametrize("file", [
    {"name": "unuploaded", "text": "raw bytes"},
    {"artifact_uri": "nerya://artifact/attachments/missing.txt"},
    {"artifact_uri": "nerya://artifact/attachments/../../private.txt"},
    {"artifact_uri": "https://external.invalid/private"},
])
def test_edits_require_saved_uploads(runtime, file):
    _, command = submit(runtime)
    with pytest.raises(CommandError, match="attachment_upload_required"):
        edit(runtime, command, {"payload": {"attachments": [file]}})


def test_attachment_only_edit_and_clear_update_context(runtime):
    _, command = submit(runtime)
    file = upload_chat_attachments([{"name": "only.txt", "text": "fixture"}], paths=runtime.config.paths)[0]
    file.pop("text", None)
    changed = edit(runtime, command, {"payload": {"text": "", "attachments": [file]}})
    assert changed["input"] == changed["context"]["input_text"] == ""
    changed = edit(runtime, changed, {"payload": {"text": "no files", "attachments": []}})
    assert changed["attachments"] == changed["context"]["attachments"] == changed["context"]["references"] == []


def test_upload_reference_cannot_smuggle_inline_aliases_or_symlinks(runtime):
    _, command = submit(runtime)
    file = upload_chat_attachments([{"name": "proof.txt", "text": "fixture"}], paths=runtime.config.paths)[0]
    file.pop("text", None)
    for key in ("data_uri", "base64", "content_b64", "bytes_b64", "download_url", "file_url"):
        with pytest.raises(CommandError, match="attachment_upload_required"):
            edit(runtime, command, {"payload": {"attachments": [{**file, key: "injected"}]}})
    root = runtime.config.paths.artifacts / "attachments"
    (root / "linked.txt").symlink_to(root / file["artifact_uri"].split("/attachments/", 1)[1])
    with pytest.raises(CommandError, match="attachment_upload_required"):
        edit(runtime, command, {"payload": {"attachments": [{**file, "artifact_uri": "nerya://artifact/attachments/linked.txt"}]}})


def test_resume_feedback_retains_turn_and_cannot_change_plan_mode(runtime):
    command = runtime.submit({"command_id": "command-envelope", "session_id": "session-envelope", "command_type": "resume",
        "request": {"work_mode": "plan", "resume_turn_id": "turn-original", "continuation_feedback": "continue", "payload": {}}}, start=False)["command"]
    changed = edit(runtime, command, {"payload": {"text": "new feedback", "attachments": []}})
    assert changed["turn_id"] == "turn-original"
    assert changed["input"] == changed["context"]["input_text"] == "new feedback"
    with pytest.raises(CommandError, match="invalid_command_edit"):
        edit(runtime, changed, {"work_mode": "execute"})
    with pytest.raises(CommandError, match="invalid_message"):
        edit(runtime, changed, {"payload": {"text": 42}})


def test_top_level_edit_bypass_and_oversize_leave_state_intact(runtime):
    _, command = submit(runtime)
    before = stored(runtime)
    with pytest.raises(CommandError, match="invalid_command_edit"):
        runtime.control({"session_id": command["session_id"], "command_id": command["command_id"],
            "action": "edit", "expected_revision": command["revision"], "text": "new", "source": "approval_continue"})
    with pytest.raises(CommandError, match="command_too_large"):
        edit(runtime, command, {"payload": {"text": "x" * 256001}})
    assert stored(runtime) == before


@pytest.mark.parametrize("decision", [
    {"source": "approval_continue"}, {"source": "interaction_continue", "work_mode": "plan"},
    {"interaction_id": "pending-question"}, {"plan_id": "reviewed-plan"},
])
def test_queue_edit_cannot_rewrite_or_promote_decision(runtime, decision):
    _, command = submit(runtime)
    with runtime.store.transaction() as con:
        request = json.loads(con.execute("SELECT request_json FROM agent_commands").fetchone()[0])
        request.update(decision)
        con.execute("UPDATE agent_commands SET request_json=?", (json.dumps(request),))
    assert not runtime.store.snapshot(command["session_id"], command["command_id"])["command"]["queue_editable"]
    before = stored(runtime)
    with pytest.raises(CommandError, match="decision_command_not_editable"):
        edit(runtime, command, {"work_mode": "execute", "payload": {"text": "approved"}})
    assert stored(runtime) == before
