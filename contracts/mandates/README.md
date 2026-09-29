# Nerya signed mandates — bounded paper prototype

This implementation binds an operator's EIP-712 signed policy to an agent's
signed action, registers the action on an EVM chain, and checks that commitment
before the existing Nerya paper execution pipeline proceeds. It is inspired by
signed delegation; it is **not an AP2 implementation or conformance claim**.

Supported execution is deliberately restricted to **mock-venue paper accounts,
market orders, fixed USD/base sizing, no protection orders**. Enrolled accounts
reject unsupported plans, including live, wallet and asynchronous orders.
Unenrolled accounts retain the existing trading behavior.

## Rehearse locally

From the repository root, install the Python `mandates` extra and Foundry, then:

```powershell
python -m pip install -e ".[mandates,dev]"
forge build --root contracts/mandates
forge test --root contracts/mandates --offline
python -m pytest tests/test_signed_mandates.py -q
python -m scripts.mandate_demo --output .tmp/mandate-demo
```

Choose a new output directory on each run. The demo starts and terminates its
own loopback-only Anvil process, deploys the actual contract, signs and submits
actual local-chain transactions, and executes the existing paper trading code.
It never uses the active workspace, existing wallets, or public RPCs.

Open `report.html` in the output directory. `evidence.json` includes policies,
signatures, typed-data requests, plans, transaction receipts, contract events,
runtime decisions and executor counts. Demo keys stay in the isolated
workspace's SecretVault and are not included in the report. The local chain is
ephemeral: its hashes are not public-testnet explorer links.

The seven cases are: allowed execution; user changes the allowed market;
fees/slippage exceed the signed ceiling; user disallows new long openings;
plan tampering; replay through the internal approval-resume path; revocation
of an already anchored authorization. Every rejected submission checks the
durable executor count before and after.

## Dashboard walkthrough

The overview at `/dashboard` includes an **Agent Safety** entry above the
account and market panels. `/dashboard/safety` presents recorded policy terms,
selectable outcomes, executor counts and local-chain receipts in Chinese or
English, following the interface language.

The **Run safety check** controls now execute a fresh isolated local-chain and
paper-account run through `POST /safety/demo/run` on the Python API. Choose a
preset or edit the permitted/requested market, integer USD amounts (1–1000),
policy limits and permission to open longs. The backend validates the inputs,
creates fresh test keys and an isolated workspace, performs actual EVM calls
and uses the existing paper execution gates. Test-owner signing is automated;
these controls do not grant access to an existing account or human wallet.
The revoke preset anchors an action, submits an owner revocation, then attempts
execution. Replay/tamper presets include a successful baseline action first.

Both run and status routes require `admin:ops` (or the existing local/owner
wildcard). Only one job runs at a time per server, and request IDs prevent
duplicate jobs after a lost response. The browser polls status and can recover
the latest job after a page reload. Job metadata is held in memory (up to 20
jobs); raw output stays under `.tmp/mandate-interactive/`. Restarting the API
clears the in-memory job catalog. New jobs are never inferred from browser
storage, and the API accepts no RPCs, paths, shell commands or account IDs.

The API imports its runner and exporter from `nerya.security.mandate_demo`
and `nerya.security.mandate_demo_export`. The repository `scripts/` files
are CLI compatibility wrappers only: an installed `nerya serve` entry point
does not necessarily include the repository root on its Python import path.
Readiness checks now import the actual runner, rather than only checking
whether Web3 and Anvil exist. The latest outcome appears directly below the
run button; historical recordings are shown only when explicitly selected.

Restart the Python backend once after installing these new routes. Keep the
same workspace and ports as your existing service. The page reports missing
dependencies or an unavailable API instead of fabricating results. Completed
interactive results and separately published historical recordings have
distinct selectors. Neither mode changes active trading permissions.

Publish an existing isolated demo run:

```powershell
python -m scripts.mandate_dashboard --input .tmp/mandate-demo-presentation/evidence.json
```

Or publish automatically after a new run (use a new output directory):

```powershell
python -m scripts.mandate_demo --output .tmp/mandate-dashboard-run --publish-dashboard
```

Then click **Refresh recording**. The exporter writes an explicit public-field
projection to `dashboard/public/mandates/demo.json`, which is ignored by Git.
It does not copy raw reports, workspace files, RPC configuration, keys or Vault
contents. The page offers this summary as a JSON download; the original signed
envelopes and full evidence remain in the operator's run output directory.
Without a published recording, the page shows setup instructions rather than
inventing successful results. A recording is not independent proof of execution.

## Signature payloads

`nerya/security/mandates.py` defines the exact EIP-712 schemas. The EVM signature
scheme is secp256k1 ECDSA, with low-s and v checks. The domain binds the protocol
name/version, chain ID, contract address and a workspace-specific salt.

| Payload | Bound fields |
|---|---|
| Policy | Owner, authorized agent, account/strategy scope hash, one exact market hash, per-action cost ceiling, cumulative authorization budget, start/end times, owner nonce, permission to open new long positions |
| Action | Policy digest, full trade-plan digest, market hash, signed cost ceiling, whether it opens a long, action nonce, expiry |

Costs are unsigned integer **micro-USD**. They mean notional plus costs, not
margin, loss, NAV or gas. The full signed action ceiling is conservatively
charged against the authorization budget. Failed runtime execution does not
automatically refund it. Gas paid to register/revoke an authorization is a
separate operator expense, not included in the paper trading budget.

The account/strategy scope is the Keccak hash of the JSON array `[account_id,
strategy_id]` using ASCII escaping and compact separators. Market matching is
exact, including venue prefix and symbol spelling. The plan hash uses Nerya's
deterministic Python JSON encoding, excluding only `meta.signed_mandate`.
This is a versioned application format, **not a claim of RFC 8785 compliance**.
Other clients should consume the exported typed data and original plan rather
than independently serializing floating point fields.

`allowLong=false` prohibits **new long-opening plans** for this mandate's
market. A buy used to reduce a short is not classified as a long opening;
Nerya's existing position-share checks still validate the close size and side.
This is not an account-wide or cross-venue net-exposure guarantee.

## Execution and revocation

1. The operator enrolls an account and pins its owner, RPC, chain, verifier,
   deployed runtime bytecode hash and workspace salt in `nerya.yml`.
2. The user signs Policy; the delegated agent signs Action referencing it.
3. A relayer calls `authorize(policy, user_signature, action, agent_signature)`.
   The contract verifies signatures, expiry, market/direction, ceilings,
   cumulative budget and nonces. It emits `ActionAuthorized` on success.
4. `submit_trade_plan` verifies signatures and binds the action to the actual
   plan before wallet/protection routing. Dropping the envelope cannot opt out.
5. Existing RiskGate, ApprovalGate and BudgetChecker still run. The mandate is
   additional authorization; it does not replace an operator approval.
6. Before reserving capital, runtime verifies resolved paper cost including
   simulator fees/slippage, reads authorization/revocation at a pinned block,
   and atomically consumes the action nonce in `mandates.sqlite`.
7. The market-order executor checks the current configuration, unchanged
   candidate, chain authorization and expiry again immediately before filling.
   It atomically marks execution started. Direct executor creation without a
   matching claim, or recovery after an uncertain start, is refused.
8. The policy owner can call `revoke(policy)` at any time. An observed revocation
   blocks future admission/execution; it cannot undo completed fills.

RPC errors and unsupported configuration fail closed. The configured RPC is a
trusted read dependency, not a light client. Reads are pinned to a block number;
this prototype has no finality policy or reorg protection. The final read and
off-chain fill are not one blockchain transaction: revocation may race a fill.
The local claim database must not be reset or shared incorrectly across runtime
replicas. Chain authorization is not global exactly-once CEX settlement.

The contract sees a signed `planHash` and declared cost/direction; it cannot
independently infer market prices, true fills or resulting CEX positions.
Runtime performs those supported checks. A blockchain record proves a
commitment, not the truth of financial research or execution data.

The trusted boundary includes the operator configuration, runtime process,
local database and Vault. This is not protection against an attacker with OS
access, arbitrary trusted plugin execution or the ability to rewrite those
files. Reject logs remain ordinary local records; only signed payloads and
their on-chain commitments have cryptographic integrity evidence. Scope this
feature to an isolated demo account until broader execution-path and deployment
hardening is complete.

## User wallet signing

The dashboard serves a standalone helper at `/mandates/index.html`. It reads a
local exported Policy JSON, displays all signed fields, requires explicit
confirmation, checks wallet owner and network, then calls
`eth_signTypedData_v4`. It exports `signed-policy.json` without making an HTTP
request or broadcasting a transaction. No private key is requested by the page.
The backend and contract independently verify the signature.

Example operator configuration (all values must match your actual deployment;
the account must be paper/mock):

```yaml
trading:
  signed_mandates:
    accounts:
      mandate_paper: "0x<USER_WALLET_ADDRESS>"
    chain_id: 31337
    verifier: "0x<DEPLOYED_CONTRACT_ADDRESS>"
    workspace: "0x<32_BYTE_UNIQUE_WORKSPACE_SALT>"
    rpc_url: "http://127.0.0.1:8545"
    runtime_code_hash: "0x<KECCAK_OF_DEPLOYED_RUNTIME_CODE>"
```

The owner must be set by the trusted operator, not accepted from an untrusted
request. Pin the runtime bytecode of this deployed, reviewed verifier; its
workspace immutable affects the bytecode. Do not enroll an active trading
account as a casual demo step.

Generate the wallet request using public addresses:

```powershell
python -m scripts.mandate_request policy --workspace .tmp/my-paper-workspace --account mandate_paper --strategy demo --market mock:BTC/USDT --agent 0x<AGENT_ADDRESS> --max-cost 110 --budget 220 --nonce 1 --ttl 900 --allow-long --output .tmp/policy-request.json
```

Import `policy-request.json` in the helper, verify the hashes against the
account/strategy/market in `review_context`, sign, and save the signed policy.
The wallet helper supports JSON integers up to `2^53-1`, rejecting imprecise
amounts. EIP-1271 smart-contract wallets are not supported in this prototype.

An operator provisions the agent key through SecretVault with `mandate:sign`
scope. No agent tool for minting user policies is registered. Prepare a regular
`TradePlan.asdict()` JSON and export its signed envelope:

```powershell
python -m scripts.mandate_request action --workspace .tmp/my-paper-workspace --signed-policy .tmp/signed-policy.json --plan .tmp/plan.json --cost-ceiling 101 --nonce 1 --ttl 300 --agent-key-ref vault://mandate-agent --output .tmp/action-request.json
```

This command verifies the user signature, enforces preflight constraints and
uses the vault key only for the action signature. It neither anchors nor submits
the trade. The existing operator integration should submit the exported
envelope to `authorize` first, then pass its exact `plan` to
`submit_trade_plan`. The local demo is an executable reference for that sequence.
Legacy intent payloads are not automatically signed; on enrolled accounts they
fail closed if they cannot carry the exact signed canonical plan.

## Public testnet and claims

No public testnet deployment, real wallet interaction, public explorer receipt,
AP2 compliance, VC implementation, or live-account coverage is claimed by the
local rehearsal. A public-testnet run needs a chosen network, operator wallet,
test gas, deployment and matched public receipts. The browser helper has been
tested with a mock wallet; the Python-to-Solidity EIP-712 signatures have been
verified against an actual local EVM contract.

For the Chinese judge walkthrough, see
[`DEMO.zh-CN.md`](DEMO.zh-CN.md).
