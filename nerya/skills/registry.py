"""Registry holds loaded manifests + (optional) action handlers.

Aligned with the Anthropic Skill spec (agent skill runtime): a skill
is a markdown playbook with minimal YAML frontmatter, plus standalone
scripts the agent invokes via ``run_shell``. The registry only loads
the manifest; it does **not** auto-import any Python from the skill
directory. ``actions == {}`` for every skill loaded this way and the
runtime never dispatches them — the agent reads the markdown and
decides what to do.

Procedural single-file ``SKILL.md`` skills (one ``run`` action) are
still supported via :mod:`nerya.skills.procedural` for ergonomic user
playbooks.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import hashlib
import json
from typing import Any, Callable

from ..core import yaml_io
from ..core.errors import SkillNotFoundError
from .manifest import ActionSpec, SkillManifest, _slugify
from .discovery import catalog_ids, catalog_parent


def _enabled_ok(skill_id: str, enabled: set[str] | None) -> bool:
    """True when ``skill_id`` passes the operator allow-list.

    A namespaced sub-skill inherits its hub's entry: enabling
    ``expert_investors`` also enables ``expert_investors.buffett`` so
    operators list one hub id instead of chasing every expert added
    later. An exact id in the list always works too (e.g. enabling a
    single ``finance.equity_research.earnings_analysis`` leaf).
    """

    if enabled is None:
        return True
    skill_id = _slugify(skill_id)
    names = {_slugify(str(name)) for name in enabled if str(name).strip()}
    return skill_id in names or any(skill_id.startswith(f"{parent}.") for parent in names)


@dataclass
class SkillEntry:
    manifest: SkillManifest
    module: Any
    actions: dict[str, Callable] = field(default_factory=dict)

    def action(self, name: str) -> Callable:
        if name not in self.actions:
            raise SkillNotFoundError(f"action {self.manifest.id}.{name} not implemented")
        spec = self.manifest.actions.get(name)
        if spec is not None and spec.status == "proposal_only_unimplemented":
            raise SkillNotFoundError(
                f"action {self.manifest.id}.{name} is proposal_only_unimplemented; "
                "operator must implement and clear the status flag"
            )
        if self.manifest.status == "proposal_only_unimplemented":
            raise SkillNotFoundError(
                f"skill {self.manifest.id} is proposal_only_unimplemented; "
                "operator must implement and clear the status flag"
            )
        return self.actions[name]

    def spec(self, name: str) -> ActionSpec:
        if name not in self.manifest.actions:
            raise SkillNotFoundError(f"action spec {self.manifest.id}.{name} missing")
        return self.manifest.actions[name]


class SkillRegistry:
    def __init__(self) -> None:
        self.by_id: dict[str, SkillEntry] = {}
        self.definitions: list[SkillEntry] = []

    def register(self, entry: SkillEntry) -> None:
        self.by_id[entry.manifest.id] = entry

    def get(self, skill_id: str) -> SkillEntry:
        if skill_id in self.by_id:
            return self.by_id[skill_id]
        canonical = _slugify(skill_id)
        for entry in self.by_id.values():
            if canonical == _slugify(entry.manifest.id):
                return entry
        raise SkillNotFoundError(skill_id)

    def list(self) -> list[SkillEntry]:
        """All enabled entries, including exact-name compatibility playbooks."""
        return list(self.by_id.values())

    def catalog(self) -> list[SkillEntry]:
        """Primary workflows only; exact lookup and enabled scope stay unchanged."""
        entries = self.list()
        visible = catalog_ids(
            (e.manifest.id, e.manifest.path, catalog_parent(e.manifest.metadata))
            for e in entries
        )
        return [e for e in entries if e.manifest.id in visible]

    @property
    def catalog_generation(self) -> str:
        """Content token shared by management, Composer and live tool indexes."""
        return catalog_generation(self.list())

    @classmethod
    def load_builtin(cls, workspace_paths=None, *, config=None,
                     include_disabled: bool = False) -> "SkillRegistry":
        """One resolver: workspace > installed > home > builtin.

        All candidates remain available to the operator catalog; only effective
        enabled definitions enter the runtime. Loading never imports scripts.
        """
        roots = [(Path(__file__).parent / "builtin", "builtin")]
        if workspace_paths is not None:
            user_roots = _user_skill_roots(workspace_paths)
            roots += [(root, "user_home") for root in user_roots[1:]]
            roots += [(workspace_paths.skills_installed, "workspace_installed"),
                      (workspace_paths.skills, "workspace")]
        reg = cls()
        for root, source in roots:
            reg.definitions.extend(discover_entries(root, source=source))
        enabled = None if include_disabled else enabled_skill_names(workspace_paths)
        for entry in reg.definitions:
            if _enabled_ok(entry.manifest.id, enabled):
                reg.register(entry)
        return reg


def enabled_skill_names(workspace_paths) -> set[str] | None:
    if workspace_paths is None:
        return None
    doc = yaml_io.load(workspace_paths.skills_enabled, default={}) or {}
    names = doc.get("enabled") if isinstance(doc, dict) else None
    return {str(name).strip() for name in names if str(name).strip()} if isinstance(names, list) else None


def catalog_generation(entries) -> str:
    rows = sorted((e.manifest.id, e.manifest.source, str(e.manifest.path),
                   e.manifest.entry_file, e.manifest.revision) for e in entries)
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False).encode()).hexdigest()


def load_entry(md: Path, *, source: str = "workspace", procedural: bool = False) -> SkillEntry | None:
    """Parse once for registry, standalone native callers and management."""
    if not md.is_file() or md.is_symlink() or md.parent.is_symlink():
        return None
    try:
        if md.name == "SKILL.md" and not procedural:
            manifest = SkillManifest.from_skill_md(md)
            manifest.source = source
            return SkillEntry(manifest=manifest, module=None)
    except Exception:
        if source == "builtin":
            return None
    if source == "builtin":
        return None
    from .procedural import load_procedural_skill, make_run_handler
    try:
        skill = load_procedural_skill(md)
        if skill is None:
            return None
        manifest = skill.manifest
        manifest.id = _slugify(manifest.id)
        manifest.source = source
        manifest.entry_file = md.name
        manifest.instructions = skill.body
        manifest.revision = hashlib.sha256(md.read_bytes()).hexdigest()
        return SkillEntry(manifest=manifest, module=None, actions={"run": make_run_handler(
            skill.body, manifest.id, manifest.title, list(manifest.tags or []),
        )})
    except (OSError, UnicodeError):
        return None


def discover_entries(root: Path, *, source: str = "workspace") -> list[SkillEntry]:
    if not root.is_dir() or root.is_symlink():
        return []
    files = ([(md, True) for md in sorted(root.glob("*.md"))]
             if source != "builtin" else [])
    files += [(md, False) for _, md in _walk_skill_dirs(root)]
    return [entry for md, procedural in files
            if (entry := load_entry(md, source=source, procedural=procedural)) is not None]


def list_bundled_skill_names() -> list[str]:
    """Return the allow-listed built-in skill names shipped with Nerya.

    Nerya's historical directory name is ``skills/builtin``. The
    AgentArchitecturePatterns vocabulary calls these bundled skills; this
    function is the compatibility allowlist surface for that concept.
    """

    bundled_root = Path(__file__).parent / "builtin"
    if not bundled_root.exists():
        return []
    names: list[str] = []
    for _d, md in _walk_skill_dirs(bundled_root):
        try:
            names.append(SkillManifest.from_skill_md(md).id)
        except Exception:
            continue
    return sorted(set(names))


def _user_skill_roots(workspace_paths) -> list[Path]:
    """Return additional procedural-skill roots ordered by precedence.

    Order: workspace top-level (overrides home), then ``~/.nerya/skills/``.
    The returned paths are never resolved against the workspace ``installed``
    subdirectory (those are handled separately).
    """

    import os
    out: list[Path] = []
    out.append(workspace_paths.skills)  # workspace/skills/
    home = os.environ.get("NERYA_USER_SKILLS_ROOT")
    if home:
        out.append(Path(home).expanduser())
    else:
        out.append(Path.home() / ".nerya" / "skills")
    return out


# Directories that, when found *inside* a skill folder, are the skill's own
# asset subtree and must NOT be re-scanned for nested skills. Keeping the
# walker conservative here is what stops a SKILL.md under
# ``references/``/``scripts/`` from being mis-registered as its own skill.
_SKILL_ASSET_DIRS: frozenset[str] = frozenset(
    {"references", "scripts", "tests", "templates", "__pycache__"}
)


def _walk_skill_dirs(root: Path):
    """Yield ``(skill_dir, SKILL.md path)`` for every skill below *root*.

    The walker treats *any* directory whose direct child is ``SKILL.md``
    as a skill. It then keeps scanning that skill's *direct* non-asset
    subdirectories so a hub skill can index expert sub-skills, e.g.
    ``expert_investors/SKILL.md`` (router) plus
    ``expert_investors/buffett/SKILL.md`` (one lens per sub-skill —
    loading a single expert must not pull every expert into context).
    Asset directories (``scripts/``, ``references/``, …) are never
    scanned, which is what stops a SKILL.md under ``references/`` from
    being mis-registered as its own skill. When a directory has no
    ``SKILL.md`` of its own and is not an asset directory, the walker
    recurses into it so namespaces like
    ``finance/private_equity/ic_memo/SKILL.md`` are picked up.

    Hidden directories (``.something``), the ``installed`` subtree
    (handled separately by :meth:`SkillRegistry.load_builtin`), and
    ``__pycache__`` are always skipped.
    """

    if not root.is_dir():
        return
    for entry in sorted(root.iterdir()):
        if not entry.is_dir() or entry.is_symlink():
            continue
        if entry.name.startswith(".") or entry.name in {"installed", "pending", "rejected"}:
            continue
        if entry.name in _SKILL_ASSET_DIRS:
            continue
        md = entry / "SKILL.md"
        if md.exists():
            yield entry, md
        # Recurse either way: a skill directory may host nested
        # sub-skills in its non-asset subdirectories.
        yield from _walk_skill_dirs(entry)
