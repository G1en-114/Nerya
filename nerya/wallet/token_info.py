"""Chain precision lookup used by adapters; never infer token decimals."""
from .errors import WalletPolicyDenied


def token_decimals(config,chain,token):
    rpc=(config.get('rpc_urls') or {}).get(chain) or (config.get('rpc_url') if chain=='solana' else '')
    if token.lower() in ('native','eth','bnb','sol','0x'+'e'*40):return 9 if chain=='solana' else 18
    if token=='So11111111111111111111111111111111111111112':return 9
    if not rpc:raise WalletPolicyDenied('chain RPC required to verify token decimals')
    if chain=='solana':
        from ..connectors.solana_native import SolanaNative
        return SolanaNative(rpc_url=rpc).get_mint_decimals(token)
    from ..connectors.evm_native import EVMNative,EVM_CHAIN_IDS
    if chain not in EVM_CHAIN_IDS:raise WalletPolicyDenied('unsupported precision lookup chain')
    return EVMNative(chain=chain,chain_id=EVM_CHAIN_IDS[chain],rpc_url=rpc).get_erc20_decimals(token)
