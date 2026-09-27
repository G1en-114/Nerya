"""Child scopes intersect current configuration with their inherited ceiling."""
from __future__ import annotations

from dataclasses import replace
from typing import Any

from ..tools.capability_policy import normalise_tool_policy
from ..tools.permissions import PermissionContext, PermissionMode


def intersect_ceilings(*ceilings: dict[str, Any]) -> dict[str, Any]:
    policy = {"allow_groups": [], "deny": []}
    for ceiling in ceilings:
        item = normalise_tool_policy(ceiling.get("tool_policy"))
        for group in item["allow_groups"]:
            if group not in policy["allow_groups"]:
                policy["allow_groups"].append(group)
        policy["deny"] = list(dict.fromkeys([*policy["deny"], *item["deny"]]))
    return {"tool_policy": policy, "plan_only": any(c.get("plan_only", False) for c in ceilings)}


def child_permission_context(config: Any, *, parent: PermissionContext | None = None,
                             saved: dict[str, Any] | None = None,
                             strategy_id: str | None = None) -> PermissionContext:
    if strategy_id and config.paths.strategy(strategy_id).is_dir():
        from ..strategies.agent_execution import execution_config
        from ..strategies.package import load_package
        config = execution_config(config, load_package(config.paths, strategy_id).manifest)
    context = parent or PermissionContext(
        mode=PermissionMode(config.get("runtime.permission_mode", "default")))
    return replace(context, **intersect_ceilings(
        {"tool_policy": config.get("agent.native.tool_policy"),
         "plan_only": bool(config.get("agent.native.plan_only", False))},
        permission_ceiling(context), saved or {}))


def permission_ceiling(context: PermissionContext) -> dict[str, Any]:
    return {"tool_policy": normalise_tool_policy(context.tool_policy),
            "plan_only": context.plan_only}
