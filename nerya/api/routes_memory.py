from __future__ import annotations

from typing import Any

from ..memory.activity import MemoryActivityLog
from ..memory.write_rules import (
    DEDUPE_STRATEGIES,
    MEMORY_CATEGORIES,
    load_write_rules,
    save_write_rules,
    validate_write_rules,
)



def routes():
    def retired_backend(client, _payload):
        return {"ok": False, "error": "builtin_memory_only", "backend": "builtin",
                "detail": "Memory is built in. External installers, watchers and unscoped indexes are retired."}

    # ----------------------------------------------- write rules + activity
    def write_rules_get(client, _payload):
        rules = load_write_rules(client.config)
        return {
            "categories": [c.to_dict() for c in MEMORY_CATEGORIES],
            "dedupe_strategies": list(DEDUPE_STRATEGIES),
            "rules": {k: r.to_dict() for k, r in rules.items()},
            "warnings": validate_write_rules(rules),
        }

    def write_rules_set(client, payload):
        body = payload or {}
        try:
            rules = save_write_rules(client.config, body.get("rules") or {})
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
        return {
            "ok": True,
            "categories": [c.to_dict() for c in MEMORY_CATEGORIES],
            "dedupe_strategies": list(DEDUPE_STRATEGIES),
            "rules": {k: r.to_dict() for k, r in rules.items()},
            "warnings": validate_write_rules(rules),
        }

    def _session_domains(client):
        from ..memory.scope import memory_actor
        from ..db.sqlite import connect
        with connect(client.config.paths.db) as con:
            rows = con.execute("""SELECT session_id, strategy_id, workflow_id FROM memory_session_context
                WHERE actor_id=? AND session_id NOT IN (SELECT session_id FROM agent_deleted_sessions)""",
                (memory_actor(getattr(client, "actor_id", "default")),)).fetchall()
        return [{"scope": "session", **dict(row)} for row in rows]

    def _memory_scope_error(client, *, scope: str, strategy_id: str, workflow_id: str = "", session_id: str = "") -> str:
        if scope == "session":
            domain = {"scope": scope, "strategy_id": strategy_id, "workflow_id": workflow_id, "session_id": session_id}
            return "" if session_id and domain in _session_domains(client) else "session_scope_requires_trusted_context"
        if session_id:
            return "scope_override_forbidden"
        if scope not in {"global", "strategy", "workflow"}:
            return "invalid_scope"
        if scope == "global":
            return "scope_override_forbidden" if strategy_id or workflow_id else ""
        if scope == "strategy" and workflow_id:
            return "scope_override_forbidden"
        if scope == "workflow":
            from ..memory.runtime import MemoryRuntime, MemoryScopeError
            try:
                MemoryRuntime._required_id(workflow_id, "workflow_id")
            except MemoryScopeError:
                return "invalid_workflow"
            if not strategy_id:
                from ..triggers.schedule import load_schedules
                return "" if any(e.id == workflow_id and not e.strategy_id for e in load_schedules(client.config.paths)) else "unknown_workflow"
            if workflow_id not in {"execution", "evolution"}:
                from ..triggers.schedule import load_schedules
                if not any(e.id == workflow_id and e.strategy_id == strategy_id for e in load_schedules(client.config.paths)):
                    return "unknown_workflow"
        try:
            from ..memory.runtime import MemoryRuntime
            MemoryRuntime._required_id(strategy_id, "strategy_id")
            strategy_path = client.config.paths.strategy(strategy_id).resolve()
            strategy_path.relative_to(client.config.paths.strategies.resolve())
        except (ValueError, OSError):
            return "invalid_scope"
        return "" if strategy_id and strategy_path.is_dir() else "unknown_strategy"

    def memory_capture(client, payload):
        body = payload or {}
        from ..memory.runtime import MemoryRuntime, MemoryScopeError

        scope = str(body.get("scope") or "global").strip().lower()
        strategy_id = str(body.get("strategy_id") or "").strip()
        workflow_id = str(body.get("workflow_id") or "").strip()
        session_id = str(body.get("session_id") or "").strip()
        if "target_files" in body:
            return {
                "ok": False,
                "skipped": True,
                "skip_reason": "target_override_forbidden",
            }
        scope_error = _memory_scope_error(
            client,
            scope=scope,
            strategy_id=strategy_id,
            workflow_id=workflow_id,
            session_id=session_id,
        )
        if scope_error:
            return {
                "ok": False,
                "skipped": True,
                "skip_reason": scope_error,
            }

        category = str(body.get("category") or "")
        content = str(body.get("content") or "")
        key = str(body.get("key") or "")
        title = str(body.get("title") or "")
        try:
            result = MemoryRuntime(
                client.config,
                actor_id=str(getattr(client, "actor_id", "default") or "default"),
                strategy_id=strategy_id,
                workflow_id=workflow_id,
                session_id=session_id,
            ).remember(
                category=category,
                content=content,
                title=title,
                key=key,
                tags=(
                    list(body.get("tags") or [])
                    if isinstance(body.get("tags"), list)
                    else None
                ),
                source="api:memory_capture",
                writer_id="memory_api",
                expected_memory_id=body.get("expected_memory_id"),
                scope=scope,
            )
        except ValueError as exc:
            from ..memory.store import MemoryConflictError
            return {"ok": False, "skipped": True, "skip_reason": "update_conflict" if isinstance(exc, MemoryConflictError) else "invalid_scope"}
        record = result.record
        unsafe_result = result.skip_reason == "unsafe_content"
        response_category = (
            record.category if record is not None else "" if unsafe_result else category
        )
        response_key = (
            record.stable_key if record is not None else "" if unsafe_result else key
        )
        response_title = (
            record.title if record is not None else "" if unsafe_result else title
        )
        rule = load_write_rules(client.config).get(response_category)
        return {
            "ok": result.ok,
            "skipped": result.skipped,
            "skip_reason": result.skip_reason,
            "category": response_category,
            "key": response_key,
            "title": response_title,
            "memory_id": record.memory_id if record else "",
            "fact_ts": record.created_at if record else None,
            "target_files": (
                list(record.target_files)
                if record is not None
                else list(rule.target_files)
                if rule is not None
                else []
            ),
        }

    def memory_forget(client, payload):
        body = payload or {}
        from ..memory.runtime import MemoryRuntime, MemoryScopeError

        scope = str(body.get("scope") or "global").strip().lower()
        strategy_id = str(body.get("strategy_id") or "").strip()
        workflow_id = str(body.get("workflow_id") or "").strip()
        session_id = str(body.get("session_id") or "").strip()
        key = str(body.get("key") or "").strip()
        memory_id = str(body.get("memory_id") or "").strip()
        if bool(key) == bool(memory_id):
            return {
                "ok": False,
                "skipped": True,
                "skip_reason": "exactly_one_selector_required",
            }
        scope_error = _memory_scope_error(
            client,
            scope=scope,
            strategy_id=strategy_id,
            workflow_id=workflow_id,
            session_id=session_id,
        )
        if scope_error:
            return {
                "ok": False,
                "skipped": True,
                "skip_reason": scope_error,
            }

        try:
            forgotten = MemoryRuntime(
                client.config,
                actor_id=str(getattr(client, "actor_id", "default") or "default"),
                strategy_id=strategy_id,
                workflow_id=workflow_id,
                session_id=session_id,
            ).forget(
                key=key,
                memory_id=memory_id,
                scope=scope,
            )
        except ValueError as exc:
            from ..memory.store import MemoryConflictError
            return {"ok": False, "skipped": True, "skip_reason": "update_conflict" if isinstance(exc, MemoryConflictError) else "invalid_scope"}
        return {"ok": True, "forgotten": forgotten, "scope": scope}

    def memory_domains(client, _payload):
        from ..triggers.schedule import load_schedules
        from ..memory.runtime import MemoryRuntime, MemoryScopeError
        domains = [{"scope": "global", "strategy_id": "", "workflow_id": ""}]
        root = client.config.paths.strategies
        if root.exists():
            for path in sorted(root.iterdir()):
                if not path.is_dir() or path.is_symlink():
                    continue
                try:
                    MemoryRuntime._required_id(path.name, "strategy_id")
                except MemoryScopeError:
                    continue
                domains.append({"scope": "strategy", "strategy_id": path.name, "workflow_id": ""})
                domains.extend({"scope": "workflow", "strategy_id": path.name, "workflow_id": name}
                               for name in ("execution", "evolution"))
        for entry in load_schedules(client.config.paths):
            item = {"scope": "workflow", "strategy_id": entry.strategy_id or "", "workflow_id": entry.id}
            if entry.session_kind == "agent" and not _memory_scope_error(client, **item) and item not in domains:
                domains.append(item)
        domains.extend(_session_domains(client))
        return {"ok": True, "domains": domains}

    def _source_links(client, rows):
        from ..db.sqlite import connect
        from ..memory.scope import memory_actor
        actor = memory_actor(getattr(client, "actor_id", "default"))
        with connect(client.config.paths.db) as con:
            for item in rows:
                turn = item.get("source_turn_id", "")
                if not turn:
                    continue
                row = con.execute("""SELECT DISTINCT m.session_id FROM agent_messages m
                    JOIN memory_session_context c ON c.session_id=m.session_id
                    WHERE m.turn_id=? AND m.deleted=0 AND c.actor_id=?
                    AND m.session_id NOT IN (SELECT session_id FROM agent_deleted_sessions) LIMIT 1""",
                    (turn, actor)).fetchone()
                if row:
                    item["source_session_id"] = str(row["session_id"])
        return rows

    def memory_records(client, payload):
        from dataclasses import asdict
        from ..memory.runtime import MemoryRuntime
        body = payload or {}
        scope = str(body.get("scope") or "global")
        strategy_id = str(body.get("strategy_id") or "")
        workflow_id = str(body.get("workflow_id") or "")
        session_id = str(body.get("session_id") or "")
        error = _memory_scope_error(client, scope=scope, strategy_id=strategy_id, workflow_id=workflow_id, session_id=session_id)
        if error:
            return {"ok": False, "error": error, "records": []}
        runtime = MemoryRuntime(client.config,
            actor_id=str(getattr(client, "actor_id", "default") or "default"),
            strategy_id=strategy_id, workflow_id=workflow_id, session_id=session_id)
        try:
            limit = max(1, min(100, int(body.get("limit", 50))))
        except (ValueError, TypeError):
            return {"ok": False, "error": "invalid_limit", "records": []}
        query = str(body.get("query") or "")
        hits = runtime.recall(query, scope=scope, limit=limit, management=True)
        # Explicit recent browsing never silently substitutes unrelated search hits.
        recent = runtime.recall("", scope=scope, limit=min(limit, 10), management=True, recent=True) if query and not hits else []
        rows = _source_links(client, [asdict(hit) for hit in hits])
        return {"ok": True, "backend": "builtin", "scope": scope, "records": rows,
                "recent_records": _source_links(client, [asdict(hit) for hit in recent]), "policy": runtime.policy()}

    def memory_policy(client, _payload):
        from ..memory.runtime import MemoryRuntime
        return {"ok": True, **MemoryRuntime(client.config, actor_id=getattr(client, "actor_id", "default")).policy()}

    def memory_policy_set(client, payload):
        from ..core import yaml_io
        from ..memory.runtime import MemoryRuntime
        body = payload or {}
        allowed = {"use_enabled", "auto_save_enabled"}
        if not isinstance(body, dict) or not body or set(body) - allowed or any(type(v) is not bool for v in body.values()):
            return {"ok": False, "error": "invalid_memory_policy"}
        existing = yaml_io.load(client.config.paths.config, default={}) or {}
        if not isinstance(existing, dict):
            return {"ok": False, "error": "invalid_config"}
        memory = existing.setdefault("memory", {})
        if not isinstance(memory, dict):
            return {"ok": False, "error": "invalid_config"}
        if not isinstance(client.config.data.get("memory", {}), dict):
            return {"ok": False, "error": "invalid_config"}
        memory.update(body)
        try:
            yaml_io.dump(client.config.paths.config, existing)
        except OSError:
            return {"ok": False, "error": "memory_policy_save_failed"}
        client.config.data.setdefault("memory", {}).update(body)
        return {"ok": True, **MemoryRuntime(client.config, actor_id=getattr(client, "actor_id", "default")).policy()}

    def memory_usage(client, payload):
        body = payload or {}
        session_id = str(body.get("session_id") or "")
        domain = next((d for d in _session_domains(client) if d["session_id"] == session_id), None)
        if not domain:
            return {"ok": False, "error": "session_scope_requires_trusted_context", "events": []}
        from ..memory.scope import memory_actor
        actor = memory_actor(getattr(client, "actor_id", "default"))
        events = [e for e in MemoryActivityLog(config=client.config).tail(limit=500, kinds=["inject"])
                  if e.get("actor_id") == actor and all(e.get("extra", {}).get(k, "") == domain[k]
                     for k in ("session_id", "strategy_id", "workflow_id"))]
        for event in events[-20:]:
            _source_links(client, event.get("extra", {}).get("included", []))
            _source_links(client, event.get("extra", {}).get("omitted", []))
        return {"ok": True, "events": events[-20:]}

    # ----------------------------------------------- curated notebook
    def _notebook_runtime(client):
        from ..memory.runtime import MemoryRuntime
        return MemoryRuntime(client.config, actor_id=getattr(client, "actor_id", "default"))

    def notebook_list(client, _payload):
        try:
            return _notebook_runtime(client).notebook_state()
        except (OSError, UnicodeError):
            return {"ok": False, "error": "notebook_unreadable"}

    def notebook_mutate(client, payload):
        from ..memory.store import MemoryConflictError
        body = payload or {}
        try:
            result = _notebook_runtime(client).notebook_mutate(
                target=str(body.get("target") or ""), action=str(body.get("action") or ""),
                content=str(body.get("content") or ""), old_text=str(body.get("old_text") or ""),
                expected_revision=body.get("expected_revision"))
            if result.get("ok") and body.get("action") in {"add", "replace"}:
                # Preserve the optional evidence-vault hook after the canonical write.
                try:
                    import hashlib
                    from ..evidence.autoingest import on_research_save
                    content = str(body.get("content") or "")
                    category = "notebook_" + str(body.get("target"))
                    on_research_save(client, provider=category,
                        artifact_id="sha256:" + hashlib.sha256(content.encode()).hexdigest()[:16],
                        title=f"notebook.{body.get('action')}:{body.get('target')}", body=content[:8000],
                        tags=[category, "source:api:notebook"])
                except Exception:
                    pass
            return result
        except MemoryConflictError as exc:
            return {"ok": False, "error": str(exc)}
        except ValueError:
            return {"ok": False, "error": "invalid_notebook_action"}
        except (OSError, UnicodeError):
            return {"ok": False, "error": "notebook_unreadable"}

    def memory_providers(client, _payload):
        return {"builtin": {"id": "builtin", "name": "Built-in memory", "family": "builtin", "available": True, "initialised": True},
                "external": None, "available_external": []}

    def memory_test(client, payload):
        """Exercise canonical recall without invoking retired services."""

        body = payload or {}
        query = str(body.get("query") or "memory test").strip() or "memory test"
        try:
            limit = max(1, min(20, int(body.get("limit") or 3)))
        except (TypeError, ValueError):
            limit = 3
        out: dict[str, Any] = {
            "ok": True,
            "query": query,
            "backends": [],
        }
        # Built-in: exercise the same scoped, query-ranked recall path used
        # by the agent instead of inspecting Notebook files directly.
        try:
            from ..memory.runtime import MemoryRuntime

            hits = MemoryRuntime(
                client.config,
                actor_id=str(getattr(client, "actor_id", "default") or "default"),
            ).recall(query, limit=limit)
            out["backends"].append(
                {
                    "backend": "builtin",
                    "ok": True,
                    "matches": len(hits),
                    "preview": [
                        {
                            "memory_id": hit.memory_id,
                            "scope": hit.scope,
                            "strategy_id": hit.strategy_id,
                            "category": hit.category,
                            "key": hit.stable_key,
                            "content": hit.content,
                        }
                        for hit in hits[: max(1, limit)]
                    ],
                }
            )
        except Exception as exc:  # noqa: BLE001 — diagnostic only
            out["backends"].append(
                {
                    "backend": "builtin",
                    "ok": False,
                    "error": str(exc),
                }
            )
        return out

    def activity_tail(client, payload):
        body = payload or {}
        log = MemoryActivityLog(config=client.config)
        try:
            limit = max(1, min(500, int(body.get("limit", 100))))
        except (TypeError, ValueError):
            limit = 100
        kinds_raw = body.get("kinds")
        kinds = None
        if isinstance(kinds_raw, list) and kinds_raw:
            kinds = [str(k) for k in kinds_raw if str(k or "")]
        from ..memory.scope import memory_actor
        actor = memory_actor(getattr(client, "actor_id", "default"))
        events = [event for event in log.tail(limit=500, kinds=kinds, category=str(body.get("category") or ""))
                  if event.get("actor_id", "default") == actor][-limit:]
        return {"events": events, "stats": {
            "write_ok": sum(e.get("kind") == "write_ok" for e in events),
            "write_skipped": sum(e.get("kind") == "write_skipped" for e in events),
            "search": sum(e.get("kind") == "search" for e in events),
        }}

    # ------------------------------------------------------------------
    # Operator preference profile.
    # ------------------------------------------------------------------

    from ..agent import operator_profile as _profile
    from ..runtime import feature_flags as _ff

    _PROFILE_FLAG = "runtime.operator_profile"
    _PROMPT_GUARD_FLAG = "runtime.prompt_guard_review_queue"

    def _profile_disabled():
        return {
            "ok": False,
            "error": "feature_disabled",
            "flag": _PROFILE_FLAG,
            "detail": "Operator preference profile is disabled via feature flag",
            "_status": 503,
        }

    def _prompt_guard_disabled():
        return {
            "ok": False,
            "error": "feature_disabled",
            "flag": _PROMPT_GUARD_FLAG,
            "detail": "Prompt guard review queue is disabled via feature flag",
            "_status": 503,
        }

    def profile_get(client, query):
        if not _ff.is_enabled(client, _PROFILE_FLAG):
            return _profile_disabled()
        q = query if isinstance(query, dict) else {}
        facet = q.get("facet") or None
        scope = q.get("scope") or None
        facts = _profile.list_facts(
            client.config.paths,
            facet=facet,
            scope=scope,
            include_forgotten=bool(q.get("include_forgotten")),
        )
        return {
            "ok": True,
            "facts": facts,
            "stats": _profile.stats(client.config.paths),
        }

    def profile_set(client, payload):
        if not _ff.is_enabled(client, _PROFILE_FLAG):
            return _profile_disabled()
        body = payload or {}
        try:
            rec = _profile.set_fact(
                client.config.paths,
                facet=str(body.get("facet") or "style"),
                key=str(body.get("key") or ""),
                value=body.get("value"),
                scope=str(body.get("scope") or "global"),
                pinned=bool(body.get("pinned", False)),
                source=str(body.get("source") or "operator_set"),
                operator_id=str(body.get("operator_id") or "operator"),
            )
        except (ValueError, PermissionError) as exc:
            return {"ok": False, "error": str(exc), "_status": 400}
        return {"ok": True, "fact": rec}

    def profile_pin(client, payload):
        if not _ff.is_enabled(client, _PROFILE_FLAG):
            return _profile_disabled()
        body = payload or {}
        try:
            rec = _profile.pin(
                client.config.paths,
                fact_id=str(body.get("fact_id") or body.get("id") or ""),
            )
        except KeyError as exc:
            return {"ok": False, "error": str(exc), "_status": 404}
        return {"ok": True, "fact": rec}

    def profile_forget(client, payload):
        if not _ff.is_enabled(client, _PROFILE_FLAG):
            return _profile_disabled()
        body = payload or {}
        try:
            rec = _profile.forget(
                client.config.paths,
                fact_id=str(body.get("fact_id") or body.get("id") or ""),
            )
        except KeyError as exc:
            return {"ok": False, "error": str(exc), "_status": 404}
        return {"ok": True, "fact": rec}

    def profile_rebuild(client, _payload):
        if not _ff.is_enabled(client, _PROFILE_FLAG):
            return _profile_disabled()
        return {"ok": True, "cache": _profile.rebuild_cache(client.config.paths)}

    # ------------------------------------------------------------------
    # Prompt-guard review queue.
    # ------------------------------------------------------------------

    from ..security import prompt_guard_queue as _pg

    def prompt_guard_list(client, query):
        if not _ff.is_enabled(client, _PROMPT_GUARD_FLAG):
            return _prompt_guard_disabled()
        q = query if isinstance(query, dict) else {}
        state = q.get("state") or None
        items = _pg.list_items(client, state=state)
        return {
            "ok": True,
            "items": items,
            "count": len(items),
            "stats": _pg.stats(client),
        }

    def prompt_guard_resolve(client, payload):
        if not _ff.is_enabled(client, _PROMPT_GUARD_FLAG):
            return _prompt_guard_disabled()
        body = payload or {}
        try:
            rec = _pg.resolve(
                client,
                item_id=str(body.get("id") or ""),
                decision=str(body.get("decision") or ""),
                operator_id=str(body.get("operator_id") or "operator"),
                note=str(body.get("note") or ""),
            )
        except (ValueError, KeyError) as exc:
            return {"ok": False, "error": str(exc), "_status": 400}
        return {"ok": True, "item": rec}

    def prompt_guard_classify(client, payload):
        """Classify a prompt sample and optionally enqueue it.

        Body::
          {
            "content": "...",
            "source_route": "POST /agent/run_turn",
            "source_channel": "dashboard",
            "enqueue": true
          }
        """
        if not _ff.is_enabled(client, _PROMPT_GUARD_FLAG):
            return _prompt_guard_disabled()
        from ..security import prompt_injection as _pi

        body = payload or {}
        content = str(body.get("content") or "")
        verdict = _pi.classify(content)
        rec = None
        if bool(body.get("enqueue", True)) and verdict["verdict"] in (
            "review",
            "block",
        ):
            rec = _pg.enqueue(
                client,
                verdict=verdict["verdict"],
                policy=verdict["policy"],
                matched=verdict["hits"],
                excerpt=_pi.sanitized_excerpt(content),
                raw_content=content,
                source_route=str(body.get("source_route") or ""),
                source_channel=str(body.get("source_channel") or ""),
                affected_action=str(body.get("affected_action") or ""),
            )
        return {
            "ok": True,
            "verdict": verdict["verdict"],
            "policy": verdict["policy"],
            "matched": verdict["hits"],
            "enqueued": rec,
        }

    return [
        ("POST", "/memory/records", memory_records),
        ("GET", "/memory/domains", memory_domains),
        ("GET", "/memory/policy", memory_policy),
        ("POST", "/memory/policy", memory_policy_set),
        ("POST", "/memory/usage", memory_usage),
        ("GET", "/memory/vector/status", retired_backend),
        ("POST", "/memory/vector/config", retired_backend),
        ("POST", "/memory/vector/install", retired_backend),
        ("POST", "/memory/vector/reindex", retired_backend),
        ("POST", "/memory/vector/search", retired_backend),
        ("POST", "/memory/vector/start", retired_backend),
        ("POST", "/memory/vector/stop", retired_backend),
        # Write rules + capture + activity feed
        ("GET", "/memory/write_rules", write_rules_get),
        ("POST", "/memory/write_rules", write_rules_set),
        ("POST", "/memory/capture", memory_capture),
        ("POST", "/memory/forget", memory_forget),
        ("GET", "/memory/activity", activity_tail),
        ("POST", "/memory/activity", activity_tail),
        # Curated agent / operator notebook
        ("GET", "/memory/notebook", notebook_list),
        ("POST", "/memory/notebook", notebook_mutate),
        # Compatibility provider directory; only builtin is active.
        ("GET", "/memory/providers", memory_providers),
        ("GET", "/memory/external/config", retired_backend),
        ("POST", "/memory/external/config", retired_backend),
        ("POST", "/memory/external/install", retired_backend),
        # Retired installer remains an explicit no-op error for old clients.
        ("POST", "/memory/external/install/run", retired_backend),
        # Compatibility recall probe uses only the built-in runtime.
        ("POST", "/memory/test", memory_test),
        # Operator preference profile.
        ("GET", "/memory/profile", profile_get),
        ("POST", "/memory/profile/set", profile_set),
        ("POST", "/memory/profile/pin", profile_pin),
        ("POST", "/memory/profile/forget", profile_forget),
        ("POST", "/memory/profile/rebuild", profile_rebuild),
        # Prompt-guard review queue.
        ("GET", "/security/prompt_guard/items", prompt_guard_list),
        ("POST", "/security/prompt_guard/resolve", prompt_guard_resolve),
        ("POST", "/security/prompt_guard/classify", prompt_guard_classify),
    ]
