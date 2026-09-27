"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { ModalFrame } from "../ModalFrame";
import { Icon } from "../icons";
import { WalletProviderPanel } from "./WalletProviderPanel";
import { providerLabel } from "../../lib/accountConnection";
import { useAccountConnection, type ConnectionProps, type ConnectionKind } from "./useAccountConnection";
import { ConnectionFields } from "./ConnectionFields";
import s from "./AccountConnection.module.css";

export function AddAccountForm(props: ConnectionProps) {
  const c = useAccountConnection(props), { t } = c, locale = useLocale();
  const [walletSetup, setWalletSetup] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null), titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (c.error) errorRef.current?.focus({ preventScroll: true }); }, [c.error]);
  useEffect(() => { titleRef.current?.focus({ preventScroll: true }); }, [c.stage]);
  const title = t(c.editing ? "editTitle" : "title");
  const savedPaper = c.saved?.profile.mode === "paper";
  const content = <form id={props.formId} onSubmit={event => { event.preventDefault(); void c.submit(); }} className={`${s.form} ${props.setupMode ? s.inline : ""}`} noValidate data-testid="account-connection">
    <header className={s.header}>
      <div className={s.headingRow}><div><p className={s.eyebrow}>NERYA / ACCOUNTS</p><h2 ref={titleRef} tabIndex={-1}>{title}</h2></div>
        {props.onCancel && <button type="button" className={s.close} disabled={c.busy} aria-label={t("close")} onClick={c.finish}><Icon name="x" size={20} /></button>}</div>
      <p className={s.hint}>{t(c.editing ? "editIntro" : "intro")}</p>
      <ol aria-label={t("steps")} className={s.steps}>{[0, 1, 2].map(index => <li key={index} aria-current={c.stage === index ? "step" : undefined} data-done={c.stage > index}>
        <span>{c.stage > index ? <Icon name="check" size={13} /> : index + 1}</span>{t(`step${index + 1}`)}
      </li>)}</ol>
    </header>
    <div className={s.body}>
      <fieldset disabled={c.busy} className={s.fieldset}>
        {c.stage === 0 && <div className={s.phase}>
          <div className={s.tabs} role="group" aria-label={t("platform")}>{(["exchange", "wallet", "paper"] as ConnectionKind[]).map(kind => <button type="button" key={kind} aria-pressed={c.kind === kind} onClick={() => { c.switchKind(kind); setWalletSetup(false); }}>
            <Icon name={kind === "exchange" ? "building" : kind === "wallet" ? "wallet" : "chart"} size={17} />{t(kind)}</button>)}</div>
          {c.kind === "exchange" && <>
            <div className={s.search}><Icon name="search" size={18} /><input aria-label={t("search")} placeholder={t("searchPlaceholder")} value={c.query} onChange={event => c.setQuery(event.target.value)} /></div>
            <p className={s.sectionLabel}>{t(c.query ? "allPlatforms" : "popular")}</p>
            {c.catalogBusy ? <p role="status" className={s.empty}>{t("providerLoading")}</p> : c.catalogError ? <div role="alert" className={s.empty}>{t("providerFailed")}<button type="button" className="btn btn-secondary" onClick={c.reloadCatalog}>{t("retry")}</button></div> : <div className={s.providers}>
              {c.visibleProviders.map(provider => <button type="button" key={provider.id} className={s.provider} aria-pressed={c.selected?.venue === provider.id} onClick={() => c.choose({ venue: provider.id, kind: provider.kind, label: provider.label, links: provider.links })}>
                <span className={s.monogram} aria-hidden="true">{providerLabel(provider.label).slice(0, 2).toUpperCase()}</span><span><strong>{providerLabel(provider.label)}</strong><small>{provider.id.replace(/_/g, " ")}</small></span><Icon name={c.selected?.venue === provider.id ? "circleCheck" : "chevronRight"} size={18} />
              </button>)}{!c.visibleProviders.length && <p className={s.empty}>{t("noMatches")}</p>}
            </div>}
          </>}
          {c.kind === "wallet" && <>
            <h3>{t("walletTitle")}</h3><p className={s.hint}>{t("walletDescription")}</p>
            {c.catalogBusy ? <p role="status">{t("providerLoading")}</p> : c.catalogError ? <p role="alert">{t("providerFailed")}</p> : c.wallets.length ? <div className={s.walletList}>{c.wallets.map(wallet => <button type="button" key={wallet.wallet_id} className={s.provider} aria-pressed={c.selected?.walletId === wallet.wallet_id} onClick={() => c.choose({ venue: wallet.provider, kind: "chain", label: wallet.label || wallet.wallet_id, walletId: wallet.wallet_id })}>
              <Icon name="wallet" size={24} /><span><strong>{wallet.label || wallet.wallet_id}</strong><small>{wallet.provider} · {wallet.wallet_id}</small></span><Icon name="chevronRight" size={16} /></button>)}</div> : <p className={s.empty}>{t("noWallets")}</p>}
            <div className={s.row}><button type="button" className="btn btn-secondary" onClick={() => setWalletSetup(value => !value)}>{t("manageWallets")}</button><button type="button" className="btn btn-ghost" onClick={c.reloadCatalog}>{t("refreshWallets")}</button></div>
            {walletSetup && <div><p className={s.hint}>{t("walletSetupHint")}</p><WalletProviderPanel bare connectionOnly onChanged={c.reloadCatalog} /></div>}
          </>}
          {c.kind === "paper" && <div className={s.practice}><Icon name="chart" size={36} /><h3>{t("paperTitle")}</h3><p>{t("paperDescription")}</p></div>}
        </div>}
        {c.stage === 1 && <ConnectionFields c={c} />}
        {c.stage === 2 && c.saved && <div className={s.success} role="status">
          <div className={s.successMark}><Icon name="check" size={30} /></div><h3>{t(savedPaper ? "paperSuccess" : "successTitle")}</h3><p className={s.hint}>{t(savedPaper ? "paperSuccessDescription" : "successDescription")}</p>
          <div className={s.receipt}><strong>{c.saved.profile.label || c.saved.profile.id}</strong><small>{c.saved.profile.id}</small>
            {!savedPaper && c.saved.snapshot && <><span>{t("balance")}</span><b>{new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(Number(c.saved.snapshot.total_usd ?? c.saved.snapshot.nav_usd ?? 0))}</b>{Number(c.saved.snapshot.total_usd ?? c.saved.snapshot.nav_usd ?? 0) === 0 && <p className={s.hint}>{t("zeroBalance")}</p>}</>}
          </div>{!c.policyChanged && <p className={s.notice}><Icon name="shield" size={18} />{t(c.editing ? "policyKept" : c.kind === "paper" ? "paperNotice" : "readOnly")}</p>}
        </div>}
      </fieldset>
      {c.error && <div ref={errorRef} tabIndex={-1} role="alert" className={s.error}><Icon name="warning" size={20} /><div><strong>{t("errorTitle")}</strong><p>{t.has(c.error) ? t(c.error) : t("connection_failed")}</p></div></div>}
      {c.busy && <div role="status" className={s.progress}><Icon name="loader" size={18} className={s.spinner} /><span>{t(c.kind === "paper" ? "paperBusy" : "busy")}<small>{t("busyHint")}</small></span></div>}
    </div>
    {c.stage !== 2 && c.kind !== "paper" && <p className={s.safety}><Icon name="shield" size={16} />{t("safeHint")}</p>}
    {!props.setupMode && <footer className={s.footer}>
      <button type="button" className="btn btn-ghost" disabled={c.busy} onClick={() => c.stage === 1 && !c.editing ? (c.setStage(0), c.clearError()) : c.finish()}>{t(c.stage === 2 ? "close" : c.stage === 1 && !c.editing ? "back" : "cancel")}</button>
      <button type="submit" className="btn btn-primary" disabled={c.busy || !c.saved && (!c.selected || c.stage === 1 && !c.schemaReady)}>
        {c.busy ? t(c.kind === "paper" ? "paperBusy" : "busy") : c.saved ? t("done") : c.stage === 0 ? t("next") : t(c.kind === "paper" ? c.editing ? "savePaper" : "createPaper" : c.editing ? "reconnect" : "connect")}<Icon name={c.saved ? "check" : "arrowRight"} size={16} />
      </button>
    </footer>}
  </form>;
  return !props.setupMode && props.onCancel ? <ModalFrame title={title} onClose={c.finish} busy={c.busy} width="40rem" testId="account-connection-dialog">{content}</ModalFrame> : content;
}
