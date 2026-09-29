# GWDC Kiln token usage and energy assumptions

The brief requires: **Report token usage broken down by flow rather than as a single total**, and support energy estimates with measurements or clearly stated assumptions.

## Scope and actual API calls

These are real Kiln calls for the evidence-inspection function: a supplied paper-run record becomes a short user-facing explanation. The three flows explain success, a changed permitted market, and fees exceeding a signed ceiling. The model explains recorded outcomes; deterministic code previously enforced the boundaries. These calls did not originate or approve the earlier trades.

Endpoint: `https://api.bricksum.com/v1/messages`. The operator reports that the newer competition notice permits `deepseek-v4.1-flash`. Each attempt records the requested/returned model, response ID, raw numeric API usage, request, source and generated explanation. Counts below use provider-reported usage, never character-based estimates. They are observed API accounting, not independently measured tokenizer counts.

| Flow | Attempts | Completed | Input tokens* | Output tokens | Total known | Unknown-usage attempts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| explain_allowed | 3 | 1 | 861 | 1898 | 2759 | 0 |
| explain_market_rejection | 3 | 1 | 825 | 1900 | 2725 | 0 |
| explain_fee_rejection | 3 | 1 | 834 | 1798 | 2632 | 0 |

| Flow | Tokens in completed calls | Tokens in other attempts with reported usage |
| --- | ---: | ---: |
| explain_allowed | 1161 | 1598 |
| explain_market_rejection | 1151 | 1574 |
| explain_fee_rejection | 1052 | 1580 |

*Input includes uncached input plus any separately reported cache-read/cache-creation tokens. Output includes all output tokens reported by the API, which may include internal reasoning. Missing usage is unknown, not zero. All recorded attempts, including failures with reported usage, are counted. Successful repeated commands reuse the existing response without another call.

## Energy: illustrative assumptions, NOT measurements

No NPU power telemetry, server duration, allocation or provider energy figures were supplied. We therefore use an explicit sensitivity model, not a hardware measurement or a calibrated prediction:

`E_flow (J) = input_tokens × input_J_per_token + output_tokens × output_J_per_token`; `Wh = J / 3600`.

| Scenario | Assumed J/input token | Assumed J/output token |
| --- | ---: | ---: |
| low | 0.01 | 0.1 |
| base | 0.05 | 0.5 |
| high | 0.1 | 1.0 |

Coefficients are deliberately chosen illustrative scenarios, not vendor specifications or empirically supported bounds. The assumed 10:1 output/input ratio explores generation being more expensive than input processing; it is not an observed ratio. Cache tokens receive the same coefficient as other input tokens, so no unmeasured cache energy saving is claimed. Unknown usage makes the corresponding energy subtotal incomplete.

| Flow | Low J | Base J | High J | Base Wh |
| --- | ---: | ---: | ---: | ---: |
| explain_allowed | 198.410 | 992.050 | 1984.100 | 0.275569 |
| explain_market_rejection | 198.250 | 991.250 | 1982.500 | 0.275347 |
| explain_fee_rejection | 188.140 | 940.700 | 1881.400 | 0.261306 |

Scope: illustrative model-inference energy for the recorded calls only. Excludes blockchain validators, local paper execution, client/network power, idle/server-sharing overhead and cooling/PUE. API latency is recorded for troubleshooting, not treated as accelerator compute time. No total-service energy measurement, NPU-vs-GPU saving percentage or carbon claim is made.

## How inference is kept bounded

- One bounded explanation task per flow; the calibration attempts above remain in accounting. Source fields are projected before sending, without full workspace/history.
- A 100-word visible-answer instruction and a 4096-output-token ceiling (including any internal reasoning). The helper requests thinking disabled, but does not assume the gateway honors it; actual reported output usage is retained. Earlier truncated 512-token attempts remain in the totals.
- Numeric policy, fee and signature checks stay deterministic; explanation calls do not control execution.
- Completed identical requests are reused locally. No extra baseline calls are made merely to manufacture a savings comparison.

These choices limit unnecessary inference; no measured percentage reduction is claimed. Replace the illustrative coefficients with provider telemetry/calibration when available.

## Generated explanations (inspect against the supplied records)

### explain_allowed (515bd0104970471e9535e33d72df2afc)

The record shows a local paper-trading ALLOW: executor_called was true, status filled, and one new executor. The user's signed boundary was a ceiling of 101,000,000 micro-USD; resolved cost was 100,070,010 micro-USD, below that ceiling. The Sepolia tx only commits to this summary, not a live trade. Another person should inspect source_sha256, the Sepolia tx, the cost-versus-ceiling calculation, and the executor/new-executor fields. No approval, execution, blockchain verification, or energy measurement is implied.

### explain_fee_rejection (cd77e188bd3c45e2a4a71782142e9d5d)

The paper-trading case was rejected: policy decision DENY, no executor was called, and zero new executors were added. The recorded reason is that resolved cost, including fees and slippage, exceeded the user's signed ceiling. The user's boundary is that signed maximum cost. Another person should inspect the calculation of resolved cost versus that ceiling, plus the source hash and Sepolia record transaction as a commitment to the summary. This is not live execution, and no blockchain or energy claim is made.

### explain_market_rejection (abba711a26e745539a376e89378149cf)

Recorded result: DENY, status rejected, because market_not_allowed. The executor was not called and no new executors were created. The user's boundary is that ETH was the allowed market; a BTC request therefore stops. Another person should inspect the source SHA-256 and Sepolia record transaction to confirm the summary matches this local paper-trading record. That transaction is only a commitment to the summary, not proof of execution, blockchain verification, approval, or energy measurement. No missing amounts are inferred.

## Evidence linkage and limits

Each source points to the existing Sepolia commitment and original local-evidence SHA-256. The earlier on-chain commitment covers the source summary, NOT these newly generated explanations or token logs. This report supplies measured API usage and explicit energy assumptions for an evidence-review workflow; it is not proof that Kiln generated the earlier trading plans or that the full competition submission is complete.

Regenerate without API calls: `python -m scripts.gwdc_efficiency report --output <this-directory>`.
