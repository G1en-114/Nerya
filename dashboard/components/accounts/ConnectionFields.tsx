"use client";
import { useId } from "react";
import { Icon } from "../icons";
import { Advanced } from "../Page";
import type { AccountCredentialField } from "../../lib/clientApi";
import { safeProviderUrl } from "../../lib/accountConnection";
import type { ConnectionController } from "./useAccountConnection";
import s from "./AccountConnection.module.css";

export function ConnectionFields({ c }: { c: ConnectionController }) {
  const prefix = useId(), { t } = c;
  const apiUrl = safeProviderUrl(c.links?.api_keys), docsUrl = safeProviderUrl(c.links?.docs);
  function renderField(field: AccountCredentialField) {
    const label = t.has(`fields.${field.name}`) ? t(`fields.${field.name}`) : field.label || field.name;
    const hasStored = Boolean(c.editing && field.sensitive && c.initial?.credentials?.[field.name]);
    const invalid = c.invalidFields.includes(field.name), inputId = `${prefix}-${field.name}`;
    return <div className={s.field} key={field.name}>
      <label htmlFor={inputId}><span>{label}</span><small>{hasStored ? t("savedCredential") : field.required ? t("required") : t("optional")}</small></label>
      <div className={s.secretInput}><input id={inputId} data-connection-field={field.name} aria-invalid={invalid || undefined} aria-required={field.required && !hasStored}
        type={field.sensitive && !c.revealed[field.name] ? "password" : field.kind === "url" ? "url" : "text"}
        autoComplete="off" autoCapitalize="none" spellCheck={false} value={c.values[field.name] || ""}
        placeholder={hasStored ? t("keepCredential") : field.sensitive ? t("secretPlaceholder", { field: label }) : field.placeholder || ""}
        onChange={event => { c.setValues(previous => ({ ...previous, [field.name]: event.target.value })); c.clearError(); }} className="input-dark" />
        {field.sensitive && <button type="button" aria-label={t(c.revealed[field.name] ? "hide" : "show", { field: label })} aria-pressed={!!c.revealed[field.name]}
          onClick={() => c.setRevealed(previous => ({ ...previous, [field.name]: !previous[field.name] }))}><Icon name="eye" size={17} /></button>}
      </div>{!field.sensitive && field.description && <p className={s.hint}>{field.description}</p>}
    </div>;
  }
  return <div className={s.phase}>
    <div className={s.selected}><span className={s.monogram}><Icon name={c.kind === "wallet" ? "wallet" : c.kind === "paper" ? "chart" : "building"} size={23} /></span>
      <div><small>{t("platform")}</small><strong>{c.label}</strong></div>{!c.editing && <button type="button" className="btn btn-ghost" onClick={() => { c.setStage(0); c.clearError(); }}>{t("change")}</button>}</div>
    <div className={s.field}><label htmlFor={`${prefix}-name`}>{t("accountName")}<small>{t("optional")}</small></label><input className="input-dark" id={`${prefix}-name`} value={c.name} maxLength={120} placeholder={c.label || t("namePlaceholder")} onChange={event => { c.setName(event.target.value); c.clearError(); }} /></div>
    {c.kind === "paper" ? <><div className={s.field}><label htmlFor={`${prefix}-balance`}>{t("paperBalance")}</label><input id={`${prefix}-balance`} className="input-dark" type="number" min="0" step="any" value={c.balance} onChange={event => { c.setBalance(event.target.value); c.clearError(); }} /></div><p className={s.notice}><Icon name="info" size={18} />{t("paperNotice")}</p></> : c.kind === "exchange" ? <>
      <div className={s.help}><p>{t("keyHint")}</p>{(apiUrl || docsUrl) && <a href={apiUrl || docsUrl} target="_blank" rel="noopener noreferrer">{t(apiUrl ? "getKeys" : "docs")}<Icon name="arrowUpRight" size={14} /></a>}</div>
      {c.schemaError ? <div role="alert" className={s.empty}>{t("schemaFailed")}<button type="button" className="btn btn-secondary" onClick={c.reloadSchema}>{t("retry")}</button></div> : !c.schemaReady ? <p role="status" className={s.empty}>{t("schemaLoading")}</p> : <>
        {c.fields.filter(field => field.required).map(renderField)}
        {c.fields.some(field => !field.required) && <Advanced title={t("optionalFields")}>{c.fields.filter(field => !field.required).map(renderField)}</Advanced>}
      </>}
    </> : <p className={s.notice}><Icon name="wallet" size={20} /><span>{c.selected?.walletId}<br />{t("walletDescription")}</span></p>}
    <Advanced title={t("advanced")}>
      <div className={s.field}><label htmlFor={`${prefix}-id`}>{t("accountId")}</label><input id={`${prefix}-id`} className="input-dark" value={c.id} readOnly={c.editing} maxLength={80} spellCheck={false} onChange={event => { c.setId(event.target.value); c.clearError(); }} /><p className={s.hint}>{t("idHint")}</p></div>
      <div className={s.twoColumns}><div className={s.field}><label htmlFor={`${prefix}-currency`}>{t("currency")}</label><input id={`${prefix}-currency`} className="input-dark" value={c.currency} maxLength={12} onChange={event => c.setCurrency(event.target.value.toUpperCase())} /></div><div className={s.field}><label htmlFor={`${prefix}-subaccount`}>{t("subaccount")}</label><input id={`${prefix}-subaccount`} className="input-dark" value={c.subaccount} onChange={event => c.setSubaccount(event.target.value)} /></div></div>
      {c.editing && <><p className={s.hint}>{t("preserved")}</p><Advanced title={t("policyTitle")}>
        <p className={s.policyWarning}>{t("policyWarning")}</p>
        <div className={s.field}><label htmlFor={`${prefix}-mode`}>{t("mode")}</label><select id={`${prefix}-mode`} className="input-dark" value={c.policy.mode} onChange={event => c.updatePolicy({ mode: event.target.value })}>
          {["paper", "shadow", "canary", "live"].map(mode => <option key={mode} value={mode}>{t(`mode${mode[0].toUpperCase()}${mode.slice(1)}`)}</option>)}</select></div>
        <label className={s.checkbox}><input type="checkbox" checked={c.policy.live_trading_enabled} onChange={event => c.updatePolicy({ live_trading_enabled: event.target.checked })} />{t("enableLive")}</label>
        {(["read_balances", "place_order", "cancel_order"] as const).map((permission, index) => <label key={permission} className={s.checkbox}><input type="checkbox" checked={c.policy.permissions[permission]} onChange={event => c.updatePolicy({ permissions: { ...c.policy.permissions, [permission]: event.target.checked } })} />{t(["readBalances", "placeOrders", "cancelOrders"][index])}</label>)}
        <div className={s.twoColumns}>{Object.entries(c.policy.limits).map(([key, value]) => <div className={s.field} key={key}><label htmlFor={`${prefix}-limit-${key}`}>{t.has(`limits.${key}`) ? t(`limits.${key}`) : key}</label><input id={`${prefix}-limit-${key}`} className="input-dark" type="number" min="0" step="any" value={value} onChange={event => c.updatePolicy({ limits: { ...c.policy.limits, [key]: Number(event.target.value) } })} /></div>)}</div>
      </Advanced></>}
    </Advanced>
  </div>;
}
