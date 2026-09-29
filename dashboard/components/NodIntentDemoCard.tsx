"use client";

import { useState } from "react";
import { useLocale } from "next-intl";
import { NodIntentCapture } from "./face/NodIntentCapture";
import type { NodIntentProof } from "../lib/nodIntent";
import styles from "../app/dashboard/safety/safety.module.css";

/** Isolated, paper-only nod intent walkthrough for the safety console. */
export function NodIntentDemoCard() {
  const zh = useLocale().startsWith("zh");
  const [proof, setProof] = useState<NodIntentProof | null>(null);
  return <section className={styles.panel} aria-label="Nod intent demo" data-testid="nod-intent-demo">
    <div className={styles.sectionHead}><div className={styles.eyebrow}>04 / {zh ? "点头确认意向" : "NOD INTENT"}</div>
      <h2>{zh ? "用一次点头表达确认意向" : "Express confirmation intent with one nod"}</h2>
      <p>{zh ? "这是隔离的模拟审批，不连接真实资金。点头只生成绑定本次请求的一次性凭据，最后仍需点击批准。" : "This is an isolated paper approval. A nod only mints a one-use receipt bound to this request; approval still requires a click."}</p>
    </div>
    <div className={styles.actions}><span className={styles.badge}>{zh ? "模拟交易 · 不执行真实订单" : "Paper trade · No live order"}</span></div>
    <NodIntentCapture approvalId="demo-nod-approval" busy={false} confirmed={!!proof} onIntent={setProof} onReset={() => setProof(null)} />
    {proof && <div className={styles.runResult} role="status"><strong className={styles.allow}>{zh ? "确认意向已记录" : "Intent recorded"}</strong><p>{zh ? "凭据已绑定模拟审批，可用于演示批准步骤。" : "The receipt is bound to the simulated approval and can be shown in the approval step."}</p><code>approval: {proof.approval_id} · expires: {new Date(proof.expires_at * 1000).toLocaleTimeString()}</code></div>}
  </section>;
}
