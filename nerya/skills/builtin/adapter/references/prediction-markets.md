# Prediction-market adapters

The built-in prediction connector is Polymarket. Find it through connector_list
and connector_describe; no Kalshi connector is currently provided. Prediction
markets use the ordinary trading plan/risk/approval/order-tracker path, not
wallet.swap. A new venue belongs in ExchangeProviderSpec + a Connector.

## Identity and data

Use POLYMARKET:<decimal CLOB outcome token id>, or POLYMARKET:<slug>#<outcome>.
Outcome names are explicit: Yes and No are different assets. A condition id is
a group of outcomes and is not a tradable token. scripts/inspect_prediction.py
lists both outcome token ids. Bare slugs are rejected rather than choosing Yes.
Case must be preserved when forwarding a slug to Gamma.

Public books and prices need no credentials. Price history has sampled prices,
not trade OHLCV: data_kind=price_samples, O=H=L=C, volume_available=false. Do not
interpret the zero compatibility volume as observed trading volume. Fidelity
is minutes between observations, not requested row count. Windows use seconds
at the API and are bounded explicitly by the connector.

## Accounts and orders

Polymarket collateral is pUSD on Polygon, accounted as PUSD. API key, API secret
and API passphrase are CLOB L2 credentials; private_key is a separate Polygon
signer. Keep the four secrets in exchange-scoped vault refs. Funder and
signature_type select EOA/proxy/Safe/deposit wallet identity; EOA funder must
equal signer, non-EOA types require explicit funder. Existing keys/wallets only.

The adapter uses the audited py-clob-client-v2 1.1 protocol line to separate
create_order and post_order and compute the signed hash before sending. The
latest unified polymarket-client is a separate API: its SecureClient.create
may deploy a deposit wallet and convenience place calls may recover allowance.
Do not silently substitute those methods. Migrating requires explicit review
of setup, authorization and retry effects. The current optional dependency is
py-clob-client-v2>=1.1.0,<2; no install happens automatically.

Supported: owned outcome BUY/SELL; market execution uses share-sized marketable
limit order with a price bound and FOK; limit GTC, GTD, IOC/FAK and post-only.
Market BUY amount in the upstream market-order API is collateral, not shares;
the adapter uses create_order to avoid conflating units. Shares have two-digit
precision. USD sizing rounds shares down before reservation; minimum size and
price tick are checked against the current book. GTD needs a future expiration.

TP/SL remains optional. Native brackets, stop triggers, leverage and opening
short positions are not implemented. Explicit requests are rejected, not
discarded. Buy the opposite outcome to express the opposite view; do not
silently convert a short request. Strategy-owned exits and conditional-token
balances constrain sells; no withdrawal, settlement redemption or bridge is
executed here.

## Confirmation and retries

client_order_id maps to a signed CLOB order hash persisted before posting.
Only the hash, request metadata and status are stored. On timeout, look up that
same hash; never sign/post a new order to resolve an unknown response. SDK
automatic post retries are off. Order query/cancel use authenticated SDK calls.

Order MATCHED and trade MATCHED are not settlement. Book only CONFIRMED trades
with a settlement hash, using taker_order_id or the matching maker_orders leg.
Read actual fill price; an order's limit price is not necessarily its execution
price. Cumulative fills are applied as incremental cost differences so later
fills do not distort cost basis. Cancel refusal stays live; successful cancel
is followed by a fresh order query to catch racing fills.

Maker/taker fees are not yet independently reconciled: fee_status=unverified,
so results are not guaranteed net of fees. Failed/unsettled settlement can keep
the order pending; inspect the original order/trades rather than retrying.
Snapshot NAV includes pUSD plus outcome currentValue from Data API; incomplete
or unavailable inventory data degrades the snapshot.

Verify an adapter with isolated signing, exact auth request shape, outcome
selection, order types, partial fills, timeout recovery, cancel races, paper
separation and Agent/script/SDK entry tests. Public reads prove data access,
not live-money order acceptance. Real orders require independent authorization.
