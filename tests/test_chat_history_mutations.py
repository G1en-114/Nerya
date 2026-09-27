"""History regression tests. Temporary database/files only; no model or network."""
import json
import sqlite3
from types import SimpleNamespace

import pytest

from nerya.agent.history_mutations import delete_session, history_response, mutate_message, rename_session
from nerya.agent.session import SessionStore, merge_session_dict
from nerya.api import routes_agent
from nerya.core.config import Config
from nerya.core.paths import WorkspacePaths
from nerya.db.repositories import AgentSessionRepository
from nerya.db.sqlite import connect

pytestmark = pytest.mark.smoke


@pytest.fixture
def history(tmp_path):
    paths = WorkspacePaths(root=tmp_path)
    con = connect(paths.db)
    repo = AgentSessionRepository(con)
    repo.upsert_session(session_id="history-a", source="user_chat", title="Original title")
    repo.record_message(message_id="turn-a:user", session_id="history-a", turn_id="turn-a", role="user", content="Original question")
    yield paths, con, repo
    con.close()


def route(paths, method, path, payload):
    handler = next(handler for verb, name, handler in routes_agent.routes() if (verb, name) == (method, path))
    return handler(SimpleNamespace(config=Config(paths=paths)), payload)


def test_edit_commits_exact_text_and_rejects_stale_writer(history):
    paths, con, repo = history
    text = "  更正问题\n保留原始空格  "
    result = history_response(mutate_message, paths, {"session_id": "history-a", "message_id": "turn-a:user", "content": text, "expected_content": "Original question"})
    assert result["ok"] and result["content"] == text
    assert repo.transcript("history-a")[0]["content"] == text
    conflict = history_response(mutate_message, paths, {"session_id": "history-a", "message_id": "turn-a:user", "content": "stale change", "expected_content": "Original question"})
    assert conflict["code"] == "message_conflict"
    assert repo.transcript("history-a")[0]["content"] == text
    # A lost response is safe to retry without overwriting or rerunning the Agent.
    assert history_response(mutate_message, paths, {"session_id": "history-a", "message_id": "turn-a:user", "content": text, "expected_content": "Original question"})["ok"]
    repo.record_message(message_id="turn-a:user", session_id="history-a", turn_id="turn-a", role="user", content="Original question")
    assert repo.transcript("history-a")[0]["content"] == text


@pytest.mark.parametrize("content,code", [("", "content_required"), (" \n", "content_required"), (42, "content_required")])
def test_invalid_content_never_truncates_or_commits(history, content, code):
    paths, con, repo = history
    result = route(paths, "POST", "/agent/session/message/edit", {"session_id": "history-a", "message_id": "turn-a:user", "content": content})
    assert result["code"] == code
    assert repo.transcript("history-a")[0]["content"] == "Original question"


def test_only_user_messages_can_be_changed(history):
    paths, con, repo = history
    repo.record_message(message_id="turn-a:assistant", session_id="history-a", role="assistant", content="Recorded result")
    result = route(paths, "POST", "/agent/session/message/edit", {"session_id": "history-a", "message_id": "turn-a:assistant", "content": "Fabricated result"})
    assert result["code"] == "message_read_only"


def test_delete_last_message_does_not_restore_journal_on_refresh(history):
    paths, con, repo = history
    journal = paths.journal("agent")
    journal.parent.mkdir(parents=True, exist_ok=True)
    journal.write_text(json.dumps({"kind": "agent.turn.start", "session_id": "history-a", "turn_id": "turn-a", "user_text": "Original question"}) + "\n")
    payload = {"session_id": "history-a", "message_id": "turn-a:user", "expected_content": "Original question"}
    for _ in range(2):
        assert route(paths, "POST", "/agent/session/message/delete", payload)["ok"]
    repo.record_message(message_id="turn-a:user", session_id="history-a", role="user", content="Late original")
    assert repo.transcript("history-a") == []
    transcript = route(paths, "GET", "/agent/session/transcript", {"session_id": "history-a", "full": "1"})
    assert transcript["ok"] and transcript["messages"] == []
    assert "Original question" in journal.read_text()  # audit retained, not conversation data


def test_pending_continuation_blocks_changes(history):
    paths, con, repo = history
    con.execute("INSERT INTO agent_turn_checkpoints(session_id,turn_id,checkpoint_json,checkpoint_bytes,saved_at) VALUES(?,?,?,?,?)", ("history-a", "pending-turn", "{}", 2, 1.0))
    for endpoint, payload in [("message/edit", {"message_id": "turn-a:user", "content": "New"}), ("message/delete", {"message_id": "turn-a:user"}), ("delete", {})]:
        assert route(paths, "POST", "/agent/session/" + endpoint, {"session_id": "history-a", **payload})["code"] == "history_busy"
    assert repo.transcript("history-a")[0]["content"] == "Original question"


def test_session_delete_is_atomic_and_repeated_delete_is_safe(history):
    paths, con, repo = history
    con.execute("CREATE TRIGGER fail_history_cleanup BEFORE DELETE ON agent_messages BEGIN SELECT RAISE(ABORT,'test-only'); END")
    failure = history_response(delete_session, paths, {"session_id": "history-a"})
    assert not failure["ok"]
    assert repo.get_session("history-a") and repo.transcript("history-a")
    assert con.execute("SELECT COUNT(*) FROM agent_deleted_sessions").fetchone()[0] == 0
    con.execute("DROP TRIGGER fail_history_cleanup")
    for _ in range(2):
        assert history_response(delete_session, paths, {"session_id": "history-a"})["ok"]
    assert repo.get_session("history-a") is None
    with pytest.raises(sqlite3.IntegrityError, match="session_deleted"):
        repo.upsert_session(session_id="history-a")


def test_file_and_journal_cannot_revive_deleted_session(history):
    paths, con, repo = history
    assert history_response(delete_session, paths, {"session_id": "history-a"})["ok"]
    # Simulate an old integration rewriting its legacy summary after deletion.
    SessionStore(paths.root).ensure("history-a")
    listing = route(paths, "GET", "/agent/sessions", {})
    assert all(row["session_id"] != "history-a" for row in listing["sessions"])
    assert route(paths, "GET", "/agent/session", {"session_id": "history-a"})["code"] == "session_deleted"
    assert not route(paths, "GET", "/agent/session/transcript", {"session_id": "history-a"})["ok"]


def test_rename_wins_over_stale_file_title(history):
    paths, con, repo = history
    old = SessionStore(paths.root).update_meta("history-a", {"title": "Stale file title"})
    result = history_response(rename_session, paths, {"session_id": "history-a", "title": "  New   title "})
    assert result["ok"] and result["title"] == "New title"
    assert merge_session_dict(old, repo.get_session("history-a"))["meta"]["title"] == "New title"
    transcript = route(paths, "GET", "/agent/session/transcript", {"session_id": "history-a"})
    assert transcript["title"] == "New title"


@pytest.mark.parametrize("sid", [" .. ", "../other", "a/b", "a\\b", "", None])
def test_invalid_session_paths_are_rejected(history, sid):
    paths, con, repo = history
    assert history_response(delete_session, paths, {"session_id": sid})["code"] == "invalid_session_id"
    assert repo.get_session("history-a") is not None
