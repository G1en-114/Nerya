"use client";

import { useLocale } from "next-intl";
import type { MandateDemo } from "../lib/mandateDemo";
import styles from "../app/dashboard/safety/safety.module.css";

export function MandateScenarioEvidence({ data }: { data: MandateDemo }) {
  const locale = useLocale();
  const zh = locale.startsWith("zh");
  const t = (cn: string, en: string) => zh ? cn : en;
  const usd = (amount: number) => new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(amount);
  const units = (amount: string) => usd(Number(amount) / 1_000_000);
  const reconciliation = data.reconciliation;
  if (data.budgetSteps?.length) return <section className={styles.panel} data-testid="budget-evidence">
    <div className={styles.sectionHead}><div className={styles.eyebrow}>CONTINUOUS BUDGET</div><h2>{t("拆成多笔，也不能越过同一授权的预算", "Splitting orders does not expand the policy budget")}</h2><p>{t("同一份 220 USD 授权，每笔动作最多占用 101 USD。下列数值来自本次链上状态与本地成交记录。", "One $220 policy, with a $101 ceiling per action. Values below come from this run's chain state and local fill records.")}</p></div>
    <ol className={styles.evidenceSteps}>{data.budgetSteps.map(s => <li key={s.step}>
      <h3>{t(`第 ${s.step} 笔`, `Request ${s.step}`)} · {usd(s.notionalUsd)} <span className={s.chainReason ? styles.deny : styles.allow}>{s.chainReason ? "DENY" : "ALLOW"}</span></h3>
      <progress aria-label={t(`第 ${s.step} 笔后的授权占用`, `Authorization used after request ${s.step}`)} value={Number(s.chainSpent)} max={Number(s.budget)}/>
      <dl className={styles.outcome}>
        <div><dt>{t("链上累计授权", "Chain authorization used")}</dt><dd>{units(s.chainSpent)}</dd></div>
        <div><dt>{t("本地累计占用", "Local claims used")}</dt><dd>{units(s.localSpent)}</dd></div>
        <div><dt>{t("剩余授权额度", "Authorization remaining")}</dt><dd>{units(s.remaining)}</dd></div>
      </dl>
      <p>{t("累计模拟成交", "Cumulative paper fills")}: {s.fills} · {t("实际成交成本合计", "Actual fill cost total")}: {usd(s.fillCostUsd)}</p>
      <p>{t("本次签署上限", "Signed ceiling")}: {units(s.ceiling)} · Block {s.blockNumber}</p>
      {s.chainReason && <p className={styles.deny}>{t("链上拒绝原因", "Chain rejection")}: <code>{s.chainReason}</code> · {t("没有新增订单或成交", "No new order or fill")}</p>}
    </li>)}</ol>
    <p className={styles.muted}>{t("额度按签署的成本上限占用，实际成交成本单独记录；剩余授权额度不是钱包现金。三个请求使用不同名义金额，保留系统原有重复请求检查。", "Authorization is consumed at the signed ceiling; actual fill costs are recorded separately. Remaining authorization is not wallet cash. Distinct notionals preserve the existing duplicate-intent checks.")}</p>
    <details><summary>Policy hash</summary><code className={styles.evidenceCode}>{data.budgetSteps[0].policyHash}</code></details>
  </section>;
  if (!reconciliation) return null;
  return <section className={styles.panel} data-testid="reconciliation-evidence">
    <div className={styles.sectionHead}><div className={styles.eyebrow}>POST-EXECUTION CHECK</div><h2>{t("成交之后，发现差异并停止后续交易", "Detect drift after a fill and stop subsequent trades")}</h2></div>
    <ol className={styles.evidenceSteps}>
      <li><h3>{t("1. 正常成交与基线对账", "1. Paper fill and clean baseline")}</h3><p>{t("先通过签名授权完成模拟成交，确认本地记录一致。", "A signed action completes a paper fill; baseline reconciliation confirms consistent local records.")}</p><code className={styles.evidenceCode}>{reconciliation.baselineReportId}</code></li>
      <li><h3>{t("2. 明确注入模拟故障", "2. Explicit test fault injection")}</h3><p>{t(`仅在隔离演示的仓位记录中增加 ${reconciliation.injectedDeltaBase} BTC，不修改原成交记录。`, `Add ${reconciliation.injectedDeltaBase} BTC only to the isolated demo's position record, leaving the original fills intact.`)}</p></li>
      <li><h3>{t("3. 实际对账检出差异", "3. Reconciliation detects the difference")}</h3>
        {reconciliation.differences.map(d => <div key={d.positionId}><p>{d.market} · <code>{d.kind}</code></p><dl className={styles.outcome}><div><dt>{t("成交推算仓位（BTC）", "Fill-derived position (BTC)")}</dt><dd>{d.expectedNet}</dd></div><div><dt>{t("记录仓位（BTC）", "Recorded position (BTC)")}</dt><dd>{d.observedSize}</dd></div><div><dt>{t("差异（BTC）", "Difference (BTC)")}</dt><dd>{Number((d.observedSize-d.expectedNet).toFixed(8))}</dd></div></dl></div>)}
        <p>{new Date(reconciliation.detectedAt * 1000).toLocaleString(locale)} · {reconciliation.severity}</p><code className={styles.evidenceCode}>{reconciliation.reportId}</code>
      </li>
      <li><h3>{t("4. 停止状态落盘，后续请求被拒绝", "4. Persist the stop and refuse subsequent requests")}</h3><p>{reconciliation.haltPersisted ? t("重新加载配置后，停止开关仍然生效。", "The stop remains active after configuration is reloaded.") : t("未确认停止状态持久化。", "Stop persistence has not been confirmed.")} {t(`已验证 ${reconciliation.blockedAttempts} 次拒绝，包括重新加载后的重试。`, `${reconciliation.blockedAttempts} refusals verified, including a retry after reloading.`)}</p>
        <dl className={styles.outcome}><div><dt>{t("被拒绝请求新增订单", "New orders from refused requests")}</dt><dd>{data.cases.filter(c => c.status === "rejected").every(c => c.newOrders != null) ? data.cases.filter(c => c.status === "rejected").reduce((n,c) => n + (c.newOrders ?? 0), 0) : "—"}</dd></div><div><dt>{t("被拒绝请求新增成交", "New fills from refused requests")}</dt><dd>{data.cases.filter(c => c.status === "rejected").every(c => c.newFills != null) ? data.cases.filter(c => c.status === "rejected").reduce((n,c) => n + (c.newFills ?? 0), 0) : "—"}</dd></div><div><dt>{t("自动恢复", "Automatic recovery")}</dt><dd>{reconciliation.automaticResume ? t("开启", "Enabled") : t("关闭", "Disabled")}</dd></div></dl>
      </li>
    </ol>
    <p className={styles.muted}>{t("这是演示专用的确定性规则：本地仓位与成交不一致时，触发整个隔离工作区的停止开关。对账原始等级为 warning，停止由该规则触发。原成交不会撤回，本次保留停止状态；重新运行会创建另一个独立环境，不是恢复旧授权。", "This explicit demo rule turns on the entire isolated workspace's stop switch when local positions disagree with fills. Reconciliation reports a warning; the demo rule triggers the stop. Earlier fills are not reversed. This run stays stopped; starting another run creates a separate environment, not a recovery of the old authorization.")}</p>
  </section>;
}
