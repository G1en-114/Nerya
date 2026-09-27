"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { fieldLabel } from "../../lib/agentConversation";
import { reviewExplanation } from "../../lib/reviewExplanation";
import styles from "./WorkflowReplay.module.css";

export function ReviewExplanation({ record, output, status }: { record: Record<string, unknown>; output?: unknown; status?: string }) {
  const t = useTranslations("workflowExperience");
  const zh = useLocale().startsWith("zh");
  const review = reviewExplanation(record, output);
  const proposalId = typeof record.proposal_id === "string" ? record.proposal_id : "";
  return <section className={styles.reviewExplanation} aria-label={t("reviewConclusion")} data-testid="review-explanation">
    <header><h3>{t("reviewConclusion")}</h3><p className={styles.reviewLead}>{review.summary || t("missingReviewSummary")}</p></header>
    {review.partial && <p className={styles.note}>{t("partialHistory")}</p>}
    <p className={styles.note}>{t(status === "applied" ? "changeApplied" : proposalId ? "proposalRecorded" : "reviewOnly")}{proposalId && <> <Link className="underline underline-offset-4" href={`/self-evolution?tab=proposals&proposal_id=${encodeURIComponent(proposalId)}`}>{t("viewProposal")}</Link></>}</p>
    {review.error && <p role="alert" className="text-danger">{review.error}</p>}
    {review.rationale && <section><h4>{t("rationale")}</h4><p>{review.rationale}</p></section>}
    <section><h4>{t("scope")}</h4>{review.scope.length > 0 && <ul className={styles.proseList}>{review.scope.map((value, index) => <li key={index}>{value}</li>)}</ul>}
      {review.changes.length ? <ol className={styles.changeList}>{review.changes.map((change, index) => <li key={index}>
        <div className={styles.replayHeader}><h4>{change.summary || change.target || t("targetNotRecorded")}</h4><span className={styles.note}>{t(change.rejected ? "changeRejected" : change.advisory ? "changeAdvisory" : "changeProposed")}</span></div>
        {change.summary && change.target && <small className={styles.note}>{change.target}</small>}
        <dl className={styles.facts}>
          <div><dt>{t("rationale")}</dt><dd>{change.rationale || t("reasonNotRecorded")}</dd></div>
          {(change.before || change.after) && <><div><dt>{t("before")}</dt><dd>{change.before || t("notRecorded")}</dd></div><div><dt>{t("after")}</dt><dd>{change.after || t("notRecorded")}</dd></div></>}
          {change.scope.length > 0 && <div><dt>{t("scope")}</dt><dd>{change.scope.join(" · ")}</dd></div>}
          {change.rejected && <div><dt>{t("changeRejected")}</dt><dd>{change.rejection || t("notRecorded")}</dd></div>}
        </dl>
      </li>)}</ol> : <p className={styles.note}>{t(review.changesRecorded ? "noProposedChanges" : "scopeNotRecorded")}</p>}
    </section>
    {review.expected.length > 0 && <section><h4>{t("expectedEffect")}</h4><p className={styles.note}>{t("expectedOnly")}</p><dl className={styles.facts}>{review.expected.map(([key, value]) => <div key={key}><dt>{t.has("effectKinds." + key) ? t("effectKinds." + key) : fieldLabel(key, zh)}</dt><dd>{value}</dd></div>)}</dl></section>}
    {review.evidence.length > 0 && <section><h4>{t("reviewEvidence")}</h4><ul className={styles.proseList}>{review.evidence.map((row, index) => <li key={index}>{row.finding}{row.source && <small className={styles.note}> · {row.source}</small>}</li>)}</ul></section>}
    <section><h4>{t("validation")}</h4><p>{review.validationStatus ? `${t("recordedValidation")}: ${review.validationStatus}` : t("validationNotRecorded")}</p>{review.validation.length > 0 && <p className={styles.note}>{t("validationPlan")}: {review.validation.map((value) => t.has(`validationKinds.${value}`) ? t(`validationKinds.${value}`) : value).join(" · ")}</p>}</section>
    {review.risks.length > 0 && <section><h4>{t("risks")}</h4><ul className={styles.proseList}>{review.risks.map((value, index) => <li key={index}>{value}</li>)}</ul></section>}
  </section>;
}
