"use client";
import { useLocale } from "next-intl";
import type { InteractionReceipt as Receipt } from "../../lib/toolOutputPresentation";
import { CheckIcon } from "../icons";
import styles from "./ExecutionTimeline.module.css";

export function InteractionReceipt({ receipt }: { receipt: Receipt }) {
  const zh = useLocale().startsWith("zh");
  const labels: Record<string,string> = { answer: zh?"已提交回答":"Answers submitted", accept: zh?"已接受计划":"Plan accepted", revise: zh?"已请求修改":"Revision requested", reject: zh?"已拒绝计划":"Plan rejected" };
  return <section className={styles.receipt} data-testid="interaction-receipt" data-find-text>
    <div className={styles.receiptTitle}><CheckIcon size={14}/><span>{labels[receipt.action] || labels.answer}</span><span className={styles.caption}>{receipt.title}</span></div>
    <dl className={styles.answerList}>{receipt.rows.map(row => <div key={row.id}><dt>{row.question}</dt><dd>{row.answers.length ? row.answers.map((answer, i) => <span key={i}>{answer}</span>) : <span className={styles.caption}>{zh ? "未回答" : "Not answered"}</span>}</dd></div>)}</dl>
    {receipt.note && <p className={styles.receiptNote}>{receipt.note}</p>}
    <p className={styles.caption}>{zh ? "仅补充需求，不代表实盘交易授权。" : "These answers are not authorization for live trading."}</p>
  </section>;
}
