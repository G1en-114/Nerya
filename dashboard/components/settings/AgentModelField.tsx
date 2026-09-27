"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { clientApi } from "../../lib/clientApi";
import { Select } from "../Select";

export function AgentModelField({ provider, model, disabled, onChange }: {
  provider: string; model: string; disabled?: boolean;
  onChange: (provider: string, model: string) => void;
}) {
  const t = useTranslations("agentsPage");
  const [models, setModels] = useState<{ provider: string; model: string }[]>([]);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    void clientApi.llmModels().then(result => {
      if (!active) return;
      setModels(Object.entries(result.providers || {}).flatMap(([provider, rows]) => rows.flatMap(row => {
        const model = String(row.id || row.model || "").trim();
        return model ? [{ provider, model }] : [];
      })));
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [attempt]);
  const key = provider || model ? JSON.stringify([provider, model]) : "inherit";
  const options = [{ value: "inherit", label: t("inheritModel") }, ...models.map(row => ({ value: JSON.stringify([row.provider, row.model]), label: row.provider + " / " + row.model }))];
  if (!options.some(row => row.value === key)) options.push({ value: key, label: provider + " / " + model });
  return <div className="space-y-2"><label className="block text-sm">{t("advModel")}</label><Select value={key} options={options} ariaLabel={t("advModel")} disabled={disabled} onChange={value => { if (value === "inherit") onChange("", ""); else { const pair = JSON.parse(value) as [string, string]; onChange(...pair); } }} />{error && <button type="button" className="btn btn-ghost" onClick={() => setAttempt(value => value + 1)}>{t("retry")}</button>}</div>;
}
