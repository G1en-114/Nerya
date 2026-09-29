"use client";

import Link from "next/link";
import { useLocale } from "next-intl";
import { useMandateDemo } from "../lib/mandateDemo";
import styles from "../app/dashboard/safety/safety.module.css";

export function MandateDemoCard() {
  const zh = useLocale().startsWith("zh");
  const { data, state } = useMandateDemo();
  return <section className={styles.entry} aria-label="Agent Safety" data-testid="mandate-demo-card">
    <div className={styles.entryIcon} aria-hidden="true"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z"/><path d="m8 12 3 3 5-6"/></svg></div>
    <div className={styles.entryBody}>
      <div className={styles.eyebrow}>SECURITY · CONSTRAINTS · EVIDENCE</div>
      <h2>Agent Safety <span>{zh ? "授权与安全边界" : "Signed authorization & boundaries"}</span></h2>
      <div className={styles.designReference}>{zh ? "设计参考：Google AP2 · Intent Signing" : "Inspired by Google AP2 · Intent Signing"}</div>
      <p>{zh ? "参考 Google AP2 的意图签署模式：签署意图 → 检查授权边界 → 执行并留证。谁授权、哪里停止、如何证明，一次演示看清楚。" : "Inspired by Google AP2's intent-signing pattern: sign intent → check authorization boundaries → execute and retain evidence. See who authorized it, where it stops, and why."}</p>
      <div className={styles.tags}><span>{zh ? "本地链 · 模拟交易 · 历史记录" : "Local chain · Paper trading · Recorded run"}</span>
        <span>{zh ? "新增：连续预算 · 执行后对账" : "New: continuous budget · Post-execution reconciliation"}</span>
        {data ? <span>{data.cases.length} {zh ? "个案例" : "cases"} · {data.cases.filter(c => c.status === "rejected").length} {zh ? "个拒绝" : "stopped"}</span> : <span>{state === "loading" ? (zh ? "正在读取记录…" : "Loading recording…") : (zh ? "暂无可用演示记录" : "No recording available")}</span>}
      </div>
    </div>
    <Link href="/dashboard/safety" className={styles.primary}>{zh ? "打开安全控制台" : "Open safety controls"} <span aria-hidden="true">↗</span></Link>
  </section>;
}
