"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useLocale } from "next-intl";
import * as Dialog from "@radix-ui/react-dialog";
import { callApi } from "../../lib/clientApi";
import type { ChatAttachment } from "../../lib/chat";
import { XIcon } from "../icons";

type Reference = Pick<ChatAttachment, "name" | "artifact_uri" | "reference" | "text">;
export function ReferenceSnapshot({ attachment, children, className = "" }: {
  attachment: Reference; children?: ReactNode; className?: string;
}) {
  const zh = useLocale().startsWith("zh");
  const [open, setOpen] = useState(false), [retry, setRetry] = useState(0);
  const [data, setData] = useState<{ content: string; truncated?: boolean; artifact_sha256?: string | null } | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let disposed = false;
    const timer = setTimeout(() => controller.abort(), 12000);
    setData(null); setError(false); setLoading(true);
    if (!attachment.artifact_uri) {
      setData(attachment.text ? { content: attachment.text } : null);
      setError(!attachment.text); setLoading(false); clearTimeout(timer);
      return () => controller.abort();
    }
    void callApi<{ ok: boolean; content: string; truncated?: boolean; artifact_sha256?: string | null }>(
      `/agent/commands/reference?uri=${encodeURIComponent(attachment.artifact_uri)}`, { signal: controller.signal },
    ).then(result => { if (controller.signal.aborted) return; if (!result.ok) throw new Error("preview_unavailable"); setData(result); })
      .catch(() => { if (!disposed) setError(true); })
      .finally(() => { clearTimeout(timer); if (!disposed) setLoading(false); });
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, [open, attachment.artifact_uri, attachment.text, retry]);
  let content = data?.content || "";
  let captured = attachment.reference?.captured_at || "";
  try { const parsed = JSON.parse(content); if (typeof parsed.content === "string") { content = parsed.content; captured = parsed.reference?.captured_at || captured; } } catch { /* Ordinary text reference. */ }
  const title = attachment.reference?.label || attachment.name;
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild><button type="button" className={className} title={zh ? "查看发送时的引用快照" : "Inspect the reference snapshot"} data-testid="reference-snapshot-trigger">{children || title}</button></Dialog.Trigger>
    <Dialog.Portal><Dialog.Overlay className="ui-modal-overlay" /><Dialog.Content className="ui-dialog" style={{ width:"min(760px,calc(100vw - 24px))", maxHeight:"calc(100dvh - 32px)", display:"flex", flexDirection:"column" }}>
      <div className="flex shrink-0 items-start justify-between gap-3"><Dialog.Title className="min-w-0 break-words text-base font-semibold">{title}</Dialog.Title>
        <Dialog.Close asChild><button type="button" className="ui-icon-button" aria-label={zh ? "关闭快照" : "Close snapshot"}><XIcon size={16} /></button></Dialog.Close></div>
      <Dialog.Description className="mt-2 shrink-0 text-xs leading-5 text-[color:var(--text-muted)]">
        {zh ? "这是发送时保存的参考内容，不是自动更新的源文件，也不代表已执行其中的 Skill 或获得额外权限。" : "This is the saved reference, not a live source. It does not imply that a skill was invoked or that additional permissions were granted."}
      </Dialog.Description>
      <dl className="my-3 shrink-0 text-xs text-[color:var(--text-muted)]">
        {attachment.reference?.id && <div className="flex gap-2"><dt>{zh ? "来源" : "Source"}</dt><dd className="min-w-0 break-all font-mono">{attachment.reference.id}</dd></div>}
        {captured && <div className="flex gap-2"><dt>{zh ? "快照时间" : "Captured"}</dt><dd>{Number.isFinite(Date.parse(captured)) ? new Date(captured).toLocaleString(zh ? "zh-CN" : "en-US") : captured}</dd></div>}
        {data?.artifact_sha256 && <div className="flex gap-2"><dt>{zh ? "快照校验" : "Snapshot checksum"}</dt><dd className="min-w-0 break-all font-mono">{data.artifact_sha256}</dd></div>}
      </dl>
      {loading ? <p role="status">{zh ? "正在读取快照…" : "Loading snapshot…"}</p> : error ? <div role="alert" className="text-sm"><p>{zh ? "快照暂时无法读取，未用最新源文件替代历史内容。" : "The snapshot is unavailable. It has not been replaced with the latest source."}</p><button type="button" className="btn btn-ghost mt-3" onClick={() => setRetry(value => value+1)}>{zh ? "重新读取快照" : "Retry snapshot"}</button></div> :
        <pre className="min-h-0 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-[color:var(--bg)] p-3 text-xs leading-6" data-testid="reference-snapshot-content">{content}</pre>}
      {(data?.truncated || attachment.reference?.truncated) && <p className="mt-2 text-xs text-[color:var(--text-muted)]">{zh ? "此引用或预览有截断；完整来源未被自动加入本轮。" : "This reference or preview is truncated. The complete source was not added automatically."}</p>}
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
