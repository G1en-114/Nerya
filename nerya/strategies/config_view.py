"""The manifest read model shared by runtime and isolated historical replay.

Only strategy-local manifest data belongs here, never workspace credentials or
the global Config. Extension fields remain available through ``extras`` for
compatibility; common parameters have explicit, documented accessors.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from typing import Any


@dataclass
class StrategyConfig:
    strategy_id: str
    title: str = ""
    mode: str = "paper"
    markets: tuple[str, ...] = ()
    accounts: tuple[str, ...] = ()
    news_sources: tuple[str, ...] = ()
    extras: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        # Isolate the facade from the manifest and its source snapshot.
        self.extras = deepcopy(self.extras)
        self.markets = tuple(self.markets)
        self.accounts = tuple(self.accounts)
        self.news_sources = tuple(self.news_sources)
        params = self.extras.get("params")
        if params is not None and not isinstance(params, dict):
            raise ValueError("strategy params must be a mapping")

    @property
    def params(self) -> dict[str, Any]:
        """A snapshot of authored parameters; preserves zero and false values."""
        return deepcopy(self.extras.get("params") or {})

    @property
    def timeframe(self) -> str:
        return str(self.extras.get("timeframe") or "")

    def __getitem__(self, key: str) -> Any:
        if not isinstance(key, str) or key.startswith("_"):
            raise KeyError(key)
        if key in {"strategy_id", "title", "mode", "markets", "accounts", "news_sources", "extras"}:
            return deepcopy(getattr(self, key))
        if key == "params":
            return self.params
        if key == "timeframe":
            return self.timeframe
        if key in self.extras:
            return deepcopy(self.extras[key])
        raise KeyError(key)

    def get(self, key: str, default: Any = None) -> Any:
        """Mapping-compatible lookup, restricted to manifest fields."""
        try:
            return self[key]
        except KeyError:
            return default
