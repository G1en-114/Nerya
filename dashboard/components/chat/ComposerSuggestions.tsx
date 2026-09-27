"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useTranslations } from "next-intl";
import type { ChatRunSettings, WorkMode } from "../../lib/chat";
import * as Popover from "@radix-ui/react-popover";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { composerFileQuery, composerTrigger, filterComposerOptions, replaceComposerTrigger, triggerSignature,
  type ComposerOption } from "../../lib/composerInput";
import { loadComposerCatalog, type ComposerCatalog, type ComposerGroup } from "../../lib/composerResources";
import { AgentsIcon, ChatIcon, ChevronLeftIcon, ChevronRightIcon, CommandIcon, FileIcon, FolderIcon,
  ImageIcon, PlusIcon, SearchIcon, SkillsIcon, StrategiesIcon, XIcon, CheckIcon } from "../icons";

const GROUPS: ComposerGroup[] = ["files", "skills", "agents", "strategies", "sessions"];
type CatalogState = ComposerCatalog & { loading?: boolean; error?: boolean };
const LOADING: CatalogState = { items: [], loading: true };
export function ComposerSourceIcon({ kind }: { kind: ComposerOption["kind"] }) {
  const Glyph = { file: FileIcon, folder: FolderIcon, skill: SkillsIcon, agent: AgentsIcon,
    strategy: StrategiesIcon, session: ChatIcon }[kind];
  return <Glyph size={17} className="shrink-0" />;
}

export function useComposerSuggestions({ value, onChange, inputRef, disabled, onReference, sessionId }: {
  value: string; onChange: (value: string) => void; inputRef: RefObject<HTMLTextAreaElement>;
  disabled: boolean; onReference: (option: ComposerOption) => boolean; sessionId?: string;
}) {
  const t = useTranslations("composer");
  const id = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const [compositionActive, setCompositionActive] = useState(false);
  const [focused, setFocused] = useState(false);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [dismissed, setDismissed] = useState("");
  const [browsedPath, setBrowsedPath] = useState(".");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [catalog, setCatalog] = useState<Partial<Record<ComposerGroup, CatalogState>>>({});
  const [files, setFiles] = useState<CatalogState>(LOADING);
  const rawTrigger = composerTrigger(value, selection.start, selection.end);
  const rawSignature = triggerSignature(rawTrigger);
  useEffect(() => { if (dismissed && rawSignature !== dismissed) setDismissed(""); }, [rawSignature, dismissed]);
  const trigger = focused && !disabled && !compositionActive ? rawTrigger : null;
  const signature = triggerSignature(trigger);
  const open = Boolean(trigger && signature !== dismissed);
  const mode = trigger?.mode;
  const query = trigger?.query ?? "";
  const fileQuery = composerFileQuery(query, browsedPath);
  const path = fileQuery.path;

  useEffect(() => { setSelectedKey(null); }, [signature, path]);
  useEffect(() => { setBrowsedPath("."); }, [trigger?.start, mode, sessionId]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const groups = GROUPS.filter(group => group !== "files" && (mode === "context" || group === "skills" || group === "agents"));
    setCatalog(Object.fromEntries(groups.map(group => [group, LOADING])));
    for (const group of groups) void loadComposerCatalog(group, ".", controller.signal).then(result => {
      if (!controller.signal.aborted) setCatalog(previous => ({ ...previous, [group]: result }));
    }).catch(() => {
      if (!controller.signal.aborted) setCatalog(previous => ({ ...previous, [group]: { items: [], error: true } }));
    });
    return () => controller.abort();
  }, [open, mode, revision, sessionId]);
  useEffect(() => {
    if (!open || mode !== "context") return;
    const controller = new AbortController();
    setFiles(LOADING);
    // Debounce typed paths; query filtering within a directory is entirely local.
    const timer = window.setTimeout(() => {
      void loadComposerCatalog("files", path, controller.signal).then(result => {
        if (!controller.signal.aborted) setFiles(result);
      }).catch(() => { if (!controller.signal.aborted) setFiles({ items: [], error: true }); });
    }, 100);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, mode, path, revision, sessionId]);

  const groups = useMemo(() => GROUPS.filter(group => mode === "context" || group === "skills" || group === "agents").map(group => {
    const data = group === "files" ? files : catalog[group] ?? LOADING;
    const filtered = filterComposerOptions(data.items.filter(item => item.kind !== "session" || item.id !== sessionId), group === "files" ? fileQuery.query : query);
    const limit = query ? 16 : group === "files" ? 8 : 5;
    return { group, ...data, items: filtered.slice(0, limit), truncated: data.truncated || filtered.length > limit };
  }), [catalog, files, mode, query, fileQuery.query, sessionId]);
  const items = useMemo(() => groups.flatMap(group => group.items), [groups]);
  const best = filterComposerOptions(items, query)[0]?.key;
  const selectedIndex = Math.max(0, items.findIndex(item => item.key === (selectedKey ?? best)));
  const selected = items[selectedIndex];
  useEffect(() => {
    if (open && selected) document.getElementById(`${id}-option-${selectedIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [id, open, selected, selectedIndex]);

  function syncSelection(node: HTMLTextAreaElement) {
    setSelection({ start: node.selectionStart, end: node.selectionEnd });
  }
  function focusAt(cursor: number) {
    setSelection({ start: cursor, end: cursor });
    setFocused(true);
    requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.setSelectionRange(cursor, cursor); });
  }
  function dismiss() { setDismissed(signature); }
  function apply(option: ComposerOption) {
    const node = inputRef.current;
    const current = node && composerTrigger(value, node.selectionStart, node.selectionEnd);
    if (!current || disabled) return;
    if (option.kind !== "folder" && !onReference(option)) return;
    const replacement = option.kind === "folder" ? "@" : current.mode === "command"
      ? t(option.kind === "agent" ? "useAgent" : "useSkill", { name: option.id }) : "";
    const next = replaceComposerTrigger(value, current, replacement, option.id);
    if (option.kind === "folder") { setBrowsedPath(option.id); setDismissed(""); }
    else dismiss();
    onChange(next.text);
    focusAt(next.cursor);
  }
  function openTrigger(mark: "@" | "\\") {
    if (disabled) return;
    const node = inputRef.current;
    const start = node?.selectionStart ?? value.length, end = node?.selectionEnd ?? start;
    const prefix = start > 0 && !/\s/.test(value[start - 1]) ? " " : "";
    const next = value.slice(0, start) + prefix + mark + value.slice(end);
    setDismissed(""); setBrowsedPath("."); onChange(next); focusAt(start + prefix.length + 1);
  }
  function back() {
    if (!trigger) return;
    setBrowsedPath(path.split("/").slice(0, -1).join("/") || ".");
    const next = replaceComposerTrigger(value, trigger, "@");
    onChange(next.text); focusAt(next.cursor);
  }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return true;
    if (!open || event.altKey || event.metaKey || event.ctrlKey) return false;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); return true; }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && items.length) {
      event.preventDefault();
      const index = (selectedIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      setSelectedKey(items[index].key); return true;
    }
    if (!event.shiftKey && (event.key === "Enter" || (event.key === "Tab" && selected))) {
      // Empty/loading panels also consume Enter, never send an unfinished trigger.
      event.preventDefault(); if (selected) apply(selected); return true;
    }
    if (event.key === "Tab") dismiss();
    return false;
  }
  return { id, panelRef, inputRef, open, mode, query, path, groups, items, selectedIndex,
    selected, apply, dismiss, openTrigger, back, retry: () => setRevision(value => value + 1),
    inputProps: {
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => { syncSelection(event.currentTarget); onChange(event.currentTarget.value); },
      onSelect: (event: React.SyntheticEvent<HTMLTextAreaElement>) => syncSelection(event.currentTarget),
      onFocus: (event: React.FocusEvent<HTMLTextAreaElement>) => { setFocused(true); syncSelection(event.currentTarget); },
      onBlur: (event: React.FocusEvent<HTMLTextAreaElement>) => {
        if (!panelRef.current?.contains(event.relatedTarget as Node | null)) setFocused(false);
      },
      onCompositionStart: () => { composing.current = true; setCompositionActive(true); },
      onCompositionEnd: (event: React.CompositionEvent<HTMLTextAreaElement>) => {
        composing.current = false; setCompositionActive(false); syncSelection(event.currentTarget);
      },
      "aria-expanded": open, "aria-autocomplete": "list" as const,
      "aria-controls": open ? `${id}-list` : undefined,
      "aria-activedescendant": open && selected ? `${id}-option-${selectedIndex}` : undefined,
    }, onKeyDown };
}

type Controller = ReturnType<typeof useComposerSuggestions>;
export function ComposerSuggestions({ controller: c, children }: { controller: Controller; children: ReactNode }) {
  const t = useTranslations("composer");
  const loading = c.groups.some(group => group.loading);
  const failed = c.groups.filter(group => group.error);
  return <Popover.Root open={c.open} onOpenChange={open => { if (!open) c.dismiss(); }}>
    <Popover.Anchor asChild>{children}</Popover.Anchor>
    <Popover.Portal><Popover.Content ref={c.panelRef} data-composer-panel data-testid="composer-suggestions"
      side="top" align="start" sideOffset={8} collisionPadding={8}
      onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}
      onInteractOutside={event => { if (event.target === c.inputRef.current) event.preventDefault(); }}
      onEscapeKeyDown={event => { event.preventDefault(); c.dismiss(); c.inputRef.current?.focus(); }}
      aria-label={t(c.mode === "command" ? "commands" : "addContext")}
      className="z-[1250] flex w-[var(--radix-popover-trigger-width)] max-w-[min(680px,calc(100vw-16px))] flex-col overflow-hidden rounded-xl border border-[color:var(--line-hi)] bg-[color:var(--overlay-surface)] text-[color:var(--text-base)]"
      style={{ maxHeight: "min(440px, var(--radix-popover-content-available-height))" }}>
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <SearchIcon size={16} /><span className="min-w-0 flex-1 truncate text-sm font-medium">{t(c.mode === "command" ? "commands" : "addContext")}</span>
        <button type="button" className="ui-icon-button" aria-label={t("close")} onClick={c.dismiss}><XIcon size={15} /></button>
      </div>
      {!c.query ? <p className="shrink-0 px-3 pb-2 text-xs leading-5 text-[color:var(--text-muted)]">{t(c.mode === "command" ? "commandHint" : "contextHint")}</p> : null}
      {c.mode === "context" && c.path !== "." ? <button type="button" className="flex min-h-9 shrink-0 items-center gap-2 border-t border-[color:var(--line)] px-3 text-left text-xs"
        onMouseDown={event => event.preventDefault()} onClick={c.back} aria-label={t("back")}><ChevronLeftIcon size={14} /><span className="truncate">{c.path}</span></button> : null}
      <div id={`${c.id}-list`} role="listbox" aria-label={t(c.mode === "command" ? "commands" : "addContext")}
        aria-busy={loading} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-1">
        {c.groups.map(group => group.items.length ? <div key={group.group} role="group" aria-label={t(group.group)}>
          <div className="px-2 pb-1 pt-2 text-xs font-medium text-[color:var(--text-muted)]">{t(group.group)}</div>
          {group.items.map(item => {
            const index = c.items.findIndex(candidate => candidate.key === item.key);
            return <button key={item.key} id={`${c.id}-option-${index}`} type="button" role="option" tabIndex={-1}
              aria-selected={index === c.selectedIndex} data-reference-kind={item.kind} data-reference-id={item.id}
              onMouseDown={event => event.preventDefault()} onClick={() => c.apply(item)}
              className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-2 text-left ${index === c.selectedIndex ? "bg-brand-500/15" : "hover:bg-brand-500/5"}`}>
              <ComposerSourceIcon kind={item.kind} />
              <span className="min-w-0 flex-1"><span className="block truncate text-sm">{item.label}</span>
                {item.detail ? <span className="block truncate text-xs text-[color:var(--text-muted)]" title={item.detail}>{item.detail}</span> : null}</span>
              {item.kind === "folder" ? <ChevronRightIcon size={14} /> : null}
            </button>;
          })}
        </div> : null)}
        {!c.items.length && !loading ? <p role="status" className="px-3 py-5 text-sm text-[color:var(--text-muted)]">{t("empty")}</p> : null}
        {loading ? <p role="status" className="px-3 py-2 text-xs text-[color:var(--text-muted)]">{t("loading")}</p> : null}
        {failed.length ? <div role="status" className="flex items-center gap-2 px-3 py-2 text-xs"><span className="min-w-0 flex-1">{t("failed")} {failed.map(group => t(group.group)).join(" · ")}</span>
          <button type="button" className="btn btn-ghost shrink-0" onClick={c.retry}>{t("retry")}</button></div> : null}
        {c.groups.some(group => group.truncated) ? <p className="px-3 py-2 text-xs text-[color:var(--text-muted)]">{t("more")}</p> : null}
      </div>
      <div className="shrink-0 border-t border-[color:var(--line)] px-3 py-2 text-[11px] text-[color:var(--text-muted)] max-sm:hidden">{t("keys")}</div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}

export function ComposerAddMenu({ disabled, uploadDisabled, settings, onSettingsChange, onFiles, onTrigger, onOpen, inputRef }: {
  disabled: boolean; uploadDisabled: boolean; onFiles: (imagesOnly: boolean) => void;
  settings: ChatRunSettings; onSettingsChange: (settings: ChatRunSettings) => void;
  onTrigger: (mark: "@" | "\\") => void; onOpen: () => void; inputRef: RefObject<HTMLTextAreaElement>;
}) {
  const t = useTranslations("composer");
  const mode = settings.work_mode || "execute";
  const modeLabel = (value: WorkMode) => t(value === "plan" ? "modePlan" : value === "goal" ? "modeGoal" : "modeExecute");
  return <Menu.Root onOpenChange={open => { if (open) onOpen(); }}>
    <Menu.Trigger asChild><button type="button" className="ui-icon-button gap-1 px-1.5 disabled:cursor-not-allowed disabled:opacity-40"
      disabled={disabled} aria-label={`${t("addContent")} · ${modeLabel(mode)}`} data-testid="composer-add" data-work-mode={mode}><PlusIcon size={19} />
      {mode !== "execute" && <span data-composer-work-mode className="text-xs">{modeLabel(mode)}</span>}</button></Menu.Trigger>
    <Menu.Portal><Menu.Content side="top" align="start" sideOffset={8} collisionPadding={8}
      aria-label={t("addContent")} className="ui-select-menu w-64 max-w-[calc(100vw-16px)]"
      style={{ maxHeight: "min(440px, var(--radix-dropdown-menu-content-available-height))" }}
      onCloseAutoFocus={event => { event.preventDefault(); inputRef.current?.focus(); }}>
      <Menu.Item disabled={uploadDisabled} className="ui-select-option" onSelect={() => onFiles(false)}><FileIcon size={17} /><span>{t("uploadFiles")}</span></Menu.Item>
      <Menu.Item disabled={uploadDisabled} className="ui-select-option" onSelect={() => onFiles(true)}><ImageIcon size={17} /><span>{t("uploadImages")}</span></Menu.Item>
      <Menu.Separator className="my-1 h-px bg-[color:var(--line)]" />
      <Menu.Item disabled={uploadDisabled} className="ui-select-option" onSelect={() => onTrigger("@")}><FolderIcon size={17} /><span className="flex-1">{t("addContext")}</span><kbd className="text-xs">@</kbd></Menu.Item>
      <Menu.Item disabled={uploadDisabled} className="ui-select-option" onSelect={() => onTrigger("\\")}><CommandIcon size={17} /><span className="flex-1">{t("commands")}</span><kbd className="text-xs">{"\\"}</kbd></Menu.Item>
      <Menu.Separator className="my-1 h-px bg-[color:var(--line)]" />
      <Menu.Label className="px-3 py-1 text-xs text-[color:var(--text-muted)]">{t("workMode")}</Menu.Label>
      <Menu.RadioGroup value={mode} onValueChange={value => onSettingsChange({ ...settings, work_mode: value as WorkMode })}>
        {(["execute", "plan", "goal"] as const).map(value => <Menu.RadioItem key={value} value={value} className="ui-select-option">
          <span className="flex-1">{modeLabel(value)}</span>
          <Menu.ItemIndicator><CheckIcon size={14} /></Menu.ItemIndicator>
        </Menu.RadioItem>)}
      </Menu.RadioGroup>
      <p className="px-3 py-2 text-xs text-[color:var(--text-muted)]">{t("modeHelp")}</p>
    </Menu.Content></Menu.Portal>
  </Menu.Root>;
}
