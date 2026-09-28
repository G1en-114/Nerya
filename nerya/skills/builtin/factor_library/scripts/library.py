"""Shared control-plane operation for the dashboard, native tool and CLI."""
from __future__ import annotations

import argparse
import json
from typing import Any

from .....data.history_store import HistoryStore
from .....research.factors import FactorStore
from ...backtest.scripts.history_data import store_root


def backtest_context(config: Any, body: dict[str, Any], *, include_source: bool = False) -> dict[str, Any]:
    # Reuse the existing strategy/proposal path guard, then additionally reject
    # separators and symlinks before reading any frozen source or report.
    from .....api.routes_strategy import _safe_backtest_dir_for_payload
    from .....core.redaction import redact_display_dict
    for key in ("strategy_id", "ts"):
        value = body.get(key)
        if not isinstance(value, str) or not value or any(token in value for token in ("/", "\\", "..")):
            raise ValueError(f"invalid backtest {key}")
    store = FactorStore(config.paths.root)
    directory = store.safe_path(_safe_backtest_dir_for_payload(config.paths, body))
    metrics_path = store.safe_path(directory / "metrics.json")
    if not metrics_path.is_file() or metrics_path.stat().st_size > 10_000_000:
        raise ValueError("completed backtest metrics not found")
    metrics = json.loads(metrics_path.read_text())
    provenance = metrics.get("provenance") or {}
    identity = {"strategy_id": body["strategy_id"], "ts": body["ts"], "proposal_id": body.get("proposal_id") or None}
    source = {**identity, "source_revision": provenance.get("source_revision"), "data_kind": provenance.get("data_kind", "unverified")}
    snapshot = store.safe_path(directory / "factor_snapshot.json")
    used = json.loads(snapshot.read_text()) if snapshot.is_file() and snapshot.stat().st_size < 1_000_000 else []
    extracted = store.sourced_from(identity)
    result = {"source_backtest": source, "used_factors": used, "extracted_factors": extracted,
              "markets": metrics.get("markets", []), "timeframe": metrics.get("tf"),
              "start": metrics.get("start_utc"), "end": metrics.get("end_utc"),
              "costs": provenance.get("assumptions", {}),
              "note": "Declared factor references are not proof of causal performance attribution. Extracted factors were not necessarily used in this run."}
    if include_source:
        frozen = store.safe_path(directory / "source" / body["strategy_id"])
        files: dict[str, str] = {}
        budget = 24000
        if frozen.is_dir():
            for path in sorted(frozen.rglob("*")):
                if path.suffix not in {".py", ".json", ".yml", ".md"} or not path.is_file() or path.is_symlink():
                    continue
                store.safe_path(path)
                if path.stat().st_size > 100000 or budget <= 0:
                    continue
                text = path.read_text(encoding="utf-8")[:budget]
                files[path.relative_to(frozen).as_posix()] = text
                budget -= len(text)
        result["source_files"] = redact_display_dict(files)
        result["source_available"] = bool(files)
        result["source_truncated"] = budget <= 0
        result["next_action"] = (
            "Extract an explainable causal expression from the frozen source. Save a candidate with this source_backtest; do not infer a factor's contribution from total strategy returns."
            if files else
            "No readable frozen source is available. Do not reconstruct it from the current strategy or infer a formula from performance. Request the original source, or run a new baseline that freezes its source."
        )
    return result


def strategy_factor_snapshots(config: Any, files: dict[str, str]) -> list[dict[str, Any]]:
    """Pin references BEFORE replay. The ordinary no-factor path is unchanged."""
    raw = files.get("factors.json")
    if raw is None:
        return []
    references = json.loads(raw)
    if not isinstance(references, list) or len(references) > 30:
        raise ValueError("factors.json must be a list of at most 30 version-pinned factors")
    store = FactorStore(config.paths.root)
    snapshots = []
    for reference in references:
        if not isinstance(reference, dict) or not isinstance(reference.get("version"), int) or isinstance(reference.get("version"), bool):
            raise ValueError("each factor reference requires factor_id and an integer version")
        item = store.get(str(reference.get("factor_id", "")), reference["version"])
        for key in ("expression", "parameters", "definition_hash", "direction"):
            if key in reference and reference[key] != item[key]:
                raise ValueError(f"pinned factor mismatch: {item['factor_id']} {key}")
        snapshots.append(item)
    return snapshots


def operation(config: Any, payload: dict[str, Any], *, check_cancel=None) -> dict[str, Any]:
    body = dict(payload)
    action = body.pop("action", "list")
    store = FactorStore(config.paths.root)
    if action == "list":
        return {"ok": True, "factors": store.list(str(body.get("query") or ""))}
    if action == "data":
        return {"ok": True, "datasets": HistoryStore(store_root(config, body.get("data_dir"))).inventory()}
    if action in {"get", "export"}:
        factor_id = str(body.get("factor_id") or "")
        version = body.get("version")
        if action == "export" and (not isinstance(version, int) or isinstance(version, bool)):
            raise ValueError("export requires an exact integer version")
        result = store.detail(factor_id, version)
        if action == "export":
            return {"ok": True, "factor": result["factor"], "files": {"factors.json": json.dumps([result["factor"]], ensure_ascii=False, indent=2)},
                    "usage": "from nerya.sdk.factors import calculate_factor; values = calculate_factor(factor_snapshot, closed_candles)",
                    "note": "Copy the snapshot into the strategy package. Do not resolve latest on each bar. Revalidate on the target market."}
        return {"ok": True, **result}
    if action == "save":
        source = body.get("source_backtest")
        if source:
            source = backtest_context(config, source)["source_backtest"]
        return {"ok": True, **store.save(body.get("definition") or {}, expected_version=body.get("expected_version"),
                                        reason=str(body.get("reason") or ""), source_backtest=source)}
    if action in {"backtest", "extract"}:
        return {"ok": True, **backtest_context(config, body, include_source=action == "extract")}
    if action == "evaluate":
        from .evaluate import evaluate
        return evaluate(config, body, check_cancel=check_cancel)
    raise ValueError(f"unknown factor library action: {action}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--json", required=True, help="JSON operation payload")
    args = parser.parse_args()
    from .....core.config import load_config
    try:
        result = operation(load_config(args.workspace), json.loads(args.json))
    except (ValueError, TypeError) as exc:
        result = {"ok": False, "error": str(exc)}
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
