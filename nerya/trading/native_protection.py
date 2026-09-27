"""Durable reduce-only exits for venues without attached entry brackets."""
from __future__ import annotations

from contextlib import closing
from hashlib import sha256

from .order_intents import OrderCandidate
from .order_tracker import OrderTracker
from .protection_store import ProtectionStore


def levels(rule, entry: float) -> dict[str, float]:
    out = {}
    sign = 1 if rule.side == "long" else -1
    for kind, spec in (("stop_loss", rule.stop_loss), ("take_profit", rule.take_profit)):
        if spec is None:
            continue
        direction = -sign if kind == "stop_loss" else sign
        price = spec.value if spec.type == "price" else (entry * (1 + direction * spec.value)
            if spec.type == "pct" else entry + direction * spec.value if spec.type == "atr" else 0)
        if price > 0:
            out[kind] = price
    return out


def sync_native(config, rule, share, *, cancel: bool = False) -> bool:
    """Return True only when it is safe for the local executor to act.

    All legs use the normal durable market-order executor, tracker, cancel,
    and fill path. Ambiguous submissions are never replaced blindly.
    """
    from .accounts import get_account_profile
    from .executors.orchestrator import ExecutorOrchestrator
    from .executors.market_order import MarketOrderExecutor
    from .cancellation import cancel_tracked_order
    from ..connectors import ConnectorRegistry

    native = rule.native
    routes = native.get("routes") or {}
    kinds = [kind for kind, route in routes.items() if route == "standalone"]
    generations = native.setdefault("generations", [])
    if not kinds and not generations:
        return True
    profile = get_account_profile(config.paths, rule.account_id)
    if not profile.is_real_money:
        return True
    store = ProtectionStore(config.paths)
    with closing(ExecutorOrchestrator(config)) as orch, closing(OrderTracker(config.paths)) as tracker:
        def child(kind, eid, generation):
            run = orch.get(eid)
            if run is not None:
                return MarketOrderExecutor(run, config.paths)
            conn = ConnectorRegistry(workspace=config.paths.root).get(profile.id, profile.to_connector_account().connector_cfg())
            query = conn.protection_query_params(rule.market, kind)
            entry_params = dict(native.get("connector_params") or {})
            # Only account/position selectors survive from the entry. Entry
            # client ids, sizes, trigger fields and post-only flags must not
            # override the generated reduce-only market exit.
            exit_params = {key:value for key,value in entry_params.items() if key in {
                "positionIdx", "positionSide", "posSide", "hedged", "marginMode", "tdMode",
                "settle", "accountId", "subAccountId", "vaultAddress", "subAccountAddress",
                "triggerBy", "triggerType", "workingType", "triggerSignal",
            }}
            candidate = OrderCandidate(account_id=rule.account_id, strategy_id=rule.strategy_id,
                market=rule.market, side="sell" if rule.side=="long" else "buy",
                order_type="stop", size_base=generation["size"], notional_usd=generation["size"]*generation["entry_price"],
                stop_price=generation["levels"][kind], reduce_only=True,
                meta={"protection_kind":kind, "order_query":query, "protects_rule":rule.protection_id,
                      "connector_params": exit_params,
                      "mark_price":generation["entry_price"]})
            return orch.create_market_order(candidate=candidate, position_id=rule.position_id, executor_id=eid)

        current = generations[-1] if generations else None
        prices = levels(rule, share.avg_entry_share_price) if share is not None and share.is_open else {}
        size = abs(share.size_share_base) if share is not None and share.is_open else 0.0
        changed = current and not current.get("retired") and (abs(current["size"] - size) > 1e-12 or current["levels"] != prices)
        orders = []
        observed_fill = False
        if current and not current.get("retired"):
            for kind, eid in current["executors"].items():
                executor = child(kind,eid,current)
                run = executor.run
                if not run.is_terminal:
                    if cancel or changed or observed_fill or native.get("exit_trigger") or share is None or not share.is_open or rule.status in ("released", "failed", "triggered"):
                        if not run.order_ids:
                            executor.prepare()
                            orch._persist(executor.run)
                    else:
                        orch.step_executor(executor)
                    run = orch.get(eid)
                for oid in run.order_ids:
                    order = tracker.get(oid)
                    if order is not None:
                        orders.append((kind, order))
                        observed_fill = observed_fill or order.filled_size > 0
                        if order.exchange_order_id:
                            rule.exchange_order_ids[kind] = order.exchange_order_id
        fired = any(o.filled_size > 0 for _,o in orders)
        retired = cancel or size <= 0 or fired or changed or (native.get("exit_trigger") and current and not current.get("retired")) or rule.status in ("released", "failed", "triggered")
        if retired:
            for _, order in orders:
                if not order.is_terminal:
                    cancel_tracked_order(config, order.order_id, strategy_id=rule.strategy_id)
            pending = any(not tracker.get(order.order_id).is_terminal for _,order in orders)
            native["state"] = "cancel_pending" if pending else "canceled"
            if rule.status == "exchange_armed":
                rule.status = "armed"
            if fired:
                native["exit_trigger"] = next(kind for kind,order in orders if order.filled_size > 0)
            if current and not pending:
                current["retired"] = True
                rule.exchange_order_ids = {}
            store.upsert(rule)
            store.close()
            # A filled native leg changes the share; let the next tick
            # re-read it before sizing another exit.
            return not pending and not fired
        if current and not current.get("retired"):
            native["state"] = "exchange_armed" if len(orders) == len(kinds) and all(
                o.exchange_order_id and not o.is_terminal for _,o in orders) else "pending"
            if any(o.state in ("rejected", "failed", "lost", "canceled", "expired") for _,o in orders):
                native["state"] = "degraded"
                if rule.mode == "hard_exchange":
                    native["exit_trigger"] = "stop_loss"
            if native["state"] == "exchange_armed":
                rule.status = "exchange_armed"
            else:
                rule.status = "armed"
            store.upsert(rule)
            store.close()
            return True
        if native.get("exit_trigger") or not kinds or not prices:
            store.close()
            return True
        seq = len(generations)
        generation = {"size": size, "levels": prices, "entry_price":share.avg_entry_share_price, "executors": {}, "retired": False}
        for kind in kinds:
            if kind in prices:
                token = sha256(f"{rule.protection_id}:{seq}:{kind}".encode()).hexdigest()[:24]
                generation["executors"][kind] = f"exc_protect_{token}"
        generations.append(generation)
        native["state"] = "pending"
        store.upsert(rule)  # write the generation before any venue side effect
        for kind,eid in generation["executors"].items():
            executor = child(kind,eid,generation)
            orch.step_executor(executor)
            if any((order := tracker.get(oid)) is not None and order.filled_size > 0 for oid in executor.run.order_ids):
                native["exit_trigger"] = kind
                store.upsert(rule)
                break
        store.close()
        return True
