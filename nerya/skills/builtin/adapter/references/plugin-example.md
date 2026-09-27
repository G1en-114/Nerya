# Workspace plugin registration

Use the existing plugin_author proposal lane to install an implementation.
Registration is scoped to the host workspace and removed on teardown; built-in
names cannot be overwritten. Factories must return all public wallet methods.

```python
from nerya.wallet.protocol import WalletProvider

class CustomDex(WalletProvider):
    # Implement readiness, capabilities, get_balance, quote, swap.
    # Inherit get_execution_status only for standard EVM/Solana receipts,
    # supplying self.config with rpc_urls and the pinned wallet address.
    ...

def setup(ctx):
    ctx.register_wallet_provider(
        "my_dex",
        lambda cfg, **kwargs: CustomDex(cfg, **kwargs),
        metadata={"label": "My DEX", "credential_fields": []},
    )
```

Then wallet.providers.<wallet_id>.provider=my_dex selects it. Plugin loading
follows the existing host lifecycle. A new process/CLI must load that workspace
plugin before it can construct the registered adapter. The external process
provider is independent of plugin activation and is useful for CLI contexts.

Test with an isolated workspace and deterministic transport; implement the
methods before registering this illustrative skeleton. Native limit/TP-SL
needs an explicit execution design beyond immediate exact-input swap.
