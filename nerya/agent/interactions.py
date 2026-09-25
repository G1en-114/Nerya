"""Durable user decisions. Responses do not confer tool or trading permission."""
from __future__ import annotations
import hashlib
import json
import time
from ..db.sqlite import connect
from .command_store import CommandError, command_id, encode
from .history_mutations import _session_id, is_session_deleted


def validate_payload(kind, payload):
    if kind not in ("question", "plan") or not isinstance(payload, dict):
        raise CommandError("invalid_interaction", 400)
    title = payload.get("title")
    if not isinstance(title, str) or not title.strip() or len(title) > 240:
        raise CommandError("invalid_interaction_title", 400)
    out = {"title": title.strip()}
    message = payload.get("message", "")
    if not isinstance(message, str) or len(message) > 12000:
        raise CommandError("invalid_interaction_message", 400)
    out["message"] = message
    for key in (("choices",) if kind == "question" else ("steps", "deliverables", "constraints")):
        values = payload.get(key, [])
        if not isinstance(values, list) or len(values) > (12 if key == "choices" else 30) or any(not isinstance(v, str) or not v.strip() or len(v) > 1000 for v in values):
            raise CommandError("invalid_interaction_options", 400)
        out[key] = list(dict.fromkeys(values))
    if kind == "plan" and not out["steps"]:
        raise CommandError("plan_steps_required", 400)
    if type(payload.get("multiple", False)) is not bool:
        raise CommandError("invalid_interaction_multiple", 400)
    out["multiple"] = payload.get("multiple", False)
    return out


def create_interaction(config, *, sid, tid, call_id, kind, payload):
    sid = _session_id(sid)
    payload = validate_payload(kind, payload)
    iid = "interaction_" + hashlib.sha256(encode([sid, tid, call_id]).encode()).hexdigest()[:32]
    con = connect(config.paths.db)
    try:
        con.execute("BEGIN IMMEDIATE")
        if is_session_deleted(con, sid):
            raise CommandError("session_deleted", 410)
        old = con.execute("SELECT * FROM agent_interactions WHERE interaction_id=?", (iid,)).fetchone()
        if old:
            if old["payload_json"] != encode(payload):
                raise CommandError("interaction_conflict")
        else:
            if con.execute("SELECT 1 FROM agent_interactions WHERE session_id=? AND state IN ('pending','deferred','answered')", (sid,)).fetchone():
                raise CommandError("interaction_already_pending")
            con.execute("INSERT INTO agent_interactions(interaction_id,session_id,turn_id,kind,payload_json,state,created_at,updated_at) VALUES (?,?,?,?,?,'pending',?,?)", (iid,sid,tid,kind,encode(payload),time.time(),time.time()))
        con.commit()
        return {"interaction_id": iid, "session_id": sid, "turn_id": tid, "kind": kind, "payload": payload, "state": "pending", "revision": 1}
    finally:
        con.close()


def respond(manager, body):
    sid = _session_id(body.get("session_id"))
    iid = command_id(body.get("interaction_id"))
    rid = command_id(body.get("response_id"))
    action = body.get("action", "answer")
    actor = str(body.get("_auth_actor_id") or "local")
    response = {"action": action, "text": body.get("text", ""), "selected": body.get("selected", [])}
    if not isinstance(response["text"], str) or len(response["text"]) > 12000 or not isinstance(response["selected"], list):
        raise CommandError("invalid_interaction_answer", 400)
    with manager.store.transaction() as con:
        manager.store._queue(con, sid)
        row = con.execute("SELECT * FROM agent_interactions WHERE interaction_id=? AND session_id=?", (iid,sid)).fetchone()
        if not row:
            raise CommandError("interaction_not_found", 404)
        row = dict(row)
        payload = json.loads(row["payload_json"])
        same = row["response_id"] == rid and row["actor_id"] == actor and row["response_json"] == encode(response)
        if row["state"] == "deferred" and same and action == "defer":
            return {"ok":True,"deferred":True,"duplicate":True}
        if row["state"] == "resolved":
            if same:
                return {"ok": True, "duplicate": True, "interaction_id": iid}
            raise CommandError("interaction_resolved")
        if not same and (row["state"] == "answered" or body.get("expected_revision") != row["revision"]):
            raise CommandError("interaction_revision_conflict")
        if action == "defer":
            con.execute("UPDATE agent_interactions SET state='deferred',response_id=?,response_json=?,actor_id=?,revision=revision+1,updated_at=? WHERE interaction_id=?", (rid,encode(response),actor,time.time(),iid))
            return {"ok": True, "deferred": True}
        if action != "answer":
            raise CommandError("invalid_interaction_action", 400)
        if any(not isinstance(v,str) or v not in payload.get("choices",[]) for v in response["selected"]):
            raise CommandError("invalid_interaction_choice", 400)
        if not payload.get("multiple") and len(response["selected"]) > 1:
            raise CommandError("invalid_interaction_choice", 400)
        if row["kind"] == "question" and not response["text"].strip() and not response["selected"]:
            raise CommandError("interaction_answer_required", 400)
        original = con.execute("SELECT * FROM agent_commands WHERE session_id=? AND turn_id=? AND kind!='guide' ORDER BY created_at DESC LIMIT 1", (sid,row["turn_id"])).fetchone()
        admitted = con.execute("SELECT 1 FROM agent_commands WHERE command_id=?", ("response_"+iid,)).fetchone()
        if not original or (original["state"] != "awaiting_input" and not (same and admitted)):
            raise CommandError("interaction_turn_not_ready")
        if row["kind"] == "question" and not admitted:
            from ..db.repositories import AgentSessionRepository
            cp = AgentSessionRepository(con).peek_turn_checkpoint(sid)
            if not cp or cp["turn_id"] != row["turn_id"] or cp.get("claim_id") or not cp["checkpoint"].get("resumable"):
                raise CommandError("interaction_checkpoint_stale")
        # The original input remains immutable even after a continuation completes.
        original = con.execute("SELECT * FROM agent_commands WHERE session_id=? AND turn_id=? AND command_id!=? ORDER BY created_at LIMIT 1", (sid,row["turn_id"],"response_"+iid)).fetchone()
        request = json.loads(original["request_json"])
        if not same:
            con.execute("UPDATE agent_interactions SET state='answered',response_id=?,response_json=?,actor_id=?,revision=revision+1,updated_at=? WHERE interaction_id=?", (rid,encode(response),actor,time.time(),iid))
    # Stable command identity makes response/admission retries safe across crashes.
    feedback = "User response to " + payload["title"] + ": " + encode(response)
    request["interaction_id"] = iid
    if row["kind"] == "question":
        request.update(resume_turn_id=row["turn_id"], continuation_feedback=feedback)
        request["payload"] = {"text": ""}
        kind = "resume"
    else:
        request.pop("resume_turn_id", None)
        request.pop("continuation_feedback", None)
        request.update(work_mode="execute", plan_id=iid)
        request["payload"] = {"text": "Execute this accepted plan within existing permissions.\n" + encode(payload) + "\n" + feedback}
        kind = "send"
    result = manager.submit({"command_id": "response_"+iid, "session_id":sid,"command_type":kind,"request":request,
                             **{key:body.get(key) for key in ("_auth_actor_id","_auth_scope","_auth_scopes")}},start=False)
    with manager.store.transaction() as con:
        con.execute("UPDATE agent_interactions SET state='resolved',revision=revision+1,updated_at=? WHERE interaction_id=? AND response_id=?", (time.time(),iid,rid))
    manager.kick(sid)
    return {"ok": True, "interaction_id": iid, "command":result["command"]}
