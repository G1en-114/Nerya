"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { useLocale } from "next-intl";
import { caseCopy, useMandateDemo } from "../../../lib/mandateDemo";
import styles from "./safety.module.css";
import { MandatePlayground } from "../../../components/MandatePlayground";
import { MandateScenarioEvidence } from "../../../components/MandateScenarioEvidence";
import type { MandateDemo } from "../../../lib/mandateDemo";

export default function SafetyDemo() {
  const locale = useLocale();
  const zh = locale.startsWith("zh");
  const t = (cn: string, en: string) => zh ? cn : en;
  const { data: recording, state, refresh } = useMandateDemo();
  const [current, setCurrent] = useState<MandateDemo | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const data = showHistory ? recording : current;
  const [selected, select] = useState(0);
  const onResult = useCallback((result: MandateDemo) => { setCurrent(result); setShowHistory(false); select(0); }, []);
  const active = data?.cases[Math.min(selected, data.cases.length - 1)];
  const detail = active ? caseCopy(active, zh) : null;
  const money = (value: string) => new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(Number(value) / 1_000_000);
  const date = (value: string | null) => value ? new Date(value).toLocaleString(locale, { timeZone: "UTC" }) + " UTC" : t("时间未记录", "Time not recorded");
  const download = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `nerya-safety-${data.runId}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className={styles.root} data-testid="safety-demo-page">
    <Link className={styles.back} href="/dashboard">← {t("返回 Dashboard", "Back to dashboard")}</Link>
    <header className={styles.hero}>
      <div className={styles.eyebrow}>WAYAGENT FX / NERYA AGENT</div>
      <h1>Agent Safety<span>{t("让授权有边界，让执行有证据。", "Bounded authority. Inspectable execution.")}</span></h1>
      <div className={styles.designReference}>{t("设计参考：Google AP2 · Intent Signing", "Inspired by Google AP2 · Intent Signing")}</div>
      <p>{t("用户签署范围，Agent 签署动作，后端在执行前独立检查。停止越界动作，也是正确结果。", "The user signs a policy. The agent signs an action. Independent checks guard execution. Stopping is a correct outcome.")}</p>
      <div className={styles.referenceNote}>{t("我们借鉴 Google AP2（Agent Payments Protocol）的意图签署模式，以 EIP-712 将用户 Policy 与 Agent Action 绑定，再由运行时检查执行边界。当前为 Nerya 自定义授权实现，尚未验证 AP2 协议兼容性。", "We draw on the intent-signing pattern of Google AP2 (Agent Payments Protocol), binding a user policy to an agent action with EIP-712 and enforcing boundaries at runtime. This is Nerya's own authorization implementation; AP2 protocol compatibility has not been verified.")}</div>
      <div className={styles.actions}>
        <span className={styles.badge}>{t("本地 Anvil · Paper / Mock · 可交互演示", "Local Anvil · Paper / Mock · Interactive demo")}</span>
        <button className={styles.button} onClick={refresh} disabled={state === "loading"}>{t("刷新记录", "Refresh recording")}</button>
        <a href="/mandates/index.html" className={styles.button} target="_blank" rel="noreferrer">{t("钱包签署工具 ↗", "Wallet signing tool ↗")}</a>
      </div>
    </header>
    <MandatePlayground onResult={onResult} />
    <div id="safety-results" className={styles.actions} role="group" aria-label={t("结果来源", "Result source")}>
      <button className={styles.button} disabled={!current} aria-pressed={!showHistory && !!current} onClick={() => { setShowHistory(false); select(0); }}>{t("本次运行结果", "Current run results")}</button>
      <button className={styles.button} aria-pressed={showHistory} onClick={() => { setShowHistory(true); select(0); }}>{t("历史演示记录", "Historical recording")}</button>
    </div>
    <div className={styles.flow} aria-label={t("授权与执行流程", "Authorization and execution flow")}>
      {[t("用户 Policy 签名", "Signed user policy"), t("Agent Action 签名", "Signed agent action"), t("链上授权登记", "On-chain authorization"), t("运行时门禁", "Runtime gates"), t("结果与证据", "Outcome & evidence")].map((label, i) => <div key={label}><span>0{i + 1}</span>{label}</div>)}
    </div>
    {!data && !showHistory && <p className={styles.notice}>{t("运行后，实际结果会显示在操作区下方；历史演示记录需单独点击查看。", "Run a check to see its actual outcome below the controls. Historical recordings are available separately.")}</p>}
    {showHistory && !data && state === "loading" && <p role="status" className={styles.notice}>{t("正在读取演示记录…", "Loading demo recording…")}</p>}
    {showHistory && !data && (state === "missing" || state === "error") && <section className={styles.panel} role="status">
      <h2>{state === "missing" ? t("还没有发布演示记录", "No published recording yet") : t("记录暂时无法读取", "Recording unavailable")}</h2>
      <p>{t("可以直接使用上方操作区运行安全检查。若要另外发布历史记录，可展开下面的导入说明。", "Use the controls above to run a safety check. To publish a separate historical recording, expand the import instructions below.")}</p>
      <details><summary>{t("历史记录导入说明", "Historical recording import")}</summary>
      <pre>python -m scripts.mandate_demo --output .tmp/mandate-dashboard-run --publish-dashboard</pre>
      <p>{t("已有 evidence.json 也可发布：", "To publish an existing evidence.json:")}</p>
      <pre>python -m scripts.mandate_dashboard --input .tmp/mandate-demo-presentation/evidence.json</pre>
      </details>
    </section>}
    {data && active && detail && <>
      <div className={styles.runMeta}><span>{!showHistory && current ? t("本次运行", "Current run") : t("历史记录", "Historical recording")} · {date(data.recordedAt)}</span><code>Run {data.runId}</code></div>
      <dl className={styles.stats}>
        <div><dt>{t("案例总数", "Recorded cases")}</dt><dd>{data.cases.length}</dd></div>
        <div><dt>{t("模拟成交", "Paper fills")}</dt><dd>{data.cases.filter(c => c.status === "filled").length}</dd></div>
        <div><dt>{t("请求被拒绝", "Stopped requests")}</dt><dd>{data.cases.filter(c => c.status === "rejected").length}</dd></div>
        <div><dt>{t("拒绝案例新增执行器", "New executors in stopped cases")}</dt><dd>{data.cases.filter(c => c.status === "rejected").reduce((n, c) => n + c.newExecutors, 0)}</dd></div>
      </dl>
      <MandateScenarioEvidence data={data}/>
      <section className={styles.panel}>
        <div className={styles.sectionHead}><div className={styles.eyebrow}>01 / {t("授权条款", "SIGNED POLICIES")}</div><h2>{t("先看用户允许了什么", "Start with what the user allowed")}</h2></div>
        <div className={styles.policies}>{data.policies.map(p => <article key={p.hash}>
          <h3>Policy #{p.nonce} · {p.marketLabel || t("市场见哈希", "Market hash below")} <span>{p.allowLong ? t("允许新开多头", "Long opening allowed") : t("禁止新开多头", "No new long openings")}</span></h3>
          <dl><div><dt>{t("单笔上限", "Per-action ceiling")}</dt><dd>{money(p.maxCost)}</dd></div><div><dt>{t("累计授权预算", "Authorization budget")}</dt><dd>{money(p.budget)}</dd></div></dl>
          <p>{t("当次有效期", "Validity for this run")}: {date(new Date(p.validAfter * 1000).toISOString())} → {date(new Date(p.validUntil * 1000).toISOString())}</p>
          <details><summary>{t("查看签名绑定字段", "Inspect bound fields")}</summary><dl className={styles.fields}>{[["Policy hash", p.hash], ["Owner", p.owner], ["Agent", p.agent], ["Account / strategy scope hash", p.scope], ["Market hash", p.marketHash]].map(([key, value]) => <div key={key}><dt>{key}</dt><dd><code>{value}</code></dd></div>)}</dl></details>
        </article>)}</div>
        <p className={styles.muted}>{t("额度按单份 Policy 计算，表示名义金额加模拟成本；不是最大亏损承诺，也不包含链上 gas。此处展示当次条款，不表示授权现在仍有效。", "Limits apply per policy to notional plus simulated costs, not maximum loss or chain gas. These are recorded terms, not a claim that the policy is still active.")}</p>
      </section>
      <section className={styles.panel}>
        <div className={styles.sectionHead}><div className={styles.eyebrow}>02 / {t("边界演示", "BOUNDARY CHECKS")}</div><h2>{t("查看每一次允许与停止", "Inspect every execution and stop")}</h2><p>{t("点击案例查看已完成运行的结果，不会发送交易。", "Select a case to inspect the recorded outcome. This does not submit a trade.")}</p></div>
        <div className={styles.caseGrid}>
          <div className={styles.caseList} aria-label={t("演示案例", "Demo cases")}>{data.cases.map((c, i) => <button key={c.id} className={styles.caseButton} aria-pressed={active.id === c.id} onClick={() => select(i)}>
            <span className={styles.caseNumber}>{String(i + 1).padStart(2, "0")}</span><span>{caseCopy(c, zh).title}</span><span className={c.status === "filled" ? styles.allow : styles.deny}>{c.status === "filled" ? "ALLOW" : "DENY"}</span>
          </button>)}</div>
          <article className={styles.caseDetail} aria-live="polite" data-testid="safety-case-detail">
            <div className={styles.eyebrow}>{t("记录结果", "RECORDED OUTCOME")} / {String(active.id).padStart(2, "0")}</div>
            <h3>{detail.title}</h3><p>{detail.description}</p>
            <dl className={styles.outcome}>
              <div><dt>{t("运行时结果", "Runtime outcome")}</dt><dd className={active.status === "filled" ? styles.allow : styles.deny}>{active.status === "filled" ? t("模拟已成交", "Paper filled") : t("已拒绝", "Rejected")}</dd></div>
              <div><dt>{t("新增执行器", "New executors")}</dt><dd>{active.newExecutors}</dd></div>
              <div><dt>{t("当次授权交易", "Authorization transaction")}</dt><dd>{active.authorizationStatus === 1 ? t("成功", "Succeeded") : active.authorizationStatus === 0 ? t("已回退", "Reverted") : t("本次未发送", "Not submitted in this case")}</dd></div>
            </dl>
            <dl className={styles.fields}>{[["Runtime reason", active.reason], ["Chain reason", active.chainReason], ["New orders", active.newOrders?.toString()], ["New fills", active.newFills?.toString()], ["Plan ID", active.planId], ["Policy hash", active.policyHash], ["Action hash", active.actionHash], ["Plan hash", active.planHash], ["Authorization tx", active.authorizationTx]].map(([key, value]) => <div key={key}><dt>{key}</dt><dd><code>{value || t("此结果未记录", "Not recorded in this result")}</code></dd></div>)}</dl>
            <p className={styles.muted}>{t("执行器数量来自演示脚本读取的持久化记录。链上授权成功仍可能被运行时拒绝；它不等于成交证明。", "Executor counts come from persisted records read by the demo script. A successful chain authorization may still be rejected at runtime; it is not proof of a fill.")}</p>
            <button className={styles.button} disabled={selected >= data.cases.length - 1} onClick={() => select(i => i + 1)}>{t("下一个案例 →", "Next case →")}</button>
          </article>
        </div>
      </section>
      <section className={styles.panel}>
        <div className={styles.sectionHead}><div className={styles.eyebrow}>03 / {t("证据与收据", "EVIDENCE & RECEIPTS")}</div><h2>{t("从结果回到链上记录", "Trace outcomes to chain records")}</h2></div>
        <div className={styles.actions}><button className={styles.primary} onClick={download}>{t("下载本次展示数据 JSON", "Download displayed evidence JSON")}</button><span className={styles.muted}>Chain {data.chainId} · {data.receipts.length} {t("笔收据", "receipts")}</span></div>
        <dl className={styles.fields}><div><dt>{t("验证合约", "Verifier contract")}</dt><dd><code>{data.contract}</code></dd></div><div><dt>{t("撤销交易", "Revocation transaction")}</dt><dd><code>{data.revocationTx || "—"}</code></dd></div></dl>
        <details><summary>{t("展开本地链交易收据", "Inspect local transaction receipts")}</summary><div className={styles.receipts}>{data.receipts.map(r => <article key={r.transactionHash}><code>{r.transactionHash}</code><span>Block {r.blockNumber} · {r.status === 1 ? "SUCCESS" : "REVERTED"} · Gas {r.gasUsed}</span></article>)}</div></details>
        <p className={styles.muted}>{t("这是本地 Anvil 运行的公开字段摘要，不包含私钥、Vault、完整签名包或工作区配置。原始 evidence.json 保留在运行输出目录。", "This is a public-field summary of the local Anvil run. It excludes keys, Vault contents, full signature envelopes and workspace configuration. The original evidence.json remains in the run output directory.")}</p>
      </section>
    </>}
    <aside className={styles.notice}><strong>{t("演示范围", "Demonstration scope")}</strong><p>{t("自动化测试用户签名、本地链、合成行情与模拟成交。链已在运行结束后关闭，哈希不支持公开浏览器查询；尚未完成真实用户钱包授权、公开测试网或实盘覆盖验证。普通运行日志也不等于不可篡改证明。", "Automated test-owner signatures, local chain, synthetic prices and paper fills. The chain closes after the run; hashes cannot be looked up on a public explorer. Human wallet approval, public-testnet deployment and live-account coverage are not established by this recording. Runtime logs are not tamper-proof evidence.")}</p></aside>
  </div>;
}
