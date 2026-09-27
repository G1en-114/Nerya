"use client";
import { copy as i18nCopy } from "../../lib/i18n";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import {
  clientApi,
  type SearchEngineStatus,
  type SearchEnginesStatus
} from "../../lib/clientApi";
import { confirm, toast } from "../../lib/dialogs";
import { Advanced, Card, ErrorBanner, Pill } from "../Page";
import { SwitchControl } from "../SwitchControl";
import { CheckIcon, RefreshIcon, SearchIcon, SparkIcon } from "../icons";
import { Field, Row, CompactSelect as Select } from "../settings/SettingsFields";

export function SearchSettings() {
  const zh = useLocale().startsWith("zh");
  const text = (key: string, values?: Record<string, unknown>) => i18nCopy(zh, key, values);
  const tUi = useTranslations("ui");
  const tTabs = useTranslations("settings.tabs");
  const tCommon = useTranslations("common");
  const tSearch = useTranslations("settingsSearch");
  function reportError(message: string) {
    toast({ message, tone: "error" });
  }
  function reportOk(message: string) {
    toast({ message, tone: "ok" });
  }
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [searchStatus, setSearchStatus] = useState<SearchEnginesStatus | null>(null);
  const [searchChainCsv, setSearchChainCsv] = useState<string>("");
  const [searchRegion, setSearchRegion] = useState<string>("wt-wt");
  const [searchSafesearch, setSearchSafesearch] = useState<string>("moderate");
  const [searchKeyDrafts, setSearchKeyDrafts] = useState<Record<string, string>>({});
  const [searchBaseUrlDrafts, setSearchBaseUrlDrafts] = useState<Record<string, string>>({});
  const searchStore = "vault" as const;
  const dirty = Boolean(searchStatus && (
    searchChainCsv !== (searchStatus.engines || []).join(", ") || searchRegion !== (searchStatus.region || "wt-wt") || searchSafesearch !== (searchStatus.safesearch || "moderate") ||
    Object.values(searchKeyDrafts).some(Boolean) || Object.entries(searchBaseUrlDrafts).some(([engine, value]) => value !== ((searchStatus.engine_status || []).find((row) => row.name === engine)?.base_url?.workspace || ""))
  ));
  async function refreshSearch() {
    if (dirty && !await confirm({ title: tUi("discardChanges"), message: tUi("discardChangesDescription"), tone: "warning" })) return;
    await loadSearchStatus();
  }
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [dirty]);

  const [searchBusy, setSearchBusy] = useState<string>("");
  const [searchTestQuery, setSearchTestQuery] = useState<string>("Nvidia earnings");
  const [searchTestEngine, setSearchTestEngine] = useState<string>("");
  const [searchTestResult, setSearchTestResult] = useState<string | null>(null);
  const [searxngHostPort, setSearxngHostPort] = useState<string>("8888");
  const [searxngImage, setSearxngImage] = useState<string>("searxng/searxng:latest");
  const [searxngRebuild, setSearxngRebuild] = useState<boolean>(false);
  const [searchEngineRowResult, setSearchEngineRowResult] = useState<Record<string, string>>({});
  function applySearchStatus(status: SearchEnginesStatus | null | undefined) {
    if (!status) return;
    setSearchStatus(status);
    setSearchChainCsv((status.engines || []).join(", "));
    setSearchRegion(status.region || "wt-wt");
    setSearchSafesearch(status.safesearch || "moderate");
    setSearchKeyDrafts({});
    const nextBaseUrls: Record<string, string> = {};
    for (const row of status.engine_status || []) {
      if (!row.needs_base_url) continue;
      const ws = row.base_url?.workspace || "";
      nextBaseUrls[row.name] = ws;
    }
    setSearchBaseUrlDrafts(nextBaseUrls);
    if (status.searxng?.host_port) {
      setSearxngHostPort(String(status.searxng.host_port));
    }
    if (status.searxng?.image) setSearxngImage(status.searxng.image);
  }
  async function loadSearchStatus() {
    try {
      const res = checked(await clientApi.searchEnginesStatus());
      applySearchStatus(res);
      setLoadError(null); setReady(true);
      return res;
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }
  function checked<T>(result: T): T {
    if (result && typeof result === "object" && "ok" in result && result.ok === false) {
      const error = result as { error?: string; detail?: string };
      throw new Error(error.detail || error.error || tUi("loadFailed"));
    }
    return result;
  }
  function parseSearchChain(csv: string): string[] {
    return csv
      .split(/[,\n]/)
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
  }
  async function saveSearchEngines(opts: { keysOnly?: boolean } = {}) {
    setSearchBusy("save");
    try {
      const body: Parameters<typeof clientApi.searchEnginesConfig>[0] = {
        store: searchStore,
      };
      if (!opts.keysOnly) {
        const chain = [...new Set(parseSearchChain(searchChainCsv))];
        if (!chain.length) throw new Error(text("copy.components_settings_SearchSettings.001"));
        body.engines = chain;
        if (searchRegion.trim()) body.region = searchRegion.trim();
        if (searchSafesearch.trim()) body.safesearch = searchSafesearch.trim();
        const baseUrlBody: Record<string, string> = {};
        const previousByEngine = new Map(
          (searchStatus?.engine_status || [])
            .filter((row) => row.needs_base_url)
            .map((row) => [row.name, row.base_url?.workspace || ""]),
        );
        for (const [engine, draft] of Object.entries(searchBaseUrlDrafts)) {
          const next = (draft || "").trim();
          const previous = previousByEngine.get(engine) || "";
          if (next === previous) continue;
          baseUrlBody[engine] = next;
        }
        if (Object.keys(baseUrlBody).length) body.base_urls = baseUrlBody;
      }
      const drafts: Record<string, string> = {};
      for (const [engine, raw] of Object.entries(searchKeyDrafts)) {
        const trimmed = (raw || "").trim();
        if (trimmed === "") continue; // empty/untouched draft → don't overwrite vault
        drafts[engine] = trimmed;
      }
      if (Object.keys(drafts).length) body.keys = drafts;
      const res = await clientApi.searchEnginesConfig(body);
      applySearchStatus(res);
      reportOk(tSearch("savedAll"));
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearchBusy("");
    }
  }
  async function clearSearchKeys(engine: string) {
    setSearchBusy(`clear:${engine}`);
    try {
      const res = await clientApi.searchEnginesConfig({
        store: searchStore,
        keys: { [engine]: [] },
      });
      applySearchStatus(res);
      reportOk(tSearch("keysCleared", { engine }));
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearchBusy("");
    }
  }
  async function saveSearchEngineRow(engine: string) {
    setSearchBusy(`save:${engine}`);
    try {
      const body: Parameters<typeof clientApi.searchEnginesConfig>[0] = {
        store: searchStore,
      };
      const draftKey = (searchKeyDrafts[engine] ?? "").trim();
      if (draftKey) {
        body.keys = { [engine]: draftKey };
      }
      const row = (searchStatus?.engine_status || []).find((r) => r.name === engine);
      if (row?.needs_base_url) {
        const previous = row.base_url?.workspace || "";
        const next = (searchBaseUrlDrafts[engine] ?? "").trim();
        if (next !== previous) {
          body.base_urls = { [engine]: next };
        }
      }
      if (!body.keys && !body.base_urls) {
        setSearchEngineRowResult((p) => ({
          ...p,
          [engine]: "no changes: type a key or change the base URL first",
        }));
        return;
      }
      const res = await clientApi.searchEnginesConfig(body);
      applySearchStatus(res);
      setSearchEngineRowResult((p) => ({
        ...p,
        [engine]: `saved (${searchStore})`,
      }));
    } catch (e) {
      setSearchEngineRowResult((p) => ({
        ...p,
        [engine]: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setSearchBusy("");
    }
  }
  async function testSearchEngineRow(engine: string) {
    setSearchBusy(`test:${engine}`);
    setSearchEngineRowResult((p) => ({ ...p, [engine]: "probing…" }));
    try {
      const res = await clientApi.searchEnginesTest({
        query: searchTestQuery.trim() || "Nerya engine probe",
        engine,
        max_results: 3,
      });
      if (!res.ok) {
        setSearchEngineRowResult((p) => ({
          ...p,
          [engine]: `error: ${res.error || "test failed"}${res.stderr_tail ? "\n" + res.stderr_tail : ""}`,
        }));
        return;
      }
      const result = res.result as Record<string, unknown> | null;
      const items = result && typeof result === "object"
        ? (result as { results?: unknown[] }).results
        : undefined;
      const count = Array.isArray(items) ? items.length : 0;
      const engineUsed = result && typeof result === "object"
        ? String((result as { engine?: unknown }).engine || "")
        : "";
      setSearchEngineRowResult((p) => ({
        ...p,
        [engine]: `ok: ${count} result(s) via ${engineUsed || engine} · ${res.elapsed_ms ?? "?"}ms`,
      }));
    } catch (e) {
      setSearchEngineRowResult((p) => ({
        ...p,
        [engine]: e instanceof Error ? e.message : String(e),
      }));
    } finally {
      setSearchBusy("");
    }
  }
  async function deploySearxng() {
    setSearchBusy("searxng-deploy");
    try {
      const res = await clientApi.searchSearxngDeploy({
        host_port: searxngHostPort.trim() ? Number(searxngHostPort.trim()) : undefined,
        image: searxngImage.trim() || undefined,
        rebuild: searxngRebuild,
      });
      if (!res.ok) {
        throw new Error(res.detail || res.error || "deploy failed");
      }
      reportOk(tSearch("searxngDeployed", { url: res.base_url || `http://127.0.0.1:${searxngHostPort}` }));
      await loadSearchStatus();
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearchBusy("");
    }
  }
  async function teardownSearxng(opts: { remove?: boolean } = {}) {
    setSearchBusy(opts.remove === false ? "searxng-stop" : "searxng-teardown");
    try {
      const res = await clientApi.searchSearxngTeardown({
        remove: opts.remove !== false,
      });
      if (!res.ok) throw new Error(res.detail || res.error || "teardown failed");
      reportOk(opts.remove === false ? tSearch("searxngStopped") : tSearch("searxngRemoved"));
      await loadSearchStatus();
    } catch (e) {
      reportError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearchBusy("");
    }
  }
  async function runSearchEngineTest() {
    setSearchBusy("test");
    setSearchTestResult(null);
    try {
      const res = await clientApi.searchEnginesTest({
        query: searchTestQuery.trim() || "Nerya search engine probe",
        engine: searchTestEngine.trim().toLowerCase() || undefined,
        max_results: 3,
      });
      if (!res.ok) {
        setSearchTestResult(
          res.error
            ? `${res.error}${res.stderr_tail ? "\n" + res.stderr_tail : ""}`
            : "test failed",
        );
        return;
      }
      const result = res.result as Record<string, unknown> | null;
      const engineUsed = result && typeof result === "object"
        ? String((result as { engine?: unknown }).engine || "")
        : "";
      const items = result && typeof result === "object"
        ? (result as { results?: unknown[] }).results
        : undefined;
      const count = Array.isArray(items) ? items.length : 0;
      setSearchTestResult(
        `engine=${engineUsed || "?"} · results=${count} · ${res.elapsed_ms ?? "?"}ms`,
      );
    } catch (e) {
      setSearchTestResult(e instanceof Error ? e.message : String(e));
    } finally {
      setSearchBusy("");
    }
  }
  function renderSearchEngineRow(row: SearchEngineStatus) {
    const counts = row.key_counts || { workspace: 0, vault: 0, env: 0, total: 0 };
    const draftKey = searchKeyDrafts[row.name] ?? "";
    const inChain = (searchStatus?.engines || []).includes(row.name);
    const baseUrlInfo = row.base_url || {};
    const baseUrlDraft = searchBaseUrlDrafts[row.name] ?? (baseUrlInfo.workspace || "");
    return (
      <div
        key={row.name}
        className="rounded-lg border border-[color:var(--line)] p-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-ink-100">{row.name}</div>
            <div
              className="mt-0.5 text-[11px] text-ink-500"
              title={
                row.needs_key
                  ? tSearch("keysCountsLocation", {
                    vault: counts.vault,
                    workspace: counts.workspace,
                    env: counts.env,
                  })
                  : undefined
              }
            >
              {row.needs_key
                ? tSearch("keysCounts", { total: counts.total })
                : tSearch("keyless")}
              {row.needs_base_url
                ? ` · ${tSearch("baseUrlInline", {
                  url: baseUrlInfo.effective || "–",
                })}`
                : ""}
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            {inChain ? <Pill tone="brand">{tSearch("inChain")}</Pill> : null}
            <Pill tone={row.ready ? "ok" : "warn"}>
              {row.ready
                ? tSearch("ready")
                : row.needs_base_url && !baseUrlInfo.effective
                  ? tSearch("needsBaseUrl")
                  : tSearch("needsKey")}
            </Pill>
          </div>
        </div>
        {row.needs_key ? (
          <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto_auto]">
            <textarea
              className="input-dark font-mono text-xs"
              rows={Math.min(4, Math.max(1, draftKey.split(/[,\n]/).filter(Boolean).length || 1))}
              value={draftKey}
              onChange={(e) => setSearchKeyDrafts((p) => ({ ...p, [row.name]: e.target.value }))}
              placeholder={tSearch("keyPlaceholder")}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
            />
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setSearchKeyDrafts((p) => {
                const next = { ...p };
                delete next[row.name];
                return next;
              })}
              disabled={!draftKey}
            >
              {tSearch("undo")}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void clearSearchKeys(row.name)}
              disabled={Boolean(searchBusy) || counts.vault === 0}
            >
              {searchBusy === `clear:${row.name}` ? tCommon("saving") : tSearch("clear")}
            </button>
          </div>
        ) : null}
        {row.needs_base_url ? (
          <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto]">
            <input
              className="input-dark font-mono text-xs"
              value={baseUrlDraft}
              onChange={(e) => setSearchBaseUrlDrafts((p) => ({ ...p, [row.name]: e.target.value }))}
              placeholder={baseUrlInfo.default || "https://example.com"}
              spellCheck={false}
            />
            <span className="self-center text-[11px] text-ink-500">
              {tSearch("envDefault", {
                env: baseUrlInfo.env || "–",
                def: baseUrlInfo.default || "–",
              })}
            </span>
          </div>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {row.needs_key || row.needs_base_url ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void saveSearchEngineRow(row.name)}
              disabled={Boolean(searchBusy)}
              title={tSearch("saveRowTitle")}
            >
              <CheckIcon size={12} />
              {searchBusy === `save:${row.name}` ? tCommon("saving") : tSearch("save")}
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void testSearchEngineRow(row.name)}
            disabled={Boolean(searchBusy)}
            title={tSearch("testRowTitle")}
          >
            <SearchIcon size={12} />
            {searchBusy === `test:${row.name}` ? tSearch("testing") : tSearch("test")}
          </button>
          {row.key_preview && row.key_preview.length ? (
            <span className="font-mono text-[11px] text-ink-500">
              {tSearch("stored", { value: row.key_preview.join(" · ") })}
            </span>
          ) : null}
          {searchEngineRowResult[row.name] ? (
            <span
              className={`ml-auto font-mono text-[11px] ${/^(error|fail|missing|❌)/i.test(searchEngineRowResult[row.name] || "")
                ? "text-rose-300"
                : "text-emerald-300"
                }`}
            >
              {searchEngineRowResult[row.name]}
            </span>
          ) : null}
        </div>
      </div>
    );
  }
  useEffect(() => {
    void loadSearchStatus();

  }, []);
  useEffect(() => {
    const refresh = () => { void refreshSearch(); };
    window.addEventListener("nerya:search-refresh", refresh);
    return () => window.removeEventListener("nerya:search-refresh", refresh);
  });
  return (<div
    id="settings-panel-search"
    role="region"
    aria-label={tTabs("search")}
    className="space-y-5"
  >
    <ErrorBanner error={loadError} onRetry={() => void loadSearchStatus()} />
    {!ready && !loadError && <p role="status">{tCommon("loading")}</p>}
    <fieldset disabled={!ready || Boolean(searchBusy)} className="m-0 min-w-0 space-y-5 border-0 p-0">
      <Card
        title={tSearch("cardTitle")}
        description={tSearch("cardDesc")}
        actions={
          searchStatus ? (
            <Pill tone={searchStatus.usable_in_chain > 0 ? "ok" : "warn"}>
              {tSearch("enginesReady", {
                ready: searchStatus.usable_in_chain,
                total: searchStatus.engines.length,
              })}
            </Pill>
          ) : null
        }
      >
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_auto_auto] lg:items-end">
          <Field label={text("copy.components_settings_SearchSettings.002")} hint={text("copy.components_settings_SearchSettings.003")}>
            <Select value={parseSearchChain(searchChainCsv)[0] || ""} onChange={(engine) => setSearchChainCsv([engine, ...parseSearchChain(searchChainCsv).filter((item) => item !== engine)].join(", "))}
              options={(searchStatus?.engine_status || []).map((row) => ({ value: row.name, label: row.name }))} />
          </Field>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void saveSearchEngines()}
            disabled={Boolean(searchBusy)}
          >
            <CheckIcon size={14} />
            {searchBusy === "save" ? tCommon("saving") : tSearch("saveChain")}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void refreshSearch()}
            disabled={Boolean(searchBusy)}
          >
            <RefreshIcon size={14} />
            {tCommon("refresh")}
          </button>
        </div>

        <Advanced title={text("copy.components_settings_SearchSettings.004")}>
          <Field label={tSearch("engineChain")} hint={tSearch("engineChainHint")}>
            <input className="input-dark w-full font-mono text-xs" aria-label={tSearch("engineChain")} value={searchChainCsv} onChange={(e) => setSearchChainCsv(e.target.value)} />
          </Field>
        </Advanced>

        <Advanced
          title={tSearch("defaultsAdvancedTitle")}
          storageKey="nerya.settings.search.advanced.defaults"
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Field label={tSearch("region")} hint={tSearch("regionHint")}>
              <input
                className="input-dark font-mono text-xs"
                value={searchRegion}
                onChange={(e) => setSearchRegion(e.target.value)}
                placeholder="wt-wt"
              />
            </Field>
            <Field label={tSearch("safesearch")}>
              <Select
                value={searchSafesearch}
                onChange={setSearchSafesearch}
                options={[
                  { value: "off", label: tSearch("safesearchOff") },
                  { value: "moderate", label: tSearch("safesearchModerate") },
                  { value: "strict", label: tSearch("safesearchStrict") },
                ]}
              />
            </Field>

          </div>
        </Advanced>

        {(() => {
          const allRows = searchStatus?.engine_status || [];
          const chainSet = new Set(searchStatus?.engines || []);
          const inChainRows = allRows.filter((r) => chainSet.has(r.name));
          const otherRows = allRows.filter((r) => !chainSet.has(r.name));
          return (
            <>
              <div className="mt-4 space-y-2">
                {inChainRows.map((row) => renderSearchEngineRow(row))}
              </div>
              {otherRows.length ? (
                <Advanced
                  title={tSearch("otherEnginesTitle", { count: otherRows.length })}
                  storageKey="nerya.settings.search.advanced.others"
                >
                  <div className="space-y-2">
                    {otherRows.map((row) => renderSearchEngineRow(row))}
                  </div>
                </Advanced>
              ) : null}
            </>
          );
        })()}
      </Card>

      {(searchStatus?.engines || []).includes("searxng") ? (
        <Card
          title={tSearch("searxngTitle")}
          description={tSearch("searxngDesc")}
          actions={
            <Pill tone={searchStatus?.searxng?.container_running ? "ok" : "warn"}>
              {searchStatus?.searxng?.docker_available
                ? searchStatus?.searxng?.container_running
                  ? tSearch("searxngStateRunning")
                  : tSearch("searxngStateStopped")
                : tSearch("searxngStateMissing")}
            </Pill>
          }
        >
          <Advanced title={text("copy.components_settings_SearchSettings.005")}>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Field label={tSearch("hostPort")} hint={tSearch("hostPortHint")}>
                <input
                  className="input-dark font-mono text-xs"
                  value={searxngHostPort}
                  onChange={(e) => setSearxngHostPort(e.target.value.replace(/[^0-9]/g, "").slice(0, 5))}
                  placeholder="8888"
                />
              </Field>
              <Field label={tSearch("image")}>
                <input
                  className="input-dark font-mono text-xs"
                  value={searxngImage}
                  onChange={(e) => setSearxngImage(e.target.value)}
                  placeholder="searxng/searxng:latest"
                />
              </Field>
              <Row label={tSearch("rebuild")} desc={tSearch("rebuildDesc")}>
                <SwitchControl
                  checked={searxngRebuild}
                  label={tSearch("rebuildSwitch")}
                  onCheckedChange={(v) => setSearxngRebuild(v)}
                />
              </Row>
            </div>
            <div className="mt-3 space-y-1 text-[11px] text-ink-500">
              <div>
                {tSearch("probe")}: <span className="font-mono">{searchStatus?.searxng?.probe?.ok ? "ok" : (searchStatus?.searxng?.probe?.error || "–")}</span>
                {searchStatus?.searxng?.probe?.elapsed_ms != null
                  ? ` · ${searchStatus.searxng.probe.elapsed_ms}ms`
                  : ""}
              </div>
              <div>
                {tSearch("baseUrl")}: <span className="font-mono">{searchStatus?.searxng?.base_url || "–"}</span>
              </div>
              <div>
                {tSearch("config")}: <span className="font-mono">{searchStatus?.searxng?.config_dir || "–"}</span>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void deploySearxng()}
                disabled={Boolean(searchBusy) || searchStatus?.searxng?.docker_available === false}
              >
                <SparkIcon size={14} />
                {searchBusy === "searxng-deploy"
                  ? tSearch("deploying")
                  : searchStatus?.searxng?.container_running
                    ? tSearch("redeploy")
                    : tSearch("deploy")}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void teardownSearxng({ remove: false })}
                disabled={Boolean(searchBusy) || !searchStatus?.searxng?.container_running}
              >
                {searchBusy === "searxng-stop" ? tSearch("stopping") : tSearch("stop")}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={async () => {
                  // Removing the container also wipes its data —
                  // confirm before the destructive teardown.
                  const confirmed = await confirm({
                    title: tSearch("removeConfirmTitle"),
                    message: tSearch("removeConfirmMessage"),
                    tone: "danger",
                    okLabel: tCommon("delete"),
                    cancelLabel: tCommon("cancel"),
                  });
                  if (confirmed) void teardownSearxng({ remove: true });
                }}
                disabled={Boolean(searchBusy) || searchStatus?.searxng?.deployed === false}
              >
                {searchBusy === "searxng-teardown" ? tSearch("removing") : tSearch("remove")}
              </button>
              {searchStatus?.searxng?.docker_available === false ? (
                <span className="self-center text-[11px] text-amber-300">
                  {tSearch("dockerMissingHint")}
                </span>
              ) : null}
            </div>
          </Advanced>
        </Card>
      ) : null}

      <Advanced
        title={tSearch("probeTitle")}
        description={tSearch("probeDesc")}
        storageKey="nerya.settings.search.advanced.probe"
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_180px_auto]">
          <Field label={tSearch("query")}>
            <input
              className="input-dark text-xs"
              value={searchTestQuery}
              onChange={(e) => setSearchTestQuery(e.target.value)}
              placeholder={tSearch("queryPlaceholder")}
            />
          </Field>
          <Field label={tSearch("engineOverride")} hint={tSearch("engineOverrideHint")}>
            <input
              className="input-dark font-mono text-xs"
              value={searchTestEngine}
              onChange={(e) => setSearchTestEngine(e.target.value)}
              placeholder={tSearch("engineOverridePlaceholder")}
            />
          </Field>
          <div className="flex items-end">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void runSearchEngineTest()}
              disabled={Boolean(searchBusy)}
            >
              <SearchIcon size={14} />
              {searchBusy === "test" ? tSearch("probing") : tSearch("probe")}
            </button>
          </div>
        </div>
        {searchTestResult ? (
          <div className="mt-3 rounded-md border border-brand-500/10 bg-ink-950/35 px-3 py-2 font-mono text-[11px] text-ink-300 whitespace-pre-wrap">
            {searchTestResult}
          </div>
        ) : null}
      </Advanced>
    </fieldset>
  </div>);
}
