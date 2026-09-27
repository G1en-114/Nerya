"""Lazy MCP uses the real executor; all targets are in-memory inert fixtures."""
from __future__ import annotations

import asyncio
import json
import threading
import time
from dataclasses import replace
from types import SimpleNamespace

import pytest

from nerya.harness.cancellation import CancelToken
from nerya.mcp.lazy import META_CALL_TOOL, LazyMcpState, install_meta_tools
from nerya.tools.executor import NativeToolExecutor
from nerya.tools.orchestrator import ToolOrchestrator
from nerya.tools.registry import ToolRegistry
from nerya.tools.permissions import (
    PermissionContext, PermissionDecisionKind, PermissionEngine, PermissionMode, PermissionRule,
)
from nerya.tools.tool_approvals import ToolApprovalCoordinator, ToolApprovalScope, tool_permission_fingerprint
from nerya.tools.types import (
    ContextModifier, PermissionScope, RiskLevel, ToolCall, ToolDescriptor, ToolError, ToolErrorKind, ToolResult,
)

pytestmark = pytest.mark.smoke
NAME = "mcp__fixture__effect"


def _ok(call):
    return ToolResult.from_text(tool_use_id=call.id, name=call.name, text="in-memory only")


def _setup(handler=_ok, *, risk=RiskLevel.DANGEROUS, read_only=False, context=None, **changes):
    registry = ToolRegistry()
    registry.register(ToolDescriptor(
        name=NAME, description="inert fixture", handler=handler,
        input_schema={"type": "object", "properties": {}},
        namespace="mcp", tags=("mcp", "fixture"), lazy=True,
        permission_scope=PermissionScope.NETWORK, risk=risk, read_only=read_only,
        **changes,
    ))
    state = LazyMcpState()
    state.register_namespace("fixture", [NAME], always_eager=False)
    install_meta_tools(registry=registry, state=state)
    executor = NativeToolExecutor(
        registry=registry, permission_engine=PermissionEngine(),
        permission_context=context or PermissionContext(),
    )
    return registry, executor


def _call(**changes):
    return ToolCall(name=META_CALL_TOOL, arguments={"namespace": "fixture", "tool": "effect"}, **changes)


@pytest.mark.parametrize("case,expected", [
    ("default", ToolErrorKind.PERMISSION_PENDING),
    ("plan", ToolErrorKind.PERMISSION_DENIED),
    ("deny", ToolErrorKind.PERMISSION_DENIED),
    ("scope", ToolErrorKind.PERMISSION_DENIED),
])
@pytest.mark.parametrize("risk", [RiskLevel.WRITE, RiskLevel.EXEC, RiskLevel.DANGEROUS])
def test_direct_and_lazy_enforce_target_permissions(case, expected, risk):
    hits, denied = [], []
    context = PermissionContext(
        plan_only=case == "plan",
        deny_rules=[PermissionRule(tool=NAME, decision=PermissionDecisionKind.DENY)] if case == "deny" else [],
        tool_policy={"deny": [NAME]} if case == "scope" else {},
    )
    registry, executor = _setup(lambda c: hits.append(c) or _ok(c), risk=risk, context=context)
    executor.add_permission_denied_hook(lambda c, d, decision: denied.append((c.name, d.name, decision.risk)))
    direct = executor.execute(ToolCall(name=NAME))
    routed = ToolOrchestrator(registry=registry, executor=executor).run_batch([_call(id="outer")]).results[0]
    assert direct.error.kind is routed.error.kind is expected
    assert direct.error.detail == routed.error.detail
    assert hits == []
    assert routed.name == META_CALL_TOOL and routed.tool_use_id == "outer"
    assert routed.metadata["mcp_underlying_tool"] == NAME
    if expected is ToolErrorKind.PERMISSION_DENIED:
        assert denied == [(NAME, NAME, risk), (NAME, NAME, risk)]


def test_approval_is_for_exact_target_arguments_and_consumed_once():
    hits, requests, consumed = [], [], []
    registry, executor = _setup(lambda c: hits.append(c) or _ok(c))
    coordinator = ToolApprovalCoordinator(
        None, scope=ToolApprovalScope(session_id="s", actor_id="a"), turn_id="turn",
    )
    approved = set()

    def consume(request, *, approval_id):
        requests.append(request)
        if (approval_id, request.fingerprint) in approved:
            approved.remove((approval_id, request.fingerprint))
            consumed.append(request)
            return True
        return None

    coordinator.store = SimpleNamespace(
        consume=consume,
        ensure_pending=lambda r: {"approval_id": "approval", "action": r.tool_name, "arguments": r.arguments},
    )
    executor.approval_resolver = coordinator
    call = _call(id="outer", turn_id="turn", caller="agent:child", parent_call_id="parent")
    call.arguments["args"] = {"value": 4}
    pending = executor.execute(call)
    assert pending.error.kind is ToolErrorKind.PERMISSION_PENDING
    assert pending.metadata["approval_request"]["action"] == NAME
    assert requests[0].caller == "agent:child"
    approved.add(("approval", tool_permission_fingerprint(NAME, {"value": 4})))
    coordinator.resume_approval_id = "approval"
    changed = replace(call, arguments={**call.arguments, "args": {"value": 5}})
    assert executor.execute(changed).error.kind is ToolErrorKind.PERMISSION_PENDING
    assert not executor.execute(call).is_error
    assert executor.execute(call).error.kind is ToolErrorKind.PERMISSION_PENDING
    assert len(hits) == len(consumed) == 1
    assert hits[0].name == NAME and hits[0].parent_call_id == "parent"
    assert hits[0].metadata["mcp_parent_call_id"] == "outer"


@pytest.mark.parametrize("async_handler", [False, True])
def test_schema_repairs_target_hooks_trace_and_outer_result_pairing(async_handler):
    hits, hooks, modifiers = [], [], []
    token = CancelToken()

    def handler(call):
        hits.append(call)
        result = _ok(call)
        result.metadata["mcp_server"] = "fixture"
        result.context_modifiers.append(ContextModifier(kind="custom", payload={"target": call.name}))
        return result

    async def async_target(call):
        await asyncio.sleep(0)
        return handler(call)

    registry, executor = _setup(async_target if async_handler else handler, risk=RiskLevel.READ, read_only=True)
    schema = {"type": "object", "properties": {
        "count": {"type": "integer"}, "options": {"type": "object"}, "items": {"type": "array"},
    }, "required": ["count", "options", "items"]}
    registry.register(replace(registry.get(NAME), input_schema=schema), replace=True)
    executor.add_pre_hook(lambda c, d, p: hooks.append(("pre", c.name, d.name, p.risk)))

    def post(call, result):
        hooks.append(("post", call.name, result.name))
        result.metadata["hook_trace"] = call.metadata["trace_id"]

    executor.add_post_hook(post)
    call = _call(id="outer", turn_id="turn", iteration=3, caller="agent:child", parent_call_id="parent", metadata={
        "cancel_token": token, "trace_id": "trace", "turn_deadline_epoch": time.time() + 60,
    })
    call.arguments = {"_raw": json.dumps({"namespace": "fixture", "tool": "effect", "args": json.dumps({
        "count": "2", "options": '{"x": true}', "items": {"item": "value"},
    })})}
    batch = ToolOrchestrator(registry=registry, executor=executor, modifier_sink=lambda c, m: modifiers.append((c, m))).run_batch([call])
    result = batch.results[0]
    assert not result.is_error
    assert (result.name, result.tool_use_id) == (META_CALL_TOOL, "outer")
    assert result.metadata["mcp_server"] == "fixture" and result.metadata["hook_trace"] == "trace"
    assert result.metadata["descriptor"]["namespace"] == "mcp"
    assert hooks == [("pre", NAME, NAME, RiskLevel.READ), ("post", NAME, NAME)]
    assert len(hits) == len(modifiers) == 1
    target = hits[0]
    assert target.arguments == {"count": 2, "options": {"x": True}, "items": ["value"]}
    assert target.metadata["cancel_token"] is token and target.metadata["trace_id"] == "trace"
    assert (target.caller, target.parent_call_id, target.turn_id, target.iteration) == ("agent:child", "parent", "turn", 3)
    assert batch.parallel_calls == 1


def test_async_executor_uses_same_pipeline():
    async def handler(call):
        await asyncio.sleep(0)
        return _ok(call)
    _, executor = _setup(handler, risk=RiskLevel.READ, read_only=True)
    result = asyncio.run(executor.execute_async(_call()))
    assert not result.is_error and result.metadata["mcp_underlying_tool"] == NAME


@pytest.mark.parametrize("moment", ["before", "pre_hook", "approval", "deadline"])
def test_cancel_or_deadline_before_effect_never_invokes_target(moment):
    hits = []
    token = CancelToken()
    _, executor = _setup(lambda c: hits.append(c) or _ok(c))
    if moment == "before":
        token.cancel("stop")
    if moment == "pre_hook":
        executor.permission_context.mode = PermissionMode.YOLO
        executor.add_pre_hook(lambda *_: token.cancel("hook stop"))
    if moment == "approval":
        def resolve(*_):
            token.cancel("approval stop")
            return SimpleNamespace(verdict=True)
        executor.approval_resolver = SimpleNamespace(resolve=resolve)
    call = _call(metadata={"cancel_token": token})
    if moment == "deadline":
        call.metadata["turn_deadline_epoch"] = time.time() - 1
    result = executor.execute(call)
    assert result.error.kind is ToolErrorKind.ABORTED
    assert hits == [] and result.error.retryable is False


def test_cancel_during_serial_batch_is_inherited_and_stops_next_effect():
    hits = []
    token = CancelToken()

    def handler(call):
        hits.append(call.id)
        assert call.metadata["cancel_token"] is token
        token.cancel("stop after first")
        return _ok(call)

    registry, executor = _setup(handler, context=PermissionContext(mode=PermissionMode.YOLO))
    batch = ToolOrchestrator(registry=registry, executor=executor).run_batch([
        _call(id=i, metadata={"cancel_token": token}) for i in ("first", "second")
    ])
    assert hits == ["first"] and batch.serial_calls == 2 and batch.parallel_calls == 0
    assert not batch.results[0].is_error and batch.results[1].error.kind is ToolErrorKind.ABORTED


@pytest.mark.parametrize("read_only,risk,concurrency_safe,dynamic,attempts,parallel", [
    (False, RiskLevel.DANGEROUS, True, False, 1, 0),
    (False, RiskLevel.READ, True, False, 1, 0),
    (True, RiskLevel.READ, True, True, 1, 0),
    (True, RiskLevel.READ, False, False, 2, 0),
    (True, RiskLevel.READ, True, False, 2, 1),
])
def test_scheduling_and_auto_retry_use_target_effects(monkeypatch, read_only, risk, concurrency_safe, dynamic, attempts, parallel):
    from nerya.tools import orchestrator as module
    from nerya.agent.error_recovery import RecoveryAction
    monkeypatch.setattr(module, "policy_for_kind", lambda _: SimpleNamespace(
        action=RecoveryAction.AUTO_RETRY, max_retries=1, backoff_for_attempt=lambda _: 0,
    ))
    hits = []

    def handler(call):
        hits.append((call.id, threading.current_thread().name))
        if len(hits) > 1:
            return _ok(call)
        return ToolResult.from_error(tool_use_id=call.id, name=call.name, error=ToolError(
            kind=ToolErrorKind.TIMEOUT, message="timed out", retryable=True,
        ))

    registry, executor = _setup(handler, risk=risk, read_only=read_only,
        context=PermissionContext(mode=PermissionMode.YOLO), is_concurrency_safe=concurrency_safe,
        risk_classifier=(lambda args: RiskLevel.DANGEROUS if args.get("mutate") else RiskLevel.READ) if dynamic else None)
    call = _call()
    call.arguments["args"] = {"mutate": True}
    batch = ToolOrchestrator(registry=registry, executor=executor).run_batch([call])
    assert len(hits) == attempts and batch.auto_retries == attempts - 1
    assert batch.parallel_calls == parallel and batch.serial_calls == 1 - parallel


@pytest.mark.parametrize("read_only", [False, True])
def test_handler_without_executor_fails_closed_even_after_executor_exists(read_only):
    hits = []
    registry, _ = _setup(lambda c: hits.append(c) or _ok(c), risk=RiskLevel.READ, read_only=read_only)
    result = registry.get(META_CALL_TOOL).handler(_call())
    assert result.error.kind is ToolErrorKind.PERMISSION_DENIED
    assert "NativeToolExecutor" in result.error.message and hits == []


def test_wrong_target_result_identity_is_not_laundered():
    registry, executor = _setup(lambda c: _ok(replace(c, id="other")), risk=RiskLevel.READ, read_only=True)
    result = ToolOrchestrator(registry=registry, executor=executor).run_batch([_call()]).results[0]
    # Executor normalizes the handler's call ID as for direct tools; tool name must still match.
    assert not result.is_error
    registry.register(replace(registry.get(NAME), handler=lambda c: _ok(replace(c, name="other"))), replace=True)
    result = executor.execute(_call())
    assert result.error.kind is ToolErrorKind.ABORTED and result.error.retryable is False


@pytest.mark.parametrize("use_policy", [False, True])
def test_routing_tool_deny_is_preserved(use_policy):
    hits = []
    context = PermissionContext(
        deny_rules=[] if use_policy else [PermissionRule(tool=META_CALL_TOOL, decision=PermissionDecisionKind.DENY)],
        tool_policy={"deny": [META_CALL_TOOL]} if use_policy else {},
    )
    _, executor = _setup(lambda c: hits.append(c) or _ok(c), context=context, risk=RiskLevel.READ, read_only=True)
    assert executor.execute(_call()).error.kind is ToolErrorKind.PERMISSION_DENIED
    assert hits == []


def test_read_only_lazy_target_is_allowed_in_plan_mode():
    _, executor = _setup(risk=RiskLevel.READ, read_only=True, context=PermissionContext(plan_only=True))
    assert not executor.execute(_call()).is_error


def test_dynamic_target_risk_is_evaluated_after_numeric_repair():
    hits = []
    registry, executor = _setup(lambda c: hits.append(c) or _ok(c), risk=RiskLevel.READ, read_only=True,
        risk_classifier=lambda args: RiskLevel.DANGEROUS if args["count"] > 1 else RiskLevel.READ)
    registry.register(replace(registry.get(NAME), input_schema={"type": "object", "properties": {
        "count": {"type": "integer"},
    }, "required": ["count"]}), replace=True)
    call = _call()
    call.arguments["args"] = {"count": "2"}
    assert executor.execute(call).error.kind is ToolErrorKind.PERMISSION_PENDING
    assert hits == []


def test_approved_mutations_run_in_order_on_serial_lane():
    hits = []
    registry, executor = _setup(
        lambda c: hits.append((c.id, threading.current_thread().name)) or _ok(c),
        context=PermissionContext(mode=PermissionMode.YOLO),
    )
    batch = ToolOrchestrator(registry=registry, executor=executor).run_batch([_call(id=str(i)) for i in range(3)])
    assert batch.serial_calls == 3 and batch.parallel_calls == batch.error_count == 0
    assert hits == [(str(i), threading.current_thread().name) for i in range(3)]


def test_read_only_targets_actually_run_concurrently():
    barrier = threading.Barrier(2)

    def handler(call):
        barrier.wait(timeout=2)
        return _ok(call)

    registry, executor = _setup(handler, risk=RiskLevel.READ, read_only=True)
    batch = ToolOrchestrator(registry=registry, executor=executor).run_batch([_call(id=str(i)) for i in range(2)])
    assert batch.parallel_calls == 2 and batch.error_count == 0


@pytest.mark.parametrize("state_change", ["missing", "disabled", "wrong_namespace", "ambiguous"])
def test_unresolvable_or_invalid_targets_fail_closed(state_change):
    hits = []
    registry, executor = _setup(lambda c: hits.append(c) or _ok(c), risk=RiskLevel.READ, read_only=True)
    call = _call()
    if state_change == "missing":
        registry.unregister(NAME)
    elif state_change == "disabled":
        registry.disable(NAME)
    elif state_change == "wrong_namespace":
        registry.register(replace(registry.get(NAME), namespace="native"), replace=True)
    else:
        names = [f"mcp__fixture__{prefix}__effect" for prefix in ("a", "b")]
        descriptor = registry.get(NAME)
        for name in names:
            registry.register(replace(descriptor, name=name))
        registry.lazy_mcp_state.register_namespace("fixture", names, always_eager=False)
    assert executor.execute(call).is_error
    assert hits == []


def test_durable_approval_queue_uses_target_and_consumes_once(tmp_path):
    from copy import deepcopy
    from nerya.core import jsonl
    from nerya.core.config import Config, DEFAULT_CONFIG
    from nerya.core.paths import WorkspacePaths

    config = Config(paths=WorkspacePaths(root=tmp_path), data=deepcopy(DEFAULT_CONFIG))
    hits = []
    _, executor = _setup(lambda c: hits.append(c.id) or _ok(c))
    coordinator = ToolApprovalCoordinator(
        config, scope=ToolApprovalScope(session_id="s", actor_id="a"), turn_id="turn",
    )
    executor.approval_resolver = coordinator
    pending = executor.execute(_call(id="first", turn_id="turn"))
    assert pending.error.kind is ToolErrorKind.PERMISSION_PENDING and hits == []
    rows = jsonl.read_all(config.paths.approvals_pending)
    assert len(rows) == 1
    assert rows[0]["items"][0]["tool"]["name"] == NAME
    assert rows[0]["items"][0]["tool_use_id"] == "first"
    jsonl.write_all(config.paths.approvals_approved, rows)
    jsonl.write_all(config.paths.approvals_pending, [])
    coordinator.resume_approval_id = rows[0]["approval_id"]
    assert not executor.execute(_call(id="resumed", turn_id="turn")).is_error
    assert executor.execute(_call(id="again", turn_id="turn")).error.kind is ToolErrorKind.PERMISSION_PENDING
    assert hits == ["resumed"]
    assert jsonl.read_all(config.paths.approvals_approved)[0]["items"][0]["consumed_call_id"] == "resumed"


def test_executors_sharing_registry_keep_their_own_permission_context():
    hits = []
    registry, allowed = _setup(lambda c: hits.append(c.id) or _ok(c), context=PermissionContext(mode=PermissionMode.YOLO))
    denied = NativeToolExecutor(registry=registry, permission_engine=PermissionEngine(), permission_context=PermissionContext(plan_only=True))
    assert not allowed.execute(_call(id="allowed")).is_error
    assert denied.execute(_call(id="denied")).error.kind is ToolErrorKind.PERMISSION_DENIED
    assert hits == ["allowed"]


def test_transient_lazy_read_cancelled_in_handler_is_not_retried():
    hits = []
    token = CancelToken()

    def handler(call):
        hits.append(call.id)
        call.metadata["cancel_token"].cancel("cancel during call")
        return ToolResult.from_error(tool_use_id=call.id, name=call.name, error=ToolError(
            kind=ToolErrorKind.TIMEOUT, message="timed out", retryable=True,
        ))

    registry, executor = _setup(handler, risk=RiskLevel.READ, read_only=True)
    batch = ToolOrchestrator(registry=registry, executor=executor).run_batch([_call(metadata={"cancel_token": token})])
    assert len(hits) == 1 and batch.auto_retries == 0
    assert batch.results[0].error.kind is ToolErrorKind.TIMEOUT
