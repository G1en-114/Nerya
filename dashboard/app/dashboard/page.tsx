"use client";
import { Icon as NeryaGlyph } from "../../components/icons";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useLocale } from "next-intl";
import { copy as i18nCopy } from "../../lib/i18n";
import { LoadingState, Pill, StatusDot } from "../../components/Page";
import { ModePill } from "../../components/ModePill";
import { CandleChart } from "../../components/CandleChart";
import { RefreshIcon } from "../../components/icons";
import { SetupReadinessCard } from "../../components/SetupReadinessCard";
import { WorkspaceCustomizeButton } from "../../components/workspace/WorkspaceCustomizeButton";
import { WorkspaceUiHome } from "../../components/workspace/WorkspaceUiHome";
import { callApi, clientApi, invalidateReadCache, type AccountSummary } from "../../lib/clientApi";
import { useUiSettings } from "../../lib/settings";
import { useCurrentAccountId } from "../../lib/currentAccount";
import { formatTs } from "../../lib/format";
import { chartTime, financeMoney, financeNumber, financeTone, sumKnown } from "../../lib/financeDisplay";
import { useOverviewResource, type OverviewResource } from "../../lib/useOverviewResource";
import type { Candle } from "../../lib/api";
import type { AttentionItem } from "../../lib/operatorTypes";
import styles from "./overview.module.css";

type NewsItem = { title: string; source: string; link: string; published_at: string; tickers?: string[] };
type NewsFeed = { ok: boolean; items: NewsItem[]; fetched_at: number; error?: string };
type MarketData = { candles: Candle[]; error?: string; _envelope?: { mode?: string; source?: string; degraded?: boolean; error?: string } };
const loadNews = async () => {
  const result = await callApi<NewsFeed>("/market/news");
  if (!result.ok || !Array.isArray(result.items)) throw new Error(result.error || "News feed unavailable");
  return result;
};
const loadAccounts = async () => {
  const result = await clientApi.accountsList();
  if (!Array.isArray(result.accounts)) throw new Error("Account data unavailable");
  return result;
};
const loadStrategies = async () => {
  const result = await clientApi.strategyList();
  if (!Array.isArray(result.strategies)) throw new Error("Strategy data unavailable");
  return result;
};
const loadOverview = async () => {
  const result = await clientApi.operatorOverview();
  if (result.ok === false || !Array.isArray(result.data?.attention)) throw new Error(result.summary || "Risk status unavailable");
  return result;
};
const loadTrades = async () => {
  const result = await clientApi.recentTrades(20);
  if (!Array.isArray(result.trades)) throw new Error("Trade data unavailable");
  return result;
};
const loadWorkspace = async () => {
  const result = await clientApi.workspace();
  if (typeof result.kill_switch !== "boolean" || typeof result.live_trading_enabled !== "boolean") throw new Error("Trading protection unavailable");
  return result;
};
const RUNNING = new Set(["paper", "shadow", "canary", "live", "active", "running"]);

export default function DashboardOverview() {
  const locale = useLocale();
  const zh = locale.startsWith("zh");
  const text = (key: string, values?: Record<string, unknown>) => i18nCopy(zh, `copy.dashboardOverview.${key}`, values);
  const [settings, patchSettings] = useUiSettings();
  const [accountId, setAccountId] = useCurrentAccountId();
  const [filter, setFilter] = useState("all");
  const [newsSource, setNewsSource] = useState("all");
  const [symbolDraft, setSymbolDraft] = useState(settings.kline.symbol);
  const [symbolError, setSymbolError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshDone, setRefreshDone] = useState(false);
  const accounts = useOverviewResource(loadAccounts, settings.refreshSeconds);
  const strategies = useOverviewResource(loadStrategies, settings.refreshSeconds);
  const overview = useOverviewResource(loadOverview, settings.refreshSeconds);
  const workspace = useOverviewResource(loadWorkspace, settings.refreshSeconds);
  const portfolio = useOverviewResource(clientApi.portfolioSummary, settings.refreshSeconds);
  const venues = useOverviewResource(clientApi.marketVenues, 0);
  const trades = useOverviewResource(loadTrades, settings.refreshSeconds);
  const news = useOverviewResource(loadNews, settings.refreshSeconds ? 300 : 0);
  const marketLoader = useCallback(async () => {
    const data = await callApi<MarketData>("/market/candles", { method: "POST", body: {
      venue: settings.kline.venue, market: settings.kline.symbol, interval: settings.kline.interval, count: settings.kline.count,
    } });
    if (data.error || data._envelope?.degraded) throw new Error(data.error || data._envelope?.error || "Market data unavailable");
    if (!Array.isArray(data.candles)) throw new Error("Market data unavailable");
    return data;
  }, [settings.kline.venue, settings.kline.symbol, settings.kline.interval, settings.kline.count]);
  const market = useOverviewResource(marketLoader, settings.refreshSeconds);
  useEffect(() => { setSymbolDraft(settings.kline.symbol); setSymbolError(""); }, [settings.kline.symbol]);

  const accountRows = accounts.data?.accounts ?? [];
  const scopedAccounts = accountRows.filter((a) => !accountId || a.profile.id === accountId);
  const missingAccount = Boolean(accountId && accounts.data && !accountRows.some((a) => a.profile.id === accountId));
  const scopedStrategies = (strategies.data?.strategies ?? []).filter((s) => !accountId || s.account_id === accountId);
  const visibleStrategies = scopedStrategies.filter((s) => filter === "all" || (filter === "running" ? RUNNING.has(s.status) : !RUNNING.has(s.status)));
  const activeCount = scopedStrategies.filter((s) => RUNNING.has(s.status)).length;
  const liveAccounts = scopedAccounts.filter((a) => a.profile.mode === "live" || a.profile.mode === "canary");
  const paperAccounts = scopedAccounts.filter((a) => a.profile.mode === "paper" || a.profile.mode === "shadow");
  // Paper accounts may have a local ledger before their first connector snapshot.
  // Never use the paper portfolio ledger as a substitute for live account balances.
  const paperLedger = (account: AccountSummary) => account.profile.mode === "paper" && !account.snapshot && !portfolio.error ? portfolio.data?.accounts?.find((a) => a.id === account.profile.id && a.mode === "paper") : undefined;
  const accountValue = (rows: AccountSummary[]) => !accounts.data || missingAccount || !rows.length ? null : sumKnown(rows.map((a) => a.snapshot?.health === "ok" ? a.snapshot.total_usd : paperLedger(a)?.equity_usd));
  const pending = (overview.data?.data.attention ?? []).filter((item) => item.requires_action);
  const attention: AttentionItem[] = [...new Map([
    ...(workspace.data?.kill_switch ? [{ id: "kill-switch", type: "kill_switch", severity: "danger" as const, title: text("killSwitchTitle"), summary: text("killSwitchSummary"), href: "/incidents", requires_action: true }] : []),
    ...pending,
  ].map((item) => [item.id, item])).values()].sort((a, b) => ({ danger: 0, warn: 1, info: 2 }[a.severity] - { danger: 0, warn: 1, info: 2 }[b.severity]));
  const scopedTradeRows = (trades.data?.trades ?? []).filter((trade) => !accountId || scopedStrategies.some((s) => s.id === trade.strategy_id));
  const candles = useMemo(() => {
    const byTime = new Map<number, Candle>();
    for (const c of market.data?.candles ?? []) {
      const ts = chartTime(c.ts);
      if (ts && [c.open, c.high, c.low, c.close].every((n) => typeof n === "number" && Number.isFinite(n))) byTime.set(ts, { ...c, ts });
    }
    return [...byTime.values()].sort((a, b) => a.ts - b.ts);
  }, [market.data]);
  const last = candles.at(-1);
  const first = candles[0];
  const delta = first?.close && last ? (last.close / first.close - 1) * 100 : null;
  const intervalSeconds = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 }[settings.kline.interval];
  const marketDelayed = last && Date.now() / 1000 - last.ts > intervalSeconds * 3;
  const feedItems = (news.data?.items ?? []).filter((item) => safeNewsLink(item.link));
  const sources = [...new Set(feedItems.map((item) => item.source))];
  const newsSelection = newsSource === "all" || sources.includes(newsSource) ? newsSource : "all";
  const visibleNews = feedItems.filter((item) => newsSelection === "all" || item.source === newsSelection);
  useEffect(() => { if (newsSource !== newsSelection) setNewsSource(newsSelection); }, [newsSource, newsSelection]);
  const riskUnknown = !workspace.data || Boolean(workspace.error);
  const date = (value: unknown) => {
    const ts = chartTime(value);
    const timeZone = ({ "utc+8": "Etc/GMT-8", "utc+0": "UTC", "utc-5": "Etc/GMT+5", "utc+9": "Etc/GMT-9", "utc-8": "Etc/GMT+8" } as Record<string, string>)[settings.timezone];
    return ts ? new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone }).format(ts * 1000) : text("timeUnavailable");
  };
  const refreshAll = async () => {
    if (refreshing) return;
    setRefreshing(true); setRefreshDone(false); invalidateReadCache();
    try { await Promise.all([accounts.refresh(), strategies.refresh(), overview.refresh(), workspace.refresh(), portfolio.refresh(), venues.refresh(), trades.refresh(), news.refresh(), market.refresh()]); }
    finally { setRefreshing(false); setRefreshDone(true); }
  };
  const sectionState = <T,>(resource: OverviewResource<T>) => <ResourceState resource={resource} text={text} />;
  const manageLink = (href: string, label: string) => <Link className={styles.textLink} href={href}>{label}<NeryaGlyph name="arrowUpRight" size={16} /></Link>;
  const accountHint = (rows: AccountSummary[]) => !accounts.data ? text("accountsAwaiting") : text("accountHint", { count: rows.length });
  const failedPanels = [accounts, strategies, overview, workspace, portfolio, venues, trades, news, market].filter((r) => r.error).length;

  return <div className={styles.root} data-testid="dashboard-overview">
    <header className={styles.header}>
      <div><h1>{text("title")}</h1><p className={styles.subtle}>{text("subtitle")}</p></div>
      <div className={styles.actions}>
        <button type="button" className={styles.button} disabled={refreshing} onClick={() => void refreshAll()}><RefreshIcon size={14} />{refreshing ? text("refreshing") : text("refresh")}</button>
        <Link href="/chat" className={styles.primary}>{text("openResearch")}<NeryaGlyph name="arrowUpRight" size={16} /></Link>
      </div>
    </header>
    <div className={styles.toolbar}>
      <div className={styles.status}>
        <StatusDot tone={riskUnknown ? "warn" : workspace.data?.kill_switch ? "danger" : "ok"} />
        <Link href="/incidents" className={styles.textLink}>{riskUnknown ? text("protectionUnknown") : workspace.data?.kill_switch ? text("emergencyActive") : text("emergencyOff")}</Link>
        <Pill tone={riskUnknown ? "neutral" : workspace.data?.live_trading_enabled ? "danger" : "brand"}>{riskUnknown ? text("permissionsUnknown") : workspace.data?.live_trading_enabled ? text("liveEnabled") : text("liveDisabled")}</Pill>
      </div>
      <label className={styles.scope}>{text("accountScope")}<select className={styles.select} aria-label={text("accountScope")} value={accountId ?? ""} onChange={(e) => setAccountId(e.target.value || null)}>
        <option value="">{text("allAccounts")}</option>
        {missingAccount && <option value={accountId!}>{text("accountUnavailable")}: {accountId}</option>}
        {accountRows.map((account) => <option key={account.profile.id} value={account.profile.id}>{account.profile.id} · {account.profile.mode.toUpperCase()}</option>)}
      </select></label>
    </div>
    <div className={styles.subtle} role="status" aria-live="polite">{refreshDone ? failedPanels ? text("refreshPartial", { count: failedPanels }) : text("refreshComplete") : text("scopeHint")}</div>
    {missingAccount && <div className={styles.failure}>{text("missingAccount")} <button className={styles.textLink} onClick={() => setAccountId(null)}>{text("showAllAccounts")}</button></div>}
    {workspace.error && sectionState(workspace)}
    {accounts.error && sectionState(accounts)}
    <dl className={styles.stats}>
      <Metric label={text("liveFunds")} value={financeMoney(accountValue(liveAccounts), locale)} hint={accountHint(liveAccounts)} loading={accounts.loading && !accounts.data} />
      <Metric label={text("paperFunds")} value={financeMoney(accountValue(paperAccounts), locale)} hint={text("paperFundsHint")} loading={accounts.loading && !accounts.data} />
      <Metric label={text("runningStrategies")} value={strategies.data && !missingAccount ? `${activeCount} / ${scopedStrategies.length}` : "—"} hint={text("runningStrategiesHint")} loading={strategies.loading && !strategies.data} />
      <Metric label={text("needsAttention")} value={overview.data && !overview.error ? String(attention.length) : "—"} hint={text("needsAttentionHint")} loading={overview.loading && !overview.data} />
    </dl>
    <section className={styles.attention} aria-label={text("needsAttention")}>
      <div className={styles.attentionHead}><span>{attention.length ? text("attentionCount", { count: attention.length }) : overview.data && !overview.error ? text("noPendingApprovals") : text("pendingUnknown")}</span>{manageLink("/inbox", text("openInbox"))}</div>
      {sectionState(overview)}
      {attention.length > 0 && <ul>{attention.slice(0, 3).map((item) => <li key={item.id}><StatusDot tone={item.severity === "danger" ? "danger" : "warn"} /><div><Link className={styles.name} href={safeInternalLink(item.href)}>{item.title}</Link>{item.summary && <p className={styles.subtle}>{item.summary}</p>}</div></li>)}</ul>}
    </section>
    <SetupReadinessCard collapsed />
    <div className={styles.grid}>
      <Panel title={text("strategies")} subtitle={text("strategiesSubtitle")} action={manageLink("/strategies", text("manageStrategies"))} testId="overview-strategies">
        <div className={styles.filters} role="group" aria-label={text("strategyStatus")}>{[["all", text("all")], ["running", text("running")], ["other", text("otherStates")]].map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>
        {sectionState(strategies)}
        {strategies.data && (visibleStrategies.length ? <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>{text("strategyMarket")}</th><th>{text("status")}</th><th>{text("realizedPnl")}</th></tr></thead><tbody>{visibleStrategies.slice(0, 5).map((strategy) => <tr key={strategy.id}>
          <td><Link href={`/strategies/${encodeURIComponent(strategy.id)}`} className={styles.name}>{strategy.title || strategy.id}</Link><p className={styles.subtle}>{strategy.markets?.join(" · ") || text("noMarkets")}</p>{strategy.account_id ? <Link className={styles.subtle} href={`/accounts/${encodeURIComponent(strategy.account_id)}`}>{strategy.account_id}</Link> : <span className={styles.subtle}>{text("noLinkedAccount")}</span>}</td>
          <td><Pill tone={strategy.status === "live" ? "danger" : strategy.status === "canary" ? "warn" : strategy.status === "paper" ? "brand" : "neutral"}>{statusLabel(strategy.status, zh)}</Pill></td>
          <td className={financeTone(strategy.realized_pnl_usd)}>{financeMoney(strategy.realized_pnl_usd, locale, true)}<p className={styles.subtle}>{financeNumber(strategy.open_positions_count, locale)} {text("positions")}</p></td>
        </tr>)}</tbody></table></div> : <Empty title={text("noStrategies")} description={text("noStrategiesDescription")} action={manageLink("/strategies", text("openStrategies"))} />)}
        {visibleStrategies.length > 5 && <p className={styles.subtle}>{text("showStrategies", { count: visibleStrategies.length })}</p>}
      </Panel>
      <Panel title={text("tradingAccounts")} subtitle={text("tradingAccountsSubtitle")} action={manageLink("/accounts", text("manageAccounts"))} testId="overview-accounts">
        {!accounts.data && !accounts.error && sectionState(accounts)}
        {portfolio.error && sectionState(portfolio)}
        {accounts.data && (scopedAccounts.length ? <div className={styles.accountList}>{scopedAccounts.slice(0, 3).map((account) => {
          const snapshot = account.snapshot;
          const valid = snapshot?.health === "ok";
          const ledger = paperLedger(account);
          const snapshotTs = chartTime(snapshot?.ts);
          const old = snapshotTs !== null && Date.now() / 1000 - snapshotTs > 300;
          return <article className={styles.account} key={account.profile.id}>
            <div className={styles.accountTop}><div><Link className={styles.accountName} href={`/accounts/${encodeURIComponent(account.profile.id)}`}>{account.profile.id} <NeryaGlyph name="arrowUpRight" size={16} /></Link><p className={styles.subtle}>{account.profile.venue} · {statusLabel(account.profile.status, zh)}</p></div><div className={styles.actions}>{["paper", "live"].includes(account.profile.mode) ? <ModePill mode={account.profile.mode} /> : <Pill tone="warn">{statusLabel(account.profile.mode, zh)}</Pill>}<Pill tone={ledger || valid && !old ? "neutral" : "warn"}>{ledger ? text("localLedger") : valid ? old ? text("snapshotOld") : text("snapshotAvailable") : text("checkConnection")}</Pill></div></div>
            <dl className={styles.accountMetrics}><div><dt>{text("netValue")}</dt><dd>{financeMoney(valid ? snapshot.total_usd : ledger?.equity_usd, locale)}</dd></div><div><dt>{ledger ? text("ledgerCash") : text("available")}</dt><dd>{financeMoney(valid ? snapshot.free_usd ?? snapshot.available_usd : ledger?.cash_usd, locale)}</dd></div><div><dt>{text("accountPositions")}</dt><dd>{financeNumber(account.open_position_count, locale)}</dd></div></dl>
            <p className={`${styles.subtle} mt-2`}>{ledger ? text("ledgerRetrieved") : text("snapshotTime")}: {date(ledger ? portfolio.updatedAt : snapshot?.ts)}</p>
          </article>;
        })}</div> : <Empty title={text("noAccounts")} description={text("noAccountsDescription")} action={manageLink("/accounts", text("setUpAccounts"))} />)}
        {scopedAccounts.length > 3 && <p className={`${styles.subtle} mt-3`}>{text("showAccounts", { count: scopedAccounts.length })}</p>}
        <div className={`${styles.footer} mt-4`}>{manageLink("/portfolio", text("viewPortfolio"))}</div>
      </Panel>
    </div>
    <div className={styles.grid}>
      <Panel title={text("marketWatch")} subtitle={text("marketWatchSubtitle")} testId="overview-market" action={<button className={styles.textLink} disabled={market.loading} onClick={() => { invalidateReadCache(); void market.refresh(); }}>{text("refreshMarket")}</button>}>
        <div className={styles.marketTools}>
          <select className={styles.select} aria-label={text("marketSource")} value={settings.kline.venue} onChange={(e) => patchSettings({ kline: { ...settings.kline, venue: e.target.value as typeof settings.kline.venue } })}>
            {!(venues.data?.venues ?? []).some((v) => v.name === settings.kline.venue) && <option value={settings.kline.venue}>{settings.kline.venue}</option>}
            {(venues.data?.venues ?? []).map((v) => <option key={v.name} value={v.name}>{v.label}</option>)}
          </select>
          <form onSubmit={(e) => { e.preventDefault(); const value = symbolDraft.trim(); if (!value || value.length > 160 || /\s/.test(value)) { setSymbolError(text("invalidSymbol")); return; } setSymbolError(""); if (value === settings.kline.symbol) { invalidateReadCache(); void market.refresh(); } else patchSettings({ kline: { ...settings.kline, symbol: value } }); }}>
            <input className={styles.select} aria-label={text("marketSymbol")} aria-invalid={Boolean(symbolError)} aria-describedby={symbolError ? "market-symbol-error" : undefined} value={symbolDraft} onChange={(e) => setSymbolDraft(e.target.value)} placeholder="BTCUSDT" maxLength={160} />
            <button type="submit" className={styles.button}>{text("apply")}</button>
          </form>
        </div>
        {symbolError && <p id="market-symbol-error" role="alert" className="text-xs text-danger mb-3">{symbolError}</p>}
        {sectionState(venues)}
        <div className={styles.filters} role="group" aria-label={text("candleInterval")}>{(["1m", "5m", "15m", "1h", "4h", "1d"] as const).map((interval) => <button key={interval} type="button" aria-pressed={settings.kline.interval === interval} onClick={() => patchSettings({ kline: { ...settings.kline, interval } })}>{interval}</button>)}</div>
        {sectionState(market)}
        {market.data && <>
          <div className={styles.quote}><strong>{last ? financeNumber(last.close, locale) : "—"}</strong>{delta !== null && <span className={`text-xs ${financeTone(delta)}`}>{delta > 0 ? "+" : ""}{delta.toFixed(2)}% <span className={styles.subtle}>{text("selectedRange")}</span></span>}<Pill tone={market.data._envelope?.mode === "live" ? "neutral" : "warn"}>{market.data._envelope?.mode === "live" ? text("marketData") : market.data._envelope?.mode === "mock" ? text("simulatedPrices") : text("sourceUnverified")}</Pill></div>
          <div className={styles.subtle}>{settings.kline.symbol} · {settings.kline.venue} · {text("lastCandle")}: {date(last?.ts)}</div>
          {marketDelayed && <p className="text-xs text-warn mt-2">{text("pricesDelayed")}</p>}
          {candles.length ? <CandleChart candles={candles} height={240} mode={settings.chartType} showVolume={settings.showVolume} /> : <Empty title={text("noCandles")} description={text("noCandlesDescription")} />}
        </>}
        <div className={styles.footer}>
          <label className={styles.scope}>{text("chart")}<select className={styles.select} aria-label={text("chartType")} value={settings.chartType} onChange={(e) => patchSettings({ chartType: e.target.value as typeof settings.chartType })}><option value="candlestick">{text("candles")}</option><option value="line">{text("line")}</option><option value="area">{text("area")}</option></select></label>
          <label className={styles.scope}><input type="checkbox" checked={settings.showVolume} onChange={(e) => patchSettings({ showVolume: e.target.checked })} />{text("showVolume")}</label>
        </div>
      </Panel>
      <Panel title={text("latestNews")} subtitle={text("latestNewsSubtitle")} testId="overview-news" action={<button className={styles.textLink} disabled={news.loading} onClick={() => { invalidateReadCache(); void news.refresh(); }}>{text("refreshNews")}</button>}>
        <label className={`${styles.scope} mb-4`}>{text("newsSource")}<select className={styles.select} aria-label={text("newsSource")} value={newsSelection} onChange={(e) => setNewsSource(e.target.value)}><option value="all">{text("allSources")}</option>{sources.map((source) => <option key={source} value={source}>{source}</option>)}</select></label>
        {sectionState(news)}
        {news.data && (visibleNews.length ? <ul className={styles.newsList}>{visibleNews.slice(0, 6).map((item) => <li key={item.link}><a href={safeNewsLink(item.link)!} target="_blank" rel="noopener noreferrer" aria-label={`${item.title} (${text("readSource")})`}>{item.title}{' '}<NeryaGlyph name="arrowUpRight" size={14} /></a><div className={styles.newsMeta}><span>{item.source}</span><time>{date(item.published_at)}</time></div></li>)}</ul> : <Empty title={text("noNews")} description={text("noNewsDescription")} />)}
        <p className={`${styles.subtle} mt-4`}>{text("newsCache")}{news.data?.fetched_at ? ` ${text("fetched")}: ${date(news.data.fetched_at)}` : ""}</p>
      </Panel>
    </div>
    <Panel title={text("recentTrades")} subtitle={accountId ? text("recentTradesForAccount") : text("recentTradesAll")} action={manageLink("/orders", text("viewOrders"))} testId="overview-trades">
      {sectionState(trades)}
      {accountId && strategies.error && <p className={styles.failure}>{text("strategyMappingsUnavailable")}</p>}
      {trades.data && (!accountId || strategies.data && !strategies.error) && (scopedTradeRows.length ? <div className={styles.tableWrap}><table className={styles.table}><thead><tr><th>{text("marketStrategy")}</th><th>{text("side")}</th><th>{text("time")}</th><th>{text("fillPrice")}</th></tr></thead><tbody>{scopedTradeRows.slice(0, 5).map((trade, index) => <tr key={trade.order_id || `${trade.ts}-${index}`}><td><span className={styles.name}>{trade.market || "—"}</span><Link href={`/strategies/${encodeURIComponent(trade.strategy_id)}`} className={styles.subtle}>{trade.strategy_id}</Link></td><td><Pill tone={trade.side?.toLowerCase() === "buy" ? "ok" : trade.side?.toLowerCase() === "sell" ? "danger" : "neutral"}>{trade.side?.toLowerCase() === "buy" ? text("buy") : trade.side?.toLowerCase() === "sell" ? text("sell") : text("unknown")}</Pill></td><td className={styles.subtle}>{date(trade.ts)}</td><td>{financeNumber(trade.price, locale)}</td></tr>)}</tbody></table></div> : <Empty title={text("noTrades")} description={text("noTradesDescription")} />)}
    </Panel>
    <WorkspaceUiHome />
    <footer className={styles.footer}>
      <label className={styles.scope}>{text("autoRefresh")}<select className={styles.select} aria-label={text("autoRefresh")} value={settings.refreshSeconds} onChange={(e) => patchSettings({ refreshSeconds: Number(e.target.value) })}>{[0, 5, 10, 30, 60].map((seconds) => <option key={seconds} value={seconds}>{seconds ? text("seconds", { count: seconds }) : text("off")}</option>)}</select></label>
      <div className={styles.actions}>{manageLink("/workflows", text("manageAutomations"))}<WorkspaceCustomizeButton context="home" compact /></div>
    </footer>
  </div>;
}

function Panel({ title, subtitle, action, children, testId }: { title: string; subtitle: string; action?: ReactNode; children: ReactNode; testId: string }) {
  return <section className={styles.panel} data-testid={testId} aria-label={title}><div className={styles.panelHead}><div><h2>{title}</h2><p className={styles.subtle}>{subtitle}</p></div>{action}</div><div className={styles.panelBody}>{children}</div></section>;
}
function Metric({ label, value, hint, loading }: { label: string; value: string; hint: string; loading: boolean }) {
  return <div className={styles.stat}><dt>{label}</dt><dd>{loading ? <span aria-label="…" className="skeleton inline-block h-7 w-24" /> : value}</dd><small>{hint}</small></div>;
}
function Empty({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className={styles.empty}><strong>{title}</strong><p className={styles.subtle}>{description}</p>{action}</div>;
}
function ResourceState<T>({ resource, text }: { resource: OverviewResource<T>; text: (key: string, values?: Record<string, unknown>) => string }) {
  if (resource.loading && !resource.data) return <LoadingState rows={2} />;
  if (!resource.error) return null;
  return <div className={styles.failure} role="alert"><p>{resource.data ? text("updateFailedCached") : text("dataUnavailable")}</p>{resource.updatedAt && <p className={styles.subtle}>{text("lastSuccessful")}: {formatTs(resource.updatedAt)}</p>}<button className={styles.textLink} disabled={resource.loading} onClick={() => { invalidateReadCache(); void resource.refresh(); }}>{resource.loading ? text("retrying") : text("retryLoading")}</button><details><summary>{text("errorDetails")}</summary><pre>{resource.error}</pre></details></div>;
}
function statusLabel(status: string, zh: boolean) {
  return i18nCopy(zh, `copy.dashboardOverview.status.${status}`) === `copy.dashboardOverview.status.${status}` ? status || i18nCopy(zh, "copy.dashboardOverview.unknown") : i18nCopy(zh, `copy.dashboardOverview.status.${status}`);
}
function safeNewsLink(value: string) {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function safeInternalLink(value?: string) {
  return value?.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : "/inbox";
}
