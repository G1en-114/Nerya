/**
 * Reference implementation for a Nerya-compatible TS/Node wallet skill.
 *
 * Nerya invokes this file with `node ts_wallet_skill.js` and writes a
 * single JSON line on stdin describing the command it wants you to run.
 * Your code is expected to write a single JSON line on stdout with the
 * result (any preceding lines are treated as debug logs and ignored).
 *
 * Wire this into your preferred TS wallet library (e.g. goat-sdk,
 * @coinbase/cdp-sdk, bitget-wallet-skill, binance-agentic-wallet) by
 * filling in the `dispatch` switch below. Do NOT install anything from
 * here — shipping dependencies is an operator decision; `package.json`
 * and `npm install` are up to them.
 *
 * Configure provider=external, command=["node", "/absolute/path/adapter.js"].
 * Contract v1 is documented by the adapter Skill. Keep describe
 * fail-closed until quote minimums and receipt lookup are implemented.
 */

const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", async () => {
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  let input;
  try {
    input = JSON.parse(raw || "{}");
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false, reason: `invalid_json_stdin: ${err.message}`,
    }) + "\n");
    process.exit(2);
  }
  try {
    if (input.protocol_version !== 1) throw new Error("unsupported_protocol_version");
    const out = await dispatch(input.command, input.payload || {});
    process.stdout.write(JSON.stringify({ protocol_version: 1, ...out }) + "\n");
  } catch (err) {
    process.stdout.write(JSON.stringify({
      protocol_version: 1, ok: false, reason: "adapter_operation_failed",
    }) + "\n");
    process.exit(1);
  }
});

async function dispatch(command, payload) {
  switch (command) {
    case "describe":
      return { swap_chains: [], minimum_output: "unknown", receipt_polling: false };
    case "balance":
    case "quote":
    case "candles":
      throw new Error("read_adapter_not_implemented");
    case "swap":
      return {
        ok: false,
        status: "failed",
        tx_hash: "",
        amount_out: 0,
        reason: "stub — implement via your TS wallet lib",
      };
    case "get_execution_status":
      return { status: "unknown", confirmed: false, reason: "receipt_reader_not_implemented" };
    default:
      return { ok: false, reason: `unknown_command: ${command}` };
  }
}
