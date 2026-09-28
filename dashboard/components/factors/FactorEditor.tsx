"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useLocale } from "next-intl";
import { useId, useState } from "react";
import { factorRequest, type Factor, type FactorDefinition, type FactorSource } from "../../lib/factorLibrary";
import { ErrorBanner } from "../Page";
import { XIcon } from "../icons";
import { toast } from "../../lib/dialogs";
import styles from "./Factors.module.css";

export const categories = ["momentum", "trend", "volatility", "volume", "mean_reversion", "custom"];
export const categoryLabel = (category: string, zh: boolean) => zh ? ({ momentum: "动量", trend: "趋势", volatility: "波动率", volume: "成交量", mean_reversion: "均值回归", custom: "自定义" }[category] || category) : category.replaceAll("_", " ");

export function FactorEditor({ factor, source, onClose, onSaved }: { factor?: Factor; source?: FactorSource; onClose: () => void; onSaved: (factor: Factor) => void }) {
  const zh = useLocale().startsWith("zh"), id = useId();
  const [form, setForm] = useState<FactorDefinition>({
    factor_id: factor?.factor_id || "", name: factor?.name || "", category: factor?.category || "momentum",
    expression: factor?.expression || "", parameters: factor?.parameters || {}, description: factor?.description || "",
    hypothesis: factor?.hypothesis || "", direction: factor?.direction || "higher_is_bullish",
    markets: factor?.markets || [], timeframes: factor?.timeframes || [], tags: factor?.tags || [], status: factor?.status || "candidate",
  });
  const [parameters, setParameters] = useState(JSON.stringify(form.parameters, null, 2));
  const [markets, setMarkets] = useState(form.markets.join(", ")), [timeframes, setTimeframes] = useState(form.timeframes.join(", "));
  const [reason, setReason] = useState(""), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const patch = (key: keyof FactorDefinition, value: string) => setForm(old => ({ ...old, [key]: value }));
  const list = (value: string) => value.split(/[,，\n]/).map(s => s.trim()).filter(Boolean);
  return <Dialog.Root open onOpenChange={open => { if (!open && !saving) onClose(); }}><Dialog.Portal>
    <Dialog.Overlay className={styles.overlay}/><Dialog.Content className={styles.modal} onEscapeKeyDown={e => { if (saving) e.preventDefault(); }} onPointerDownOutside={e => e.preventDefault()}>
      <div className={styles.modalHeader}><Dialog.Title className={styles.modalTitle}>{factor ? (zh ? "编辑因子 · 保存新版本" : "Edit factor · new version") : (zh ? "添加候选因子" : "Add a candidate factor")}</Dialog.Title><Dialog.Close className="ui-icon-button" disabled={saving} aria-label={zh ? "关闭" : "Close"}><XIcon size={18}/></Dialog.Close></div>
      <Dialog.Description className={`${styles.muted} mb-5`}>{zh ? "直接保存，不创建提案。修改定义会生成新版本，历史验证记录不会被覆盖或自动继承。" : "Save directly without a proposal. Changes create a new version; historical evidence is never overwritten or inherited."}</Dialog.Description>
      <form className={styles.form} onSubmit={async event => {
        event.preventDefault(); if (saving) return; setError(""); setSaving(true);
        try {
          const parsed = JSON.parse(parameters);
          if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.values(parsed).some(v => typeof v !== "number" || !Number.isFinite(v))) throw new Error(zh ? "参数必须是数值组成的 JSON 对象。" : "Parameters must be a JSON object of finite numbers.");
          const result = await factorRequest<{ factor: Factor; duplicates: string[] }>("save", { definition: { ...form, factor_id: form.factor_id.trim(), name: form.name.trim(), parameters: parsed, markets: list(markets), timeframes: list(timeframes) }, expected_version: factor?.version || 0, reason, ...(source ? { source_backtest: { strategy_id: source.strategy_id, ts: source.ts, proposal_id: source.proposal_id || null } } : {}) });
          if (result.duplicates.length) toast({ tone: "warn", message: `${zh ? "已保存；发现相同计算定义：" : "Saved; matching definitions: "}${result.duplicates.join(", ")}` });
          onSaved(result.factor);
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setSaving(false); }
      }}>
        <div className={styles.fields}>
          <label className={styles.field} htmlFor={`${id}-name`}>{zh ? "名称" : "Name"}<input id={`${id}-name`} required maxLength={160} value={form.name} onChange={e => patch("name", e.target.value)}/></label>
          <label className={styles.field} htmlFor={`${id}-key`}>{zh ? "唯一标识" : "Factor ID"}<input id={`${id}-key`} required disabled={!!factor} pattern="[a-zA-Z0-9][a-zA-Z0-9_.\-]{0,79}" placeholder="momentum.return20" value={form.factor_id} onChange={e => patch("factor_id", e.target.value)}/></label>
        </div>
        <div className={styles.fields}>
          <label className={styles.field}>{zh ? "分类" : "Category"}<select value={form.category} onChange={e => patch("category", e.target.value)}>{categories.map(c => <option key={c} value={c}>{categoryLabel(c,zh)}</option>)}</select></label>
          <label className={styles.field}>{zh ? "研究方向" : "Research direction"}<select value={form.direction} onChange={e => patch("direction", e.target.value)}><option value="higher_is_bullish">{zh ? "数值越高越偏多" : "Higher is bullish"}</option><option value="lower_is_bullish">{zh ? "数值越低越偏多" : "Lower is bullish"}</option></select></label>
        </div>
        <label className={styles.field}>{zh ? "因子公式" : "Factor expression"}<textarea required maxLength={2000} value={form.expression} placeholder="close / delay(close, n) - 1" onChange={e => patch("expression", e.target.value)} spellCheck={false}/><small>{zh ? "支持 OHLCV、四则运算、sma / ema / std / zscore / delay / delta / ts_min / ts_max / abs / log。只允许历史窗口，不执行任意 Python。" : "OHLCV, arithmetic, sma / ema / std / zscore / delay / delta / ts_min / ts_max / abs / log. Trailing windows only; no arbitrary Python."}</small></label>
        <label className={styles.field}>{zh ? "数值参数 · JSON" : "Numeric parameters · JSON"}<textarea value={parameters} onChange={e => setParameters(e.target.value)} spellCheck={false}/></label>
        <label className={styles.field}>{zh ? "研究假设" : "Research hypothesis"}<textarea value={form.hypothesis} maxLength={4000} onChange={e => patch("hypothesis", e.target.value)} placeholder={zh ? "为什么这个因子可能包含独立信息？" : "Why might this factor contain independent information?"}/></label>
        <div className={styles.fields}>
          <label className={styles.field}>{zh ? "适用品种 · 逗号分隔" : "Markets · comma separated"}<input value={markets} onChange={e => setMarkets(e.target.value)} placeholder="BINANCE:ETH/USDT:USDT"/></label>
          <label className={styles.field}>{zh ? "适用周期 · 逗号分隔" : "Timeframes · comma separated"}<input value={timeframes} onChange={e => setTimeframes(e.target.value)} placeholder="15m, 1h, 4h"/></label>
        </div>
        <p className={styles.muted}>{zh ? "适用范围留空表示尚未限制，不代表已在所有市场验证。" : "An empty applicability list means unrestricted, not validated in all markets."}</p>
        <div className={styles.fields}><label className={styles.field}>{zh ? "研究状态" : "Research status"}<select value={form.status} onChange={e => patch("status", e.target.value)}><option value="candidate">{zh ? "候选" : "Candidate"}</option><option value="rejected">{zh ? "已否定（保留记录）" : "Rejected (retain evidence)"}</option><option value="retired">{zh ? "已停用" : "Retired"}</option></select></label><label className={styles.field}>{zh ? "保存原因" : "Change reason"}<input required maxLength={2000} value={reason} onChange={e => setReason(e.target.value)}/></label></div>
        {error && <ErrorBanner error={error}/>}
        <div className={styles.actions}><button className="btn btn-primary" type="submit" disabled={saving}>{saving ? (zh ? "保存中…" : "Saving…") : (zh ? "保存因子" : "Save factor")}</button><button type="button" className="btn btn-ghost" disabled={saving} onClick={onClose}>{zh ? "取消" : "Cancel"}</button></div>
      </form>
    </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
