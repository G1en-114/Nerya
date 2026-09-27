"use client";
import { useMemo, useState } from "react";
import type { ChartBlockShape } from "../../lib/chartBlock";
import type { ResearchInstrument } from "../../lib/researchVisuals";
import { instrumentId } from "../../lib/researchVisuals";
import { ResearchAssetCard } from "../../components/chat/ResearchReplyCards";
import { ResearchCharts, ResearchInstrumentPanel } from "../../components/chat/ResearchWorkspace";

/** Live-data visual check only. This viewer does not create an Agent message or alter a session. */
export function ResearchLivePreview({ publication }: { publication: { chart_blocks: ChartBlockShape[]; research_context: { instruments: Record<string, any>[] }; receipt: { chart_ids: string[] } } }) {
  const [selected, setSelected] = useState("");
  const [study, setStudy] = useState(false);
  const charts = publication.chart_blocks;
  const instruments = useMemo<ResearchInstrument[]>(() => publication.research_context.instruments.map(item => ({
    id: instrumentId(item.market, item.venue), market: item.market, venue: item.venue, name: item.name,
    interval: item.interval, news: item.news || [], newsAsOf: item.news_as_of || "", newsStatus: item.news_status || "not_requested", seenAt: 0,
    chartIds: charts.filter(block => block.instrument && (block.instrument as Record<string, string>).market === item.market).map(block => block.chart_id),
  })), [publication, charts]);
  const active = instruments.find(item => item.id === selected);
  const studies = charts.filter(block => !block.instrument);
  return <div className="flex h-full min-h-0 flex-col text-[color:var(--text-base)]" data-testid="live-research-preview">
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[color:var(--line)] px-6 py-4">
      <div><h1 className="text-base font-semibold">真实行情 · 研究组件验收</h1><p className="mt-1 text-xs text-[color:var(--text-muted)]">Hyperliquid 实际接口 · 非 Agent 生成 · 不创建聊天记录</p></div>
      <button type="button" className="rounded-lg border border-[color:var(--line)] px-3 py-2 text-xs" onClick={() => setStudy(!study)}>{study ? "查看品种卡片" : "查看多品种对比图"}</button>
    </header>
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="min-w-0 flex-1 overflow-y-auto">
        {study ? <ResearchCharts charts={studies} selected="" onSelect={() => {}} /> : <section className="mx-auto max-w-[900px] space-y-4 px-6 py-10" data-testid="live-price-cards">
          <p className="text-xs text-[color:var(--text-muted)]">正式回复中的同一套品种卡片组件</p>
          <h2 className="text-2xl font-semibold tracking-tight">Hyperliquid 市场快照</h2>
          <p className="pb-4 text-sm leading-7 text-[color:var(--text-muted)]">价格与迷你走势来自实际获取的 96 根小时 K 线。区间涨跌并非 24 小时涨跌；末根 K 线可能尚未收盘。点击品种打开右侧详情。</p>
          {[...instruments].reverse().map(item => { const block = charts.find(chart => item.chartIds.includes(chart.chart_id)); return block && <ResearchAssetCard key={item.id} instrument={item} block={block} onOpen={() => setSelected(item.id)} />; })}
          <p className="pt-4 text-xs leading-6 text-[color:var(--text-muted)]">此次仅核验真实行情的卡片与图表渲染。真实应用的 Agent 请求返回了 mock 回显，未作为研究成功证据；没有使用该回显构造本页内容。</p>
        </section>}
      </div>
      {active && <aside className="min-h-0 w-full overflow-y-auto border-l border-[color:var(--line)] bg-[color:var(--card)] lg:w-[48%]" aria-label="品种行情详情">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[color:var(--line)] bg-[color:var(--card)] px-5 py-3 text-xs"><span>{active.name} · K 线与指标</span><button type="button" onClick={() => setSelected("")} aria-label="收起品种详情">收起 ×</button></div>
        <ResearchInstrumentPanel key={active.id} instrument={active} charts={charts} />
      </aside>}
    </div>
  </div>;
}
