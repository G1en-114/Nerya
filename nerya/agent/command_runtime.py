"""Conversation execution outlives the HTTP request, not the runtime lease.

All work goes through the existing run_turn handler. Queue restoration is
explicit; ambiguous execution is reconciled, never automatically replayed.
"""
from __future__ import annotations

import copy
import json
import logging
import threading
import time
import uuid
from typing import Callable

from ..core.config import Config
from ..db.sqlite import connect
from ..harness.cancellation import signal_cancel, signal_steer
from .command_store import CommandError, CommandStore, encode
from .streaming import get_default_bus

_LOG = logging.getLogger(__name__)
EPOCH = uuid.uuid4().hex
_FIELDS = ("source", "kind", "payload", "strategy_id", "strategy_proposal_id", "reasoning_effort",
           "reasoning_summary", "permission_mode", "model_tier", "model_provider", "model_id",
           "model_context_window", "max_iterations", "max_total_tool_calls", "max_wall_seconds",
           "evidence_contract", "resume_turn_id", "continuation_feedback", "work_mode", "interaction_id", "plan_id")


def outcome_state(result: dict) -> str:
    if result.get("ok") is False or result.get("status") == "error":
        return "failed"
    stop = str(result.get("stopped_reason") or "").lower()
    if stop == "user_input_pending":
        return "awaiting_input"
    if "approval" in stop or result.get("awaiting_approval"):
        return "awaiting_approval"
    if any(word in stop for word in ("cancel", "interrupt", "operator_stop")):
        return "interrupted"
    if result.get("aborted") or stop not in ("", "end_turn", "completed", "stop"):
        return "blocked"
    return "succeeded"


class CommandRuntime:
    def __init__(self, config: Config, execute: Callable[[Config, dict], dict], *, epoch=EPOCH):
        self.config, self.execute = config, execute
        self.store = CommandStore(config.paths, epoch)
        self._lock = threading.Lock()
        self._workers: dict[str, threading.Thread] = {}

    def submit(self, payload: dict, *, start=True):
        raw = payload.get("request")
        if not isinstance(raw, dict):
            raise CommandError("invalid_command_request", 400)
        kind = payload.get("command_type", "send")
        if kind not in ("send", "resume", "guide"):
            raise CommandError("invalid_command_type", 400)
        request = {key: copy.deepcopy(raw[key]) for key in _FIELDS if key in raw}
        # Dispatcher-authenticated identity only; nested/body assertions are ignored.
        for key in ("_auth_actor_id", "_auth_scope", "_auth_scopes"):
            request[key] = copy.deepcopy(payload.get(key, "" if key != "_auth_scopes" else []))
        request["session_id"] = payload.get("session_id")
        request["target"] = "main"
        if request.get("work_mode", "execute") not in ("execute", "plan"):
            raise CommandError("invalid_work_mode", 400)
        message = request.setdefault("payload", {})
        if not isinstance(message, dict):
            raise CommandError("invalid_command_request", 400)
        text = message.get("text", "")
        attachments = message.get("attachments", [])
        if not isinstance(text, str) or len(text) > (4000 if kind == "guide" else 16000):
            raise CommandError("invalid_message", 400)
        if not isinstance(attachments, list) or len(attachments)>8:
            raise CommandError("invalid_attachments", 400)
        if kind == "guide" and (not text.strip() or attachments):
            raise CommandError("guide_text_only", 400)
        if kind != "resume" and not text.strip() and not attachments:
            raise CommandError("message_required", 400)
        if kind == "resume":
            from .loop_state import validate_turn_checkpoint_resume_request
            validate_turn_checkpoint_resume_request(resume_turn_id=request.get("resume_turn_id"),
                continuation_feedback=request.get("continuation_feedback"), session_id=request["session_id"],
                turn_id=None, has_attachments=bool(attachments))
        elif request.get("resume_turn_id"):
            raise CommandError("invalid_command_type", 400)
        # The user's original request is the idempotency key payload; resolved
        # defaults may change before an ACK retry and must not change its identity.
        identity_request = copy.deepcopy(request)
        existing = self.store.existing_receipt(payload.get("command_id"),payload.get("session_id"),
            str(payload.get("_auth_actor_id") or "local"),kind,identity_request)
        if existing is not None:
            return existing
        from ..llm.gateway import LLMGateway
        accepted_model = None
        try:
            provider, model, metadata = LLMGateway(self.config).effective_model_metadata(
                request.get("model_tier") or self.config.get("agent.native.tier"), provider_override=request.get("model_provider"),
                model_override=request.get("model_id"))
            if provider and model:
                request["model_provider"], request["model_id"] = provider, model
                accepted_model = {"provider": provider, "model": model,
                    "context_limit": getattr(metadata, "context_window", None),
                    "limit_source": "registry" if getattr(metadata, "context_window", None) else "unconfirmed"}
        except Exception:
            # Original runtime resolves configuration errors; admission does not
            # substitute a model or silently enable mock execution.
            pass
        context = {"version":1, "captured_at":time.time(), "work_mode":request.get("work_mode", "execute"), "plan_id":request.get("plan_id"),
                   "input_text":str(request.get("continuation_feedback") or text),
                   "strategy_id":request.get("strategy_id"),
                   "proposal_id":request.get("strategy_proposal_id"),
                   "requested_model":{key:identity_request.get(key) for key in ("model_provider","model_id","model_tier","model_context_window","reasoning_effort")},
                   "accepted_model":accepted_model,
                   "references":[file.get("reference") for file in attachments if isinstance(file,dict) and file.get("reference")],
                   "attachments":[{key:file.get(key) for key in ("id","name","artifact_uri","reference")} for file in attachments if isinstance(file,dict)]}
        if request.get("strategy_id"):
            from ..strategies.workflow_service import source_files
            from ..strategies.workflow_graph import package_revision
            files, source = source_files(self.config.paths, str(request["strategy_id"]), request.get("strategy_proposal_id"))
            context["strategy_source"] = {**source, "revision":package_revision(files)}
        receipt = self.store.accept(cid=payload.get("command_id"),sid=payload.get("session_id"),
            actor=str(payload.get("_auth_actor_id") or "local"),kind=kind,request=request,context=context,
            turn_id=str(request.get("resume_turn_id") or "turn_"+uuid.uuid4().hex),
            continuation=kind=="resume" or bool(request.get("interaction_id")) or request.get("source")=="approval_continue", identity_request=identity_request)
        if start and not receipt["duplicate"]:
            self.kick(receipt["command"]["session_id"])
        return receipt

    def kick(self, sid: str):
        with self._lock:
            if sid in self._workers:
                return
            thread=threading.Thread(target=self._drain,args=(sid,),name="nerya-command-"+sid[-12:],daemon=True)
            self._workers[sid]=thread
            thread.start()

    def _drain(self, sid: str):
        try:
            while True:
                # Serialize idle handoff with kick so an accepted item cannot be
                # stranded between the worker's final query and its exit.
                with self._lock:
                    owner=uuid.uuid4().hex
                    row=self.store.claim(sid,owner)
                    if row is None:
                        self._workers.pop(sid,None)
                        return
                self._run(row,owner)
        except Exception:
            _LOG.exception("conversation command worker failed; lease recovery will not replay work")
            with self._lock:
                self._workers.pop(sid,None)

    def _run(self, row: dict, owner: str):
        sid,cid,tid=row["session_id"],row["command_id"],row["turn_id"]
        request=json.loads(row["request_json"])
        request["turn_id"]=tid
        config=Config(paths=self.config.paths,data=copy.deepcopy(self.config.data))
        done=threading.Event()
        event_failure=threading.Event()
        bus=get_default_bus()
        head=bus.latest_seq()
        def capture(event):
            if event.get("session_id")!=sid or event.get("turn_id")!=tid or int(event.get("seq") or 0)<=head:
                return
            try:
                self.store.record_event(cid,event)
            except Exception:
                event_failure.set()
                signal_cancel(tid,reason="event_persistence_failed")
                _LOG.exception("command event persistence failed")
        unsubscribe=bus.subscribe(capture)
        def watch():
            renewed=0.0
            while not done.wait(0.4):
                try:
                    if time.monotonic()-renewed>3:
                        if not self.store.heartbeat(sid,owner):
                            signal_cancel(tid,reason="command_lease_lost")
                            return
                        renewed=time.monotonic()
                    current=self.store.snapshot(sid,cid)["command"]
                    if current["state"]=="stopping":
                        signal_cancel(tid,reason="operator_cancel")
                    self._guides(sid,tid)
                except Exception:
                    signal_cancel(tid,reason="command_control_unavailable")
                    _LOG.exception("command control failed")
        watcher=threading.Thread(target=watch,name="nerya-command-control",daemon=True)
        watcher.start()
        result,error,state=None,None,"failed"
        started = time.monotonic()
        try:
            context = json.loads(row["context_json"])
            if context.get("strategy_source"):
                from ..strategies.workflow_service import source_files
                from ..strategies.workflow_graph import package_revision
                files, source = source_files(config.paths, str(request["strategy_id"]), request.get("strategy_proposal_id"))
                expected = context["strategy_source"]
                if package_revision(files) != expected["revision"] or source.get("state") != expected.get("state"):
                    raise CommandError("strategy_version_changed")
            if self.store.snapshot(sid,cid)["command"]["state"]=="stopping":
                result={"turn_id":tid,"session_id":sid,"stopped_reason":"cancelled","final_text":""}
            else:
                result=self.execute(config,request)
            if not isinstance(result,dict):
                raise TypeError("invalid turn result")
            state=outcome_state(result)
            # The accepted snapshot remains requested input; resolved provider
            # usage in the result is authoritative about what actually ran.
            result["command_id"]=cid
            result["execution_elapsed_ms"] = round((time.monotonic()-started)*1000)
            result["context_snapshot"]=json.loads(row["context_json"])
            from ..api.local_server import _json_safe
            result = _json_safe(result)
            if result.get("ok") is False:
                error={"code":str(result.get("error") or "turn_rejected"),"retrying":False}
            if event_failure.is_set():
                state="blocked"
                error={"code":"event_persistence_failed","retrying":False}
        except Exception as exc:
            status=getattr(exc,"status_code",None)
            error={"code":getattr(exc,"code",None) or ("rate_limited" if status==429 else "turn_failed"),
                   "status_code":status,"type":type(exc).__name__,"retrying":False,
                   "request_id":str(getattr(exc,"request_id","") or "")[:160]}
            _LOG.warning("conversation command %s failed: type=%s code=%s", cid, type(exc).__name__, error["code"])
        finally:
            done.set()
            watcher.join(timeout=5)
            unsubscribe()
        self.store.finish(cid,sid,owner,state,result,error)

    def _guides(self,sid: str,tid: str):
        with self.store.transaction() as con:
            rows=con.execute("SELECT command_id,request_json FROM agent_commands WHERE session_id=? AND turn_id=? AND kind='guide' AND state='queued' ORDER BY position",(sid,tid)).fetchall()
            for row in rows:
                con.execute("UPDATE agent_commands SET state='delivering',revision=revision+1,updated_at=? WHERE command_id=?",(time.time(),row["command_id"]))
        for row in rows:
            cid=row["command_id"]
            text=json.loads(row["request_json"])["payload"]["text"]
            def consumed(command=cid):
                with self.store.transaction() as con:
                    con.execute("UPDATE agent_commands SET state='injected',revision=revision+1,updated_at=? WHERE command_id=? AND state IN ('delivering','delivered')",(time.time(),command))
            accepted=signal_steer(tid,text,on_consumed=consumed)
            with self.store.transaction() as con:
                con.execute("UPDATE agent_commands SET state=?,revision=revision+1,updated_at=? WHERE command_id=? AND state='delivering'",
                            ("delivered" if accepted else "queued",time.time(),cid))

    def control(self,payload: dict):
        sid=payload.get("session_id")
        if payload.get("action")=="reconcile":
            return self.reconcile(sid,payload.get("command_id"))
        response=self.store.control(sid,payload.get("action"),cid=payload.get("command_id"),
            revision=payload.get("expected_revision"),text=payload.get("text"),before=payload.get("before_command_id"))
        if payload.get("action")=="stop":
            command=next(c for c in response["commands"] if c["command_id"]==payload["command_id"])
            response["signal_delivered"]=signal_cancel(command["turn_id"],reason="operator_cancel")
            # Never equate this signal receipt with actual execution termination.
        elif payload.get("action")=="resume":
            self.kick(sid)
        return response

    def reconcile(self,sid: str,cid: str):
        command=self.store.snapshot(sid,cid)["command"]
        if command["state"]!="unconfirmed":
            return {"ok":True,"command":command}
        with self.store.transaction() as con:
            row=con.execute("SELECT meta_json FROM agent_messages WHERE session_id=? AND turn_id=? AND role='assistant' AND deleted=0 ORDER BY ts DESC LIMIT 1",(sid,command["turn_id"])).fetchone()
            meta=json.loads(row[0]) if row else {}
            result=meta.get("turn")
            # A resumed turn reuses turn_id; its older final answer is not proof
            # that this command finished. Require exact persisted command identity.
            if isinstance(result,dict) and result.get("stopped_reason") and meta.get("source_command_id")==cid:
                con.execute("UPDATE agent_commands SET state=?,result_json=?,revision=revision+1,updated_at=? WHERE command_id=? AND state='unconfirmed'",
                            (outcome_state(result),encode(result),time.time(),cid))
        return self.store.snapshot(sid,cid)


_RUNTIMES: dict[str,CommandRuntime]={}
_LOCK=threading.Lock()

def runtime(config: Config,execute: Callable[[Config,dict],dict]) -> CommandRuntime:
    key=str(config.paths.db.resolve())
    with _LOCK:
        instance=_RUNTIMES.get(key)
        if instance is None:
            instance=CommandRuntime(config,execute)
            _RUNTIMES[key]=instance
        else:
            instance.config=config
        return instance
