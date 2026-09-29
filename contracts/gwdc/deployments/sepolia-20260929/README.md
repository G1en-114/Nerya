# GWDC Sepolia deployment evidence

Network: Ethereum Sepolia (`11155111`). All four transactions below have successful receipts; the public verifier passed against the live RPC.

## Contracts

| Contract | Address |
| --- | --- |
| NeryaStrategyRegistry | [0xebcd11A2Ff45ACB5fa1e52bb2513A0Aaa543BcE1](https://sepolia.etherscan.io/address/0xebcd11A2Ff45ACB5fa1e52bb2513A0Aaa543BcE1) |
| NeryaRunRecords | [0x11413B0EeAc04000D1746aC223961B5bb9Cd6F4f](https://sepolia.etherscan.io/address/0x11413B0EeAc04000D1746aC223961B5bb9Cd6F4f) |

## Transaction hashes and matching logs

| Step | Transaction | Block |
| --- | --- | --- |
| Deploy strategy registry | [0x9c0a9695761a2278670c7e1c57711532af8cc31732e7f7e94745e4f20beabeb0](https://sepolia.etherscan.io/tx/0x9c0a9695761a2278670c7e1c57711532af8cc31732e7f7e94745e4f20beabeb0) | 11807617 |
| Deploy run records | [0x94d6d8d305c1a574f5c0ed1f0cb17b939347c13491bd4e4bc5eebf7b28a835f2](https://sepolia.etherscan.io/tx/0x94d6d8d305c1a574f5c0ed1f0cb17b939347c13491bd4e4bc5eebf7b28a835f2) | 11807634 |
| Register paper strategy | [0x11bf8cf110699e7272ee6522ff80d3655a727e23fed6aa7af7ed6782cb74a84d](https://sepolia.etherscan.io/tx/0x11bf8cf110699e7272ee6522ff80d3655a727e23fed6aa7af7ed6782cb74a84d) | 11807635 |
| Anchor paper-run evidence | [0xdcb673aaee0d78f4dc1b4e580c0c2437fe9061ec9c447e0c93c4ff12cc7a62c4](https://sepolia.etherscan.io/tx/0xdcb673aaee0d78f4dc1b4e580c0c2437fe9061ec9c447e0c93c4ff12cc7a62c4) | 11807636 |

Total actual gas cost: **0.000961643804 Sepolia test ETH**.

The second deployment replaced a pending transaction at the same nonce after a gas-price increase. The original hash is preserved in `deployment.json`; it is not an additional successful deployment.

`deployment.json` includes the matching raw receipt logs and decoded `StrategyRegistered` / `RunRecorded` events. The stored digest is SHA-256 of canonical `record.json`:

```text
0x51bad86e86061b686300c445464e78052ee4e45668330845c8d7f1e8e6ad297a
```

## Recorded local paper outcomes

| Case | Status | New executors |
| --- | --- | --- |
| ALLOW: signed and anchored action | filled | 1 |
| DENY: user changes allowed market to ETH; BTC request stops | rejected | 0 |
| DENY: fees and slippage exceed signed ceiling | rejected | 0 |
| DENY: long opening prohibited | rejected | 0 |
| DENY: plan changed after signing | rejected | 0 |
| DENY: replay through resume path | rejected | 0 |
| DENY: user revoked previously anchored policy | rejected | 0 |

These results came from a fresh local paper demo before the public-chain commitment. They are not trades executed on Sepolia. The original evidence file is bound by `source_sha256`; the public summary alone does not independently prove the correctness of the off-chain execution.

## Verify without a wallet

From the repository root:

```powershell
python -m scripts.gwdc_verify --bundle contracts/gwdc/deployments/sepolia-20260929
```

Expected result: `verified: true`, `transactions: 4`. This checks the current public chain, rather than trusting the saved `verified` flag.

## Submission boundary

This bundle supplies two contract deployments and a workflow-record commitment with a matching transaction hash and log. It does not by itself establish full GWDC acceptance. The operator reports a newer organizer notice allowing `deepseek-v4.1-flash`; model selection is therefore not treated as a blocker. Actual Kiln workflow calls using an allowed model, per-flow token/energy evidence, and any claimed human-approval controls must still be supplied. See [the acceptance table](../../README.md#competition-scope).
