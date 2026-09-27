"use client";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { clientApi, type FinancialDatasetsStatus } from "../../lib/clientApi";
import { toast } from "../../lib/dialogs";
import { Advanced, ErrorBanner } from "../Page";
import { CheckIcon, RefreshIcon } from "../icons";
import { Field } from "./SettingsFields";

export function DataServiceSettings() {
  const tCommon = useTranslations("common");
  const tFdApi = useTranslations("financialDatasets");
  const tProxy = useTranslations("networkProxy");
  function reportError(message: string) {
    toast({ message, tone: "error" });
  }
  function reportOk(message: string) {
    toast({ message, tone: "ok" });
  }
  const [loadError, setLoadError] = useState<string | null>(null);
  const [fdStatus, setFdStatus] = useState<FinancialDatasetsStatus | null>(null);
  const [fdKeysDraft, setFdKeysDraft] = useState<string>("");
  const [fdBusy, setFdBusy] = useState<string>("");
  async function loadFinancialDatasetsStatus() {
    try {
      const next = await clientApi.financialDatasetsStatus();
      if (!next.ok) throw new Error("Could not load data service credentials");
      setFdStatus(next);
      setLoadError(null);
    } catch (e) {
      setFdStatus(null);
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }
  async function saveFinancialDatasetsKeys() {
    setFdBusy("save");
    try {
      const text = fdKeysDraft.trim();
      const res = await clientApi.financialDatasetsSetKeys({
        keys: text,
        store: "vault",
      });
      setFdStatus(res);
      setFdKeysDraft("");
      reportOk(tFdApi("keysSaved"));
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e));
    } finally {
      setFdBusy("");
    }
  }
  async function clearFinancialDatasetsKeys() {
    setFdBusy("clear");
    try {
      const res = await clientApi.financialDatasetsSetKeys({
        keys: [],
        store: "vault",
      });
      setFdStatus(res);
      setFdKeysDraft("");
      reportOk(tFdApi("keysCleared", { store: "vault" }));
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e));
    } finally {
      setFdBusy("");
    }
  }
  useEffect(() => { void loadFinancialDatasetsStatus(); }, []);
  return (<Advanced
    title={tFdApi("title")}
    description={tFdApi("description")}
    count={
      fdStatus?.ready
        ? fdStatus.total_keys === 1
          ? tFdApi("keysReady", { count: fdStatus.total_keys })
          : tFdApi("keysReadyPlural", { count: fdStatus.total_keys })
        : undefined
    }
    storageKey="nerya.settings.access.advanced.fdapi"
  >
    <div className="space-y-3">
      <ErrorBanner error={loadError} onRetry={() => void loadFinancialDatasetsStatus()} />
      <div className="text-[11px] text-ink-500">
        Vault: <span className="font-mono">{fdStatus?.vault_count ?? 0}</span> ·
        Env: <span className="font-mono">{fdStatus?.env_count ?? 0}</span>
        {fdStatus?.env_sources?.length
          ? ` (${fdStatus.env_sources.join(", ")})`
          : ""}
        {fdStatus?.key_preview?.length ? (
          <>
            {" · "}
            <span className="font-mono">{fdStatus.key_preview.join(" ")}</span>
          </>
        ) : null}
      </div>
      <Field
        label={tProxy("apiKeys")}
        hint={tProxy("apiKeysHint")}
      >
        <input
          className="input-dark font-mono text-xs"
          type="password"
          value={fdKeysDraft}
          onChange={(e) => setFdKeysDraft(e.target.value)}
          placeholder="k1,k2,k3"
        />
      </Field>
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void clearFinancialDatasetsKeys()}
          disabled={Boolean(fdBusy) || (fdStatus?.vault_count ?? 0) === 0}
        >
          {fdBusy === "clear" ? tCommon("saving") : tProxy("clearLower")}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void loadFinancialDatasetsStatus()}
          disabled={Boolean(fdBusy)}
        >
          <RefreshIcon size={14} />
          {tCommon("refresh")}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void saveFinancialDatasetsKeys()}
          disabled={Boolean(fdBusy) || !fdStatus || !fdKeysDraft.trim()}
        >
          <CheckIcon size={14} />
          {fdBusy === "save" ? tCommon("saving") : tProxy("apiKeysSave")}
        </button>
      </div>
      {fdStatus?.documentation ? (
        <a
          className="text-[11px] text-brand-300 hover:underline"
          href={fdStatus.documentation}
          target="_blank"
          rel="noreferrer"
        >
          {tProxy("docsFinancialDatasets")}
        </a>
      ) : null}
    </div>
  </Advanced>);
}
