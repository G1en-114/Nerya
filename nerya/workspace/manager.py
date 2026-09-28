"""Workspace lifecycle: init, load, journal accessors, state store accessors."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..core import yaml_io
from ..core.config import Config, load_config
from ..core.paths import WorkspacePaths, resolve_workspace
from .journal import Journal
from .layout import REQUIRED_JOURNALS, required_dirs
from .prompt_bundles import DEFAULT_BUNDLE_ID, load_bundle, seed_bundle
from .state_store import StateStore


@dataclass
class WorkspaceManager:
    config: Config

    @property
    def paths(self) -> WorkspacePaths:
        return self.config.paths

    @classmethod
    def load(cls, workspace: Path | str | None = None) -> "WorkspaceManager":
        return cls(config=load_config(workspace))

    @classmethod
    def init(cls, workspace: Path | str | None = None) -> "WorkspaceManager":
        paths = resolve_workspace(workspace)
        paths.root.mkdir(parents=True, exist_ok=True)
        for d in required_dirs(paths):
            d.mkdir(parents=True, exist_ok=True)
        # default nerya.yml
        if not paths.config.exists():
            from ..core.config import DEFAULT_CONFIG
            yaml_io.dump(paths.config, DEFAULT_CONFIG)
        # seed journals so tail works
        for name in REQUIRED_JOURNALS:
            p = paths.journal(name)
            if not p.exists():
                p.touch()
        # seed config files
        _seed_yaml(paths.skills_enabled, {"version": 1, "enabled": _DEFAULT_ENABLED_SKILLS})
        _seed_yaml(paths.exchanges_file, {"version": 1, "exchanges": {}})
        _seed_yaml(paths.accounts_file, {"version": 1, "accounts": [
            {"id": "paper_main", "exchange": "mock", "mode": "paper",
             "live_trading_enabled": False, "initial_balance_usd": 100000.0}
        ]})
        _seed_yaml(paths.secrets_refs_file, {"version": 1, "refs": {}})
        _seed_yaml(paths.triggers_routes_file, {"version": 1, "routes": _DEFAULT_ROUTES})
        _seed_yaml(paths.triggers_schedules_file, {"version": 1, "schedules": []})
        _seed_yaml(paths.messages_channels, {"version": 1, "channels": {
            "dashboard": {"kind": "dashboard"},
        }})
        # Declarative dashboard UI starts as an empty, versioned manifest.
        # Agent-authored changes still go through the proposal/approval
        # pipeline; seeding here only makes the active source explicit for
        # operators and for the files browser.
        if not paths.ui_workspace.exists():
            from .ui import DEFAULT_MANIFEST
            yaml_io.dump(paths.ui_workspace, DEFAULT_MANIFEST)
        # seed memory
        _seed_text(paths.memory / "global.md",
                   "# Global memory\n\nAgent-wide notes go here.\n")
        _seed_text(paths.memory / "mistakes.md",
                   "# Mistakes\n\nReflected mistakes, one bullet per entry.\n")
        _seed_text(paths.memory / "market_regimes.md",
                   "# Market regimes\n")
        _seed_text(paths.memory / "skill_learnings.md",
                   "# Skill learnings\n")
        # workspace prompts now ship as a real prompt
        # bundle under ``nerya/workspace/_prompt_bundles/<id>``.  The
        # bundle loader records provenance (sha256, source path, bundle
        # version) into ``agents/_provenance.yml`` so future migrations
        # can detect operator-edited prompts and avoid silently reverting
        # them.  The previous Python-literal seeding flow (which baked a
        # trading personality into the bootstrap path) is replaced by
        # :func:`seed_bundle`.
        seed_bundle(
            paths,
            bundle=load_bundle(DEFAULT_BUNDLE_ID),
        )
        # New workspaces deliberately contain no strategies. Only explicit user
        # creation/import may add one; repeated init never restores demo data.
        return cls.load(paths.root)

    # ---------- accessors ----------
    def journal(self, name: str) -> Journal:
        return Journal(self.paths.journal(name))

    def state(self) -> StateStore:
        return StateStore(self.paths.runtime_state)


_DEFAULT_ENABLED_SKILLS = [
    # These are SKILL.md playbook ids. Native tool availability and approval
    # live in the tool registry; do not duplicate tool/action names here.
    "analysis", "backtest", "browser", "coding", "evolve",
    "expert_investors", "finance-creators", "llm", "market_data_routing",
    "market_research",
    "markets", "memory", "news_social", "notify", "quant-strategy-loop",
    "quant_research", "factor_library",
    "research", "research_report", "strategy_author", "tasks", "team",
    "trading", "triggers", "self_modify", "plugin_author", "adapter",
    # Integration-gated: listed here but loaded only after configuration.
    "dcf_valuation", "equity_research", "sec_filings",
    # Canonical hubs expose specialist methods only on demand.
    "finance.equity_research", "finance.financial_analysis", "finance.fund_admin",
    "finance.investment_banking", "finance.operations", "finance.private_equity",
    "finance.wealth_management",
]


# No implicit demo routes or strategy-bound automation on a fresh installation.
_DEFAULT_ROUTES: list[dict[str, Any]] = []


def _seed_yaml(path: Path, data: dict[str, Any]) -> None:
    if not path.exists():
        yaml_io.dump(path, data)


def _seed_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text(content, encoding="utf-8")
