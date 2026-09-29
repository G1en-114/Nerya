# GWDC: minimal blockchain evidence

**Declared function:** Nerya is an agent-finance evidence tool that registers a paper strategy and anchors its recorded outcomes on a testnet for independent inspection.

This lane uses two small contracts on **Ethereum Sepolia, chain ID 11155111**:

- `NeryaStrategyRegistry`: register a strategy identifier and metadata digest.
- `NeryaRunRecords`: the strategy's owner writes an immutable run/evidence digest and emits `RunRecorded`.

They are simple registries, **not ERC-721 NFTs or ERC-8004 implementations**. They
hold no user funds and do not place orders. A public commitment proves that a
particular digest was recorded, not that the underlying claims are true.

**Deployed and independently checked:** [Sepolia addresses, four transaction
hashes, receipt logs and public evidence bundle](deployments/sepolia-20260929/README.md).

## Reproduce the blockchain lane

Install the repository's `mandates` Python extra and Foundry. Use a fresh output
directory for the local run; never include its Vault in a submission archive.

```powershell
forge test --root contracts/gwdc --offline
forge build --root contracts/mandates
python -m scripts.mandate_demo --output .tmp/gwdc-new-run
python -m scripts.gwdc_deploy --check --evidence .tmp/gwdc-new-run/evidence.json
python -m scripts.gwdc_deploy --evidence .tmp/gwdc-new-run/evidence.json --output .tmp/gwdc-new-deployment
python -m scripts.gwdc_verify --bundle .tmp/gwdc-new-deployment
```

The operator deployment CLI reads `.env` for `NERYA_WORKSPACE` and
`NERYA_TESTNET_SIGNER_REF`. It expands `~`, recognizes the default workspace
subdirectory, and resolves the signing key from SecretVault with `chain_audit`
scope. It never prints the key. An unset/placeholder RPC uses PublicNode Sepolia.
Only chain ID 11155111 is accepted. The aggregate transaction fee upper bound is
0.003 test ETH. No mainnet or trading permission is enabled.

There are four transactions: two deployments, one strategy registration, and one
run commitment. The CLI saves transaction hashes **before broadcasting**, then
receipts and decoded events. Reuse the same output to recover pending receipts;
it will not automatically rebroadcast an uncertain submission. After a process
crash, remove `deployment.lock` only after confirming no deployment process is
still running. An absent transaction after an uncertain broadcast requires
operator reconciliation; do not blindly run again with a new output directory.

## Public submission bundle

Share only `deployment.json`, `record.json`, `strategy.json`, both ABI files, this
README and the contract source. `deployment.json` contains addresses, transaction
hashes, block numbers, receipts, events, and explorer URLs. `record.json` contains
a bounded public case summary and the SHA-256 digest of the original local
evidence file. Do not share `.env`, Vault files or the entire local workspace.

The evidence digest is SHA-256 of UTF-8 JSON with sorted keys, compact separators,
and unescaped Unicode. The verifier recomputes it, fetches successful Sepolia
receipts and logs, checks the contract code hashes, registry ownership/linkage,
and reads the stored commitment. No wallet is needed to verify. Verification
trusts the selected RPC; it does not attest to off-chain fills or model usage.

## Competition scope

The operator reports a newer organizer notice permitting
`deepseek-v4.1-flash` in addition to the model named in the original brief.
Use that updated model allowance for submission review. Actual calls must
still go through the required Kiln service and be linked to the demonstrated flow.

| Requirement | What this lane provides |
| --- | --- |
| At least one workflow transaction with matching hash/log | A paper demo produces evidence; the operator CLI anchors its summary and exports a matching `RunRecorded` receipt |
| Explain blockchain use | Writes strategy provenance and a run digest; independently reads them back |
| Changed user conditions | The local demo records seven cases, including changed market and fee-ceiling rejection; these are local paper results, not public-chain trading |
| Actual Kiln calls with an allowed model in the selected workflow | [Actual `deepseek-v4.1-flash` calls](efficiency/20260929/README.md) now explain three recorded outcomes in the evidence-inspection workflow; they did not generate the earlier trades |
| Tokens by flow and measured/assumed energy | [Completed report](efficiency/20260929/README.md): API-reported input/output usage by flow, including truncated attempts, plus explicit illustrative energy coefficients and scope |
| Human approval, monitoring and stopping (Challenge B) | **Not supplied by these registries**; the local demo uses test signers, not a demonstrated human wallet approval |

Deploying contracts alone is insufficient to claim completion of GWDC. This is
the blockchain evidence component. The demo followed by the anchoring command
is a reproducible operator workflow; it is not automatic anchoring from the
agent runtime, nor a Kiln-powered end-to-end acceptance run. The existing
signed-mandate demo and risk/approval gates remain separate from these contracts.

The subsequent [Kiln evidence-inspection report](efficiency/20260929/README.md)
adds actual model-generated explanations and per-flow efficiency evidence. Its
token records are not covered by the earlier Sepolia commitment. Recompute the
report without API calls:

```powershell
python -m scripts.gwdc_efficiency report --output contracts/gwdc/efficiency/20260929
```
