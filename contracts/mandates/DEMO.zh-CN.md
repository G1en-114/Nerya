# Agent Safety / Policy：签名授权与边界拦截演示

项目 **Nerya Agent**，战队 **WayAgent FX**，代表 **非小号 × WayToWeb4**。

这次交付把“谁授权、授权了什么、Agent 请求了什么、为什么停止”连接成了可检查的流程。它回应评委对 intent signing、constraints 和 evidence 的追问，但没有官方依据可以把它换算成“60 分到 85 分”或“总分增加 6–9%”。

## 1. 这次实际做到了什么

| 能力 | 实际实现与验证 | 对评委问题的回答 |
|---|---|---|
| 用户授权签名 | EIP-712 Policy，包含 owner、agent、账户/策略范围、市场、额度、有效期与 nonce | 用户批准的具体条款可以验签；签名者必须匹配操作员登记的 owner |
| Agent 动作签名 | Action 引用 Policy digest 和实际 TradePlan digest | 动作与授权可关联；签名后修改策略动作会失败 |
| 链上授权登记 | Solidity 验签、预算与 nonce 检查，实际本地链交易和事件 | 授权记录有交易收据；不能把一条普通日志当成链上证据 |
| 运行时约束 | 在现有 RiskGate、ApprovalGate 与 BudgetChecker 之外叠加验证 | 签名通过不会跳过原有风控和人工审批 |
| 费用边界 | 根据模拟执行器的手续费和滑点复核成本上限 | Agent 不能以低报成本的方式让本次支持的模拟单超额执行 |
| 撤销与到期 | 合约 owner 撤销；运行时与执行边界复查撤销和有效期 | 用户可以停止尚未执行的授权，已执行结果不能回滚 |
| 重放与恢复 | 链上动作 nonce；本地 SQLite 原子认领；执行前单次标记 | 同一授权动作不能通过重复提交或审批恢复路径再次成交 |
| 浏览器钱包入口 | `/mandates/index.html` 导入请求、确认、校验账户和网络、签名导出 | 可以用钱包签署用户授权，无需把私钥交给页面 |

**验证环境必须说清楚：**已经完成的是本地 Anvil 链上的真实合约调用、Nerya paper/mock 执行、合成行情、隔离测试密钥签名。浏览器钱包界面通过了 mock provider 检查，尚未完成真人钱包签名录像或公开测试网部署。

## 2. 如何打开演示

在项目根目录运行：

```powershell
forge build --root contracts/mandates

forge test --root contracts/mandates --offline
python -m scripts.mandate_demo --output .tmp/mandate-demo-presentation
```

需要 Foundry 和 Python `mandates` extra；如果依赖未安装，执行 `python -m pip install -e ".[mandates,dev]"`。每次使用新的输出目录，脚本拒绝覆盖已有工作空间。

打开生成的 `report.html`，旁边的 `evidence.json` 包含完整证据。演示会启动并关闭自己的本地链，不使用当前运行中的交易账户。链关闭后，报告里的哈希对应导出的本地收据，不能拿到公开区块浏览器查询。

钱包签署入口：<http://127.0.0.1:3001/mandates/index.html>。钱包请求和 Agent 签名命令参见 [实现说明](README.md)。

## 3. 跟评委讲的 90 秒版本

### 开场：接住评委的问题

中文：

您之前问到两个问题：用户如何明确授权，Agent 如何保证不超出这个授权。我们把授权条款和执行动作分别做成签名数据，并且把它们关联起来。

English:

> You asked how the user authorizes an Agent, and how we enforce the boundaries of that authorization. We now bind a signed user policy to a separately signed Agent action.

### 第一屏：展示被签署的内容

中文：

这份 Policy 指定了用户、Agent、账户和策略范围、市场、额度以及有效期。Agent 的 Action 引用这份授权的哈希，也绑定即将提交的完整策略动作。修改授权或动作，验签或动作匹配就会失败。

English:

> This policy identifies the owner, delegated Agent, account and strategy scope, market, budget and expiry. The Agent action references the policy hash and the exact trade-plan hash. Changing either payload breaks verification or the binding to the submitted plan.

### 第二屏：展示允许与拒绝

中文：

这里合规的请求实际走完了模拟执行。随后用户改变允许的市场，BTC 请求被拒绝；用户禁止新开多头后，开多请求也被拒绝。另外，即使合约已经登记授权，运行时发现加入手续费和滑点后的成本超过签署上限，也会停止。

English:

> The permitted request completes paper execution. When the user changes the allowed market, the BTC request stops. When the user prohibits new long openings, that request also stops.
>
> We also check costs at runtime. Even an anchored authorization is rejected if the resolved cost, including simulated fees and slippage, exceeds the signed ceiling.

### 第三屏：打开证据

中文：

这里是授权交易收据、Policy 与 Action 哈希、运行时拒绝原因，以及执行器记录。报告记录了这六个拒绝案例前后的执行器数量，均没有新增执行器。我们还测试了在执行器创建之后撤销授权的情况：执行器会再次检查，并拒绝成交。

English:

> Here are the authorization receipts, policy and action hashes, runtime decisions, and executor records. Each of these six rejected submissions created zero new executors. We also test revocation after executor creation: the final execution check stops the fill.

### 收尾：明确技术和边界

中文：

我们借鉴了 signed delegation 的思路，使用 EIP-712 与 secp256k1 实现这套原型。当前展示范围是本地链与模拟市价交易；我们没有声称实现完整 AP2 协议或覆盖所有实盘交易路径。

English:

> This prototype uses EIP-712 signed delegation with secp256k1 signatures. Today we demonstrate it on a local EVM chain and paper market orders. We do not claim full AP2 compliance or coverage of every live trading path.

## 4. 七个实际演示案例

| 案例 | 条件／操作 | 预期并实际检查的结果 |
|---|---|---|
| 1. ALLOW | 用户允许 BTC，100 USD 模拟单，签署成本上限 101 USD | 链上授权成功；创建执行器并完成模拟成交 |
| 2. 改变市场范围 | 用户签署新的 ETH-only Policy，Agent 仍请求 BTC | 合约拒绝，运行时拒绝，新增执行器为 0 |
| 3. 费用后超限 | 99 USD 模拟单，签署上限也为 99 USD | 合约可接受声明的额度；运行时算入费用／滑点后拒绝，新增执行器为 0 |
| 4. 禁止新开多头 | 用户签署 `allowLong=false` 的新 Policy，Agent 请求开多 | 合约与运行时拒绝，新增执行器为 0 |
| 5. 签署后篡改 | 对已签署的动作修改下单大小 | plan hash 不一致，新增执行器为 0 |
| 6. 重放 | 将已成交动作通过内部审批恢复路径再次提交 | 本地已认领 nonce 拒绝，新增执行器为 0 |
| 7. 撤销 | 动作已登记链上，owner 随后撤销 Policy，再提交动作 | 运行时观察到撤销，新增执行器为 0 |

数字均为本地合成示例，不是真实账户绩效。“成本上限”是名义金额加模拟费用的上限，不是最大亏损，也不包含链上登记／撤销所花的 gas。

## 5. 评委追问时的准确回答

**“这是不是 AP2？”**

这是受签名授权思路启发的 Nerya 应用协议，不是 AP2 的兼容实现。没有按官方协议完成互操作测试，也没有实现完整 Intent/Cart/Payment mandate 格式。不要说“AP2 80% 实现”或“Google hosted AP2”。

**“链上验签是不是就保证 Agent 不会越权？”**

验签证明签名者与数据完整性；权限是否满足仍需要规则检查。合约检查它能看到的市场、额度、期限与 nonce，运行时把签名绑定到实际 TradePlan，并检查成本和原有交易门禁。合约并不知道 CEX 的真实仓位与成交结果。

**“可以保证 BTC 净多头永远为零吗？”**

当前限制是这个 mandate 下禁止新开多头。买入平空不会被简单误判为开多，原有仓位检查仍验证平仓数量。尚未实现跨账户、跨交易所、并发订单下的组合净敞口保证，不能这样宣传。

**“撤销立即生效吗？”**

执行边界会重新读取链上撤销状态，观察到撤销后拒绝未执行动作。链上读操作与链下成交不是同一笔原子交易，所以撤销仍有传播和竞态窗口。已经完成的交易不因撤销而回滚。

**“为什么重启不会再次执行？”**

本地数据库以 policy hash + nonce 原子认领，再在执行前标记已经开始。结果不确定时保守拒绝自动重试。这个保证依赖保留本地状态；不能清空数据库或复制到多个独立运行实例后仍声称全局 exactly-once。

**“支持真实钱包签名吗？”**

提供了浏览器 `eth_signTypedData_v4` 页面与操作员请求导出工具。页面检查账户、网络与用户确认，后端和合约再次验签。目前已验证真实密码学签名和本地 EVM 的一致性；真人钱包操作录像仍需要由用户实际完成。当前验签只支持 EOA，不支持 EIP-1271 合约钱包。

**“签名数据和日志是否全都可信？”**

签名与链上记录使授权内容和动作关联可核验。普通本地拒绝日志并没有自动上链或签名；它们是运行时证据，不应称为不可篡改账本。公开演示时可以同时展示测试、收据、授权数据和调用记录。

## 6. 当前交付范围与正式参赛前的剩余事项

已完成代码、离线单元测试、本地 EVM 合约测试、本地端到端报告和钱包签署页面。当前实例没有自动开启此功能，也没有改动现有交易账户、发送公开链交易或执行真实资金交易。

正式提交前，仍需要选定公开测试网、使用测试 gas 部署，并保存能够由第三方独立查看的交易哈希与匹配日志；录制真实用户钱包授权和撤销操作。本地 Anvil 收据不能冒充公开测试网完成情况。

这个模块也不能替代 Kiln 指定模型接入、按流程 token 统计、能耗依据，以及用户工作流说明。按 FuriosaAI × Bricksum Agent Finance Bonus Track 的 A/B 验收条款分项提供证据，不把安全原型当作整条赛道验收已经完成。
