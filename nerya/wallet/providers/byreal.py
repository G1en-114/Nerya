"""Byreal CLMM DEX (Solana) wallet provider.

Byreal (https://byreal.io) ships an AI-native CLI, ``@byreal-io/byreal-cli``
(bin ``byreal-cli``), for its concentrated-liquidity (CLMM) DEX on Solana.
Nerya treats it as an on-chain wallet provider: read-only commands
(``overview``, ``pools``, ``tokens``, ``pools klines``) need no wallet, while
swaps use the official router plus an explicitly selected keypair or vault
signer. CLI discovery and pool data remain available independently.

Nerya never installs the CLI implicitly. When it is absent the provider raises
:class:`WalletDependencyError` carrying the exact install command — either a
global ``npm install -g @byreal-io/byreal-cli`` or, inside a Nerya workspace,
the ``npm:@byreal-io/byreal-cli`` install handled by
:mod:`nerya.install.dep_installer`.

Wire details:

* Every command is invoked as ``byreal-cli -o json <subcommand> ...`` and the
  CLI replies with ``{"success": bool, "meta": {...}, "data": <payload>}``;
  this provider returns / parses the ``data`` payload.
* Byreal K-lines are per-**pool**, not per-token. ``get_token_klines`` therefore
  treats the ``token`` argument as a Byreal **pool address** (market id
  ``solana:<poolAddress>``). An optional ``token_mint`` keyword selects which
  side of the pool to chart; otherwise the CLI auto-detects the base token.
* On-chain timestamps are normalised to **seconds** to match Nerya's other
  on-chain candle sources (OKX OnchainOS / GeckoTerminal fallback).
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
from typing import Any

from ..errors import (
    WalletDependencyError,
    WalletError,
    WalletPolicyDenied,
    WalletQuoteError,
    WalletTransportError,
)
from ..protocol import (
    WalletBalance,
    WalletCapabilities,
    WalletCapability,
    WalletProvider,
    WalletQuote,
    WalletReadiness,
    WalletSwapResult,
)


_PACKAGE = "@byreal-io/byreal-cli"
_PACKAGE_SCOPE = "@byreal-io"
_PACKAGE_NAME = "byreal-cli"
_SAFE_PACKAGE = "byreal-io__byreal-cli"
_BIN = "byreal-cli"
_ENTRY = "dist/index.cjs"
_VERSION = "0.3.6"

_INSTALL_COMMAND = f"npm:{_PACKAGE}#version={_VERSION}&entry={_ENTRY}"

_SOLANA_ALIASES = {"solana", "sol", "mainnet-beta", "mainnet", ""}

# Balance-request routing: "" / native names must return ONLY native SOL,
# never a sum over every token row; "usd"/"total" is the explicit
# portfolio-USD request.
_NATIVE_SOL_TOKENS = {"", "sol", "wsol", "native"}
_PORTFOLIO_USD_TOKENS = {"usd", "total"}
# Canonical wrapped-SOL mint (case-folded) used to spot the native row.
_WRAPPED_SOL_MINT = "so11111111111111111111111111111111111111112"

# byreal-cli K-line intervals (src/core/types.ts KlineInterval).
_BYREAL_INTERVALS = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1h": "1h",
    "1hr": "1h",
    "60m": "1h",
    "4h": "4h",
    "12h": "12h",
    "1d": "1d",
    "day": "1d",
    "1day": "1d",
}


_CAPABILITIES = WalletCapabilities(
    balance=WalletCapability(
        supported=True,
        status="real",
        note="byreal-cli `wallet balance` for the locally configured Solana keypair.",
    ),
    quote=WalletCapability(
        supported=True,
        status="real",
        note="byreal-cli `swap execute --dry-run` returns a signed-quote preview (price impact, est. out).",
    ),
    swap=WalletCapability(
        supported=True,
        status="partial",
        note=(
            "Uses the official router quote and the explicit keypair, then signs, broadcasts and reads Solana transaction metadata after approval."
        ),
    ),
    market_data=WalletCapability(
        supported=True,
        status="real",
        note=(
            "Solana CLMM pool OHLCV via byreal-cli `pools klines`; the token field "
            "is the Byreal pool address (market id solana:<poolAddress>)."
        ),
    ),
    execution_profile="partial",
    chains=("solana",),
    notes=(
        "Read-only pools/tokens/overview/klines need no wallet. Swaps and CLMM "
        "positions use a local keypair from `byreal-cli setup`; keys never leave "
        "the host."
    ),
)


@dataclass
class ByrealWallet(WalletProvider):
    id: str = "byreal"
    label: str = "Byreal CLMM DEX (Solana)"
    cli_path: str = ""
    workspace: str = ""
    rpc_url: str = ""
    keypair_path: str = ""
    config: dict[str, Any] = field(default_factory=dict)
    transport: Any = None

    def _signer(self):
        if self.config.get('signer_ref'):
            from .self_custody import SelfCustodyWallet
            return SelfCustodyWallet(signer_ref=self.config['signer_ref'],workspace=self.workspace)._resolve_signer_key()
        path = str(self.keypair_path or self.config.get('keypair_path') or '')
        if not path:
            raise WalletPolicyDenied('Byreal execution requires an explicit keypair_path or vault signer_ref')
        data = json.loads(Path(path).expanduser().read_text())
        if not isinstance(data,list) or len(data) != 64 or any(not isinstance(x,int) or not 0<=x<=255 for x in data):
            raise WalletPolicyDenied('invalid configured Solana keypair file')
        import base58
        return base58.b58encode(bytes(data)).decode()

    def _solana(self, *, live=False):
        from ...connectors.solana_native import SolanaNative
        kwargs = {'transport':self.transport} if self.transport else {}
        return SolanaNative(live=live,rpc_url=self.rpc_url or self.config.get('rpc_url') or 'https://api.mainnet-beta.solana.com',**kwargs)

    def _api_quote(self, token_in, token_out, amount_in, slippage_bps, owner):
        from ...connectors.http import UrllibHttp
        from ..amounts import to_base_units
        conn = self._solana()
        sol = 'So11111111111111111111111111111111111111112'
        mint_in = sol if token_in.upper() in ('SOL','NATIVE') else token_in
        mint_out = sol if token_out.upper() in ('SOL','NATIVE') else token_out
        dec_in = 9 if mint_in==sol else conn.get_mint_decimals(mint_in)
        dec_out = 9 if mint_out==sol else conn.get_mint_decimals(mint_out)
        body = {'inputMint':mint_in,'outputMint':mint_out,'amount':str(to_base_units(amount_in,dec_in)),
            'swapMode':'in','slippageBps':str(slippage_bps),'userPublicKey':owner,
            'broadcastMode':'priority','feeType':'maxCap','feeAmount':'10000000',
            'cuPrice':str(self.config.get('compute_unit_price') or 100000)}
        if mint_in==sol: body['createInputAta']=True
        if mint_out==sol: body['createOutputAta']=True
        status,doc = (self.transport or UrllibHttp()).request('POST',
            'https://api2.byreal.io/byreal/api/router/v1/router-service/swap',body=body,timeout=30)
        quote = (doc or {}).get('result') or {}
        if status>=400 or not quote.get('outAmount') or int(quote['outAmount'])<=0:
            error=quote.get('result') if isinstance(quote.get('result'),dict) else doc or {}
            raise WalletQuoteError('Byreal router returned no executable quote: '+
                str(error.get('retMsg') or error.get('message') or 'no route/output'))
        if quote.get('inputMint') != mint_in or quote.get('outputMint') != mint_out or int(quote.get('inAmount') or 0)!=int(body['amount']):
            raise WalletQuoteError('Byreal quote asset/amount mismatch')
        return quote,dec_in,dec_out

    # ------------------------------------------------------------------
    # CLI resolution
    # ------------------------------------------------------------------
    def _cli_command(self) -> list[str] | None:
        """Return the argv prefix that runs byreal-cli, or ``None``.

        Resolution order: explicit ``cli_path`` → workspace npm install
        (``skills/_node/<safe>/node_modules/.bin``) → the package entry run
        through ``node`` → ``byreal-cli`` on ``PATH``.
        """

        if self.cli_path:
            p = Path(self.cli_path)
            if p.exists():
                if p.suffix in (".cjs", ".js", ".mjs"):
                    return ["node", str(p)]
                return [str(p)]

        if self.workspace:
            root = Path(self.workspace) / "skills" / "_node" / _SAFE_PACKAGE
            bin_names = [f"{_BIN}.cmd", _BIN] if os.name == "nt" else [_BIN]
            for bin_name in bin_names:
                shim = root / "node_modules" / ".bin" / bin_name
                if shim.exists():
                    return [str(shim)]
            entry = (
                root / "node_modules" / _PACKAGE_SCOPE / _PACKAGE_NAME / "dist" / "index.cjs"
            )
            if entry.exists():
                return ["node", str(entry)]

        resolved = shutil.which(_BIN)
        if resolved:
            return [resolved]
        return None

    def _node_available(self) -> bool:
        return shutil.which("node") is not None

    def _missing(self) -> list[str]:
        missing: list[str] = []
        if not self._node_available():
            missing.append("bin:node")
        if not self._cli_command():
            missing.append(f"npm:{_PACKAGE}")
        return missing

    def _install_hint(self) -> str:
        return (
            f"Install the Byreal CLI: `npm install -g {_PACKAGE}` (exposes "
            f"`{_BIN}` on PATH), or let Nerya install it into the workspace via "
            f"`{_INSTALL_COMMAND}`. Read-only pools/tokens/overview/klines work "
            "immediately; run `byreal-cli setup` only for wallet-signed swaps/positions."
        )

    # ------------------------------------------------------------------
    # Subprocess
    # ------------------------------------------------------------------
    @staticmethod
    def _extract_json(text: str) -> Any | None:
        cleaned = re.sub(r"\x1b\[[0-9;]*m", "", text or "")
        decoder = json.JSONDecoder()
        for idx, ch in enumerate(cleaned):
            if ch in "{[":
                try:
                    obj, _ = decoder.raw_decode(cleaned[idx:])
                    return obj
                except json.JSONDecodeError:
                    continue
        return None

    def _run_cli(self, args: list[str], *, timeout_s: float = 45.0) -> Any:
        cmd = self._cli_command()
        if not cmd:
            raise WalletDependencyError(self.id, self._missing(), self._install_hint())
        env = os.environ.copy()
        if self.rpc_url:
            env.setdefault("BYREAL_RPC_URL", self.rpc_url)
            env.setdefault("SOLANA_RPC_URL", self.rpc_url)
        # Suppress the CLI's background auto-update / update-notice noise so JSON
        # output stays clean and deterministic for parsing.
        env.setdefault("BYREAL_DISABLE_AUTO_UPDATE", "1")
        env.setdefault("BYREAL_NO_UPDATE_NOTIFIER", "1")
        env.setdefault("NO_UPDATE_NOTIFIER", "1")
        full = [*cmd, "-o", "json", "--non-interactive", *args]
        try:
            proc = subprocess.run(
                full,
                cwd=self.workspace or None,
                env=env,
                capture_output=True,
                timeout=timeout_s,
                check=False,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
        except FileNotFoundError as exc:
            raise WalletDependencyError(
                self.id,
                ["bin:node"],
                "Install Node 18+: https://nodejs.org/",
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise WalletTransportError(
                f"byreal-cli {' '.join(args)} timed out after {timeout_s}s"
            ) from exc
        doc = self._extract_json(proc.stdout or "")
        if isinstance(doc, dict) and doc.get("success") is False:
            err = doc.get("error")
            if isinstance(err, dict):
                msg = err.get("message") or err.get("code") or "unknown error"
            else:
                msg = str(err or "unknown error")
            raise WalletTransportError(f"byreal-cli {' '.join(args)} failed: {msg}")
        if proc.returncode != 0 and not (
            isinstance(doc, dict) and doc.get("success") is True
        ):
            # A failing CLI can still print parseable JSON (partial
            # output, banner, error payload without success:false).
            # Non-zero exit is a transport failure unless the doc
            # explicitly reports success — never a silent pass.
            detail = (proc.stderr or proc.stdout or "").strip()[-512:]
            raise WalletTransportError(
                f"byreal-cli {' '.join(args)} exited {proc.returncode}: {detail}"
            )
        if isinstance(doc, dict) and "data" in doc:
            return doc.get("data")
        return doc

    @staticmethod
    def _require_solana(chain: str) -> None:
        if str(chain or "").strip().lower() not in _SOLANA_ALIASES:
            raise WalletPolicyDenied(
                f"Byreal is a Solana-only DEX; unsupported chain {chain!r}"
            )

    # ------------------------------------------------------------------
    # Protocol surface
    # ------------------------------------------------------------------
    def readiness(self) -> WalletReadiness:
        explicit_signer = bool(self.keypair_path or self.config.get('keypair_path') or self.config.get('signer_ref'))
        missing = [] if explicit_signer else self._missing()
        reasons: list[str] = []
        if missing:
            reasons.append("Byreal CLI (byreal-cli) is not installed.")
        if explicit_signer:
            for module, dependency in (('nacl.signing','pynacl'),('base58','base58')):
                try:
                    __import__(module)
                except ImportError:
                    missing.append('pip:'+dependency)
                    reasons.append('Direct signing requires '+dependency)
        keypair = str(
            self.keypair_path or self.config.get("keypair_path") or ""
        ).strip()
        if keypair and not Path(keypair).expanduser().exists():
            missing = [*missing, f"keypair:{keypair}"]
            reasons.append(f"Configured keypair path does not exist: {keypair}")
        ready = not missing
        return WalletReadiness(
            provider=self.id,
            ready=ready,
            missing=missing,
            install_hint="" if ready else self._install_hint(),
            reason=("Direct wallet RPC/router ready; CLI pool discovery requires byreal-cli separately."
                    if ready and explicit_signer else "" if ready else " ".join(reasons)),
        )

    def capabilities(self) -> WalletCapabilities:
        from dataclasses import replace
        return replace(_CAPABILITIES,swap_chains=('solana',),minimum_output='enforced',receipt_polling=True)

    # ------------------------------------------------------------------
    # On-chain data scraping helpers (read-only, no wallet required)
    # ------------------------------------------------------------------
    def overview(self) -> dict[str, Any]:
        """Global Byreal DEX statistics (TVL, volume, fees)."""

        data = self._run_cli(["overview"], timeout_s=30.0)
        return data if isinstance(data, dict) else {"raw": data}

    def list_pools(
        self,
        *,
        sort_field: str = "tvl",
        sort_type: str = "desc",
        limit: int = 20,
        category: str = "",
        **_kw: Any,
    ) -> list[dict[str, Any]]:
        """List CLMM pools (sortable by tvl/volumeUsd24h/feeUsd24h/apr24h)."""

        args = [
            "pools",
            "list",
            "--sort-field",
            str(sort_field or "tvl"),
            "--sort-type",
            str(sort_type or "desc"),
            "--page-size",
            str(max(1, min(int(limit or 20), 100))),
        ]
        if category:
            args += ["--category", str(category)]
        data = self._run_cli(args, timeout_s=30.0)
        pools = data.get("pools") if isinstance(data, dict) else data
        return [row for row in pools if isinstance(row, dict)] if isinstance(pools, list) else []

    def pool_info(self, pool: str) -> dict[str, Any]:
        """Detailed information about a single pool."""

        pool_s = str(pool or "").strip()
        if not pool_s:
            raise WalletPolicyDenied("Byreal pool info requires a pool address")
        data = self._run_cli(["pools", "info", pool_s], timeout_s=30.0)
        return data if isinstance(data, dict) else {"raw": data}

    def analyze_pool(self, pool: str, *, invest_usd: float | None = None) -> dict[str, Any]:
        """Comprehensive pool analysis (APR, risk, range recommendations)."""

        pool_s = str(pool or "").strip()
        if not pool_s:
            raise WalletPolicyDenied("Byreal pool analysis requires a pool address")
        args = ["pools", "analyze", pool_s]
        if invest_usd is not None:
            args += ["--amount", str(invest_usd)]
        data = self._run_cli(args, timeout_s=45.0)
        return data if isinstance(data, dict) else {"raw": data}

    def list_tokens(
        self,
        *,
        search: str = "",
        sort_field: str = "volumeUsd24h",
        limit: int = 20,
        **_kw: Any,
    ) -> list[dict[str, Any]]:
        """List tokens available on Byreal."""

        args = [
            "tokens",
            "list",
            "--sort-field",
            str(sort_field or "volumeUsd24h"),
            "--page-size",
            str(max(1, min(int(limit or 20), 100))),
        ]
        if search:
            args += ["--search", str(search)]
        data = self._run_cli(args, timeout_s=30.0)
        tokens = data.get("tokens") if isinstance(data, dict) else data
        return [row for row in tokens if isinstance(row, dict)] if isinstance(tokens, list) else []

    def get_token_klines(
        self,
        *,
        chain: str,
        token: str,
        interval: str = "1h",
        limit: int = 100,
        **kw: Any,
    ) -> list[dict[str, Any]]:
        """Fetch Byreal CLMM pool OHLCV.

        ``token`` is the Byreal **pool address** (market id ``solana:<pool>``).
        An optional ``token_mint`` keyword charts a specific side of the pool;
        otherwise byreal-cli auto-detects the pool's base token.
        """

        self._require_solana(chain)
        pool = str(token or "").strip()
        if '@' in pool:
            pool, selected_mint = pool.split('@',1)
            kw.setdefault('token_mint',selected_mint)
        if not pool:
            raise WalletPolicyDenied(
                "Byreal market data requires a pool address (market id solana:<poolAddress>)"
            )
        bar = _BYREAL_INTERVALS.get(str(interval or "1h").lower())
        if bar is None:
            raise WalletPolicyDenied('unsupported Byreal candle interval')
        import time
        seconds=int(bar[:-1])*{'m':60,'h':3600,'d':86400}[bar[-1]]
        end=int(kw.get('end') if kw.get('end') is not None else time.time())
        start=int(kw.get('start') if kw.get('start') is not None else end-seconds*max(1,min(limit,10000)))
        args = ["pools", "klines", pool, "--interval", bar]
        token_mint = str(kw.get("token_mint") or kw.get("mint") or "").strip()
        if token_mint:
            args += ["--token", token_mint]
        args += ['--start',str(start),'--end',str(end)]
        if token_mint and self._cli_command() is None:
            from ...connectors.http import UrllibHttp
            status,doc=(self.transport or UrllibHttp()).request('GET',
                'https://api2.byreal.io/byreal/api/dex/v2/kline/query-ui',
                params={'poolAddress':pool,'tokenAddress':token_mint,'klineType':bar,'startTime':start,'endTime':end},timeout=30)
            if status>=400 or str(doc.get('retCode',0))!='0':
                raise WalletTransportError('Byreal pool candle request failed')
            data=(doc.get('result') or {}).get('data') or []
        else:
            data = self._run_cli(args, timeout_s=45.0)
        rows: Any = data
        if isinstance(data, dict):
            rows = data.get("klines") or data.get("candles") or data.get("list") or []
        out: list[dict[str, Any]] = []
        for row in rows if isinstance(rows, list) else []:
            try:
                if isinstance(row, dict):
                    ts = row.get("timestamp") or row.get("ts") or row.get("time") or row.get('t')
                    o = row.get("open",row.get('o'))
                    h = row.get("high",row.get('h'))
                    lo = row.get("low",row.get('l'))
                    c = row.get("close",row.get('c'))
                    v = row.get("volume") or row.get("vol") or row.get('v')
                elif isinstance(row, (list, tuple)) and len(row) >= 6:
                    ts, o, h, lo, c, v = row[:6]
                else:
                    continue
                ts_i = int(float(ts))
                if ts_i > 1_000_000_000_000:  # ms → s (Byreal returns ms)
                    ts_i //= 1000
                out.append({
                    "ts": ts_i,
                    "open": float(o),
                    "high": float(h),
                    "low": float(lo),
                    "close": float(c),
                    "volume": float(v or 0.0),
                    'price_currency':'pool_pair',
                })
            except (TypeError, ValueError):
                continue
        out.sort(key=lambda r_: r_["ts"])
        out=[row for row in out if (kw.get('start') is None or row['ts']>=int(kw['start']))
             and (kw.get('end') is None or row['ts']<=int(kw['end']))]
        if limit and len(out) > int(limit):
            out = out[-int(limit):]
        return out

    # ------------------------------------------------------------------
    # Wallet-bound surface (requires `byreal-cli setup`)
    # ------------------------------------------------------------------
    @staticmethod
    def _row_amount(
        row: dict[str, Any], *, default_symbol: str, default_decimals: int,
    ) -> tuple[float, str, int]:
        try:
            amount = float(
                row.get("uiAmount") or row.get("amount") or row.get("balance") or 0.0
            )
        except (TypeError, ValueError):
            amount = 0.0
        symbol = str(row.get("symbol") or "") or default_symbol
        try:
            decimals = int(row.get("decimals") or default_decimals)
        except (TypeError, ValueError):
            decimals = default_decimals
        return amount, symbol, decimals

    @staticmethod
    def _native_sol_row(balances: Any) -> dict[str, Any] | None:
        for row in balances if isinstance(balances, list) else []:
            if not isinstance(row, dict):
                continue
            mint = str(row.get("mint") or row.get("address") or "").lower()
            sym = str(row.get("symbol") or "").lower()
            if row.get("isNative") or sym in ("sol", "wsol") or mint == _WRAPPED_SOL_MINT:
                return row
        return None

    def get_balance(
        self, *, chain: str, address: str, token: str, **kw: Any,
    ) -> WalletBalance:
        self._require_solana(chain)
        if self.keypair_path or self.config.get('keypair_path') or self.config.get('signer_ref'):
            from ...connectors.solana_native import _pubkey_from_signer
            key=self._signer()
            try: owner=_pubkey_from_signer(key)
            finally: key=''
            if address and address != owner:
                raise WalletPolicyDenied('balance address differs from configured Byreal signer')
            conn=self._solana()
            native=token.lower() in ('','sol','native')
            decimals=9 if native else conn.get_mint_decimals(token)
            value=conn.get_balance(owner) if native else conn.get_token_balance(owner,token)
            return WalletBalance(provider=self.id,chain='solana',address=owner,token=token,balance=value,decimals=decimals,
                                 symbol='SOL' if native else '')
        data = self._run_cli(["wallet", "balance"], timeout_s=30.0)
        balances = []
        if isinstance(data, dict):
            balances = data.get("balances") or data.get("tokens") or []
        token_s = str(token or "").strip().lower()

        if token_s in _PORTFOLIO_USD_TOKENS:
            # Explicit portfolio-USD request only — never folded into a
            # token balance. Reported honestly as symbol USD / token "".
            total = 0.0
            if isinstance(data, dict):
                try:
                    total = float(
                        data.get("totalValueUsd") or data.get("total") or 0.0
                    )
                except (TypeError, ValueError):
                    total = 0.0
            return WalletBalance(
                provider=self.id, chain="solana", address=address, token="",
                balance=total, symbol="USD", decimals=2,
            )

        if token_s in _NATIVE_SOL_TOKENS:
            # Native SOL only: the "" / unset token must NOT sum every
            # token row into an "SOL"-labelled total.
            row = self._native_sol_row(balances)
            if row is not None:
                total, symbol, decimals = self._row_amount(
                    row, default_symbol="SOL", default_decimals=9,
                )
            else:
                total, symbol, decimals = 0.0, "SOL", 9
                if isinstance(data, dict):
                    for key in ("sol", "nativeBalance", "native", "solBalance"):
                        if data.get(key) is None:
                            continue
                        try:
                            total = float(data[key])
                            break
                        except (TypeError, ValueError):
                            continue
            return WalletBalance(
                provider=self.id, chain="solana", address=address, token=token,
                balance=total, symbol=symbol, decimals=decimals,
            )

        # Specific token request: match by mint or case-insensitive symbol.
        total, symbol, decimals = 0.0, token_s.upper(), 9
        for row in balances if isinstance(balances, list) else []:
            if not isinstance(row, dict):
                continue
            mint = str(row.get("mint") or row.get("address") or "").lower()
            sym = str(row.get("symbol") or "")
            if token_s not in (mint, sym.lower()):
                continue
            total, symbol, decimals = self._row_amount(
                row, default_symbol=sym or token_s.upper(), default_decimals=9,
            )
            break
        return WalletBalance(
            provider=self.id, chain="solana", address=address, token=token,
            balance=total, symbol=symbol, decimals=decimals,
        )

    @staticmethod
    def _decimals_in(kw: dict[str, Any]) -> int:
        """Validate the ``decimals_in`` kwarg (default 9 for SOL UI amounts).

        Documented unit contract: NO in-repo evidence (no vendored
        byreal-cli source, skill doc, or README under agent/) states what
        unit ``byreal-cli swap execute --amount`` expects, so we do not
        guess a raw-base-unit conversion. ``amount_in`` is passed through
        as a UI float (current behaviour) and the assumption is recorded
        in the returned ``extra`` (``amount_units`` / ``decimals_in``).
        """
        raw = kw.get("decimals_in")
        if raw is None:
            return 9
        try:
            val = int(raw)
        except (TypeError, ValueError) as exc:
            raise WalletError(
                f"Byreal: decimals_in must be an integer, got {raw!r}"
            ) from exc
        if val < 0:
            raise WalletError(f"Byreal: decimals_in must be >= 0, got {val}")
        return val

    @staticmethod
    def _first_positive(doc: dict[str, Any], keys: tuple[str, ...]) -> float:
        for key in keys:
            if doc.get(key) is None:
                continue
            try:
                val = float(doc[key])
            except (TypeError, ValueError):
                continue
            if math.isfinite(val) and val > 0:
                return val
        return 0.0

    def quote(
        self, *, chain: str, token_in: str, token_out: str,
        amount_in: float, slippage_bps: int = 50, **kw: Any,
    ) -> WalletQuote:
        self._require_solana(chain)
        dec_in = self._decimals_in(kw)
        if self.keypair_path or self.config.get('keypair_path') or self.config.get('signer_ref'):
            from ...connectors.solana_native import _pubkey_from_signer
            key = self._signer()
            try:
                doc, dec_in, dec_out = self._api_quote(token_in,token_out,amount_in,slippage_bps,_pubkey_from_signer(key))
            finally:
                key = ''
            expected = int(doc['outAmount'])/(10**dec_out)
            return WalletQuote(provider=self.id,chain='solana',token_in=token_in,token_out=token_out,
                amount_in=float(amount_in),expected_out=expected,
                min_out=int(doc.get('otherAmountThreshold') or int(doc['outAmount'])*(10000-slippage_bps)//10000)/(10**dec_out),
                slippage_bps=slippage_bps,extra={'real_quote':True,'decimals_in':dec_in,'decimals_out':dec_out})
        data = self._run_cli(
            [
                "swap",
                "execute",
                "--input-mint",
                str(token_in),
                "--output-mint",
                str(token_out),
                "--amount",
                str(float(amount_in)),
                "--slippage",
                str(int(slippage_bps)),
                "--dry-run",
            ],
            timeout_s=45.0,
        )
        doc = data if isinstance(data, dict) else {}
        expected = self._first_positive(
            doc, ("uiOutAmount", "expectedOut", "estimatedOut", "expected_out"),
        )
        if expected <= 0:
            # An unparseable quote must fail loudly instead of freezing an
            # approval with expected_out=0 / min_out=0.
            raise WalletQuoteError(
                f"byreal-cli quote returned no positive output amount for "
                f"{token_in} -> {token_out}: {str(doc)[:512]}"
            )
        min_out = self._first_positive(doc, ("minOut", "minimumOut", "min_out"))
        if min_out <= 0:
            min_out = expected * (1.0 - slippage_bps / 10_000)
        impact = doc.get("priceImpactBps") or doc.get("price_impact_bps")
        if impact is None:
            pct = doc.get("priceImpactPct") or doc.get("priceImpact") or 0.0
            try:
                impact = int(round(float(pct) * 100))
            except (TypeError, ValueError):
                impact = 0
        return WalletQuote(
            provider=self.id, chain="solana",
            token_in=token_in, token_out=token_out,
            amount_in=float(amount_in),
            expected_out=expected,
            min_out=min_out,
            slippage_bps=slippage_bps,
            price_impact_bps=int(impact or 0),
            extra={
                "raw": doc,
                "amount_units": "ui",
                "decimals_in": dec_in,
            },
        )

    def swap(
        self, *, chain: str, token_in: str, token_out: str,
        amount_in: float, slippage_bps: int = 50,
        receiver: str | None = None, live: bool = False, **kw: Any,
    ) -> WalletSwapResult:
        if not live:
            return WalletSwapResult(provider=self.id,chain=chain,ok=False,reason="live=False")
        self._require_solana(chain)
        from ...connectors.solana_native import _pubkey_from_signer
        from ..amounts import to_base_units_ceil
        key = self._signer()
        try:
            owner = _pubkey_from_signer(key)
            if receiver and receiver != owner:
                raise WalletPolicyDenied("Byreal receiver must equal the selected signing wallet")
            # The CLI confirm command re-quotes. Build once through the same
            # official router and sign/broadcast that exact quoted transaction.
            quote, _, dec_out = self._api_quote(token_in,token_out,amount_in,slippage_bps,owner)
            floor = to_base_units_ceil(kw.get('min_out') or 0,dec_out)
            expected = int(quote['outAmount'])
            conservative_floor = int(quote.get('otherAmountThreshold') or expected*(10000-slippage_bps)//10000)
            if conservative_floor < floor:
                raise WalletPolicyDenied('Byreal quote slippage floor is below the approved minimum')
            tx = quote.get('transaction')
            if not tx:
                raise WalletQuoteError('Byreal quote has no transaction for selected wallet')
            conn = self._solana(live=True)
            if str(quote.get('routerType') or 'AMM').upper() == 'RFQ':
                from ...connectors.solana_native import _sign_solana_v0_tx
                from ...connectors.http import UrllibHttp
                signed=_sign_solana_v0_tx(tx,key)
                if not quote.get('quoteId') or not quote.get('orderId'):
                    raise WalletQuoteError('Byreal RFQ quote identity unavailable')
                status,doc=(self.transport or UrllibHttp()).request('POST','https://api2.byreal.io/byreal/api/rfq/v1/swap',
                    body={'quoteId':quote['quoteId'],'requestId':quote['orderId'],'transaction':signed},timeout=30)
                data=((doc or {}).get('result') or {}).get('data') or {}
                signature=data.get('txSignature') or (data.get('signatures') or [''])[0]
                if not signature:
                    raise WalletTransportError('Byreal RFQ result has no signature; execution outcome unknown')
                if kw.get('on_broadcast'):
                    kw['on_broadcast']({'tx_hash':signature,'chain':'solana','owner':owner,'token_out':quote['outputMint']})
                try:
                    conn.wait_for_signature(signature)
                    actual=conn.transaction_output(signature,owner,quote['outputMint'])
                except Exception:
                    actual=None
                return WalletSwapResult(provider=self.id,chain='solana',ok=actual is not None,tx_hash=signature,
                    amount_in=float(amount_in),amount_out=float(actual or 0),
                    extra={'confirmed':actual is not None,'amount_out_source':'transaction_meta' if actual is not None else 'unknown'})
            out = conn.send_swap_transaction(tx,key,output_mint=quote['outputMint'],user_public_key=owner,
                quote=quote,on_broadcast=kw.get('on_broadcast'))
            actual = out.get('amount_out')
            return WalletSwapResult(provider=self.id,chain='solana',ok=bool(out.get('confirmed')) and actual is not None,
                tx_hash=str(out.get('signature') or ''),amount_in=float(amount_in),amount_out=float(actual or 0),
                reason='' if actual is not None else 'confirmation_or_receipt_pending',
                extra={'confirmed':bool(out.get('confirmed')),'amount_out_source':'transaction_meta' if actual is not None else 'unknown',
                       'owner':owner,'expected_out':expected/(10**dec_out)})
        finally:
            key = ''
