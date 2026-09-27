"""Compact discovery without removing skills or widening an operator allowlist.

Nested playbooks belong to their nearest available hub. A flat compatibility
playbook can name ``metadata.nerya.catalog_parent`` in SKILL.md. Exact lookup,
script paths and permissions are unchanged; only the advertised catalog folds.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable


def catalog_parent(metadata: Any) -> str:
    """Read optional discovery metadata, never execution or permission policy."""
    nerya = metadata.get("nerya") if isinstance(metadata, dict) else None
    value = nerya.get("catalog_parent") if isinstance(nerya, dict) else None
    return value.strip() if isinstance(value, str) else ""


def catalog_roots(rows: Iterable[tuple[str, Path | None, str]]) -> dict[str, str]:
    """Map each entry to its visible workflow, without changing permissions."""
    entries = {name: (path, parent) for name, path, parent in rows}
    parents: dict[str, str] = {}
    for name, (path, declared) in entries.items():
        if declared in entries and declared != name:
            parents[name] = declared
        elif path is not None:
            ancestors = [
                (len(other.parts), candidate)
                for candidate, (other, _) in entries.items()
                if (other is not None and other in path.parents
                    and name.startswith(candidate + "."))
            ]
            if ancestors:
                parents[name] = max(ancestors)[1]
    roots = {name: name for name in entries}
    for name in parents:
        seen = {name}
        current = parents[name]
        while current in parents and current not in seen:
            seen.add(current)
            current = parents[current]
        if current not in seen:
            roots[name] = current
        # Fail open for catalog mistakes; do not make a cycle disappear.
    return roots


def catalog_ids(rows: Iterable[tuple[str, Path | None, str]]) -> set[str]:
    """Return visible IDs; missing hubs and malformed cycles stay discoverable."""
    return {name for name, root in catalog_roots(rows).items() if name == root}


def catalog_group(metadata: Any) -> str:
    """Optional presentation group; unknown/custom entries stay in core."""
    nerya = metadata.get("nerya") if isinstance(metadata, dict) else None
    return "professional" if isinstance(nerya, dict) and nerya.get("catalog_group") == "professional" else "core"
