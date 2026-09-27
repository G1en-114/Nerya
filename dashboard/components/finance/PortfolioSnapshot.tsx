"use client";
import { copy as i18nCopy } from "../../lib/i18n";

import { ChoiceSelect } from "../ChoiceSelect";

import { useState } from "react";
import { useLocale } from "next-intl";
import Link from "next/link";
import type { SnapshotAccount } from "../../lib/portfolioSnapshot";
import { chartTime, financeMoney, financeTone, sumKnown } from "../../lib/financeDisplay";
import { PositionsView } from "./PositionsView";
import { ModePill } from "../ModePill";
import styles from "./FinanceSurface.module.css";

export function PortfolioSnapshot({ accounts }: { accounts: SnapshotAccount[] }) {
  const locale = useLocale(), zh = locale.startsWith("zh");
  const [selected, setSelected] = useState("");
  const account = accounts.find((a) => a.id === selected) || accounts[0];
  if (!account) return <p className="py-3 text-sm text-[color:var(--text-muted)]">{i18nCopy(zh, "copy.components_finance_PortfolioSnapshot.001")}</p>;
  const total = account.positionsKnown ? sumKnown(account.positions.map((p) => p.unrealized_pnl_usd)) : null;
  const time = chartTime(account.asOf);
  return <section className={styles.surface} data-testid="portfolio-snapshot">
    <div className={styles.header}><h2>{i18nCopy(zh, "copy.components_finance_PortfolioSnapshot.002")}</h2><span className={styles.note}>{i18nCopy(zh, "copy.components_finance_PortfolioSnapshot.003")}</span></div>
    <div className={styles.header} style={{ paddingTop: 0 }}><ChoiceSelect aria-label={i18nCopy(zh, "copy.components_finance_PortfolioSnapshot.004")} value={account.id} onValueChange={setSelected}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.id} · {a.mode || (i18nCopy(zh, "copy.components_finance_PortfolioSnapshot.005"))}</option>)}</ChoiceSelect>{account.mode === "paper" || account.mode === "live" ? <ModePill mode={account.mode} /> : <span className={styles.note}>{i18nCopy(zh, "copy.components_finance_PortfolioSnapshot.006")}</span>}</div>
    <dl className={styles.metrics}>
      <div><dt>{i18nCopy(zh, "copy.components_finance_PortfolioSnapshot.007")}</dt><dd>{financeMoney(account.equity, locale)}</dd></div><div><dt>{i18nCopy(zh, "copy.components_finance_PortfolioSnapshot.008")}</dt><dd>{financeMoney(account.cash, locale)}</dd></div>
      <div><dt>{i18nCopy(zh, "copy.components_finance_PortfolioSnapshot.009")}</dt><dd className={financeTone(total)}>{financeMoney(total, locale, true)}</dd></div><div><dt>{i18nCopy(zh, "copy.components_finance_PortfolioSnapshot.010")}</dt><dd>{financeMoney(account.fees, locale)}</dd></div>
    </dl>
    <PositionsView key={account.id} positions={account.positions} modes={{ [account.id]: account.mode }} error={!account.positionsKnown ? (i18nCopy(zh, "copy.components_finance_PortfolioSnapshot.011")) : undefined} />
    <footer className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[color:var(--text-muted)]"><span>{i18nCopy(zh, "copy.components_finance_PortfolioSnapshot.012")}{time === null ? (i18nCopy(zh, "copy.components_finance_PortfolioSnapshot.013")) : new Date(time * 1000).toLocaleString(locale)}</span><Link href="/portfolio" className={styles.action}>{i18nCopy(zh, "copy.components_finance_PortfolioSnapshot.014")}</Link></footer>
  </section>;
}
