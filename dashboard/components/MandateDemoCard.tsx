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
      <p>{zh ? "设定市场与额度，点击运行，亲自验证哪些动作会被拦下。" : "Set the market and limits, run a check, and see which actions are stopped."}</p>
      <div className={styles.tags}><span>{zh ? "本地链 · 模拟交易 · 历史记录" : "Local chain · Paper trading · Recorded run"}</span>
        {data ? <span>{data.cases.length} {zh ? "个案例" : "cases"} · {data.cases.filter(c => c.status === "rejected").length} {zh ? "个拒绝" : "stopped"}</span> : <span>{state === "loading" ? (zh ? "正在读取记录…" : "Loading recording…") : (zh ? "暂无可用演示记录" : "No recording available")}</span>}
      </div>
    </div>
    <Link href="/dashboard/safety" className={styles.primary}>{zh ? "打开安全控制台" : "Open safety controls"} <span aria-hidden="true">↗</span></Link>
  </section>;
}
