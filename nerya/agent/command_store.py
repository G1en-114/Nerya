"""Durable conversation commands. An ingress receipt is not a tool receipt.

SQLite owns admission, queue revisions and active command uniqueness. Expired
workers become unconfirmed; neither reads nor retries replay external effects.
"""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import re
import time
from typing import Any

from ..db.sqlite import connect
from .history_mutations import _session_id, is_session_deleted

ACTIVE = ("running", "stopping")
PENDING = ("queued", "delivering", "delivered", "running", "stopping", "unconfirmed")
TERMINAL = ("succeeded", "failed", "interrupted", "awaiting_approval", "awaiting_input", "blocked", "not_consumed", "injected", "removed", "unconfirmed")
LEASE_SECONDS = 30
MAX_QUEUE = 32


class CommandError(ValueError):
    def __init__(self, code: str, status: int = 409):
        self.code, self.status = code, status
        super().__init__(code)


def encode(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str, allow_nan=False)


def command_id(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,160}", value):
        raise CommandError("invalid_command_id", 400)
    return value


def fingerprint(kind: str, request: dict) -> str:
    return hashlib.sha256(json.dumps([kind, request], sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":"), allow_nan=False).encode()).hexdigest()


class CommandStore:
    def __init__(self, paths, epoch: str):
        self.paths, self.epoch = paths, epoch

    @contextmanager
    def transaction(self):
        con = connect(self.paths.db)
        try:
            con.execute("BEGIN IMMEDIATE")
            yield con
            con.commit()
        except BaseException:
            if con.in_transaction:
                con.rollback()
            raise
        finally:
            con.close()

    def _queue(self, con, sid: str):
        if is_session_deleted(con, sid):
            raise CommandError("session_deleted", 410)
        now = time.time()
        con.execute("INSERT OR IGNORE INTO agent_command_queues(session_id,runtime_epoch,updated_at) VALUES (?,?,?)",
                    (sid, self.epoch, now))
        queue = dict(con.execute("SELECT * FROM agent_command_queues WHERE session_id=?", (sid,)).fetchone())
        expired = bool(queue["worker_owner"] and queue["lease_until"] < now)
        restarted = queue["runtime_epoch"] != self.epoch and not queue["worker_owner"]
        if expired:
            con.execute("UPDATE agent_commands SET state='unconfirmed',revision=revision+1,updated_at=? "
                        "WHERE session_id=? AND state IN ('running','stopping')", (now, sid))
            con.execute("UPDATE agent_commands SET state='not_consumed',revision=revision+1,updated_at=? "
                        "WHERE session_id=? AND kind='guide' AND state IN ('queued','delivering','delivered')", (now, sid))
        if expired or restarted:
            pending = con.execute("SELECT 1 FROM agent_commands WHERE session_id=? AND state IN ('queued','unconfirmed') LIMIT 1", (sid,)).fetchone()
            con.execute("UPDATE agent_command_queues SET runtime_epoch=?,worker_owner='',lease_until=0,"
                        "paused=?,pause_reason=?,revision=revision+1,updated_at=? WHERE session_id=?",
                        (self.epoch, int(bool(pending)), "restarted" if pending else "", now, sid))
            queue = dict(con.execute("SELECT * FROM agent_command_queues WHERE session_id=?", (sid,)).fetchone())
        return queue

    @staticmethod
    def public(row, *, full=False):
        item = dict(row)
        request = json.loads(item.pop("request_json"))
        item["context"] = json.loads(item.pop("context_json"))
        result = item.pop("result_json", None)
        error = item.pop("error_json", None)
        item.pop("fingerprint", None)
        item.pop("actor_id", None)
        item["input"] = str(request.get("payload", {}).get("text") or request.get("continuation_feedback") or "")
        item["attachments"] = request.get("payload", {}).get("attachments", [])
        item["show_user"] = request.get("source") != "approval_continue"
        item["has_result"] = bool(result)
        item["error"] = json.loads(error) if error else None
        if full:
            item["result"] = json.loads(result) if result else None
        return item

    def existing_receipt(self, cid: str, sid: str, actor: str, kind: str, request: dict):
        cid, sid = command_id(cid), _session_id(sid)
        con = connect(self.paths.db)
        try:
            if is_session_deleted(con,sid):
                raise CommandError("session_deleted",410)
            row = con.execute("SELECT * FROM agent_commands WHERE command_id=?",(cid,)).fetchone()
            if not row:
                return None
            if row["session_id"] != sid or row["actor_id"] != actor or row["fingerprint"] != fingerprint(kind,request):
                raise CommandError("command_conflict")
            return {"ok":True,"duplicate":True,"command":self.public(row)}
        finally:
            con.close()

    def accept(self, *, cid: str, sid: str, actor: str, kind: str, request: dict,
               context: dict, turn_id: str, continuation=False, identity_request=None):
        cid, sid = command_id(cid), _session_id(sid)
        digest = fingerprint(kind, identity_request if identity_request is not None else request)
        if len(encode(request).encode()) > 256_000:
            raise CommandError("command_too_large", 413)
        with self.transaction() as con:
            queue = self._queue(con, sid)
            old = con.execute("SELECT * FROM agent_commands WHERE command_id=?", (cid,)).fetchone()
            if old:
                if old["session_id"] != sid or old["actor_id"] != actor or old["fingerprint"] != digest:
                    raise CommandError("command_conflict")
                return {"ok": True, "duplicate": True, "command": self.public(old)}
            pending = con.execute("SELECT interaction_id,state FROM agent_interactions WHERE session_id=? AND state IN ('pending','deferred','answered')", (sid,)).fetchall()
            iid = request.get("interaction_id")
            if iid:
                interaction = con.execute("SELECT state,session_id,actor_id FROM agent_interactions WHERE interaction_id=?", (iid,)).fetchone()
                if not interaction or interaction["session_id"] != sid or interaction["actor_id"] != actor or interaction["state"] not in ("answered","resolved") or cid != "response_"+iid:
                    raise CommandError("interaction_response_required")
            if pending and (len(pending) != 1 or pending[0]["interaction_id"] != iid or pending[0]["state"] != "answered"):
                raise CommandError("interaction_response_required")
            from ..db.repositories import AgentSessionRepository
            repo = AgentSessionRepository(con)
            session = repo.get_session(sid)
            if session and session.get("strategy_id") != request.get("strategy_id"):
                raise CommandError("strategy_binding_conflict")
            if session and session.get("source") in ("mcp", "tunnel"):
                raise CommandError("external_session_read_only")
            if not session:
                repo.upsert_session(session_id=sid, source="user_chat", strategy_id=request.get("strategy_id"),
                                    title=str(request.get("payload", {}).get("text") or "Conversation")[:80],
                                    meta={"strategy_proposal_id":request.get("strategy_proposal_id")})
            count = con.execute("SELECT count(*) FROM agent_commands WHERE session_id=? AND state='queued'", (sid,)).fetchone()[0]
            if count >= MAX_QUEUE:
                raise CommandError("queue_full", 429)
            position = con.execute("SELECT COALESCE(MAX(position),0)+1 FROM agent_commands WHERE session_id=?", (sid,)).fetchone()[0]
            state = "queued"
            if kind == "guide":
                active = con.execute("SELECT turn_id FROM agent_commands WHERE session_id=? AND kind!='guide' AND state='running'", (sid,)).fetchone()
                if not active:
                    raise CommandError("no_running_turn")
                turn_id = active["turn_id"]
            elif continuation:
                if con.execute("SELECT 1 FROM agent_commands WHERE session_id=? AND state='unconfirmed'", (sid,)).fetchone():
                    raise CommandError("execution_unconfirmed")
                if queue["worker_owner"]:
                    raise CommandError("session_turn_in_progress")
                position = con.execute("SELECT COALESCE(MIN(position),0)-1 FROM agent_commands WHERE session_id=?", (sid,)).fetchone()[0]
                con.execute("UPDATE agent_command_queues SET paused=0,pause_reason='',runtime_epoch=?,revision=revision+1 WHERE session_id=?", (self.epoch, sid))
            now = time.time()
            con.execute("INSERT INTO agent_commands(command_id,session_id,actor_id,kind,fingerprint,request_json,context_json,state,turn_id,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                        (cid,sid,actor,kind,digest,encode(request),encode(context),state,turn_id,position,now,now))
            con.execute("UPDATE agent_command_queues SET revision=revision+1,updated_at=? WHERE session_id=?", (now,sid))
            row = con.execute("SELECT * FROM agent_commands WHERE command_id=?", (cid,)).fetchone()
            return {"ok": True, "duplicate": False, "command": self.public(row)}

    def _projection(self, con, row, *, full=False):
        item = self.public(row,full=full)
        user = con.execute("SELECT content,deleted FROM agent_messages WHERE session_id=? AND message_id=?",
                           (row["session_id"],row["turn_id"]+":user")).fetchone()
        if user is not None:
            if user["deleted"]:
                item["show_user"] = False
            elif row["kind"] == "send":
                item["input"] = user["content"]
        return item

    def snapshot(self, sid: str, cid: str | None = None):
        sid = _session_id(sid)
        with self.transaction() as con:
            queue = self._queue(con, sid)
            if cid:
                row = con.execute("SELECT * FROM agent_commands WHERE command_id=? AND session_id=?", (command_id(cid),sid)).fetchone()
                if not row:
                    raise CommandError("command_not_found", 404)
                return {"ok": True, "command": self._projection(con,row, full=True)}
            rows = con.execute("SELECT * FROM agent_commands WHERE session_id=? AND "
                               "(state IN ('queued','delivering','delivered','running','stopping','unconfirmed') OR command_id IN "
                               "(SELECT command_id FROM agent_commands WHERE session_id=? ORDER BY created_at DESC LIMIT 30)) ORDER BY position", (sid,sid)).fetchall()
            from ..db.repositories import AgentSessionRepository
            checkpoint = AgentSessionRepository(con).peek_turn_checkpoint(sid)
            safe_checkpoint = None
            if checkpoint and not checkpoint.get("claim_id"):
                cp = checkpoint.get("checkpoint") or {}
                if isinstance(cp, dict) and cp.get("resumable"):
                    safe_checkpoint = {"turn_id": checkpoint["turn_id"], "resumable": True,
                                       "resume_count": cp.get("resume_count",0)}
            session = AgentSessionRepository(con).get_session(sid)
            branch = json.loads(session.get("meta_json") or "{}").get("branch_of") if session else None
            return {"ok": True, "branch_of":branch, "commands": [self._projection(con,row) for row in rows],
                    "queue": {k: queue[k] for k in ("paused","pause_reason","revision")},
                    "checkpoint": safe_checkpoint, "server_time": time.time()}

    def claim(self, sid: str, owner: str):
        with self.transaction() as con:
            queue = self._queue(con, sid)
            if queue["paused"] or queue["worker_owner"]:
                return None
            if con.execute("SELECT 1 FROM agent_commands WHERE session_id=? AND state='unconfirmed'", (sid,)).fetchone():
                return None
            row = con.execute("SELECT * FROM agent_commands WHERE session_id=? AND kind!='guide' AND state='queued' ORDER BY position LIMIT 1", (sid,)).fetchone()
            if not row:
                return None
            now = time.time()
            con.execute("UPDATE agent_command_queues SET worker_owner=?,lease_until=?,runtime_epoch=? WHERE session_id=?", (owner,now+LEASE_SECONDS,self.epoch,sid))
            context = json.loads(row["context_json"])
            context["execution_started_at"] = now
            con.execute("UPDATE agent_commands SET state='running',context_json=?,revision=revision+1,updated_at=? WHERE command_id=?", (encode(context),now,row["command_id"]))
            request = json.loads(row["request_json"])
            if row["kind"] == "send" and request.get("source") != "approval_continue":
                from ..db.repositories import AgentSessionRepository
                AgentSessionRepository(con).record_message(message_id=row["turn_id"]+":user", session_id=sid,
                    turn_id=row["turn_id"], role="user", content=str(request.get("payload",{}).get("text") or ""),
                    meta={"source_command_id":row["command_id"], "attachments":request.get("payload",{}).get("attachments",[])})
            return dict(con.execute("SELECT * FROM agent_commands WHERE command_id=?", (row["command_id"],)).fetchone())

    def heartbeat(self, sid: str, owner: str):
        with self.transaction() as con:
            return bool(con.execute("UPDATE agent_command_queues SET lease_until=? WHERE session_id=? AND worker_owner=?",
                                    (time.time()+LEASE_SECONDS,sid,owner)).rowcount)

    def finish(self, cid: str, sid: str, owner: str, state: str, result=None, error=None):
        with self.transaction() as con:
            queue = con.execute("SELECT worker_owner FROM agent_command_queues WHERE session_id=?", (sid,)).fetchone()
            if not queue or queue[0] != owner:
                return False  # A lost lease cannot manufacture a new authority state.
            now = time.time()
            con.execute("UPDATE agent_commands SET state=?,result_json=?,error_json=?,revision=revision+1,updated_at=? WHERE command_id=?",
                        (state,encode(result) if result is not None else None,encode(error) if error else None,now,cid))
            # Preserve a terminal message even when a gate failed before Kernel
            # wrote its answer; older failures must not disappear after 30 commands.
            command = con.execute("SELECT turn_id,context_json FROM agent_commands WHERE command_id=?", (cid,)).fetchone()
            from ..db.repositories import AgentSessionRepository
            if not con.execute("SELECT 1 FROM agent_messages WHERE session_id=? AND message_id=?",(sid,command["turn_id"]+":assistant")).fetchone():
                AgentSessionRepository(con).record_message(message_id=command["turn_id"]+":assistant",session_id=sid,
                    role="assistant",content="",turn_id=command["turn_id"],meta={})
            # Enrich the canonical answer without replacing its tool/approval metadata.
            answer = con.execute("SELECT meta_json FROM agent_messages WHERE session_id=? AND message_id=?",
                                 (sid, command["turn_id"]+":assistant")).fetchone()
            if answer:
                meta = json.loads(answer[0] or "{}")
                meta["source_command_id"] = cid
                meta["execution_status"] = state
                meta["command_revision"] = con.execute("SELECT revision FROM agent_commands WHERE command_id=?",(cid,)).fetchone()[0]
                saved_turn = dict(result or meta.get("turn") or {})
                saved_turn.update({"command_id":cid,"context_snapshot":json.loads(command["context_json"]),"execution_status":state})
                if error:
                    meta["error"] = encode(error)
                    saved_turn["error"] = encode(error)
                if not saved_turn.get("stopped_reason"):
                    saved_turn["stopped_reason"] = state
                meta["turn"] = saved_turn
                con.execute("UPDATE agent_messages SET meta_json=? WHERE session_id=? AND message_id=?",
                            (encode(meta),sid,command["turn_id"]+":assistant"))
            con.execute("UPDATE agent_commands SET state='not_consumed',revision=revision+1,updated_at=? "
                        "WHERE session_id=? AND kind='guide' AND state IN ('queued','delivering','delivered')", (now,sid))
            if state != "succeeded":
                con.execute("UPDATE agent_command_queues SET paused=1,pause_reason=?,revision=revision+1 WHERE session_id=?", (state,sid))
            con.execute("UPDATE agent_command_queues SET worker_owner='',lease_until=0,updated_at=? WHERE session_id=? AND worker_owner=?", (now,sid,owner))
            return True

    def record_event(self, cid: str, event: dict):
        with self.transaction() as con:
            con.execute("INSERT OR IGNORE INTO agent_command_events(command_id,event_id,payload_json) VALUES (?,?,?)",
                        (cid,str(event["event_id"]),encode(event)))

    def events(self, sid: str, cid: str, after: int = 0, limit: int = 500):
        sid, cid = _session_id(sid), command_id(cid)
        con = connect(self.paths.db)
        try:
            if is_session_deleted(con,sid):
                raise CommandError("session_deleted",410)
            if not con.execute("SELECT 1 FROM agent_commands WHERE session_id=? AND command_id=?",(sid,cid)).fetchone():
                raise CommandError("command_not_found",404)
            limit = max(1,min(1000,int(limit)))
            rows = con.execute("SELECT id,payload_json FROM agent_command_events WHERE command_id=? AND id>? ORDER BY id LIMIT ?", (cid,max(0,int(after)),limit+1)).fetchall()
            more = len(rows)>limit
            rows = rows[:limit]
            events = [{**json.loads(row["payload_json"]), "seq": row["id"]} for row in rows]
            cursor = rows[-1]["id"] if rows else max(0,int(after))
            return {"ok": True,"events":events,"cursor":cursor,"next_cursor":cursor,
                    "epoch":cid,"has_more":more,"reset_required":False}
        finally:
            con.close()

    def control(self, sid: str, action: str, *, cid=None, revision=None, text=None, before=None):
        sid = _session_id(sid)
        with self.transaction() as con:
            queue = self._queue(con,sid)
            row = None
            if cid:
                row = con.execute("SELECT * FROM agent_commands WHERE command_id=? AND session_id=?", (command_id(cid),sid)).fetchone()
                if not row:
                    raise CommandError("command_not_found",404)
            expected = row["revision"] if row else queue["revision"]
            if revision is None or revision != expected:
                raise CommandError("command_revision_conflict")
            now=time.time()
            if action in ("pause","resume"):
                if action=="resume" and con.execute("SELECT 1 FROM agent_commands WHERE session_id=? AND state='unconfirmed'", (sid,)).fetchone():
                    raise CommandError("execution_unconfirmed")
                con.execute("UPDATE agent_command_queues SET paused=?,pause_reason=?,runtime_epoch=?,revision=revision+1,updated_at=? WHERE session_id=?",
                            (int(action=="pause"),"operator" if action=="pause" else "",self.epoch,now,sid))
            elif action=="stop":
                if not row or row["state"] not in ACTIVE or row["kind"]=="guide":
                    raise CommandError("command_not_running")
                con.execute("UPDATE agent_commands SET state='stopping',revision=revision+1,updated_at=? WHERE command_id=?", (now,cid))
                con.execute("UPDATE agent_command_queues SET paused=1,pause_reason='stopping',revision=revision+1 WHERE session_id=?", (sid,))
            elif action in ("edit","remove","move"):
                if not row or row["state"]!="queued" or row["kind"]=="guide":
                    raise CommandError("command_already_claimed")
                if action=="edit":
                    if not isinstance(text,str) or not text.strip() or len(text)>16000:
                        raise CommandError("invalid_message",400)
                    request=json.loads(row["request_json"])
                    if row["kind"] == "resume":
                        request["continuation_feedback"] = text.strip()
                    else:
                        request.setdefault("payload",{})["text"]=text.strip()
                    context=json.loads(row["context_json"])
                    context["input_text"] = text.strip()
                    con.execute("UPDATE agent_commands SET request_json=?,context_json=?,revision=revision+1,updated_at=? WHERE command_id=?", (encode(request),encode(context),now,cid))
                    # Original fingerprint is immutable: an ACK retry cannot undo an operator edit.
                elif action=="remove":
                    con.execute("UPDATE agent_commands SET state='removed',revision=revision+1,updated_at=? WHERE command_id=?", (now,cid))
                else:
                    ids=[r[0] for r in con.execute("SELECT command_id FROM agent_commands WHERE session_id=? AND kind!='guide' AND state='queued' ORDER BY position", (sid,))]
                    if before is not None and before not in ids:
                        raise CommandError("queue_anchor_missing")
                    if before!=cid:
                        ids.remove(cid)
                        ids.insert(ids.index(before) if before else len(ids),cid)
                        base=con.execute("SELECT COALESCE(MAX(position),0)+1 FROM agent_commands WHERE session_id=? AND state!='queued'", (sid,)).fetchone()[0]
                        for index,item in enumerate(ids):
                            con.execute("UPDATE agent_commands SET position=?,revision=revision+1,updated_at=? WHERE command_id=?", (base+index,now,item))
                con.execute("UPDATE agent_command_queues SET revision=revision+1,updated_at=? WHERE session_id=?", (now,sid))
            else:
                raise CommandError("invalid_command_action",400)
        return self.snapshot(sid)
