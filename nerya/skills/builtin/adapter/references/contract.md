# Wallet/DEX contract v1

Python interface: nerya.wallet.protocol.WalletProvider. Public methods:
readiness(), capabilities(), get_balance(), quote(), swap(),
get_execution_status(request=..., transaction=...). get_execution_status
defaults to nerya.wallet.confirmation.read_transaction for EVM/Solana;
custodial adapters first resolve execution_ref to tx_hash. A provider for other
chains must supply its own receipt reader.

Keep configuration and secrets out of returned objects. Capability fields
include chains (reads), swap_chains, order_types, protection_types,
minimum_output and receipt_polling. Minimum-output values:
enforced = the executable transaction/quote binds an absolute output floor;
relative_slippage = a re-quoting API only accepts a percentage;
unknown = no verified contract. Relative slippage alone cannot enforce a
previously approved absolute min_out.

## External process

Configure command as an argv array. The runtime invokes it without a shell,
writes one JSON object to stdin, and reads the final JSON stdout line. Each
response includes protocol_version: 1. stderr/non-JSON output is not surfaced
as a financial result. env_refs maps environment variable names to vault refs.

Request: {"protocol_version":1,"command":"quote","payload":{...}}

- describe payload {} → swap_chains list, minimum_output="enforced",
  receipt_polling=true. This handshake is required before live swap.
- balance payload chain,address,token → balance (UI), symbol, decimals,
  address,token. Missing decimals is an error; 0 is a valid precision.
- quote payload chain,token_in,token_out,amount_in (UI),slippage_bps →
  expected_out,min_out (UI, finite >0), optional quote_id/expires_at.
  Include chain/token/amount identity if available; mismatches are errors.
- swap adds receiver,min_out,execution_id. Return status,tx_hash and/or
  execution_ref,owner,amount_out,confirmed,amount_out_source.
- get_execution_status payload contains request and transaction. Return the
  same result shape. Never submit a fresh swap to resolve an unknown result.
- Optional candles action (enable adapter_candles in config): chain,token,
  interval,limit,start/end → matching chain/token, explicit price_currency
  (USD or pool_pair), candles with unix-second ts and OHLCV. The host validates
  finite prices, high/low, ordering, duplicates and the requested window.
  Otherwise get_token_klines uses public USD token data. EXTERNAL_ONCHAIN is
  the configured data venue for this process adapter.

Execution states: submitted, unknown, confirmed, failed. A submitted order id
is execution_ref, not tx_hash. A confirmed result requires tx_hash,
confirmed=true, positive actual amount_out and source receipt,
transaction_meta or transaction_trace. Otherwise the runtime retains a
pending/unknown state and prevents blind resend. A process timeout before a
response can leave outcome unknown; use persistent idempotency in the adapter
and never re-execute an existing execution_id. JSON v1 is a single-response
protocol, so it cannot preserve a hash lost before stdout; use the Python
on_broadcast hook when pre-send persistence is needed.

Python swap receives on_broadcast(transaction). Call it before sending when
the hash is locally computable, or immediately after a custodial submission
returns its durable id. Persist only tx_hash/execution_ref/chain/owner,
token_out, phase and necessary receipt metadata. The host pins configuration
and serializes same-chain sends. Changing a wallet does not make an old send
safe to retry.

Readiness is dependency configuration, not proof of execution. Treat optional
dependencies lazily, preserve explicit zero slippage/zero decimals, and never
invent a missing minimum or actual output. Exact-input swap receipts currently
book input at approved amount; partial-input/cross-chain routes need a richer
execution implementation and must not silently use this contract.
