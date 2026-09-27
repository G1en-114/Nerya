"""Uniswap V2 Router02-compatible DEX with an explicit network and signer."""
from dataclasses import dataclass
import re
from .self_custody import SelfCustodyWallet
from ..errors import WalletPolicyDenied
from ..protocol import WalletCapabilities,WalletCapability


@dataclass
class EvmV2Wallet(SelfCustodyWallet):
    id:str='evm_v2'
    label:str='EVM V2 DEX router'

    def _network(self,chain=None):
        from ...connectors.evm_native import EVM_CHAIN_IDS
        configured=self.config.get('chain')
        if configured not in EVM_CHAIN_IDS or (chain is not None and chain!=configured):
            raise WalletPolicyDenied('configure the exact EVM V2 chain')
        return configured

    def capabilities(self):
        chain=self.config.get('chain')
        return WalletCapabilities(balance=WalletCapability(True,'real','EVM RPC'),
            quote=WalletCapability(True,'real','Router02 getAmountsOut'),
            swap=WalletCapability(True,'partial','Exact input, exact approval and on-chain amountOutMin'),
            market_data=WalletCapability(True,'partial','Public USD token data'),
            execution_profile='partial',chains=(chain,) if chain else (),swap_chains=(chain,) if chain else (),
            minimum_output='enforced',receipt_polling=True)

    def readiness(self):
        ready=super().readiness()
        try:self._bsc_connector(live=False)
        except WalletPolicyDenied as exc:
            ready.ready=False;ready.reason=str(exc);ready.missing.append('config:router/network/RPC')
        return ready

    def _address(self,value):
        if not isinstance(value,str) or not re.fullmatch(r'0x[0-9a-fA-F]{40}',value):
            raise WalletPolicyDenied('router and token addresses must be full EVM addresses')
        return value

    def _resolve_bsc_token(self,token):
        native=str(self.config.get('native_symbol') or 'NATIVE').upper()
        if token.upper() in ('NATIVE',native):return self._address(self.config.get('wrapped_native'))
        return self._address(token)

    def _bsc_connector(self,*,live):
        from ...connectors.bsc_native import BSCNative
        from ...connectors.evm_native import EVM_CHAIN_IDS
        chain=self._network();rpc=(self.rpc_urls or {}).get(chain)
        if not rpc:raise WalletPolicyDenied('EVM V2 requires an explicit chain RPC')
        kw={'transport':self.transport} if self.transport else {}
        return BSCNative(chain=chain,chain_id=EVM_CHAIN_IDS[chain],venue=self.id,rpc_url=rpc,
            router=self._address(self.config.get('router')),wbnb=self._address(self.config.get('wrapped_native')),
            live=live,**kw)

    def quote(self,*,chain,token_in,token_out,amount_in,slippage_bps=50,**kw):
        self._network(chain)
        return self._bsc_quote(token_in=token_in,token_out=token_out,amount_in=amount_in,slippage_bps=slippage_bps,**kw)

    def swap(self,*,chain,token_in,token_out,amount_in,slippage_bps=50,receiver=None,live=False,**kw):
        if not live:raise WalletPolicyDenied('live execution is disabled')
        self._network(chain)
        key=self._resolve_signer_key()
        try:
            return self._bsc_swap(key=key,token_in=token_in,token_out=token_out,amount_in=amount_in,
                slippage_bps=slippage_bps,receiver=receiver,min_out=kw.pop('min_out',None),**kw)
        finally:key=''
