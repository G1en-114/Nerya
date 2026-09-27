"use client";
import { copy as i18nCopy } from "../../lib/i18n";

import { useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { clientApi } from "../../lib/clientApi";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";

import {
  liveEventsToBlocks,
  type ChatAttachment,
  type ChatMessage,
  type ChatThread,
  type NativeBlock,
  type NativeBlockEnvelope,
} from "../../lib/chat";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FileIcon,
  GlobeIcon,
  SearchIcon,
} from "../icons";
import { JsonView as StructuredJsonView } from "../JsonView";
import { AgentChartPanel } from "./AgentChartPanel";
import { Markdown } from "./Markdown";
import { CopyButton } from "./tool-cards/atoms";
import {
  parseWebToolResult,
  webSearchResultsFromResult,
  type WebSearchResult,
} from "./tool-cards/WebCard";

type ResourceKind =
  | "file"
  | "html"
  | "web"
  | "image"
  | "text"
  | "charts"
  | "diff"
  | "pdf";

export type WorkspaceResourceItem = {
  id: string;
  kind: ResourceKind;
  title: string;
  subtitle?: string;
  body?: string;
  html?: string;
  imageSrc?: string;
  url?: string;
  path?: string;
  dataUrl?: string;
  mimeType?: string;
  language?: string;
  data?: unknown;
  thread?: ChatThread | null;
  workspaceLoaded?: boolean;
  operation?: string;
  seenAt: number;
};

type ToolLike = {
  action?: unknown;
  payload?: unknown;
  result?: unknown;
  ok?: unknown;
  error?: unknown;
  error_kind?: unknown;
  elapsed_ms?: unknown;
};

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseJsonRecord(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith("{")) return {};
  try {
    return recordOf(JSON.parse(trimmed));
  } catch {
    return {};
  }
}

function resultRecordFrom(value: unknown): Record<string, unknown> {
  const direct = recordOf(value);
  if (Object.keys(direct).length > 0) return direct;
  if (typeof value !== "string") return {};
  const parsed = parseJsonRecord(value);
  if (Object.keys(parsed).length > 0) return parsed;
  const stdout = value.match(/---- stdout ----\s*([\s\S]*?)(?:\r?\n---- stderr ----|$)/);
  return stdout?.[1] ? parseJsonRecord(stdout[1]) : {};
}

function decodeDataText(dataUrl: string): string {
  const idx = dataUrl.indexOf(",");
  if (idx < 0) return "";
  const meta = dataUrl.slice(0, idx).toLowerCase();
  const body = dataUrl.slice(idx + 1);
  try {
    if (meta.includes(";base64")) return atob(body);
    return decodeURIComponent(body);
  } catch {
    return "";
  }
}

function looksLikeHtml(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^<!doctype\s+html/i.test(trimmed)) return true;
  if (/^<html[\s>]/i.test(trimmed)) return true;
  if (/^<body[\s>]/i.test(trimmed)) return true;
  if (/^<(script|style|iframe|canvas)[\s>]/i.test(trimmed)) return true;
  const tag = trimmed.match(/^<([a-z][\w:-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>\s*$/i);
  return Boolean(tag);
}

function looksLikeSvg(value: string): boolean {
  return /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(value);
}

function looksLikeUnifiedDiff(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^diff --git /m.test(trimmed)) return true;
  if (/^@@ -\d+(?:,\d+)? \+\d+/m.test(trimmed)) return true;
  if (/^--- [^\n]*\n\+\+\+ /m.test(trimmed)) return true;
  if (/^\*\*\* [^\n]*\n--- /m.test(trimmed)) return true;
  return false;
}

function diffFromResult(result: Record<string, unknown>): string {
  const content = result.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const r = recordOf(part);
      if (String(r.type || r.kind || "") === "diff" && typeof r.text === "string") {
        return r.text;
      }
    }
  }
  return stringValue(result.diff || result.patch || result.unified_diff);
}

// Native file tools flatten their ``ToolResult`` parts into a single string
// (``ToolResult.text()``) before it reaches the dashboard, so the
// human-readable body gets a trailing one-line JSON metadata blob
// (``{"path": ..., "content_hash": ...}``) appended. Strip it so the canvas
// shows just the file/diff content.
function stripToolMetaJson(text: string): string {
  if (!text) return "";
  return text.replace(/\n*\{[^\n]*"content_hash"[^\n]*\}\s*$/, "").replace(/\s+$/, "");
}

function extractToolMetaJson(text: string): Record<string, unknown> {
  const match = text.match(/\n(\{[^\n]*"content_hash"[^\n]*\})\s*$/);
  if (!match) return {};
  try {
    return recordOf(JSON.parse(match[1]));
  } catch {
    return {};
  }
}

// ``read_file`` prefixes the content with a ``# <path> (N lines, B bytes)``
// markdown header; drop it since the canvas already shows the path.
function cleanReadFileBody(text: string): string {
  return stripToolMetaJson(text).replace(
    /^#\s.+\(\d+\s+lines?,\s*\d+\s+bytes?\)\n\n/,
    "",
  );
}

type DiffHunk = {
  header: string;
  newStart: number;
  // Raw prefixed lines (`+`/`-`/` `) for display, excluding the @@ header.
  lines: string[];
  // Reconstructed file content for the hunk region, by side.
  newLines: string[];
  oldLines: string[];
};

// Resolve the workspace-relative path a unified diff applies to. Our diffs are
// produced via ``difflib.unified_diff`` with ``a/<path>`` / ``b/<path>`` labels.
function diffTargetPath(diff: string): string {
  const clean = (s: string) =>
    s
      .replace(/\t.*$/, "")
      .replace(/^[ab]\//, "")
      .trim();
  const plus = diff.match(/^\+\+\+ (.+)$/m);
  if (plus && plus[1].trim() !== "/dev/null") return clean(plus[1]);
  const minus = diff.match(/^--- (.+)$/m);
  if (minus && minus[1].trim() !== "/dev/null") return clean(minus[1]);
  return "";
}

// A `--- /dev/null` source means the diff creates a brand-new file, so the only
// meaningful "revert" is to delete it again.
function diffCreatesFile(diff: string): boolean {
  return /^--- \/dev\/null\s*$/m.test(diff);
}

function parseDiffHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  for (const line of diff.split("\n")) {
    const head = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (head) {
      if (cur) hunks.push(cur);
      cur = {
        header: line,
        newStart: parseInt(head[1], 10),
        lines: [],
        newLines: [],
        oldLines: [],
      };
      continue;
    }
    if (!cur) continue;
    const tag = line[0];
    const text = line.slice(1);
    if (tag === "+") {
      cur.lines.push(line);
      cur.newLines.push(text);
    } else if (tag === "-") {
      cur.lines.push(line);
      cur.oldLines.push(text);
    } else if (tag === " ") {
      cur.lines.push(line);
      cur.newLines.push(text);
      cur.oldLines.push(text);
    }
    // Ignore "\ No newline at end of file" and any stray non-diff lines.
  }
  if (cur) hunks.push(cur);
  return hunks;
}

// Reverse-apply the selected hunks to the CURRENT file content, turning their
// "new" side back into the "old" side. ``alreadyReverted`` lists hunks reverted
// in earlier clicks (already on disk); their line-count delta shifts the
// positions of any hunk below them, so we fold that into each target's start.
// Targets are then applied bottom-to-top so they don't shift one another. Any
// hunk whose region no longer matches the file (changed since) is left as-is.
function revertSelectedHunks(
  content: string,
  allHunks: DiffHunk[],
  selected: Set<number>,
  alreadyReverted: Set<number>,
): { content: string; reverted: number; stale: number } {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const ordered = [...allHunks].sort((a, b) => a.newStart - b.newStart);
  const offsetAtStart = new Map<number, number>();
  let delta = 0;
  for (const h of ordered) {
    offsetAtStart.set(h.newStart, delta);
    if (alreadyReverted.has(h.newStart)) {
      delta += h.oldLines.length - h.newLines.length;
    }
  }
  let reverted = 0;
  let stale = 0;
  const targets = ordered
    .filter((h) => selected.has(h.newStart))
    .sort((a, b) => b.newStart - a.newStart);
  for (const h of targets) {
    const start = h.newStart - 1 + (offsetAtStart.get(h.newStart) ?? 0);
    const len = h.newLines.length;
    if (start < 0 || start + len > lines.length) {
      stale += 1;
      continue;
    }
    if (lines.slice(start, start + len).join("\n") !== h.newLines.join("\n")) {
      stale += 1;
      continue;
    }
    lines.splice(start, len, ...h.oldLines);
    reverted += 1;
  }
  return { content: lines.join(eol), reverted, stale };
}

function withBaseUrl(html: string, url?: string): string {
  if (!url || /<base\s/i.test(html)) return html;
  const base = `<base href="${url.replace(/"/g, "&quot;")}">`;
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${base}`);
  }
  return `${base}${html}`;
}

const HTML_PREVIEW_BOOTSTRAP = `<script>
(() => {
  const installStorage = (name) => {
    try {
      const storage = window[name];
      if (storage) return;
    } catch (_) {}
    const data = new Map();
    const shim = {
      get length() { return data.size; },
      clear() { data.clear(); },
      getItem(key) { key = String(key); return data.has(key) ? data.get(key) : null; },
      key(index) { return Array.from(data.keys())[Number(index)] ?? null; },
      removeItem(key) { data.delete(String(key)); },
      setItem(key, value) { data.set(String(key), String(value)); },
    };
    try { Object.defineProperty(window, name, { value: shim, configurable: true }); } catch (_) {}
  };
  installStorage("localStorage");
  installStorage("sessionStorage");
})();
</script>`;

function withHtmlPreviewBootstrap(html: string): string {
  if (html.includes("data-nerya-html-preview")) return html;
  const boot = HTML_PREVIEW_BOOTSTRAP.replace(
    "<script>",
    '<script data-nerya-html-preview="1">',
  );
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${boot}`);
  }
  if (/<html[\s>]/i.test(html)) {
    return html.replace(/<html([^>]*)>/i, `<html$1><head>${boot}</head>`);
  }
  return `${boot}${html}`;
}

function filenameFromPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || path || "file";
}

function languageForPath(path: string): string {
  const ext = filenameFromPath(path).split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    c: "c",
    cc: "cpp",
    cpp: "cpp",
    cs: "csharp",
    csv: "csv",
    dart: "dart",
    diff: "diff",
    dockerfile: "dockerfile",
    go: "go",
    h: "cpp",
    hpp: "cpp",
    js: "javascript",
    jsx: "jsx",
    kt: "kotlin",
    less: "less",
    lua: "lua",
    ts: "typescript",
    tsx: "tsx",
    py: "python",
    json: "json",
    jsonl: "json",
    yml: "yaml",
    yaml: "yaml",
    md: "markdown",
    mdx: "markdown",
    html: "html",
    htm: "html",
    css: "css",
    java: "java",
    php: "php",
    rb: "ruby",
    rs: "rust",
    scss: "scss",
    sh: "shell",
    sql: "sql",
    swift: "swift",
    toml: "toml",
    tsv: "tsv",
    txt: "text",
    vue: "vue",
    xml: "xml",
    ps1: "powershell",
  };
  return map[ext] || ext || "text";
}

function extensionForPath(path: string): string {
  const base = filenameFromPath(path).toLowerCase();
  if (base === "dockerfile" || base.endsWith(".dockerfile")) return "dockerfile";
  return base.split(".").pop() || "";
}

function rawWorkspaceFileUrl(path: string): string {
  const clean = path.replace(/^\/+/, "").replace(/\\/g, "/");
  const encoded = clean.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `/api/proxy/workspace/file/raw/${encoded}`;
}

function rawWorkspaceDirUrl(path: string): string {
  const clean = path.replace(/^\/+/, "").replace(/\\/g, "/");
  const parts = clean.split("/").filter(Boolean);
  parts.pop();
  const encoded = parts.map(encodeURIComponent).join("/");
  return `/api/proxy/workspace/file/raw/${encoded}${encoded ? "/" : ""}`;
}

function isUrlLike(value?: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(String(value || ""));
}

function pathFromItem(item: WorkspaceResourceItem): string {
  const direct = String(item.path || "").trim();
  if (direct) return direct;
  const sub = String(item.subtitle || "").trim();
  if (!sub || isUrlLike(sub) || sub.includes("\n")) return "";
  if (!/[/.]/.test(sub)) return "";
  return sub;
}

function isImagePath(path: string, mime = ""): boolean {
  const ext = extensionForPath(path);
  return mime.startsWith("image/") || /^(png|jpe?g|gif|webp|avif|bmp|ico)$/.test(ext);
}

function isPdfPath(path: string, mime = ""): boolean {
  return mime.includes("pdf") || extensionForPath(path) === "pdf";
}

function isAudioPath(path: string, mime = ""): boolean {
  return mime.startsWith("audio/") || /^(mp3|wav|ogg|m4a|aac|flac)$/.test(extensionForPath(path));
}

function isVideoPath(path: string, mime = ""): boolean {
  return mime.startsWith("video/") || /^(mp4|webm|mov|m4v|ogv)$/.test(extensionForPath(path));
}

function canUseRawPreview(path: string, mime = ""): boolean {
  return (
    isImagePath(path, mime) ||
    isPdfPath(path, mime) ||
    isAudioPath(path, mime) ||
    isVideoPath(path, mime)
  );
}

function unwrapBlock(env: NativeBlockEnvelope): NativeBlock {
  const block = env.block;
  if (block && typeof block === "object" && Object.keys(block).length > 0) {
    return block as NativeBlock;
  }
  return env as unknown as NativeBlock;
}

function bodyFromResult(result: Record<string, unknown>): string {
  const content = result.content;
  if (Array.isArray(content)) {
    const textParts = content
      .map((part) => stringValue(recordOf(part).text))
      .filter(Boolean);
    if (textParts.length) return textParts.join("\n");
  }
  return (
    stringValue(result.text) ||
    stringValue(result.body) ||
    stringValue(result.content) ||
    stringValue(result.markdown) ||
    stringValue(result.diff) ||
    ""
  );
}

function browserScriptPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const scriptName = String(
    payload.name || payload.script || payload.file || payload.path || "",
  )
    .replace(/\\/g, "/")
    .toLowerCase();
  const skillId = String(payload.skill_id || payload.skill || "").toLowerCase();
  const isBrowserScript =
    scriptName.endsWith("browser_session.py") ||
    (skillId === "browser" && scriptName.includes("browser_session"));
  if (!isBrowserScript) return {};

  const args = Array.isArray(payload.args) ? payload.args : [payload.args];
  for (const arg of args) {
    if (typeof arg !== "string") continue;
    const parsed = parseJsonRecord(arg);
    if (Object.keys(parsed).length > 0) return parsed;
  }
  return {};
}

function pathFromResultParts(result: Record<string, unknown>): string {
  const metadata = recordOf(result.metadata);
  const direct = stringValue(metadata.path || metadata.file || metadata.filename);
  if (direct) return direct;
  const content = result.content;
  if (!Array.isArray(content)) return "";
  for (const part of content) {
    const r = recordOf(part);
    const partMeta = recordOf(r.metadata);
    const metaPath = stringValue(partMeta.path || partMeta.file || partMeta.filename);
    if (metaPath) return metaPath;
    const data = recordOf(r.data);
    const dataPath = stringValue(data.path || data.file || data.filename);
    if (dataPath) return dataPath;
  }
  return "";
}

function pathFromTool(payload: Record<string, unknown>, result: Record<string, unknown>): string {
  return String(
    payload.path ||
      payload.file ||
      payload.filename ||
      result.path ||
      result.file ||
      result.filename ||
      pathFromResultParts(result) ||
      "",
  );
}

function itemFromAttachment(
  attachment: ChatAttachment,
  message: ChatMessage,
  index: number,
): WorkspaceResourceItem | null {
  const mime = attachment.mime_type || "";
  const name = attachment.name || "attachment";
  const base = {
    id: `attachment:${message.id}:${attachment.id || index}`,
    title: name,
    subtitle: mime || undefined,
    mimeType: mime,
    seenAt: message.ts,
  };
  if (attachment.data_url?.startsWith("data:image/")) {
    return { ...base, kind: "image", imageSrc: attachment.data_url };
  }
  if (mime.startsWith("image/") && attachment.url) {
    return { ...base, kind: "image", imageSrc: attachment.url, url: attachment.url };
  }
  if (mime.includes("pdf") || /\.pdf$/i.test(name)) {
    const src = attachment.data_url || attachment.url || "";
    if (src) return { ...base, kind: "pdf", dataUrl: src, url: attachment.url };
  }
  const text = attachment.text || decodeDataText(attachment.data_url || "");
  if (!text) return null;
  if (
    !looksLikeSvg(text) &&
    (mime.includes("html") || /\.html?$/i.test(name) || looksLikeHtml(text))
  ) {
    return { ...base, kind: "html", html: text, language: "html" };
  }
  if (looksLikeUnifiedDiff(text)) {
    return { ...base, kind: "diff", body: text, language: "diff" };
  }
  return {
    ...base,
    kind: "file",
    body: text,
    language: languageForPath(name),
  };
}

function itemFromToolLike(
  value: ToolLike,
  idPrefix: string,
  seenAt: number,
): WorkspaceResourceItem | null {
  const action = String(value.action || "").toLowerCase();
  const payload = recordOf(value.payload);
  const result = resultRecordFrom(value.result);
  // The native agent loop flattens ``ToolResult`` to a plain string before it
  // reaches the dashboard, so ``value.result`` is usually a string (file
  // content / diff / fetched markdown), not a structured record.
  const resultText = typeof value.result === "string" ? value.result : "";
  // Committed ``tool_result`` blocks carry no payload, but the flattened file
  // result ends with a metadata JSON blob ({"path": ..., "content_hash": ...});
  // recover the path from there so titles/syntax stay correct.
  const meta = extractToolMetaJson(resultText);
  const error = stringValue(value.error || result.error || result.detail);
  const path = pathFromTool(payload, result) || stringValue(meta.path);
  const url = String(payload.url || result.url || result.link || result.href || "");
  const title = String(result.title || payload.title || path || url || action || "artifact");
  const html = stringValue(result.html || result.rendered_html || payload.html);
  const payloadFileBody = stringValue(
    payload.content || payload.contents || payload.body || payload.text,
  );
  const body = bodyFromResult(result) || resultText || payloadFileBody || error;
  const imageSrc = stringValue(result.data_uri || result.image_data_uri || payload.data_uri);
  const diff =
    diffFromResult(result) || (looksLikeUnifiedDiff(resultText) ? resultText : "");
  const failed = value.ok === false || Boolean(error);

  if (failed && !html && !imageSrc && !diff) {
    return null;
  }

  if (action === "web_search" || action === "web_search_fetch") {
    const results = webSearchResultsFromResult(value.result);
    if (results.length > 0) {
      const webResult = parseWebToolResult(value.result);
      const nestedSearch = recordOf(webResult.search);
      const query = String(payload.query || webResult.query || nestedSearch.query || "");
      const engine = String(
        webResult.engine ||
          webResult.provider ||
          nestedSearch.engine ||
          nestedSearch.provider ||
          "",
      );
      return {
        id: `${idPrefix}:web-search`,
        kind: "web",
        title: query || title || "Web search",
        subtitle: engine || results[0]?.url || undefined,
        body,
        url: results[0]?.url,
        data: { query, engine, results },
        seenAt,
      };
    }
  }

  if (imageSrc.startsWith("data:image/")) {
    return {
      id: `${idPrefix}:image`,
      kind: "image",
      title,
      subtitle: url || path || undefined,
      imageSrc,
      url,
      path: path || undefined,
      seenAt,
    };
  }

  if (html) {
    return {
      id: `${idPrefix}:html`,
      kind: action.includes("web") ? "web" : "html",
      title,
      subtitle: url || path || undefined,
      html,
      url,
      path: path || undefined,
      language: "html",
      seenAt,
    };
  }

  if (action.includes("web_fetch") || action.includes("web_search_fetch")) {
    if (!body) return null;
    return {
      id: `${idPrefix}:web`,
      kind: "web",
      title: title || url,
      subtitle: url || undefined,
      body,
      url,
      path: path || undefined,
      seenAt,
    };
  }

  if (
    action === "read_file" ||
    action === "write_file" ||
    action === "edit_file" ||
    action === "create_file"
  ) {
    const diffBody = stripToolMetaJson(
      diff || (body && looksLikeUnifiedDiff(body) ? body : ""),
    );
    const fileBody = action === "read_file" ? cleanReadFileBody(body) : body;
    if (action === "read_file" && !fileBody) return null;
    const htmlBody =
      !diffBody &&
      fileBody &&
      !looksLikeSvg(fileBody) &&
      (looksLikeHtml(fileBody) || /\.html?$/i.test(path));
    if (htmlBody) {
      return {
        id: `${idPrefix}:html-file`,
        kind: "html",
        title: filenameFromPath(path),
        subtitle: path,
        html: fileBody,
        url: path ? rawWorkspaceDirUrl(path) : undefined,
        path: path || undefined,
        language: "html",
        seenAt,
      };
    }
    if (diffBody) {
      return {
        id: `${idPrefix}:diff`,
        kind: "diff",
        title: path ? filenameFromPath(path) : title,
        subtitle: path || action,
        body: diffBody,
        path: path || undefined,
        language: "diff",
        seenAt,
      };
    }
    if (!fileBody && !path) return null;
    return {
      id: `${idPrefix}:file`,
      kind: "file",
      title: filenameFromPath(path),
      subtitle: path || action,
      body: fileBody || String(result.message || result.status || ""),
      path: path || undefined,
      language: languageForPath(path),
      mimeType: stringValue(result.mime_type || payload.mime_type),
      seenAt,
    };
  }

  if (diff || (body && looksLikeUnifiedDiff(body))) {
    return {
      id: `${idPrefix}:diff`,
      kind: "diff",
      title: path ? filenameFromPath(path) : title,
      subtitle: url || path || action,
      body: stripToolMetaJson(diff || body),
      path: path || undefined,
      language: "diff",
      seenAt,
    };
  }

  if (body && looksLikeSvg(body)) {
    return {
      id: `${idPrefix}:svg`,
      kind: "file",
      title,
      subtitle: url || path || undefined,
      body,
      path: path || undefined,
      language: "svg",
      seenAt,
    };
  }

  if (body && looksLikeHtml(body)) {
    return {
      id: `${idPrefix}:html-body`,
      kind: "html",
      title,
      subtitle: url || path || undefined,
      html: body,
      url,
      path: path || undefined,
      language: "html",
      seenAt,
    };
  }

  return null;
}

export function collectThreadItems(thread: ChatThread | null): WorkspaceResourceItem[] {
  if (!thread) return [];
  const items: WorkspaceResourceItem[] = [];
  const seen = new Set<string>();
  const seenSig = new Set<string>();

  function add(item: WorkspaceResourceItem | null) {
    if (!item || seen.has(item.id)) return;
    // The same artifact can arrive via turn.blocks, tool_trace, actions, and
    // live_events; dedupe on a content signature so it shows up once.
    const sig = `${item.kind}|${item.title}|${item.subtitle || ""}|${(
      item.body ||
      item.html ||
      item.imageSrc ||
      item.url ||
      ""
    ).slice(0, 200)}`;
    if (seenSig.has(sig)) return;
    seen.add(item.id);
    seenSig.add(sig);
    items.push(item);
  }

  for (const message of thread.messages) {
    if (message.role === "user") continue;

    const messageKey = message.backend_message_id || message.id;
    const envelopes: NativeBlockEnvelope[] = [
      ...(message.turn?.blocks || []),
      ...liveEventsToBlocks(message.live_events || []),
    ];
    // A committed tool_result can omit the path/query that was present in
    // its tool_use. Join within this message only, never across turns.
    const requests = new Map<string, ToolLike>();
    for (const env of envelopes) {
      const block = unwrapBlock(env);
      const callId = String(block.call_id || block.tool_use_id || "");
      if (block.kind === "tool_use" && callId) requests.set(callId, block as ToolLike);
    }
    envelopes.forEach((env, index) => {
      const block = unwrapBlock(env);
      const callId = String(block.call_id || block.tool_use_id || "");
      const request = block.kind === "tool_result" && callId ? requests.get(callId) : undefined;
      const resolved = request ? { ...request, ...block, payload: block.payload || request.payload } : block;
      // An attempted write is not a completed file change. Only returned
      // tool evidence enters the resource collection.
      if (block.kind === "tool_use") return;
      const item = itemFromToolLike(resolved as ToolLike, `block:${messageKey}:${String(block.call_id || index)}`, message.ts);
      const returned = resultRecordFrom(resolved.result);
      const confirmed = resolved.ok === true && returned.ok !== false && returned.success !== false && !returned.error && !resolved.error;
      add(item ? { ...item, operation: confirmed ? String(resolved.action || "") : undefined } : null);
    });

    (message.turn?.tool_trace || []).forEach((tool, index) =>
      add(itemFromToolLike(tool, `tool:${messageKey}:${index}`, message.ts)),
    );
    (message.turn?.actions || []).forEach((action, index) =>
      add(itemFromToolLike(action as ToolLike, `action:${messageKey}:${index}`, message.ts)),
    );
    (message.turn?.attachments || []).forEach((attachment, index) =>
      add(itemFromAttachment(attachment, message, index)),
    );
  }

  return items.sort((a, b) => b.seenAt - a.seenAt);
}

function ResourceToolbar({ label, copyText }: { label: string; copyText?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-brand-500/10 px-3 py-2">
      <span className="truncate font-mono text-[11px] text-ink-400">{label}</span>
      {copyText ? <CopyButton text={copyText} /> : null}
    </div>
  );
}

const CODE_HIGHLIGHT_MAX = 400_000;

// rehype-highlight language ids differ slightly from our path-derived ones.
const HLJS_LANG_ALIAS: Record<string, string> = {
  jsx: "javascript",
  tsx: "typescript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  text: "",
  txt: "",
};

function hljsLang(language?: string): string {
  const lang = (language || "").toLowerCase();
  if (!lang) return "";
  return lang in HLJS_LANG_ALIAS ? HLJS_LANG_ALIAS[lang] : lang;
}

// Pick a fence longer than any backtick run in the body so code containing
// triple backticks can't break out of the fenced block.
function backtickFence(code: string): string {
  let longest = 0;
  for (const run of code.match(/`+/g) || []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

const codeMarkdownComponents: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => <code className={className}>{children}</code>,
};

function CodeHighlight({ code, language }: { code: string; language?: string }) {
  if (code.length > CODE_HIGHLIGHT_MAX) {
    return (
      <pre className="min-h-0 flex-1 overflow-auto p-4 text-[12px] leading-relaxed text-ink-100 whitespace-pre-wrap break-words">
        {code}
      </pre>
    );
  }
  const fence = backtickFence(code);
  const lang = hljsLang(language);
  const markdown = `${fence}${lang}\n${code}\n${fence}`;
  return (
    <pre className="nerya-code min-h-0 flex-1 overflow-auto whitespace-pre p-4 text-[12px] leading-relaxed text-ink-100">
      <ReactMarkdown
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={codeMarkdownComponents}
      >
        {markdown}
      </ReactMarkdown>
    </pre>
  );
}

function CodeView({ item }: { item: WorkspaceResourceItem }) {
  const body = item.body || "";
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-ink-950">
      <ResourceToolbar label={item.language || item.mimeType || "text"} copyText={body} />
      <CodeHighlight code={body} language={item.language} />
    </div>
  );
}

function diffLineClass(line: string): string {
  if (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("*** ")
  ) {
    return "text-brand-300";
  }
  if (line.startsWith("@@")) return "text-cyan-300 bg-cyan-400/[0.06]";
  if (line.startsWith("+")) return "text-emerald-300 bg-emerald-400/[0.05]";
  if (line.startsWith("-")) return "text-rose-300 bg-rose-400/[0.05]";
  return "text-ink-300";
}

function DiffView({ item }: { item: WorkspaceResourceItem }) {
  const t = useTranslations("chat");
  const diff = item.body || "";
  const path = useMemo(() => diffTargetPath(diff), [diff]);
  const isCreate = useMemo(() => diffCreatesFile(diff), [diff]);
  const hunks = useMemo(() => parseDiffHunks(diff), [diff]);
  const [busy, setBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [reverted, setReverted] = useState<Set<number>>(() => new Set<number>());
  const [status, setStatus] = useState<{
    tone: "ok" | "err" | "info";
    text: string;
  } | null>(null);

  if (!diff) return <EmptyResource title={item.title} />;

  // File creations come through as a `--- /dev/null` diff with no `@@` hunks,
  // so the only revert is to delete the file again.
  const canRevert = Boolean(path) && (hunks.length > 0 || isCreate);
  const allDone = isCreate
    ? deleted
    : hunks.length > 0 && hunks.every((h) => reverted.has(h.newStart));

  async function runRevert(selected: Set<number>, deleteFile: boolean) {
    if (!path) {
      setStatus({ tone: "err", text: t("canvasDiffRevertNoPath") });
      return;
    }
    setBusy(true);
    setStatus({ tone: "info", text: t("canvasDiffReverting") });
    try {
      if (deleteFile) {
        const res = await clientApi.workspaceFileDelete({ path });
        if (!res.ok) {
          setStatus({ tone: "err", text: res.error || res.detail || "delete failed" });
          return;
        }
        setDeleted(true);
        setReverted(new Set(hunks.map((h) => h.newStart)));
        setStatus({ tone: "ok", text: t("canvasDiffDeleted") });
        return;
      }
      const read = await clientApi.workspaceFileRead(path);
      if (!read.ok || typeof read.content !== "string") {
        setStatus({ tone: "err", text: read.error || read.detail || "read failed" });
        return;
      }
      const result = revertSelectedHunks(read.content, hunks, selected, reverted);
      if (result.reverted === 0) {
        setStatus({ tone: "err", text: t("canvasDiffRevertStale") });
        return;
      }
      const save = await clientApi.workspaceFileSave({ path, content: result.content });
      if (!save.ok) {
        setStatus({ tone: "err", text: save.error || save.detail || "save failed" });
        return;
      }
      setReverted((prev) => {
        const next = new Set(prev);
        for (const start of selected) next.add(start);
        return next;
      });
      setStatus(
        result.stale > 0
          ? {
              tone: "info",
              text: t("canvasDiffRevertPartial", {
                reverted: result.reverted,
                stale: result.stale,
              }),
            }
          : { tone: "ok", text: t("canvasDiffReverted") },
      );
    } catch (err) {
      setStatus({
        tone: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
      setConfirmAll(false);
    }
  }

  const statusColor =
    status?.tone === "ok"
      ? "text-emerald-300"
      : status?.tone === "err"
        ? "text-rose-300"
        : "text-ink-400";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-ink-950">
      <div className="flex items-center justify-between gap-2 border-b border-brand-500/10 px-3 py-2">
        <span className="truncate font-mono text-[11px] text-ink-400">
          {path || item.subtitle || "unified diff"}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {canRevert ? (
            <button
              type="button"
              disabled={busy || allDone}
              onClick={() => {
                if (allDone) return;
                if (!confirmAll) {
                  setConfirmAll(true);
                  return;
                }
                const pending = new Set(
                  hunks
                    .map((h) => h.newStart)
                    .filter((start) => !reverted.has(start)),
                );
                void runRevert(pending, isCreate);
              }}
              title={t("canvasDiffRevertHint")}
              className={`rounded-md border px-2 py-1 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                confirmAll
                  ? "border-rose-400/40 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25"
                  : "border-brand-500/20 bg-brand-500/10 text-brand-200 hover:bg-brand-500/20"
              }`}
            >
              {allDone
                ? t("canvasDiffRevertedTag")
                : confirmAll
                  ? isCreate
                    ? t("canvasDiffDeleteConfirm")
                    : t("canvasDiffRevertConfirm")
                  : isCreate
                    ? t("canvasDiffDelete")
                    : t("canvasDiffRevertAll")}
            </button>
          ) : null}
          <CopyButton text={diff} />
        </div>
      </div>
      {status ? (
        <div className={`border-b border-brand-500/10 px-3 py-1 text-[11px] ${statusColor}`}>
          {status.text}
        </div>
      ) : null}
      <div
        className={`min-h-0 flex-1 overflow-auto py-2 text-[11.5px] font-mono leading-relaxed ${
          deleted ? "opacity-40" : ""
        }`}
      >
        {hunks.length === 0
          ? diff.split("\n").map((line, i) => (
              <div key={i} className={`${diffLineClass(line)} px-3`}>
                {line || "\u00A0"}
              </div>
            ))
          : hunks.map((hunk, hi) => {
              const done = reverted.has(hunk.newStart);
              return (
                <div key={hi} className="mb-1.5">
                  <div className="flex items-center justify-between gap-2 bg-cyan-400/[0.06] px-3 py-0.5">
                    <span className="truncate text-cyan-300">{hunk.header}</span>
                    {path && !isCreate ? (
                      <button
                        type="button"
                        disabled={busy || done}
                        onClick={() =>
                          void runRevert(new Set([hunk.newStart]), false)
                        }
                        className="shrink-0 rounded border border-brand-500/20 bg-brand-500/10 px-1.5 py-0.5 text-[10px] font-medium text-brand-200 transition hover:bg-brand-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {done ? t("canvasDiffRevertedTag") : t("canvasDiffRevertHunk")}
                      </button>
                    ) : null}
                  </div>
                  {hunk.lines.map((line, li) => (
                    <div
                      key={li}
                      className={`${diffLineClass(line)} px-3 ${done ? "opacity-40" : ""}`}
                    >
                      {line || "\u00A0"}
                    </div>
                  ))}
                </div>
              );
            })}
      </div>
    </div>
  );
}

function itemFromWorkspaceText(item: WorkspaceResourceItem, path: string, body: string): WorkspaceResourceItem {
  const language = languageForPath(path);
  const base = {
    ...item,
    title: item.title || filenameFromPath(path),
    subtitle: item.subtitle || path,
    path,
    mimeType: item.mimeType,
    workspaceLoaded: true,
    seenAt: item.seenAt,
  };
  if (!looksLikeSvg(body) && (language === "html" || looksLikeHtml(body))) {
    return {
      ...base,
      kind: "html",
      html: body,
      body: undefined,
      url: rawWorkspaceDirUrl(path),
      language: "html",
    };
  }
  if (looksLikeUnifiedDiff(body) || language === "diff") {
    return { ...base, kind: "diff", body, language: "diff" };
  }
  return { ...base, kind: "file", body, language };
}

function itemFromRawPreview(item: WorkspaceResourceItem, path: string): WorkspaceResourceItem | null {
  const mime = item.mimeType || "";
  const url = rawWorkspaceFileUrl(path);
  const base = {
    ...item,
    title: item.title || filenameFromPath(path),
    subtitle: item.subtitle || path,
    path,
    url,
    mimeType: mime,
    workspaceLoaded: true,
  };
  if (isImagePath(path, mime)) {
    return { ...base, kind: "image", imageSrc: url };
  }
  if (isPdfPath(path, mime)) {
    return { ...base, kind: "pdf", dataUrl: url };
  }
  if (isAudioPath(path, mime) || isVideoPath(path, mime)) {
    return { ...base, kind: "file" };
  }
  return null;
}

function shouldResolveWorkspaceFile(item: WorkspaceResourceItem): boolean {
  const path = pathFromItem(item);
  if (!path) return false;
  if (item.workspaceLoaded) return false;
  if (item.kind === "html") return !item.html;
  if (item.kind === "image") return !item.imageSrc;
  if (item.kind === "pdf") return !item.dataUrl && !item.url;
  if (item.kind === "file") return !item.body && !item.url;
  return false;
}

function FileStatusView({
  item,
  tone,
  message,
  href,
}: {
  item: WorkspaceResourceItem;
  tone: "info" | "error";
  message: string;
  href?: string;
}) {
  const t = useTranslations("chat");
  const toneClass = tone === "error" ? "text-rose-300" : "text-ink-400";
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-ink-950/70 px-8 text-center">
      <div className="max-w-sm">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-md border border-brand-500/20 bg-brand-500/[0.08] text-brand-200">
          <FileIcon size={18} />
        </div>
        <div className="text-sm font-medium text-ink-100">{item.title}</div>
        <div className={`mt-1 text-xs leading-relaxed ${toneClass}`}>{message}</div>
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex rounded-md border border-brand-500/25 px-2.5 py-1 text-[11px] font-medium text-brand-200 hover:border-brand-500/50 hover:text-brand-100"
          >
            {t("canvasOpenFile")}
          </a>
        ) : null}
      </div>
    </div>
  );
}

function WorkspaceFileResolver({ item }: { item: WorkspaceResourceItem }) {
  const t = useTranslations("chat");
  const path = pathFromItem(item);
  const [resolved, setResolved] = useState<WorkspaceResourceItem | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState("");

  useEffect(() => {
    if (!path) {
      setResolved(null);
      setLoading(false);
      setError("");
      return;
    }
    const rawPreview = itemFromRawPreview(item, path);
    if (rawPreview && canUseRawPreview(path, item.mimeType || "")) {
      setResolved(rawPreview);
      setLoading(false);
      setError("");
      return;
    }

    let cancelled = false;
    setResolved(null);
    setLoading(true);
    setError("");
    clientApi
      .workspaceFileRead(path)
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(res.detail || res.error || t("canvasFileReadFailed"));
          return;
        }
        if (res.binary) {
          setResolved({
            ...item,
            kind: "file",
            title: item.title || filenameFromPath(path),
            subtitle: item.subtitle || path,
            path,
            url: rawWorkspaceFileUrl(path),
            body: "",
            workspaceLoaded: true,
          });
          return;
        }
        setResolved(itemFromWorkspaceText(item, path, res.content || ""));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item, path, t]);

  if (resolved) return <ResourceBody item={resolved} />;
  if (loading) {
    return (
      <FileStatusView item={item} tone="info" message={t("canvasFileLoading")} />
    );
  }
  if (error) {
    return (
      <FileStatusView
        item={item}
        tone="error"
        message={`${t("canvasFileReadFailed")}: ${error}`}
        href={path ? rawWorkspaceFileUrl(path) : undefined}
      />
    );
  }
  return <EmptyResource title={item.title} />;
}

function PdfView({ item }: { item: WorkspaceResourceItem }) {
  const src = item.dataUrl || item.url || "";
  if (!src) return <EmptyResource title={item.title} />;
  return (
    <iframe
      title={item.title}
      src={src}
      className="h-full w-full border-0 bg-ink-900"
    />
  );
}

function SvgView({ svg, title }: { svg: string; title: string }) {
  if (!svg.trim()) return <EmptyResource title={title} />;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-ink-950">
      <ResourceToolbar label="svg" copyText={svg} />
      <iframe
        title={title}
        srcDoc={svg}
        className="min-h-0 flex-1 border-0 bg-white"
        sandbox=""
      />
    </div>
  );
}

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r[0] ?? "").trim() !== "");
}

const CSV_ROW_CAP = 500;

function CsvTable({
  text,
  delimiter,
  item,
}: {
  text: string;
  delimiter: string;
  item: WorkspaceResourceItem;
}) {
  const rows = useMemo(() => parseDelimited(text, delimiter), [text, delimiter]);
  if (rows.length < 2) return <CodeView item={item} />;
  const header = rows[0];
  const dataRows = rows.slice(1, CSV_ROW_CAP + 1);
  const hidden = rows.length - 1 - dataRows.length;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-ink-950">
      <ResourceToolbar
        label={`${rows.length - 1} rows \u00B7 ${header.length} cols`}
        copyText={text}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-[11.5px]">
          <thead className="sticky top-0 z-10 bg-ink-900">
            <tr>
              {header.map((cell, ci) => (
                <th
                  key={ci}
                  className="whitespace-nowrap border-b border-brand-500/20 px-2.5 py-1.5 text-left font-semibold text-ink-200"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dataRows.map((cells, ri) => (
              <tr key={ri} className="odd:bg-ink-900/30">
                {header.map((_, ci) => (
                  <td
                    key={ci}
                    className="border-b border-brand-500/[0.07] px-2.5 py-1 align-top text-ink-200"
                  >
                    {cells[ci] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {hidden > 0 ? (
          <div className="px-3 py-2 text-[11px] text-ink-500">
            {`\u2026 ${hidden} more rows`}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function JsonResourceView({ item }: { item: WorkspaceResourceItem }) {
  const parsed = useMemo(() => {
    const raw = item.body || "";
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }, [item.body]);
  if (parsed === undefined) return <CodeView item={{ ...item, language: "json" }} />;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-ink-950">
      <ResourceToolbar label="json" copyText={item.body || ""} />
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <StructuredJsonView
          value={parsed}
          className="border-brand-500/15 bg-ink-900/30"
        />
      </div>
    </div>
  );
}

function MediaView({ item }: { item: WorkspaceResourceItem }) {
  const src = item.url || item.dataUrl || "";
  const path = pathFromItem(item);
  const mime = item.mimeType || "";
  if (!src) return <EmptyResource title={item.title} />;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-ink-950">
      <ResourceToolbar label={mime || extensionForPath(path) || "media"} copyText={src} />
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        {isVideoPath(path, mime) ? (
          <video
            src={src}
            controls
            className="max-h-full max-w-full rounded-md bg-black"
          />
        ) : (
          <audio src={src} controls className="w-full max-w-md" />
        )}
      </div>
    </div>
  );
}

function BinaryFileView({ item }: { item: WorkspaceResourceItem }) {
  const t = useTranslations("chat");
  const href = item.url || (pathFromItem(item) ? rawWorkspaceFileUrl(pathFromItem(item)) : "");
  return (
    <FileStatusView
      item={item}
      tone="info"
      message={t("canvasFileBinary")}
      href={href || undefined}
    />
  );
}

function FileView({ item }: { item: WorkspaceResourceItem }) {
  const body = item.body || "";
  const lang = (item.language || "").toLowerCase();
  const mime = (item.mimeType || "").toLowerCase();
  const name = (item.title || "").toLowerCase();
  const path = pathFromItem(item);

  if (!body && item.url && (isAudioPath(path, mime) || isVideoPath(path, mime))) {
    return <MediaView item={item} />;
  }
  if (!body && item.url) {
    return <BinaryFileView item={item} />;
  }
  if (!body) return <EmptyResource title={item.title} />;

  if (lang === "svg" || mime.includes("svg") || looksLikeSvg(body)) {
    return <SvgView svg={body} title={item.title} />;
  }
  if (lang === "markdown" || mime.includes("markdown") || /\.mdx?$/.test(name)) {
    return <TextView item={item} />;
  }
  if (
    lang === "csv" ||
    lang === "tsv" ||
    mime.includes("csv") ||
    mime.includes("tab-separated") ||
    /\.(csv|tsv)$/.test(name)
  ) {
    const useTab = lang === "tsv" || mime.includes("tab-separated") || /\.tsv$/.test(name);
    return <CsvTable text={body} delimiter={useTab ? "\t" : ","} item={item} />;
  }
  if (lang === "json" || mime.includes("json") || /\.json$/.test(name)) {
    return <JsonResourceView item={item} />;
  }
  return <CodeView item={item} />;
}

function HtmlFrame({ item, title }: { item: WorkspaceResourceItem; title: string }) {
  const srcDoc = item.html
    ? withBaseUrl(withHtmlPreviewBootstrap(item.html), item.url)
    : "";
  if (!srcDoc) {
    return item.body ? <TextView item={item} /> : <EmptyResource title={title} />;
  }
  return (
    <iframe
      title={title}
      srcDoc={srcDoc}
      className="h-full w-full border-0 bg-white"
      sandbox="allow-forms allow-popups allow-pointer-lock allow-scripts"
    />
  );
}

function ImageView({ item }: { item: WorkspaceResourceItem }) {
  if (!item.imageSrc) return <EmptyResource title={item.title} />;
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-ink-950 p-3">
      <img
        src={item.imageSrc}
        alt={item.title}
        className="max-h-full max-w-full object-contain"
      />
    </div>
  );
}

function TextView({ item }: { item: WorkspaceResourceItem }) {
  const body = item.body || "";
  if (!body) return <EmptyResource title={item.title} />;
  return (
    <div className="h-full min-h-0 overflow-auto bg-ink-950/70 p-4">
      <Markdown className="text-[13px] leading-relaxed">{body}</Markdown>
    </div>
  );
}

function resultDomain(result: WebSearchResult): string {
  if (result.url) {
    try {
      return new URL(result.url).hostname.replace(/^www\./, "");
    } catch {
      // Fall back to the provider supplied source below.
    }
  }
  return result.source || "";
}

function WebSearchResourceView({ item }: { item: WorkspaceResourceItem }) {
  const t = useTranslations("chat");
  const data = recordOf(item.data);
  const rows = Array.isArray(data.results)
    ? (data.results as WebSearchResult[]).filter(
        (row) => row && (row.title || row.url || row.snippet),
      )
    : [];
  const query = String(data.query || item.title || "");
  const engine = String(data.engine || "");
  if (!rows.length) return <TextView item={item} />;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-ink-950">
      <div className="border-b border-brand-500/15 bg-ink-900/45 px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-brand-500/20 bg-brand-500/[0.08] text-brand-200">
            <SearchIcon size={15} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="break-words text-sm font-semibold leading-snug text-ink-100">
              {query}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-500">
              <span>{t("canvasSearchResultCount", { count: rows.length })}</span>
              {engine ? <span className="font-mono text-ink-400">{engine}</span> : null}
            </div>
          </div>
        </div>
      </div>
      <ol className="min-h-0 flex-1 space-y-2 overflow-auto p-3">
        {rows.map((row, index) => {
          const domain = resultDomain(row);
          return (
            <li
              key={`${row.url || row.title}:${index}`}
              className="grid grid-cols-[28px_minmax(0,1fr)_32px] gap-2 rounded-md border border-brand-500/10 bg-ink-900/35 px-3 py-3"
            >
              <span className="pt-0.5 font-mono text-[11px] text-ink-500">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div className="min-w-0">
                {row.url ? (
                  <a
                    href={row.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-words text-[13px] font-semibold leading-snug text-brand-200 underline-offset-2 hover:text-brand-100 hover:underline"
                  >
                    {row.title || row.url}
                  </a>
                ) : (
                  <div className="break-words text-[13px] font-semibold leading-snug text-ink-100">
                    {row.title}
                  </div>
                )}
                {domain ? (
                  <div className="mt-1 truncate font-mono text-[10px] text-ink-500">
                    {domain}
                  </div>
                ) : null}
                {row.snippet ? (
                  <p className="mt-1.5 break-words text-[12px] leading-relaxed text-ink-300">
                    {row.snippet}
                  </p>
                ) : null}
              </div>
              {row.url ? (
                <a
                  href={row.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={t("canvasSearchOpen")}
                  title={t("canvasSearchOpen")}
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-brand-500/15 text-ink-400 transition-colors hover:border-brand-500/35 hover:bg-brand-500/[0.08] hover:text-brand-200"
                >
                  <GlobeIcon size={14} />
                </a>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ResourceBody({ item }: { item: WorkspaceResourceItem }) {
  if (shouldResolveWorkspaceFile(item)) {
    return <WorkspaceFileResolver item={item} />;
  }
  if (item.kind === "charts") {
    return <AgentChartPanel thread={item.thread || null} embedded />;
  }
  if (item.kind === "image") return <ImageView item={item} />;
  if (item.kind === "html") return <HtmlFrame item={item} title={item.title} />;
  if (item.kind === "pdf") return <PdfView item={item} />;
  if (item.kind === "diff") return <DiffView item={item} />;
  if (item.kind === "web") {
    if (item.html) return <HtmlFrame item={item} title={item.title} />;
    if (item.data) return <WebSearchResourceView item={item} />;
    return <TextView item={item} />;
  }
  if (item.kind === "text") return <TextView item={item} />;
  return <FileView item={item} />;
}

/** Standalone document renderer for workspace tabs, without Canvas navigation. */
export function WorkspaceResource({ item }: { item: WorkspaceResourceItem }) {
  return <div className="h-full min-h-0 overflow-auto" data-testid="workspace-resource"><ResourceBody item={item} /></div>;
}

export function workspaceFileItem(path: string): WorkspaceResourceItem {
  return { id: 'file:' + path, kind: 'file', title: path.split('/').pop() || path, path, seenAt: 0 };
}


function EmptyResource({ title }: { title?: string }) {
  const zh = useLocale().startsWith('zh');
  return <div className="flex h-full min-h-0 items-center justify-center p-8 text-center text-sm text-[color:var(--text-muted)]">{title || i18nCopy(zh, "copy.components_chat_WorkspaceResourcePreview.001")}</div>;
}
