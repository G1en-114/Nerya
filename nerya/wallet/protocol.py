"""Wallet-provider protocol.

All providers implement the same narrow surface: discover readiness,
fetch a balance, request a swap quote, and — when the operator has
enabled live trading — execute a swap. Anything else specific to a
backend (approvals, bridging ...) is up to the provider to expose via
``extra`` keys in the returned dicts.

Providers additionally declare a static :class:`WalletCapabilities`
ceiling so the operator UI can honestly distinguish:

- *installed* — the provider class ships with Nerya.
- *dependency-ready* — all required SDK / Node / credential bits are
  present (reported by :meth:`WalletProvider.readiness`).
- *execution-ready* — each method is actually wired to a real backend
  (see :attr:`WalletCapability.status`).
- *experimental / stub* — the overall provider profile
  (:attr:`WalletCapabilities.execution_profile`).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable


# Capability-status vocabulary. Kept tiny so the operator UI does not
# have to guess.
CAPABILITY_STATUS = ("real", "partial", "experimental", "stub")

# Provider-level execution-profile vocabulary.
EXECUTION_PROFILE = ("production", "partial", "experimental", "stub")


@dataclass
class WalletCapability:
    """How truthful a single provider method is."""

    supported: bool = False
    status: str = "stub"
    note: str = ""

    def __post_init__(self) -> None:
        if self.status not in CAPABILITY_STATUS:
            raise ValueError(
                f"WalletCapability.status must be one of {CAPABILITY_STATUS}, "
                f"got {self.status!r}"
            )

    def to_dict(self) -> dict[str, Any]:
        return {
            "supported": bool(self.supported),
            "status": self.status,
            "note": self.note,
        }


@dataclass
class WalletCapabilities:
    """Static ceiling of what a provider can really do.

    ``execution_profile`` rolls up the per-method statuses for display:
    the operator UI can show a single truthful pill next to each
    provider without having to interpret the per-method table.
    """

    balance: WalletCapability = field(default_factory=WalletCapability)
    quote: WalletCapability = field(default_factory=WalletCapability)
    swap: WalletCapability = field(default_factory=WalletCapability)
    market_data: WalletCapability = field(default_factory=WalletCapability)
    execution_profile: str = "stub"
    chains: tuple[str, ...] = ()
    notes: str = ""
    swap_chains: tuple[str, ...] = ()
    order_types: tuple[str, ...] = ("market",)
    protection_types: tuple[str, ...] = ()
    minimum_output: str = "unknown"
    receipt_polling: bool = False

    def __post_init__(self) -> None:
        if self.execution_profile not in EXECUTION_PROFILE:
            raise ValueError(
                f"WalletCapabilities.execution_profile must be one of "
                f"{EXECUTION_PROFILE}, got {self.execution_profile!r}"
            )

    def to_dict(self) -> dict[str, Any]:
        return {
            "balance": self.balance.to_dict(),
            "quote": self.quote.to_dict(),
            "swap": self.swap.to_dict(),
            "market_data": self.market_data.to_dict(),
            "execution_profile": self.execution_profile,
            "chains": list(self.chains),
            "notes": self.notes,
            "swap_chains": list(self.swap_chains),
            "order_types": list(self.order_types),
            "protection_types": list(self.protection_types),
            "minimum_output": self.minimum_output,
            "receipt_polling": self.receipt_polling,
        }


@dataclass
class WalletReadiness:
    """Snapshot of whether a provider can be used right now.

    ``installed`` is always ``True`` for providers that ship with Nerya
    (the catalog is static), but is surfaced so downstream callers do
    not have to re-derive it. ``ready`` requires the provider's live
    dependencies and credentials to be present — i.e. dependency-ready.
    """

    provider: str
    ready: bool
    missing: list[str] = field(default_factory=list)
    install_hint: str = ""
    reason: str = ""
    installed: bool = True

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "ready": self.ready,
            "installed": self.installed,
            "missing": list(self.missing),
            "install_hint": self.install_hint,
            "reason": self.reason,
        }


@dataclass
class WalletQuote:
    provider: str
    chain: str
    token_in: str
    token_out: str
    amount_in: float
    expected_out: float
    min_out: float
    slippage_bps: int
    price_impact_bps: int = 0
    gas_cost_usd: float = 0.0
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "chain": self.chain,
            "token_in": self.token_in,
            "token_out": self.token_out,
            "amount_in": self.amount_in,
            "expected_out": self.expected_out,
            "min_out": self.min_out,
            "slippage_bps": self.slippage_bps,
            "price_impact_bps": self.price_impact_bps,
            "gas_cost_usd": self.gas_cost_usd,
            "extra": dict(self.extra),
        }


@dataclass
class WalletSwapResult:
    provider: str
    chain: str
    ok: bool
    tx_hash: str = ""
    amount_in: float = 0.0
    amount_out: float = 0.0
    reason: str = ""
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "chain": self.chain,
            "ok": self.ok,
            "tx_hash": self.tx_hash,
            "amount_in": self.amount_in,
            "amount_out": self.amount_out,
            "reason": self.reason,
            "extra": dict(self.extra),
        }


@dataclass
class WalletBalance:
    provider: str
    chain: str
    address: str
    token: str
    balance: float
    symbol: str = ""
    decimals: int = 18

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "chain": self.chain,
            "address": self.address,
            "token": self.token,
            "balance": self.balance,
            "symbol": self.symbol,
            "decimals": self.decimals,
        }


@runtime_checkable
class WalletProvider(Protocol):
    """Protocol every wallet backend implements."""

    id: str
    label: str

    def readiness(self) -> WalletReadiness: ...

    def capabilities(self) -> WalletCapabilities:
        """Return the static capability ceiling for this provider."""
        ...

    def get_balance(
        self, *, chain: str, address: str, token: str, **kw: Any,
    ) -> WalletBalance: ...

    def quote(
        self, *, chain: str, token_in: str, token_out: str,
        amount_in: float, slippage_bps: int = 50, **kw: Any,
    ) -> WalletQuote: ...

    def swap(
        self, *, chain: str, token_in: str, token_out: str,
        amount_in: float, slippage_bps: int = 50,
        receiver: str | None = None, live: bool = False, **kw: Any,
    ) -> WalletSwapResult: ...

    def get_execution_status(self, *, request: dict, transaction: dict) -> WalletSwapResult:
        """Read an existing transaction; never sign, send or re-create an order.

        Custodial adapters may override to resolve an execution_ref before
        passing the resulting hash to the shared chain receipt reader.
        """
        from .confirmation import read_transaction
        return read_transaction(self.id, getattr(self, 'config', {}), request, transaction,
                                transport=getattr(self, 'transport', None))

    def get_token_klines(self, *, chain: str, token: str, interval: str = '1h', limit: int = 100, **kw):
        """Public USD token candles; adapters may override with declared units."""
        from ..data.onchain_klines import fetch_token_klines
        return fetch_token_klines(chain,token,interval=interval,limit=limit,
            **{k:kw[k] for k in ('start','end','token_mint') if k in kw})
