"use client";
import { copy as i18nCopy } from "../lib/i18n";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocale } from "next-intl";
import { ChevronRightIcon, SearchIcon, XIcon } from "./icons";

export function SearchField({ value, onChange, label, placeholder, disabled, className = "" }: {
  value: string; onChange: (value: string) => void; label: string; placeholder?: string; disabled?: boolean; className?: string;
}) {
  const zh = useLocale().startsWith("zh");
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  return <div className={`ui-search-field ${className}`}>
    <label htmlFor={id} className="sr-only">{label}</label>
    <SearchIcon size={16} aria-hidden="true" />
    <input ref={input} id={id} type="search" disabled={disabled} value={value} placeholder={placeholder ?? label}
      onChange={(event) => onChange(event.target.value)} />
    {value ? <button type="button" disabled={disabled} className="ui-icon-button" aria-label={i18nCopy(zh, "copy.components_ListControls.001")}
      onClick={() => { onChange(""); input.current?.focus(); }}><XIcon size={14} /></button> : null}
  </div>;
}

export function FilterBar<T extends string>({ label, value, onChange, options }: {
  label: string; value: T; onChange: (value: T) => void; options: { value: T; label: ReactNode; count?: number }[];
}) {
  return <div role="group" aria-label={label} className="ui-filter-bar">{options.map((option) => <button key={option.value}
    type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
    {option.label}{option.count !== undefined ? <span className="tabular-nums text-[color:var(--text-muted)]">{option.count}</span> : null}
  </button>)}</div>;
}

export function useListPage<T>(items: T[], resetKey: unknown, size = 20) {
  const [page, setPage] = useState(1);
  const count = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(page, count);
  useEffect(() => { setPage(1); }, [resetKey]);
  const rows = useMemo(() => items.slice((current - 1) * size, current * size), [items, current, size]);
  return { rows, page: current, setPage, total: items.length, size };
}

export function Pagination({ page, setPage, total, size, label }: { page: number; setPage: (page: number) => void; total: number; size: number; label?: string }) {
  const zh = useLocale().startsWith("zh");
  if (total <= size) return null;
  const count = Math.ceil(total / size), start = (page - 1) * size + 1, end = Math.min(page * size, total);
  return <nav aria-label={label ?? (i18nCopy(zh, "copy.components_ListControls.002"))} className="ui-pagination">
    <span role="status">{i18nCopy(zh, "copy.components_ListControls.003", { value0: start, value1: end, value2: total })}</span>
    <div className="flex items-center gap-2">
      <button type="button" className="btn btn-ghost" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label={i18nCopy(zh, "copy.components_ListControls.004")}><ChevronRightIcon size={15} className="rotate-180" /></button>
      <span className="tabular-nums">{page} / {count}</span>
      <button type="button" className="btn btn-ghost" disabled={page >= count} onClick={() => setPage(page + 1)} aria-label={i18nCopy(zh, "copy.components_ListControls.005")}><ChevronRightIcon size={15} /></button>
    </div>
  </nav>;
}

export function TableViewport({ children, label, className = "" }: { children: ReactNode; label: string; className?: string }) {
  const zh = useLocale().startsWith("zh");
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const hintId = useId();
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setOverflow(node.scrollWidth > node.clientWidth + 2);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    measure();
    return () => observer.disconnect();
  }, [children]);
  return <div className="min-w-0">
    {overflow ? <p id={hintId} className="mb-2 text-xs text-[color:var(--text-muted)]">{i18nCopy(zh, "copy.components_ListControls.006")}</p> : null}
    <div ref={ref} role="region" aria-label={label} aria-describedby={overflow ? hintId : undefined} tabIndex={overflow ? 0 : undefined}
      className={`ui-table-viewport ${className}`}>{children}</div>
  </div>;
}
