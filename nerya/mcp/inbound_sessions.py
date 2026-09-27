"""Persistent logical MCP sessions, independent of HTTP/stdio connections.

Tunnel can multiplex many conversations through one stdio child. Never use
that child's process (or its shared SDK session) as a conversation identity.
External agents open nerya_session and reuse its remote_session_id, as in MCPX.
Unidentified calls are rejected before any write/dispatch; never invent threads.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
import uuid
from collections import OrderedDict
from contextvars import ContextVar
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

from ..db.repositories import AgentSessionRepository
from ..db.sqlite import connect

_LOG = logging.getLogger(__name__)
_CURRENT: ContextVar[CallTrace | None] = ContextVar("nerya_inbound_call", default=None)
_STACK: ContextVar[tuple[str, ...]] = ContextVar("nerya_inbound_stack", default=())
from .inbound_contract import (
    ACTIVITY_SCHEMA, PROGRESS_TOOL, SESSION_INSTRUCTIONS, SESSION_PATTERN,
    SESSION_PROPERTY, SESSION_TOOL, control_descriptors,
)

_SESSION_ID = re.compile(SESSION_PATTERN)
_MAX_VALUE_BYTES = 1_048_576


def active_call() -> CallTrace | None:
    return _CURRENT.get()


def _safe(value: Any) -> Any:
    from .catalog import public_result
    value = public_result(value)
    encoded = json.dumps(value, ensure_ascii=False, default=str)
    size = len(encoded.encode("utf-8"))
    if size > _MAX_VALUE_BYTES:
        return {"truncated": True, "total_bytes": size,
                "preview": encoded.encode("utf-8")[:_MAX_VALUE_BYTES].decode("utf-8", "ignore")}
    return json.loads(encoded)


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat()


def _status(result: dict[str, Any]) -> str:
    from .catalog import is_error
    error = result.get("error")
    code = str(error.get("code", "")) if isinstance(error, dict) else ""
    if code == "interrupted":
        return "interrupted"
    if code in {"permission_pending", "approval_required"}:
        return "awaiting_approval"
    return "failed" if is_error(result) else "succeeded"


@dataclass
class CallTrace:
    store: InboundSessions
    session_id: str
    call_id: str
    tool: str
    arguments: Any
    request_id: Any = None
    client_name: str = ""
    turn_id: str = ""
    turn_title: str = ""
    sequence: int = 0
    activity: dict[str, str] = field(default_factory=dict)
    purpose: str = ""
    description: str = ""
    started_at: float = field(default_factory=time.time)
    status: str = "running"
    result: Any = None
    elapsed_ms: int | None = None
    nodes: list[dict[str, Any]] = field(default_factory=list)
    presentation_blocks: list[dict[str, Any]] = field(default_factory=list)
    lock: Any = field(default_factory=threading.RLock, repr=False)

    @property
    def source(self) -> str:
        return self.store.source

    def payload(self) -> dict[str, Any]:
        return {"source": self.source, "remote_session_id": self.session_id,
                "call_id": self.call_id, "request_id": self.request_id,
                "client_name": self.client_name, "tool": self.tool,
                "arguments": self.arguments, "result": self.result,
                "status": self.status, "started_at": _iso(self.started_at),
                "elapsed_ms": self.elapsed_ms, "nodes": self.nodes,
                "presentation_blocks": self.presentation_blocks,
                "turn_id": self.turn_id, "turn_title": self.turn_title,
                "sequence": self.sequence, "activity": self.activity,
                "purpose": self.purpose, "description": self.description}

    def native_start(self, call: Any) -> None:
        with self.lock:
            if any(row["call_id"] == call.id for row in self.nodes):
                return
            stack = _STACK.get()
            self.nodes.append({"call_id": call.id,
                "parent_call_id": stack[-1] if stack else self.call_id,
                "tool": call.name, "arguments": _safe(call.arguments),
                "status": "running", "started_at": _iso(time.time())})
            _STACK.set((*stack, call.id))
            self.store.persist(self)

    def native_finish(self, call: Any, result: dict[str, Any]) -> None:
        with self.lock:
            for row in self.nodes:
                if row["call_id"] == call.id:
                    from .presentation import result_charts
                    row.update(result=_safe(result), status=_status(result),
                               elapsed_ms=result.get("elapsed_ms"),
                               presentation_blocks=result_charts(result, self.store.config))
                    break
            _STACK.set(tuple(item for item in _STACK.get() if item != call.id))
            self.store.persist(self)


# Native executor hooks observe internal tool steps without changing Agent Loop.
def native_start(call: Any, descriptor: Any = None, decision: Any = None) -> None:
    trace = active_call()
    if trace:
        trace.native_start(call)


def native_finish(call: Any, result: Any) -> None:
    trace = active_call()
    if trace:
        from .registry_bridge import _result_as_mcp_dict
        body = _result_as_mcp_dict(result)
        trace.native_finish(call, body)


class InboundTraceExecutor:
    """Observe internal dispatch including validation/permission early returns.

    Existing pre/post hooks run only around a handler, so they cannot account
    for denied or invalid child calls. This proxy is bound only to MCP kernels;
    all execution and policy decisions still belong to the native executor.
    """
    def __init__(self, executor: Any):
        self._executor = executor

    def __getattr__(self, name: str) -> Any:
        return getattr(self._executor, name)

    def execute(self, call: Any) -> Any:
        trace = active_call()
        if trace is None:
            return self._executor.execute(call)
        stack_token = _STACK.set(_STACK.get())
        try:
            trace.native_start(call)
            try:
                result = self._executor.execute(call)
            except BaseException as exc:
                try:
                    trace.native_finish(call, {"ok": False, "error": {
                        "code": "internal" if isinstance(exc, Exception) else "interrupted",
                        "message": "Internal tool execution did not complete"}})
                except Exception:
                    _LOG.warning("Cannot finalize internal MCP tool trace")
                raise
            try:
                native_finish(call, result)
            except Exception:
                _LOG.warning("Cannot finalize completed internal MCP tool trace")
            return result
        finally:
            _STACK.reset(stack_token)


class InboundSessions:
    def __init__(self, config: Any, catalog: Any, *, source: str = "mcp",
                 catalog_factory: Callable[[], Any] | None = None):
        if source not in {"mcp", "tunnel"}:
            raise ValueError("invalid inbound source")
        self.config, self.catalog, self.source = config, catalog, source
        self.catalog_factory = catalog_factory
        self._catalogs: OrderedDict[str, Any] = OrderedDict()
        self._lock = threading.RLock()

    def descriptors(self) -> list[dict[str, Any]]:
        rows = deepcopy(self.catalog.list_tools())
        for row in rows:
            schema = row["inputSchema"]
            props = schema.setdefault("properties", {})
            props["remote_session_id"] = deepcopy(SESSION_PROPERTY)
            props["activity"] = deepcopy(ACTIVITY_SCHEMA)
            from .operator_messages import ACK_SCHEMA
            props["acknowledge_requests"] = deepcopy(ACK_SCHEMA)
            props.setdefault("purpose", {"type": "string", "maxLength": 4000,
                "description": "Public purpose/method of this call, shown in the conversation."})
            required = schema.setdefault("required", [])
            if "remote_session_id" not in required:
                required.append("remote_session_id")
            row["description"] = ("Reuse remote_session_id from nerya_session; include activity.next "
                                  "to explain this action. " + row["description"])
        return control_descriptors() + rows

    def _resolve(self, requested: Any) -> tuple[str, dict | None]:
        from .catalog import failed
        if requested is None:
            return "", failed("session_required", "No tool was executed and no session was created. "
                "Call nerya_session(action='open', client_request_id='<stable unique conversation key>', "
                "title='<goal>') ONCE, then reuse its remote_session_id on every call.")
        if isinstance(requested, str) and _SESSION_ID.fullmatch(requested):
            con = connect(self.config.paths.db)
            try:
                row = AgentSessionRepository(con).get_session(requested)
                if row and row.get("source") == self.source:
                    return requested, None
            finally:
                con.close()
        return "", failed("invalid_session", "Session not found for this source. "
            "No tool was executed and no session was created. Recover with nerya_session(action='list').")

    def _session(self, args: dict[str, Any], client_name: str) -> dict[str, Any]:
        import hashlib
        from jsonschema import Draft202012Validator
        from .catalog import failed
        if not Draft202012Validator(control_descriptors()[0]["inputSchema"]).is_valid(args):
            return failed("invalid_arguments", "Invalid session arguments; use the advertised open/resume/list schema")
        action = args.get("action", "open")
        requested = args.get("remote_session_id")
        if action != "list" and requested is not None:
            sid, error = self._resolve(requested)
            return error if error else self._session_result(sid, created=False)
        key = args.get("client_request_id", "").strip()
        if action != "list" and (action == "resume" or len(key) < 8):
            return failed("session_identity_required", "Opening requires one stable client_request_id "
                "for the conversation, reused on retries. Resume with remote_session_id or recover "
                "with action='list'. No session was created.")
        con = connect(self.config.paths.db)
        try:
            if action == "list":
                query = args.get("query", "").strip()
                rows = con.execute("SELECT session_id, title, created_at, updated_at FROM agent_sessions "
                    "WHERE source=? AND (?='' OR instr(title,?)>0 OR instr(session_id,?)>0) "
                    "ORDER BY updated_at DESC LIMIT ?", (self.source, query, query, query, args.get("limit", 30))).fetchall()
                return {"ok": True, "sessions": _safe([dict(row) for row in rows])}
            # Durable idempotency across concurrent processes and server restarts.
            # A client name, title or shared stdio process is NEVER conversation identity.
            digest = hashlib.sha256(("nerya-session-v2\0" + self.source + "\0" + key).encode()).hexdigest()
            sid = f"ext_{self.source}_{digest[:32]}"
            con.execute("BEGIN IMMEDIATE")
            repo = AgentSessionRepository(con)
            exists = repo.get_session(sid)
            if exists and exists.get("source") != self.source:
                con.execute("ROLLBACK")
                return failed("invalid_session", "Session identity conflict; no session was changed")
            if not exists:
                title = str(_safe(args.get("title", "").strip()))[:120]
                title = title or f"{'Tunnel' if self.source == 'tunnel' else 'MCP'} · {client_name or sid[-8:]}"
                repo.upsert_session(session_id=sid, source=self.source, title=title,
                    meta={"title": title, "external": {"source": self.source,
                        "client_name": client_name, "contract_version": 2,
                        "open_request_hash": digest}})
            con.execute("COMMIT")
            return self._session_result(sid, created=not bool(exists))
        except BaseException:
            if con.in_transaction:
                con.execute("ROLLBACK")
            raise
        finally:
            con.close()

    def _session_result(self, sid: str, *, created: bool) -> dict[str, Any]:
        return {"ok": True, "remote_session_id": sid, "source": self.source,
                "created": created, "instructions": SESSION_INSTRUCTIONS}

    def _allocate_turn(self, sid: str, activity: dict[str, str]) -> tuple[str, str, int]:
        con = connect(self.config.paths.db)
        try:
            con.execute("BEGIN IMMEDIATE")
            repo = AgentSessionRepository(con)
            row = repo.get_session(sid)
            if row is None:
                raise ValueError("Session disappeared")
            meta = json.loads(row["meta_json"] or "{}")
            external = meta.get("external", {})
            intent = activity.get("intent", "")
            if not external.get("turn_id") or (intent and intent != external.get("turn_title")):
                external["turn_id"] = "turn_" + uuid.uuid4().hex
                external["turn_title"] = intent or row.get("title", "")
            sequence = int(external.get("sequence", 0)) + 1
            external["sequence"] = sequence
            external["last_activity"] = activity
            meta["external"] = external
            repo.update_session_meta(sid, meta)
            con.execute("COMMIT")
            return external["turn_id"], external.get("turn_title", ""), sequence
        except BaseException:
            if con.in_transaction:
                con.execute("ROLLBACK")
            raise
        finally:
            con.close()

    def persist(self, trace: CallTrace) -> None:
        con = connect(self.config.paths.db)
        try:
            con.execute("BEGIN IMMEDIATE")
            repo = AgentSessionRepository(con)
            repo.upsert_session(session_id=trace.session_id, source=self.source,
                meta={"external": {"source": self.source, "last_call_id": trace.call_id,
                                   "last_status": trace.status}})
            payload = trace.payload()
            content = trace.activity.get("next") or trace.activity.get("status") or trace.purpose or trace.tool
            repo.record_message(message_id=trace.call_id + ":assistant",
                session_id=trace.session_id, role="assistant", content=content,
                turn_id=trace.turn_id, ts=trace.started_at,
                meta={"source": self.source, "turn": {"harness": "external",
                      "turn_id": trace.turn_id, "external_call": payload}})
            repo.record_tool_event(event_id=trace.call_id + ":" + trace.status,
                session_id=trace.session_id, turn_id=trace.turn_id, call_id=trace.call_id,
                tool=trace.tool, phase="start" if trace.status == "running" else "result",
                ok=None if trace.status == "running" else trace.status == "succeeded",
                payload=payload)
            con.execute("COMMIT")
        except BaseException:
            if con.in_transaction:
                con.execute("ROLLBACK")
            raise
        finally:
            con.close()

    def call(self, name: str, arguments: Any = None, *, request_id: Any = None,
             client_name: str = "") -> dict[str, Any]:
        from jsonschema import Draft202012Validator
        from .catalog import failed
        from .operator_messages import ACK_SCHEMA, acknowledge, pending_messages
        args = dict(arguments) if isinstance(arguments, dict) else arguments
        ack = args.pop("acknowledge_requests", []) if isinstance(args, dict) else []
        if not Draft202012Validator(ACK_SCHEMA).is_valid(ack):
            return failed("invalid_arguments", "Invalid acknowledge_requests; no tool was executed")
        sid = args.get("remote_session_id") if isinstance(args, dict) else None
        if ack:
            valid_sid, error = self._resolve(sid)
            if error:
                return error
            try:
                acknowledge(self.config, valid_sid, self.source, ack)
            except ValueError as exc:
                return failed("invalid_acknowledgement", str(exc))
            except Exception:
                return failed("message_unavailable", "Cannot acknowledge messages; no tool was executed")
        result = self._call(name, args, request_id=request_id, client_name=client_name)
        receipt = result.get("nerya_trace", {})
        # Only the control tool / server-owned trace can identify the session.
        # A business result may itself contain a remote_session_id field.
        sid = receipt.get("remote_session_id") or (result.get("remote_session_id") if name == SESSION_TOOL else sid)
        if sid:
            try:
                if self._resolve(sid)[1]:
                    return result
                # Fetch AFTER execution so a user message added while a tool runs
                # is delivered with that tool's result, including failed tools.
                result["operator_control"] = pending_messages(self.config, sid, self.source, receipt.get("call_id", ""))
            except Exception:
                _LOG.exception("Cannot attach operator messages; do not replay the tool")
                result["operator_control"] = {"requests": [], "delivery_error": True,
                    "guidance": "Message delivery failed. Resume nerya_session to retry; do NOT replay the completed tool."}
        return result

    def _call(self, name: str, arguments: Any = None, *, request_id: Any = None,
              client_name: str = "") -> dict[str, Any]:
        from jsonschema import Draft202012Validator
        from .catalog import failed, public_result
        args = {} if arguments is None else dict(arguments) if isinstance(arguments, dict) else arguments
        if not isinstance(args, dict):
            return failed("invalid_arguments", "Arguments must be a JSON object; no session was created")
        client_name = str(_safe(client_name))[:120]
        with self._lock:
            try:
                if name == SESSION_TOOL:
                    return self._session(args, client_name)
                sid, invalid = self._resolve(args.pop("remote_session_id", None))
                if invalid:
                    return invalid
                activity = args.pop("activity", {})
                if not Draft202012Validator(ACTIVITY_SCHEMA).is_valid(activity):
                    return failed("invalid_arguments", "Invalid public activity; no tool was executed")
                activity = {k: str(_safe(v.strip())) for k, v in activity.items() if v.strip()}
                descriptor = self.catalog.describe(name)
                props = descriptor.get("inputSchema", {}).get("properties", {})
                purpose = args.get("purpose", "") if "purpose" in props else args.pop("purpose", "")
                if not isinstance(purpose, str) or len(purpose) > 4000:
                    return failed("invalid_arguments", "purpose must be a string of at most 4000 characters")
                if name == PROGRESS_TOOL:
                    payload = {**args, "remote_session_id": sid, "activity": activity}
                    if not Draft202012Validator(control_descriptors()[1]["inputSchema"]).is_valid(payload):
                        return failed("invalid_arguments", "Invalid progress fields; no update was recorded")
                    if not any(args.get(k) for k in ("current", "result", "next", "phase")) and not activity:
                        return failed("invalid_arguments", "Progress requires a public current/result/next/activity update")
                turn_id, turn_title, sequence = self._allocate_turn(sid, activity)
                trace = CallTrace(self, sid, "call_" + uuid.uuid4().hex, name,
                    _safe(args), request_id=_safe(request_id), client_name=client_name,
                    activity=activity, purpose=str(_safe(purpose)),
                    description=str(_safe(descriptor.get("description", "")))[:600],
                    turn_id=turn_id, turn_title=turn_title, sequence=sequence)
                self.persist(trace)
            except Exception:
                _LOG.exception("Cannot start inbound MCP trace")
                return failed("trace_unavailable", "Cannot persist call trace; no tool was executed")
            token = _CURRENT.set(trace)
            stack_token = _STACK.set(())
            started = time.monotonic()
            result = failed("interrupted", "Tool execution was interrupted; inspect state before retrying")
            persisted = True
            try:
                if name == PROGRESS_TOOL:
                    result = {"ok": True, "progress": _safe(args), "activity": activity}
                else:
                    if sid not in self._catalogs:
                        self._catalogs[sid] = self.catalog_factory() if self.catalog_factory else self.catalog
                        if len(self._catalogs) > 64:
                            self._catalogs.popitem(last=False)
                    self._catalogs.move_to_end(sid)
                    result = self._catalogs[sid].call(name, args)
                result = public_result(result)
            except Exception:
                _LOG.exception("Inbound MCP dispatch failed")
                result = failed("internal", "Tool execution failed; inspect local diagnostics before retrying")
            finally:
                trace.result = _safe(result)
                trace.status = _status(result)
                from .presentation import result_charts
                trace.presentation_blocks = result_charts(trace.result, self.config)
                trace.elapsed_ms = int((time.monotonic() - started) * 1000)
                try:
                    self.persist(trace)
                except Exception:
                    persisted = False
                    _LOG.exception("Cannot finalize inbound MCP trace; do not replay the tool")
                _STACK.reset(stack_token)
                _CURRENT.reset(token)
            return {**result, "nerya_trace": {"remote_session_id": sid, "call_id": trace.call_id,
                    "source": self.source, "status": trace.status, "persisted": persisted,
                    "turn_id": trace.turn_id, "sequence": trace.sequence, "activity": trace.activity}}
