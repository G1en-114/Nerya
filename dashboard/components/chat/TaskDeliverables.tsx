"use client";
import { useState } from "react";
import { useLocale } from "next-intl";
import { FileIcon } from "../icons";

export type TaskDeliverable = { id: string; label: string };
const group = (id: string) => id.startsWith("result:") ? "results"
  : id === "strategy" || id.startsWith("backtest:") ? "strategy"
  : id.startsWith("instrument:") || id.startsWith("snapshot:") ? "research"
  : id === "agents" ? "team" : "files";

/** A directory of existing task resources; it never manufactures execution facts. */
export function TaskDeliverables({ items, files, onSelect, onOpenFile, onBrowseFiles }: {
  items: TaskDeliverable[]; files: { path: string; message_id?: string }[];
  onSelect: (id: string) => void; onOpenFile: (path: string) => void; onBrowseFiles: () => void;
}) {
  const zh = useLocale().startsWith("zh");
  const [query, setQuery] = useState("");
  const match = (label: string) => label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const labels: Record<string, string> = { results: zh ? "报告与结论" : "Reports and conclusions",
    strategy: zh ? "策略与回测" : "Strategies and backtests", research: zh ? "研究与数据" : "Research and data",
    team: zh ? "协作成员" : "Agent team", files: zh ? "文件与引用" : "Files and references" };
  const entries = [...new Map(items.map(item => [item.id, item])).values()].filter(item => match(item.label));
  const paths = [...new Set(files.map(file => file.path))].filter(match);
  const action = "flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-[color:var(--panel-bg)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--violet)]";
  return <div className="h-full overflow-y-auto p-4" data-testid="task-deliverables">
    <h2 className="text-sm font-medium">{zh ? "本任务产物" : "Task deliverables"}</h2>
    <p className="mt-1 text-xs leading-relaxed text-[color:var(--text-muted)]">{zh ? "当前任务的报告、策略、文件与来源。打开内容不会重新执行任务。" : "Reports, strategies, files and sources from this task. Opening an item does not rerun it."}</p>
    <input type="search" aria-label={zh ? "查找任务产物" : "Find task deliverables"} placeholder={zh ? "查找报告、标的或文件…" : "Find a report, instrument or file…"} value={query} onChange={event => setQuery(event.target.value)} className="input mt-4 min-h-11 w-full"/>
    {Object.entries(labels).map(([key, label]) => { const rows = entries.filter(item => group(item.id) === key);
      return rows.length ? <section key={key} className="mt-5"><h3 className="mb-1 text-xs font-medium text-[color:var(--text-muted)]">{label}</h3>{rows.map(item => <button key={item.id} type="button" className={action} onClick={() => onSelect(item.id)}><FileIcon size={16}/><span className="min-w-0 break-words">{item.label}</span></button>)}</section> : null;
    })}
    {paths.length > 0 && <section className="mt-5"><h3 className="mb-1 text-xs font-medium text-[color:var(--text-muted)]">{zh ? "交付文件" : "Delivered files"}</h3>{paths.map(path => <button type="button" key={path} className={action} onClick={() => onOpenFile(path)}><FileIcon size={16}/><span className="min-w-0"><span className="block break-words">{path.split("/").pop()}</span><span className="block break-all text-xs text-[color:var(--text-muted)]">{path}</span></span></button>)}</section>}
    {!entries.length && !paths.length && <p role="status" className="py-8 text-sm text-[color:var(--text-muted)]">{query ? (zh ? "没有匹配的产物。" : "No matching deliverables.") : (zh ? "本任务尚未记录产物。执行产生的报告与文件会显示在这里。" : "No deliverables recorded yet. Reports and files will appear here as the task produces them.")}</p>}
    <details className="mt-6 border-t border-[color:var(--line)] pt-3"><summary className="cursor-pointer py-2 text-xs text-[color:var(--text-muted)]">{zh ? "高级浏览" : "Advanced browsing"}</summary><button type="button" className={action} onClick={onBrowseFiles}>{zh ? "浏览完整工作区文件" : "Browse all workspace files"}</button></details>
  </div>;
}
