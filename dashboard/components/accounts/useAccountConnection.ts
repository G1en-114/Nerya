"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { clientApi, type AccountCredentialField, type AccountSummary, type WalletBinding } from "../../lib/clientApi";
import { confirm } from "../../lib/dialogs";
import { connectionErrorCode, connectionId, providerLabel } from "../../lib/accountConnection";

export interface ConnectionProps {
  initial?: Partial<AccountSummary["profile"]>;
  onSaved?: (account: AccountSummary) => void;
  onProposed?: (proposalId: string) => void;
  onCancel?: () => void;
  setupMode?: boolean;
  formId?: string;
  onBusyChange?: (busy: boolean) => void;
}
type Provider = Awaited<ReturnType<typeof clientApi.exchangeProviders>>["providers"][number];
export type ConnectionKind = "exchange" | "wallet" | "paper";
export type Selection = { venue: string; kind: string; label: string; walletId?: string; links?: Record<string, string> };
const popular = ["binance", "okx", "bybit", "bitget", "coinbase", "kraken", "hyperliquid", "gate"];

/** No draft credential is written to browser storage. Retries reuse one request ID. */
export function useAccountConnection({ initial: incoming, setupMode, onBusyChange, onSaved, onCancel }: ConnectionProps) {
  const [initial] = useState(incoming);
  const t = useTranslations("accountConnection");
  const editing = Boolean(initial?.id);
  const [kind, setKind] = useState<ConnectionKind>(initial?.mode === "paper" || !editing && setupMode ? "paper" : initial?.wallet_id ? "wallet" : "exchange");
  const [stage, setStage] = useState(editing || setupMode ? 1 : 0);
  const [selected, setSelected] = useState<Selection | null>(editing ? { venue: initial!.venue || "", kind: initial!.kind || "cex", label: initial!.venue || "", walletId: initial!.wallet_id } : setupMode ? { venue: "mock", kind: "cex", label: "" } : null);
  const [id, setId] = useState(initial?.id || "");
  const [name, setName] = useState(initial?.label || "");
  const [currency, setCurrency] = useState(initial?.base_currency || "USDT");
  const [subaccount, setSubaccount] = useState(initial?.subaccount || "");
  const [balance, setBalance] = useState(String(initial?.initial_balance_usd ?? 10000));
  const [providers, setProviders] = useState<Provider[]>([]);
  const [wallets, setWallets] = useState<WalletBinding[]>([]);
  const [catalogBusy, setCatalogBusy] = useState(true);
  const [catalogError, setCatalogError] = useState(false);
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [fields, setFields] = useState<AccountCredentialField[]>([]);
  const [schemaBusy, setSchemaBusy] = useState(false);
  const [schemaError, setSchemaError] = useState(false);
  const [schemaTarget, setSchemaTarget] = useState("");
  const [schemaAttempt, setSchemaAttempt] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invalidFields, setInvalidFields] = useState<string[]>([]);
  const [saved, setSaved] = useState<AccountSummary | null>(null);
  const [policy, setPolicy] = useState(() => ({ mode: initial?.mode || "shadow", live_trading_enabled: initial?.live_trading_enabled ?? false,
    permissions: { read_balances: initial?.permissions?.read_balances ?? true, place_order: initial?.permissions?.place_order ?? false, cancel_order: initial?.permissions?.cancel_order ?? false, withdraw: false }, limits: { ...initial?.limits } }));
  const [policyChanged, setPolicyChanged] = useState(false);
  const inFlight = useRef(false), alive = useRef(true), delivered = useRef(false);
  const request = useRef({ id: "", fingerprint: "" });
  const target = selected ? `${selected.kind}:${selected.venue}` : "";
  const requiresSchema = kind === "exchange";
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!id && selected) setId(connectionId(selected.venue === "mock" ? "practice" : selected.venue, crypto.randomUUID())); }, [id, selected]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    let active = true;
    setCatalogBusy(true); setCatalogError(false);
    if (kind === "paper") { setCatalogBusy(false); return; }
    const call = kind === "wallet" ? clientApi.walletConfigured() : clientApi.exchangeProviders();
    call.then(result => {
      if (!active) return;
      if ("bindings" in result && Array.isArray(result.bindings)) setWallets(result.bindings);
      else if ("providers" in result && Array.isArray(result.providers)) setProviders(result.providers);
      else throw new Error("catalog_unavailable");
    }).catch(() => { if (active) setCatalogError(true); }).finally(() => { if (active) setCatalogBusy(false); });
    return () => { active = false; };
  }, [catalogAttempt, kind]);
  useEffect(() => {
    let active = true;
    setFields([]); setSchemaError(false); setSchemaTarget("");
    if (!selected || !requiresSchema) { setSchemaBusy(false); return; }
    setSchemaBusy(true);
    clientApi.accountsIntakeSchema({ venue: selected.venue, account_kind: selected.kind }).then(result => {
      if (!active) return;
      if (!result.ok || !Array.isArray(result.credential_fields)) throw new Error("schema_unavailable");
      setFields(result.credential_fields); setSchemaTarget(target);
      setValues(previous => Object.fromEntries(result.credential_fields!.map(field => [field.name, previous[field.name] ?? (editing && !field.sensitive ? String(initial?.provider_config?.[field.name] ?? "") : "")])));
    }).catch(() => { if (active) setSchemaError(true); }).finally(() => { if (active) setSchemaBusy(false); });
    return () => { active = false; };
    // The edit profile is a snapshot; background refreshes must not overwrite drafts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, requiresSchema, schemaAttempt]);
  const visibleProviders = useMemo(() => providers.filter(p => !["mock", "mock_chain", "ccxt"].includes(p.id) && p.supports?.balances && p.kind !== "data_source")
    .filter(p => `${p.label} ${p.id} ${(p.aliases || []).join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => (popular.includes(a.id) ? popular.indexOf(a.id) : 100) - (popular.includes(b.id) ? popular.indexOf(b.id) : 100) || a.label.localeCompare(b.label)), [providers, query]);
  const label = kind === "paper" ? t("paperTitle") : providerLabel(providers.find(p => p.id === selected?.venue)?.label || selected?.label || "");
  const links = selected?.links || providers.find(p => p.id === selected?.venue)?.links;
  function clearError() { setError(""); setInvalidFields([]); }
  function choose(selection: Selection) {
    setSelected(selection); setValues({}); setRevealed({}); setName("");
    setId(connectionId(selection.venue === "mock" ? "practice" : selection.venue, crypto.randomUUID())); clearError(); request.current = { id: "", fingerprint: "" };
  }
  function switchKind(next: ConnectionKind) {
    if (editing || busy) return;
    setKind(next); setQuery(""); setSelected(null); setValues({}); setRevealed({}); clearError();
    if (next === "paper") choose({ venue: "mock", kind: "cex", label: "" });
  }
  function finish() { if (saved && !delivered.current) { delivered.current = true; onSaved?.(saved); } else if (!saved) onCancel?.(); }
  function updatePolicy(patch: Partial<typeof policy>) { setPolicy(previous => ({ ...previous, ...patch })); setPolicyChanged(true); clearError(); }
  const schemaReady = !requiresSchema || !schemaBusy && !schemaError && schemaTarget === target;
  async function submit() {
    if (inFlight.current || busy) return;
    if (saved) { finish(); return; }
    clearError();
    if (!selected) { setError("missing_fields"); return; }
    if (stage === 0) { setStage(1); return; }
    if (!schemaReady) return;
    const missing = requiresSchema ? fields.filter(f => f.required && !values[f.name]?.trim() && !(editing && f.sensitive && initial?.credentials?.[f.name])).map(f => f.name) : [];
    if (missing.length) { setInvalidFields(missing); setError("missing_fields"); return; }
    if (!/^[\p{L}\p{N}_-]{1,80}$/u.test(id)) { setError("invalid_account_id"); return; }
    if (kind === "paper" && (!balance.trim() || !Number.isFinite(Number(balance)) || Number(balance) < 0)) { setError("invalid_balance"); return; }
    inFlight.current = true; setBusy(true);
    try {
      if (policyChanged && !await confirm({ message: t("confirmPolicy"), tone: "warning" })) return;
      const credentials: Record<string, string> = {}, publicConfig: Record<string, string> = {};
      for (const field of requiresSchema ? fields : []) {
        const value = values[field.name]?.trim() || "";
        if (field.sensitive) { if (value) credentials[field.name] = value; }
        else if (value || editing) publicConfig[field.name] = value;
      }
      const body = { id, operation: editing ? "update" as const : "create" as const, expected_revision: initial?.revision,
        label: name.trim() || label, venue: selected.venue, kind: selected.kind, mode: editing ? initial?.mode || "shadow" : kind === "paper" ? "paper" : "shadow",
        ...(selected.walletId ? { wallet_id: selected.walletId } : {}), base_currency: currency, subaccount,
        ...(kind === "paper" ? { initial_balance_usd: Number(balance) } : { credentials, provider_config: publicConfig }), ...(policyChanged ? { policy } : {}) };
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      const digest = await crypto.subtle.digest("SHA-256", bytes); bytes.fill(0);
      const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
      if (request.current.fingerprint !== fingerprint) request.current = { id: crypto.randomUUID(), fingerprint };
      const response = await clientApi.accountsConnect({ ...body, request_id: request.current.id });
      if (!alive.current) return;
      if (!response.ok || !response.account) { setError(connectionErrorCode(response)); setInvalidFields(response.fields || []); return; }
      if (response.account.profile.mode !== "paper" && (response.verified !== true || response.account.snapshot?.health !== "ok" || !["live", "shadow"].includes(response.account.snapshot?.source || ""))) {
        setError("connection_failed"); return;
      }
      setValues({}); setRevealed({}); setSaved(response.account); setStage(2);
      if (setupMode) { delivered.current = true; onSaved?.(response.account); }
    } catch (value) { if (alive.current) setError(connectionErrorCode(value)); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  return { t, editing, initial, kind, stage, setStage, selected, label, links, id, setId, name, setName, currency, setCurrency, subaccount, setSubaccount,
    balance, setBalance, visibleProviders, wallets, catalogBusy, catalogError, reloadCatalog: () => setCatalogAttempt(n => n + 1), query, setQuery,
    fields, schemaBusy, schemaError, schemaReady, reloadSchema: () => setSchemaAttempt(n => n + 1), values, setValues, revealed, setRevealed,
    busy, error, invalidFields, saved, policy, policyChanged, updatePolicy, clearError, choose, switchKind, finish, submit };
}
export type ConnectionController = ReturnType<typeof useAccountConnection>;
