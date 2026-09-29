"use strict";
const byId = id => document.getElementById(id);
const fields = [
  ["owner", "address"], ["agent", "address"], ["scope", "bytes32"], ["market", "bytes32"],
  ["maxCost", "uint256"], ["budget", "uint256"], ["validAfter", "uint256"],
  ["validUntil", "uint256"], ["nonce", "uint256"], ["allowLong", "bool"],
];
const domainFields = [["name", "string"], ["version", "string"], ["chainId", "uint256"], ["verifyingContract", "address"], ["salt", "bytes32"]];
let request = null, downloadUrl = null, busy = false;
function status(text) { byId("status").textContent = text; }
function schema(value, expected) {
  return JSON.stringify(value) === JSON.stringify(expected.map(([name, type]) => ({ name, type })));
}
function validate(data) {
  if (data?.primaryType !== "Policy" || data.domain?.name !== "Nerya Mandates" || data.domain?.version !== "1" ||
      !schema(data.types?.Policy, fields) || !schema(data.types?.EIP712Domain, domainFields) ||
      Object.keys(data.types).sort().join() !== "EIP712Domain,Policy") throw new Error("请求不是受支持的 Nerya Policy v1。");
  for (const [values, definitions] of [[data.domain, domainFields], [data.message, fields]]) {
    if (!values || Object.keys(values).sort().join() !== definitions.map(([name]) => name).sort().join()) throw new Error("授权字段不完整或含未知字段。");
    for (const [name, type] of definitions) {
      const value = values[name];
      if (type === "uint256" && (!Number.isSafeInteger(value) || value < 0)) throw new Error("数字超出此签署页面支持的精确整数范围。");
      if (type === "address" && (!/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/.test(value))) throw new Error("地址无效。");
      if (type === "bytes32" && !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("范围哈希无效。");
      if (type === "bool" && typeof value !== "boolean") throw new Error("授权开关无效。");
    }
  }
  const p = data.message;
  if (data.domain.chainId <= 0 || p.maxCost <= 0 || p.budget < p.maxCost || p.validUntil <= Math.floor(Date.now() / 1000) || p.validAfter >= p.validUntil) throw new Error("额度、网络或有效期无效。");
}
function reset() {
  request = null;
  byId("review").hidden = true;
  byId("confirmed").checked = false;
  byId("sign").disabled = true;
  byId("download").hidden = true;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = null;
}
byId("request").addEventListener("change", async event => {
  reset(); status("");
  try {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 100000) throw new Error("请求文件过大。");
    const parsed = JSON.parse(await file.text());
    const data = parsed.policy_typed_data || parsed;
    validate(data);
    request = data;
    const summary = byId("summary"); summary.replaceChildren();
    const p = data.message;
    for (const [label, value] of [
      ["签名账户", p.owner], ["被授权 Agent", p.agent], ["网络 Chain ID", data.domain.chainId],
      ["验证合约", data.domain.verifyingContract], ["账户／策略范围", p.scope], ["市场范围", p.market],
      ["工作空间域", data.domain.salt], ["单次成本上限", `${p.maxCost / 1000000} USD`],
      ["累计授权上限", `${p.budget / 1000000} USD`], ["允许新开多头", p.allowLong ? "是" : "否"],
      ["生效时间", new Date(p.validAfter * 1000).toISOString()], ["到期时间", new Date(p.validUntil * 1000).toISOString()],
      ["授权 Nonce", p.nonce],
    ]) {
      const dt = document.createElement("dt"), dd = document.createElement("dd");
      dt.textContent = label; dd.textContent = String(value); summary.append(dt, dd);
    }
    byId("payload").textContent = JSON.stringify(data, null, 2);
    byId("review").hidden = false;
  } catch (error) { reset(); status(error.message); }
});
byId("confirmed").addEventListener("change", () => { byId("sign").disabled = busy || !request || !byId("confirmed").checked; });
byId("sign").addEventListener("click", async () => {
  if (busy || !request || !byId("confirmed").checked) return;
  const selected = request;
  busy = true; byId("sign").disabled = true; byId("request").disabled = true;
  byId("download").hidden = true;
  try {
    validate(selected);
    if (!window.ethereum?.request) throw new Error("未检测到浏览器钱包，请在装有钱包扩展的浏览器打开此页。");
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    const owner = selected.message.owner;
    if (!accounts[0] || accounts[0].toLowerCase() !== owner.toLowerCase()) throw new Error("当前钱包账户与授权 owner 不匹配。");
    const chain = await window.ethereum.request({ method: "eth_chainId" });
    if (BigInt(chain) !== BigInt(selected.domain.chainId)) throw new Error("钱包网络与授权网络不匹配，请手动切换后重试。");
    status("请在钱包中核对授权内容并确认签名。");
    const signature = await window.ethereum.request({ method: "eth_signTypedData_v4", params: [owner, JSON.stringify(selected)] });
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("钱包返回了无效签名。");
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(new Blob([JSON.stringify({ domain: selected.domain, policy: selected.message, policy_signature: signature }, null, 2)], { type: "application/json" }));
    byId("download").href = downloadUrl; byId("download").hidden = false;
    status("签名已导出。后续由运行时和合约验签；本页面没有发送交易。");
  } catch (error) { status(error.code === 4001 ? "你已取消钱包签名。" : error.message); }
  finally { busy = false; byId("request").disabled = false; byId("sign").disabled = !request || !byId("confirmed").checked; }
});
