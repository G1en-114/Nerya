"use client";
import { useLocale, useTranslations } from "next-intl";
import { fieldLabel } from "../../lib/agentConversation";
import styles from "./WorkflowReplay.module.css";

export function ReplayEvidence({ value }: { value: unknown }) {
  const t = useTranslations("workflowExperience");
  const zh = useLocale().startsWith("zh");
  if (value === null || value === undefined) return <p className={styles.note}>{t("notRecorded")}</p>;
  if (typeof value !== "object") return <p className="whitespace-pre-wrap break-words text-sm leading-6">{String(value)}</p>;
  return <dl className={styles.facts}>{Object.entries(value).slice(0, 30).map(([key, item]) => <div key={key}><dt>{fieldLabel(key, zh)}</dt><dd>{item !== null && typeof item === "object" ? <details><summary>{Array.isArray(item) ? `${item.length} · ${fieldLabel(key, zh)}` : fieldLabel(key, zh)}</summary><pre>{JSON.stringify(item, null, 2)}</pre></details> : <ReplayEvidence value={item} />}</dd></div>)}{Object.keys(value).length > 30 && <details><summary>{t("loadMore")}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>}</dl>;
}
