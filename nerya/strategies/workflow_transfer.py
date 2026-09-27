"""Portable strategy source bundles. Import stages a review, never runs code."""
from __future__ import annotations

import ast
import json
import re
from pathlib import PurePosixPath
from typing import Any
from uuid import uuid4

import yaml

from ..core import yaml_io
from ..core.paths import WorkspacePaths
from ..evolution.patch_proposal import create_proposal, list_proposals
from ..security.secret_scanner import SecretBuffer, scan_and_redact
from .validator import validate_proposal_files
from .workflow_graph import (
    MAX_FILE_BYTES, WORKFLOW_FILE, WorkflowError, build_workflows,
    package_revision, parse_metadata, read_manifest, safe_relative_path,
)
from .workflow_service import _LOCK, _MAX_TOTAL_BYTES, _SKIP_DIRS, _safe_root, source_files, view_workflow

FORMAT = "nerya.strategy"
VERSION = 1
MAX_FILES = 200
_SUFFIXES = {".py", ".yml", ".yaml", ".md", ".json", ".txt"}
_PRIVATE_PARTS = _SKIP_DIRS | {"vault", "credentials", "wallets", "approvals"}
_PRIVATE_STEMS = {"secrets", "credentials", "accounts", "private_key", "api_key", "password", "token"}
_SENSITIVE = re.compile(r"^(?:api[_-]?key|api[_-]?secret|secret|secret[_-]?key|private[_-]?key|access[_-]?token|password|passphrase|mnemonic|seed[_-]?phrase)$", re.I)


def _check_secrets(name: str, text: str) -> None:
    # Do not redact source silently: a redacted export is not a round trip.
    buffer = SecretBuffer()
    try:
        captures = scan_and_redact(text, buffer=buffer).captures
        if any(c.kind in {"evm_private_key", "jwt", "aws_access_key", "prefixed_secret", "base58_key"} for c in captures):
            raise WorkflowError(f"Possible plaintext credential in {name}; use vault references before transferring")
    finally:
        buffer.clear()

    visited: set[int] = set()

    def check(key: Any, value: Any) -> None:
        if isinstance(value, (dict, list)):
            if id(value) in visited:
                return
            visited.add(id(value))
        if isinstance(value, str) and value.strip() and _SENSITIVE.fullmatch(str(key)):
            if not value.startswith(("vault://", "${")):
                raise WorkflowError(f"Plaintext credential field in {name}; use a vault reference")
        if isinstance(value, dict):
            for k, v in value.items():
                check(k, v)
        elif isinstance(value, list):
            for v in value:
                check("", v)

    try:
        if name.endswith((".yml", ".yaml", ".json")):
            check("", json.loads(text) if name.endswith(".json") else yaml_io.loads(text))
        elif name.endswith(".py"):
            for node in ast.walk(ast.parse(text, filename=name)):
                if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant):
                    for target in node.targets:
                        if isinstance(target, ast.Name):
                            check(target.id, node.value.value)
                elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and isinstance(node.value, ast.Constant):
                    check(node.target.id, node.value.value)
    except SyntaxError:
        # Python syntax errors are reported below without execution.
        pass
    except (yaml.YAMLError, ValueError, RecursionError) as exc:
        raise WorkflowError(f"Invalid structured source in {name}") from exc


def _checked_files(value: Any) -> dict[str, str]:
    if not isinstance(value, dict) or not value or len(value) > MAX_FILES:
        raise WorkflowError(f"A strategy bundle must contain 1–{MAX_FILES} text files")
    files: dict[str, str] = {}
    names: set[str] = set()
    total = 0
    for name, text in value.items():
        if not isinstance(name, str) or len(name) > 240 or any(ord(c) < 32 for c in name) or ":" in name:
            raise WorkflowError("Invalid strategy package path")
        safe_relative_path(name)
        path = PurePosixPath(name)
        if (any(p.startswith(".") or p.lower() in _PRIVATE_PARTS for p in path.parts)
                or path.stem.lower() in _PRIVATE_STEMS or path.suffix not in _SUFFIXES
                or name == "validation_report.json"):
            raise WorkflowError(f"Non-portable or private package file: {name}")
        if name.casefold() in names:
            raise WorkflowError("Package paths must be unique on case-insensitive filesystems")
        folded = name.casefold()
        if any(folded.startswith(other + "/") or other.startswith(folded + "/") for other in names):
            raise WorkflowError("Package contains conflicting file and directory paths")
        names.add(folded)
        if not isinstance(text, str) or "\0" in text:
            raise WorkflowError(f"Package file must contain UTF-8 text: {name}")
        try:
            size = len(text.encode("utf-8"))
        except UnicodeEncodeError as exc:
            raise WorkflowError(f"Invalid UTF-8 text in {name}") from exc
        total += size
        if size > MAX_FILE_BYTES or total > _MAX_TOTAL_BYTES:
            raise WorkflowError("Strategy bundle exceeds the 200 KB/file or 4 MB total limit")
        _check_secrets(name, text)
        files[name] = text
    if "strategy.yml" not in files:
        raise WorkflowError("Strategy bundle must include strategy.yml")
    return files


def export_workflow(paths: WorkspacePaths, strategy_id: str, proposal_id: str | None = None,
                    *, base_revision: str | None = None) -> dict[str, Any]:
    with _LOCK:
        files, source = source_files(paths, strategy_id, proposal_id)
        if source["omitted_files"]:
            raise WorkflowError("Export refused: package contains unreadable, oversized or symlinked source files")
        revision = package_revision(files)
        if base_revision and revision != base_revision:
            raise WorkflowError("revision_conflict: strategy changed; reload before exporting")
        files = _checked_files(files)
        manifest = read_manifest(files)
        if (manifest.get("strategy_id") or manifest.get("id")) != strategy_id:
            raise WorkflowError("Manifest strategy ID does not match the package")
        return {"ok": True, "filename": f"{strategy_id}.nerya.json", "bundle": {
            "format": FORMAT, "version": VERSION, "strategy_id": strategy_id,
            "title": str(manifest.get("title") or strategy_id),
            "revision": revision, "files": files,
        }}


def _available(paths: WorkspacePaths, strategy_id: str) -> None:
    target = _safe_root(paths.strategies, strategy_id)
    if target.exists():
        raise WorkflowError("strategy_id_conflict: choose a new strategy ID; existing strategies are not overwritten")
    for proposal in list_proposals(paths):
        if proposal.state not in {"applied", "rejected", "superseded", "rolled_back"}:
            if (proposal.path / "after" / "strategies" / strategy_id).exists():
                raise WorkflowError("strategy_id_conflict: this ID already has a pending proposal")


def import_workflow(paths: WorkspacePaths, payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise WorkflowError("Import request must be an object")
    bundle = payload.get("bundle")
    if not isinstance(bundle, dict) or bundle.get("format") != FORMAT or type(bundle.get("version")) is not int or bundle["version"] != VERSION:
        raise WorkflowError("Unsupported strategy bundle; expected nerya.strategy version 1")
    files = _checked_files(bundle.get("files"))
    manifest = read_manifest(files)
    original_id = manifest.get("strategy_id") or manifest.get("id")
    if not isinstance(original_id, str) or original_id != bundle.get("strategy_id"):
        raise WorkflowError("Bundle and manifest strategy IDs do not match")
    _safe_root(paths.strategies, original_id)
    strategy_id = payload.get("strategy_id") or f"{original_id[:100]}_import_{uuid4().hex[:8]}"
    _safe_root(paths.strategies, strategy_id)
    with _LOCK:
        _available(paths, strategy_id)
        for key in ("strategy_id", "id"):
            if key in manifest:
                manifest[key] = strategy_id
        # Import is a new, inert copy, not a restore of execution authority.
        manifest["mode"] = "paper"
        if "status" in manifest:
            manifest["status"] = "draft"
        for owner in (manifest, manifest.get("tuning")):
            if isinstance(owner, dict) and isinstance(owner.get("schedule"), dict):
                owner["schedule"]["enabled"] = False
        if isinstance(manifest.get("tuning"), dict):
            guardrails = manifest["tuning"].setdefault("guardrails", {})
            if not isinstance(guardrails, dict):
                raise WorkflowError("Invalid tuning guardrails")
            guardrails["require_operator_approval"] = True
        files["strategy.yml"] = yaml_io.dumps(manifest)
        if WORKFLOW_FILE in files:
            metadata = parse_metadata(files[WORKFLOW_FILE])
            old, new = f"strategy:{original_id}", f"strategy:{strategy_id}"
            if old in metadata["nodes"]:
                metadata["nodes"][new] = metadata["nodes"].pop(old)
            for edge in metadata["edges"]:
                for end in ("source", "target"):
                    if edge.get(end) == old:
                        edge[end] = new
            files[WORKFLOW_FILE] = json.dumps(metadata, ensure_ascii=False, indent=2) + "\n"
        _checked_files(files)
        view = build_workflows(files)
        # Validate Python syntax even for legacy prompt/config packages.
        for name, text in files.items():
            if name.endswith(".py"):
                try:
                    ast.parse(text, filename=name)
                except SyntaxError as exc:
                    raise WorkflowError(f"Invalid Python syntax in {name} at line {exc.lineno}") from exc
        if view["legacy"]:
            validation = {"ok": True, "blockers": [], "warnings": [], "legacy": True}
        else:
            report = validate_proposal_files(strategy_id=strategy_id, files=files, smoke_test=False)
            validation = report.asdict()
            if not report.ok:
                return {"ok": False, "error": "validation_failed", "validation": validation}
        validation["static_only"] = True
        _available(paths, strategy_id)
        proposal = create_proposal(
            paths, kind="prompt_patch" if view["legacy"] else "strategy_package_proposal",
            summary=f"Import · {manifest.get('title') or strategy_id}",
            rationale="Operator imported a portable strategy as a new paper-only copy. No source code was executed.",
            test_plan="Static validation only. Review source, account references and required backtests before approval.",
            rollback="No active strategy or schedules were changed; reject this proposal to discard the import.",
            target=f"strategies/{strategy_id}", initial_state="pending_review",
            extra_files={**{f"after/strategies/{strategy_id}/{rel}": text for rel, text in files.items()},
                         "validation_report.json": json.dumps(validation, indent=2)},
            metadata={"strategy_id": strategy_id, "workflow_import": True, "imported_from": original_id},
        )
        return {"ok": True, "strategy_id": strategy_id, "proposal_id": proposal.id,
                "state": proposal.state, "validation": validation,
                "workflow": view_workflow(paths, strategy_id, proposal.id)}
