<div align="center">

<img src="branding/logo.png" alt="Nerya" width="88" />

# Nerya

### 一句想法，一支策略团队。

你的本地 Agent 策略工作区：在同一条对话中完成研究、策略构建、回测和复盘。

**1.0.0 Beta** · `1.0.0-beta.1`

[English](README.md) · [简体中文](README.zh-CN.md)

[官网](https://neryaai.github.io/) · [使用文档](https://neryaai.github.io/docs.html) · [桌面端下载](https://github.com/NeryaAI/Nerya/releases) · [构建状态](https://github.com/NeryaAI/Nerya/actions/workflows/desktop.yml)

[![桌面端 CI](https://github.com/NeryaAI/Nerya/actions/workflows/desktop.yml/badge.svg)](https://github.com/NeryaAI/Nerya/actions/workflows/desktop.yml)
[![版本](https://img.shields.io/badge/version-1.0.0--beta.1-7961e8)](VERSION)
[![许可证](https://img.shields.io/badge/license-PolyForm%20Noncommercial-blue)](LICENSE)

</div>

你提出交易逻辑与约束，Agent 分工研究、编写策略并检查假设。你可以看到工具执行过程，查看证据，在对话中打开策略和回测详情，再决定下一步怎么做。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="branding/screenshots/1.0.0-beta/strategy-zh-dark.gif" />
  <img src="branding/screenshots/1.0.0-beta/strategy-zh-light.gif" alt="Nerya 中文策略对话与工作流" width="100%" />
</picture>

*素材录制自官网的隔离演示工作台，使用示例数据，不连接真实账户，也不代表已验证的投资收益。[查看素材来源](branding/screenshots/1.0.0-beta/README.md)。*

## 从一个想法，到每一步都有据可查

**说出想法，开始构建。** 描述目标市场、入场与出场条件、时间范围和风险约束。Agent 准备策略包并执行校验。纯脚本策略、脚本驱动 Agent 策略和事件驱动 Agent 策略共用同一工作区，保留可读的工作流节点、参数和运行记录。

**让 Agent 分工研究。** 研究员分别分析行情、新闻和技术信号，审阅员检查假设，协调 Agent 汇总证据。研究资料和报告可以直接打开，不必离开当前对话重新寻找上下文。

**结果不止一段文字。** 策略卡片、回测曲线、行情图表和完整投研报告都能出现在对话中，并在工作区标签页中展开。回测详情包含已有的历史 K 线、买卖标记、保护价位、交易明细和执行证据；数据缺失会明确展示，不把不完整结果包装成完整回测。

**查看记录，再做改动。** 可以回到某次运行，检查日志和执行过程。按需开启复盘计划，让 Agent 根据证据提出建议和候选改动。策略复盘、交易授权与普通资源编辑是不同流程：Skill 和 Agent 资源可以直接编辑保存。

**把工作区留在本地。** 策略、历史行情缓存、报告和配置保存在自己的工作区，账户凭据加密存入本地 Vault，并通过引用传递。使用外部模型、行情服务或工具时，仍会向相应服务发送执行任务所需的请求；本地存储不等于全部离线。

## 1.0.0 Beta 包含什么？

| 模块 | 工作区能力 |
| --- | --- |
| Agent 对话 | 流式回复、模型提供的思考输出、工具执行、进度、追加消息和错误恢复 |
| 策略 | 脚本与 Agent 执行、定时器／事件工作流节点、编辑、导入导出和运行详情 |
| 回测 | 可复用的本地历史数据、运行前检查、覆盖情况、分品种图表和交易记录 |
| 投研 | 行情卡片、技术图表、带证据的报告和多 Agent 协作 |
| 技能与 Agent | `SKILL.md` 规范、按需加载参考资料、可复用脚本和直接编辑保存 |
| 接入 | 模型服务、交易所／钱包连接、MCP 和外部 Agent 接入 |
| 桌面端 | Tauri 外壳，内置 Python、Node、Web 工作台及 Chromium；三平台原生构建流水线 |
| 界面 | 中英文、明暗主题、工作区标签页及集中管理模型与账户的设置页 |

研究市场与交易接入范围不能混为一谈。加密货币交易所使用已配置的连接器；钱包和预测市场操作取决于对应服务与凭据。期货、A 股研究示例不表示所有券商、订单类型或品种都已经能够执行交易。

## 安装桌面端

进入 [GitHub Releases](https://github.com/NeryaAI/Nerya/releases)，选择一个**已完成发布**的版本，下载与系统及处理器匹配的安装包。

| 平台 | 架构 | 发布文件 |
| --- | --- | --- |
| macOS | Apple Silicon / ARM64 | `.dmg`、`.pkg` |
| macOS | Intel / x64 | `.dmg`、`.pkg` |
| Windows | x64 | NSIS `.exe`、Windows Installer `.msi` |
| Linux | x64 | `.deb`、`.AppImage` |

桌面安装包携带应用所需的 Python、Node、Web 服务和浏览器引擎，使用时不需要安装开发工具链。Windows 安装包包含离线 WebView2 安装器。Linux 仍依赖发行版提供的桌面和浏览器系统库，当前构建基线为 Ubuntu 22.04。详细说明见 [桌面端安装与构建文档](desktop/README.md)。

默认 Beta 流水线使用 macOS ad-hoc 签名，Windows 安装包未签名，除非另外接入正式签名流程。它们**不等同于**经过 Apple Developer ID 公证或获得 Windows 信誉认可的安装包。请遵循操作系统及组织的安全政策，不要为了安装不可信版本关闭系统安全保护。

首次启动时配置模型，按需连接交易账户，并为外部访问配置管理员密码。新工作区**不预置策略或定时交易任务**。后续可以在设置中修改模型、账户和访问选项；升级不会静默清空已有工作区。

## 试试第一个任务

> 使用已有历史数据研究 BTC/USDT。创建一个有明确入场和出场规则的脚本策略，完成校验并运行历史回测。展示策略工作流、数据覆盖情况和交易明细，不要启动实盘交易。

也可以先做纯投研：

> 对比 BTC 与 ETH 当前的市场状态。让研究员分别分析价格行为和新闻，引用证据，输出带行情图表的研究报告，并说明缺失的数据。

模型能否调用、行情能否获取取决于你配置的服务。回测是历史模拟，不代表未来收益。启动执行前，请检查策略代码、参数、数据覆盖、手续费和交易权限。

## 测试网风控存证

操作员可以把一次已保存的策略风控决策摘要写入 Sepolia 或 Base Sepolia。需要安装 `.[trading]`，准备测试网 RPC、少量测试币，并在工作空间密钥库中保存演示钱包私钥，作用域设为 `chain_audit`；命令只接受 `vault://` 引用，不接受明文私钥。`anchor` 是显式的链上广播，会消耗测试币支付 gas。

```powershell
$env:NERYA_TESTNET_RPC_URL = "https://<your-sepolia-rpc>"
python -m nerya.cli.app chain-evidence prepare --strategy-id <strategy-id> --session-id <session-id>
python -m nerya.cli.app chain-evidence anchor --strategy-id <strategy-id> --session-id <session-id> --chain sepolia --signer-ref vault://<secret-name>
python -m nerya.cli.app chain-evidence verify --strategy-id <strategy-id> --session-id <session-id> --chain sepolia
```

`session-id` 来自交易计划提交结果。`prepare` 显示待存证内容及 SHA-256 摘要；`verify` 从测试网读取交易与回执，核对链 ID、摘要和确认状态。工作空间 `journals/chain_evidence.jsonl` 保存会话 ID、交易哈希与状态。工作空间不在默认位置时，每条命令都加 `--workspace <path>`。这只证明决策摘要被写入测试网，不证明该风控结论本身正确。

## 从源码运行

源码方式适用于开发与服务端部署。Node 和 Python 版本分别固定在 `.node-version` 与 `.python-version`。

```bash
git clone https://github.com/NeryaAI/Nerya.git
cd Nerya
uv venv
uv pip install -e ".[dev,mcp,trading,prediction,browser]"
npm ci
npm --prefix desktop ci
```

启动桌面开发模式：

```bash
npm --prefix desktop run dev
```

桌面启动器负责管理本地服务。源码构建还需要 Rust 和对应平台的原生构建依赖。纯 Web 部署可参考现有 [CLI / MCP 指南](MCP.md) 及 `nerya --help`；Web 工作台仍可独立于 Tauri 使用。

## 构建、校验与发布

```bash
python scripts/release_version.py
npm run typecheck --workspace @nerya/dashboard
npm run check:i18n --workspace @nerya/dashboard
python -m unittest discover -s desktop/tests -v
npm --prefix desktop run build
python desktop/scripts/verify_runtime.py
python desktop/scripts/smoke.py --access-port 0
```

Python 命令应在项目虚拟环境中运行。macOS 构建应用后还可以执行 `node desktop/scripts/installer.mjs` 生成 `.pkg`。[桌面文档](desktop/README.md) 包含各平台的完整打包命令和安装包校验方式。

[桌面 CI/CD](.github/workflows/desktop.yml) 分别使用 Windows、Linux、Apple Silicon Mac 和 Intel Mac 构建，检查版本一致性、锁定依赖、前端类型、Python 分发内容、桌面单元测试和打包后的运行时。安装包测试使用临时工作区与测试凭据，不调用真实模型、不执行交易；Rust 编译成功并不意味着安装包已经通过验证。

推送与 `VERSION` 一致的标签，例如 `v1.0.0-beta.1`，即可请求发布。只有必需的流水线任务全部通过，发布任务才会上传安装包、SHA-256 校验和与构建元数据。普通提交和 Pull Request 只构建产物，不发布版本。原生通知授权、系统信任提示和各交易服务的实盘接入仍需要分别验收。

## 项目结构

```text
nerya/              Python Agent 运行时、API、连接器与交易服务
nerya/skills/       内置 SKILL.md 技能、参考资料和执行脚本
nerya/sdk/          运行时策略、交易和触发器 API
sdk/               Python 与 TypeScript 客户端 SDK
dashboard/         Next.js 对话与策略工作台
desktop/           Tauri 外壳、便携运行时打包与原生冒烟测试
tests/             运行时回归测试
.github/workflows/ 校验、桌面原生构建与版本发布
```

## 本机视觉栈（点头 / 人脸登录）

审批卡点头意向与登录人脸验证运行在独立的 `.venv-face` 推理环境。演示机一条命令完成部署：创建虚拟环境、安装视觉依赖、把 `models/uniface/`（随仓库提交，离线可用）播种到模型缓存，并对点头 / 人脸两个 worker 做冒烟验证：

```bash
python scripts/setup_vision_stack.py
```

点头检测以「摄像头作用域的热 worker」运行：开摄像头时加载模型，关闭摄像头即释放（另有 180 秒闲置兜底回收），连续采集每次约 0.5 秒。人脸特征加密存储、原始帧不落盘；点头只表达确认意向，不是身份核验，也从不绕过风控与审批闸门。

## GWDC 2026 披露与证据

按赛道规则，本节区分**赛前完成**与**赛中完成**的工作。

**赛前已有：** 策略生成/回测流水线、证据库及其存储契约（`nerya/evidence/store.py`、`nerya/evidence/visual.py` 数据契约）、审批/风控闸门（`ApprovalGate`、`RiskGate`）、网关与账户面板、加密人脸录入登录、视觉证据存储与页面脚手架。

**赛中完成：** 视觉证据工作台表面接线（路由/客户端/页面传输、侧边栏入口）——[PR #6](https://github.com/NeryaAI/Nerya/pull/6)、[PR #11](https://github.com/NeryaAI/Nerya/pull/11)；审批卡点头意向检测（连拍 → 绑定审批内容摘要的单次回执；由 `/approvals/callback` 消费；`RiskGate` 未动）——PR #6；演示初始密码（`1145141919810`，设置操作员密码后立即失效）——PR #6；本机访问判定修正与模型加载修复——PR #6；硬拒绝演示证据（`tests/test_hard_rejection_demo.py`）：触犯硬性上限的请求在任何审批卡出现前即被拒绝，已捕获的点头回执无法重新绑定到该请求，恢复时二次风控复核仍然拒绝——执行器对此类请求不可达；Kiln 用量证据导出器（`scripts/export_kiln_usage.py`）。

**如实声明：** 点头检测只表达确认意向——不是身份核验、不是活体/防翻拍检测，从不绕过风控与审批闸门。人脸特征仅存本机，任何生物特征数据不出机器。

### API 用量证明（两条硬性要求，均已一键化）

**1. Kiln —— NPU LLM `gpt-oss-120b` 的 HTTP 调用。** Kiln 提供 OpenAI 兼容接口（`https://api.bricksum.com/v1`）。一条命令存入 `sk-bk-...` 密钥并把全部模型档位切到 Kiln，然后重跑演示流程，日志里即为真实 Kiln 调用：

```bash
python scripts/setup_gwdc_infra.py kiln --workspace <workspace-root> --api-key sk-bk-...
# 重启 `nerya serve`，跑完演示流程后：
python scripts/export_kiln_usage.py --workspace <workspace-root>
```

**2. 区块链 —— testnet 锚定与 `tx_hash`。** 生成 Sepolia 签名密钥入库，水龙头充值后，把持久化的风控决策（32 字节证据声明哈希）以自址交易锚定上链：

```bash
python scripts/setup_gwdc_infra.py chain-key --workspace <workspace-root>      # 输出待充值地址
python scripts/setup_gwdc_infra.py chain-check --workspace <workspace-root>    # chainId + 余额探测
python -m nerya.cli.app chain-evidence anchor --workspace <workspace-root>   --strategy-id <id> --session-id <id> --chain sepolia   --signer-ref vault://chain_audit_sepolia_team3
python scripts/export_kiln_usage.py --workspace <workspace-root>               # tx 哈希在此浮出
```

将导出输出粘贴到下方，并为每行标注对应的演示流程。（Team 3：提交前填入 Kiln 调用数据与 tx 哈希。）

### 演示说明

- 全新安装使用初始密码 `1145141919810` 登录；在 设置 → 登录与访问 设置自己的密码后立即失效。为演示零配置有意提交——正式使用前务必修改。
- 视觉证据演示样例在 `docs/demo-samples/`（正常 / 单位歧义 / 模糊截断）。

## 安全与许可

实盘执行需要相应配置与授权，请勿绕过交易风险和审批检查。Vault 加密保护落盘凭据，不能阻止已被攻破的运行进程读取数据。备份工作区及加密密钥，不要将账户密钥、`.env` 文件或真实交易状态提交到 Git。

Nerya 使用 [PolyForm Noncommercial 1.0.0](LICENSE) 许可证，商业使用需要单独授权。安装包内的第三方组件保留各自的许可。此 Beta 版本用于研究和策略操作，不构成投资建议，也不保证避免资金损失。
