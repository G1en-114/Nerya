"use client";
import { Icon as NeryaGlyph } from "../icons";
import { copy as i18nCopy } from "../../lib/i18n";

import { StrategyWorkflowPanel } from "../workflows/StrategyWorkflowPanel";
import { BacktestChart } from "../backtest/BacktestChart";
import { WorkspaceFiles } from "./WorkspaceFiles";
import { WorkspaceTerminal } from "./WorkspaceTerminal";
import { useStrategyReports } from "./useStrategyReports";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import {
  callApi,
  clientApi,
  type AgentSession,
  type ApprovalCard,
} from "../../lib/clientApi";
import { confirm as confirmDialog } from "../../lib/dialogs";
import {
  ChatAttachment,
  ChatMessage,
  UserMessage,
  ChatModelOption,
  ChatRunSettings,
  ChatThread,
  DEFAULT_CHAT_RUN_SETTINGS,
  buildChatModelOptions,
  cacheThreadTranscript,
  LiveEvent,
  TurnPayload,
  deriveTitle,
  loadCachedThreadTranscript,
  loadRunSettings,
  loadThreads,
  newThread,
  saveRunSettings,
  saveThreads,
  subscribeThreadsChanged,
  upsertThread,
  uuid,
} from "../../lib/chat";
import { AssistantBubble, UserBubble } from "./ChatMessage";
import { ExternalCallMessage } from "./ExternalCallMessage";
import { ExternalSessionTimeline } from "./ExternalSessionTimeline";
import { ConversationSourceIcon } from "./ConversationSourceIcon";
import { isExternalSource, conversationTimestamp } from "../../lib/externalCalls";
import { projectExternalThread } from "../../lib/externalNative";
import { ChatInput } from "./ChatInput";
import { useWorkbench } from "./useWorkbench";
import { ConversationTimeline,hasReadingAnchor,clearReadingAnchor } from "./ConversationTimeline";
import { ComposerContextSummary } from "./ComposerContextSummary";
import { TaskProvenance } from "./TaskProvenance";
import { CollaborationSummary } from "./CollaborationSummary";
import { InteractionPanel } from "./InteractionPanel";
import { RuntimeNotice } from "./RuntimeNotice";
import { taskStatus } from "../../lib/workbench";
import { useConversationCommands } from "./useConversationCommands";
import { ConversationControls } from "./ConversationControls";
import { ForkMessageDialog } from "./ForkMessageDialog";
import { submitCommand, projectCommand, CommandClientError, commandErrorCode } from "../../lib/conversationCommands";
import { commandErrorText } from "../../lib/commandCopy";
import { useChatDraft } from "./useChatDraft";
import { useMessageHistory } from "./useMessageHistory";
import { HistoryDeleteDialog } from "./ChatHistoryActions";
import { historyPending, historyRevision, HISTORY_CHANGED_EVENT } from "../../lib/historyClient";
import { AgentStart } from "./AgentStart";
import { AgentTaskBar, AgentWorkPanel } from "./AgentWorkspace";
import { ChatTaskHeader } from "./ChatTaskHeader";
import { collectChatResults, type ChatResult } from "../../lib/chatResults";
import { childResult } from "../../lib/agentConversation";
import styles from "./ChatWorkbench.module.css";
import { useAgentWork } from "./useAgentWork";
import { collectThreadItems, WorkspaceResource, workspaceFileItem } from "./WorkspaceResourcePreview";
import { ChatResultsPanel } from "./ChatResultsPanel";
import { collectResearchVisuals, type ResearchInstrument } from "../../lib/researchVisuals";
import type { ChartBlockShape } from "../../lib/chartBlock";
import { ResearchVisualContext, ResearchInstrumentContext } from "./ResearchVisualContext";
import { ResearchInstrumentPanel, ResearchCharts, ResearchChartTabs } from "./ResearchWorkspace";
import { collectPortfolioArtifacts } from "../../lib/portfolioArtifacts";
import { PortfolioSnapshot } from "../finance/PortfolioSnapshot";
import { TaskDockHeader } from './TaskDockHeader';
import { useTaskDock, type TaskDockTab } from './useTaskDock';
import { BrowserWorkspacePanel } from './BrowserWorkspacePanel';
import { browserCalls } from '../../lib/browserTrace';
import { liveEventsToBlocks } from '../../lib/chat';
import { useCanvasLayout } from "./useCanvasLayout";
import { XIcon } from "../icons";
import { takeComposeDraftPayload } from "../../lib/composeDraft";
import { FinanceDraftContext, appendReviewDraft } from "../finance/FinanceReview";
import { toast } from "../../lib/dialogs";

function parseTs(ts: string | number | undefined | null): number | null {
  return conversationTimestamp(ts);
}

const DELETED_SESSIONS_KEY = "nerya.chat.deletedSessions.v1";
const SESSION_PAGE_SIZE = 20;

type PendingFirstMessage = {
  threadId: string;
  text: string;
  attachments?: ChatAttachment[];
};

const pendingFirstMessages = new Map<string, PendingFirstMessage>();

function loadDeletedSessionIds(): Set<string> {
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    return new Set();
  }
  try {
    const parsed = JSON.parse(localStorage.getItem(DELETED_SESSIONS_KEY) || "[]");
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string" && !!id)
        : [],
    );
  } catch {
    return new Set();
  }
}

function rememberDeletedSession(id: string): Set<string> {
  const next = loadDeletedSessionIds();
  next.add(id);
  if (typeof window !== "undefined" && typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(
        DELETED_SESSIONS_KEY,
        JSON.stringify(Array.from(next).slice(-500)),
      );
    } catch {
      // Ignore quota/privacy-mode failures; the backend delete still runs.
    }
  }
  return next;
}

function threadHasUnpersistedMessages(thread: ChatThread | null | undefined): boolean {
  return Boolean(
    thread?.messages.some((m) => {
      if (m.role === "assistant") return Boolean(m.loading) || !m.backend_message_id;
      return !m.backend_message_id;
    }),
  );
}

function sortThreadsByUpdated(threads: ChatThread[]): ChatThread[] {
  return threads
    .slice()
    .sort((a, b) => (Number(b.updated_ts) || 0) - (Number(a.updated_ts) || 0));
}

function selectInitialThreads(
  threads: ChatThread[],
  opts: { keepId?: string; limit: number },
): ChatThread[] {
  const sorted = sortThreadsByUpdated(threads);
  const pinnedIds = new Set<string>();
  if (opts.keepId) pinnedIds.add(opts.keepId);
  for (const thread of sorted) {
    if (threadHasUnpersistedMessages(thread)) pinnedIds.add(thread.id);
  }
  const selected: ChatThread[] = [];
  const seen = new Set<string>();
  for (const thread of sorted) {
    if (selected.length >= opts.limit && !pinnedIds.has(thread.id)) continue;
    if (seen.has(thread.id)) continue;
    selected.push(thread);
    seen.add(thread.id);
  }
  return selected;
}

function isoFromMs(ts: number | undefined): string | undefined {
  return typeof ts === "number" && Number.isFinite(ts) && ts > 0
    ? new Date(ts).toISOString()
    : undefined;
}

function sessionTitle(session: AgentSession, sid: string): string {
  const title =
    typeof session.meta?.title === "string"
      ? session.meta.title
      : String(session.meta?.title || "");
  // Persisted titles remain complete; CSS owns visual truncation.
  return title.trim() || `Session ${sid.slice(0, 8)}`;
}

function threadFromSessionMetadata(session: AgentSession): ChatThread | null {
  const sid = String(session.session_id || "").trim();
  if (!sid) return null;
  const created = parseTs(session.created_at) ?? Date.now();
  const updated = parseTs(session.updated_at) ?? created;
  const cached = loadCachedThreadTranscript(sid, updated);
  if (cached) {
    return {
      ...cached,
      title: cached.title || sessionTitle(session, sid),
      created_ts: created || cached.created_ts,
      updated_ts: Math.max(updated, cached.updated_ts),
      source: session.source ?? cached.source,
      strategy_id: session.strategy_id ?? cached.strategy_id ?? undefined,
      strategy_proposal_id: String(session.meta?.strategy_proposal_id || "") || undefined,
      message_count: Math.max(
        cached.message_count ?? 0,
        Number(session.message_count || 0),
        cached.messages.length,
      ),
    };
  }
  return {
    id: sid,
    source: session.source,
    title: sessionTitle(session, sid),
    created_ts: created,
    updated_ts: updated,
    messages: [],
    message_count: Number(session.message_count || 0),
    imported: true,
    imported_at: Date.now(),
    transcript_loaded: false,
    backend_updated_ts: updated,
    strategy_id: session.strategy_id ?? undefined,
    strategy_proposal_id: String(session.meta?.strategy_proposal_id || "") || undefined,
  };
}

function chatMessageTextForMerge(message: ChatMessage): string {
  return message.role === "user"
    ? message.text
    : message.turn?.reply_text || message.turn?.final_text || "";
}

function mergeAuthoritativeThread(
  current: ChatThread | null | undefined,
  authoritative: ChatThread,
): ChatThread {
  if (!current) return authoritative;
  const currentByBackendId = new Map(
    current.messages
      .filter((m) => typeof m.backend_message_id === "string" && !!m.backend_message_id)
      .map((m) => [m.backend_message_id as string, m]),
  );
  const authoritativeMessages = authoritative.messages.map((message) => {
    const backendId = message.backend_message_id;
    const prior = backendId ? currentByBackendId.get(backendId) : null;
    if (!prior || prior.role !== message.role) return message;
    if (message.role === "user" && prior.role === "user") {
      return {
        ...message,
        id: prior.id,
        attachments: prior.attachments?.length
          ? prior.attachments
          : message.attachments,
      };
    }
    if (message.role === "assistant" && prior.role === "assistant") {
      return {
        ...message,
        id: prior.id,
        live_events: prior.live_events?.length
          ? prior.live_events
          : message.live_events,
        live_cursor: prior.live_cursor ?? message.live_cursor,
        started_ms: prior.started_ms ?? message.started_ms,
        elapsed_ms: prior.elapsed_ms ?? message.elapsed_ms,
      };
    }
    return message;
  });
  const stableAuthoritative = {
    ...authoritative,
    messages: authoritativeMessages,
  };
  const backendMessageIds = new Set(
    stableAuthoritative.messages
      .map((m) => m.backend_message_id)
      .filter((id): id is string => typeof id === "string" && !!id),
  );
  const pending = current.messages.filter((message) => {
    if (message.backend_message_id) {
      return !backendMessageIds.has(message.backend_message_id) && message.ts > stableAuthoritative.updated_ts + 1000;
    }
    if (message.ts <= stableAuthoritative.updated_ts + 1000) return false;
    const text = chatMessageTextForMerge(message).trim();
    if (!text) return true;
    return !stableAuthoritative.messages.some(
      (candidate) =>
        candidate.role === message.role &&
        chatMessageTextForMerge(candidate).trim() === text,
    );
  });
  if (!pending.length) return stableAuthoritative;
  return {
    ...stableAuthoritative,
    updated_ts: Math.max(stableAuthoritative.updated_ts, ...pending.map((m) => m.ts)),
    messages: [...stableAuthoritative.messages, ...pending],
    imported: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function attachmentForRequest(attachment: ChatAttachment): ChatAttachment {
  if (!attachment.artifact_uri) return attachment;
  const { data_url: _dataUrl, text: _text, ...rest } = attachment;
  return rest;
}

function approvalState(value: unknown): string {
  const record = asRecord(value);
  const nested = asRecord(record.record);
  return String(
    record.state ||
      record.resolved_state ||
      nested.state ||
      "",
  ).toLowerCase();
}

function isApprovalResolved(value: unknown): boolean {
  const state = approvalState(value);
  return state === "approved" || state === "rejected";
}

function approvalIdFromRecord(value: unknown): string {
  const record = asRecord(value);
  return String(record.approval_id || record.id || "");
}

function approvalBlockFromEnvelope(value: unknown): Record<string, unknown> {
  const env = asRecord(value);
  return asRecord(env.block || env);
}

function cardSessionId(card: ApprovalCard): string {
  const record = asRecord(card.record);
  const metadata = asRecord(card.prompt?.metadata);
  return String(record.session_id || metadata.session_id || "");
}

function pendingApprovalIdsForThread(
  thread: ChatThread | null,
  pendingApprovals: Map<string, ApprovalCard>,
): string[] {
  if (!thread) return [];
  const requested = new Set<string>();
  const resolved = new Set<string>();
  const currentStopRequests = new Set<string>();
  const pendingRecordIds = new Set<string>();
  const latestAssistant = [...thread.messages]
    .reverse()
    .find(
      (msg): msg is Extract<ChatMessage, { role: "assistant" }> =>
        msg.role === "assistant",
    );
  const latestStoppedOnApproval =
    latestAssistant &&
    String(latestAssistant.turn?.stopped_reason || "").toLowerCase() ===
      "approval_pending";

  for (const msg of thread.messages) {
    if (msg.role !== "assistant") continue;
    for (const ev of msg.live_events ?? []) {
      const id = approvalIdFromRecord(ev);
      if (!id) continue;
      if (ev.kind === "approval.request") requested.add(id);
      if (ev.kind === "approval.resolved" || isApprovalResolved(ev)) {
        resolved.add(id);
      }
    }

    const stoppedOnApproval =
      latestStoppedOnApproval && msg.id === latestAssistant.id;
    for (const env of msg.turn?.blocks ?? []) {
      const block = approvalBlockFromEnvelope(env);
      if (String(block.kind || "") !== "approval_request") continue;
      const id = approvalIdFromRecord(block);
      if (!id) continue;
      requested.add(id);
      if (stoppedOnApproval) currentStopRequests.add(id);
      if (isApprovalResolved(block)) resolved.add(id);
    }
  }

  for (const [id, card] of pendingApprovals) {
    if (cardSessionId(card) !== thread.id) continue;
    requested.add(id);
    pendingRecordIds.add(id);
  }

  return Array.from(requested).filter(
    (id) =>
      !resolved.has(id) &&
      (pendingRecordIds.has(id) || currentStopRequests.has(id)),
  );
}

export function ChatView({ sessionId }: { sessionId?: string } = {}) {
  const router = useRouter();
  const t = useTranslations("chat");
  const tCommon = useTranslations("common");
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const draftScope = sessionId || `new:${typeof window !== "undefined" ? window.location.search : ""}`;
  const draft = useChatDraft(draftScope);
  const { text: input, setText: setInput, attachments, setAttachments } = draft;
  const [historyMore,setHistoryMore]=useState(false);
  const [historyLimit,setHistoryLimit]=useState(60);
  const [loadingOlder,setLoadingOlder]=useState(false);
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [pendingAutoSend,setPendingAutoSend]=useState<{text:string;attachments:ChatAttachment[]}|null>(null);
  const [forkTarget, setForkTarget] = useState<{ sessionId:string; message:UserMessage } | null>(null);
  const [externalSending, setExternalSending] = useState(false);
  const externalSendBusy = useRef(false);
  const externalMessageAttempt = useRef<{ sid: string; text: string; key: string } | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [missingSession, setMissingSession] = useState(false);
  // Distinguish "the fetch blew up" from "the session does not exist" so
  // the failure case can offer a Retry instead of a dead end.
  const [transcriptLoadFailed, setTranscriptLoadFailed] = useState(false);
  const [transcriptRetry, setTranscriptRetry] = useState(0);
  const [settings, setSettings] = useState<ChatRunSettings>(
    DEFAULT_CHAT_RUN_SETTINGS,
  );
  useEffect(()=>{if(draft.settings)setSettings(draft.settings);},[draft.settings]);
  const [modelOptions, setModelOptions] = useState<ChatModelOption[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<Map<string, ApprovalCard>>(
    () => new Map(),
  );
  const [resolvingApprovalIds, setResolvingApprovalIds] = useState<Set<string>>(
    () => new Set(),
  );
  const turnInFlightRef = useRef(false);
  const draftConsumedRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const followLatest = useRef(true);
  const lastScrollTop = useRef(0);
  const [readingHistory, setReadingHistory] = useState(false);
  function jumpToLatest() {
    clearReadingAnchor(active?.id||"");
    followLatest.current = true; setReadingHistory(false);
    if (scrollRef.current) scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight });
  }
  const deletedSessionIdsRef = useRef<Set<string>>(new Set());
  const [sessionHasMore, setSessionHasMore] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionNextOffset, setSessionNextOffset] = useState(0);
  const [loadingTranscriptIds, setLoadingTranscriptIds] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    const loaded = selectInitialThreads(loadThreads(), {
      keepId: sessionId,
      limit: SESSION_PAGE_SIZE,
    });
    const savedSettings = loadRunSettings();
    deletedSessionIdsRef.current = loadDeletedSessionIds();
    setSettings(savedSettings);
    setThreads(loaded);
    setHydrated(true);
    void hydrateModelOptions();
    // Fold in conversations that were started outside the dashboard
    // (curl / gateway / scripted runs) by walking backend sessions and
    // pulling their reconstructed transcript. Local threads always win
    // — we only import sessions whose ``session_id`` is not already a
    // local thread ``id``.
    void hydrateBackendSessions(loaded);
    // Refresh imported sessions when the tab regains focus so curl
    // turns that landed while the dashboard was hidden show up.
    function onVisibility() {
      if (document.visibilityState === "visible") {
        // Re-read the latest local threads via a state callback so we
        // don't capture a stale closure.
        setThreads((prev) => {
          void hydrateBackendSessions(prev);
          return prev;
        });
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hand-off from the Codex command home: when the new-chat route mounts
  // with a stashed composer draft, drop it into the input and auto-run the
  // turn so the home box behaves like Codex's "what should we build?" entry.
  useEffect(() => {
    if (!hydrated || draftConsumedRef.current || sessionId) return;
    const draft = takeComposeDraftPayload();
    if (!draft || (!draft.text.trim() && !draft.attachments.length)) return;
    draftConsumedRef.current = true;
    setInput(draft.text);
    setAttachments(draft.attachments);
    if (draft.autoSend) setPendingAutoSend({text:draft.text,attachments:draft.attachments});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, sessionId]);

  // The conversation list now lives in the global Codex sidebar. If the
  // active chat is deleted from there (tombstoned), leave the dead route.
  useEffect(() => {
    if (!hydrated) return;
    return subscribeThreadsChanged(() => {
      const deleted = loadDeletedSessionIds();
      deletedSessionIdsRef.current = deleted;
      const saved = new Map(loadThreads().map(thread => [thread.id, thread]));
      setThreads(previous => {
        let changed = false;
        const next = previous.filter(thread => { if (deleted.has(thread.id)) { changed = true; return false; } return true; }).map(thread => {
          const cached = saved.get(thread.id);
          if (cached && cached.title !== thread.title && cached.updated_ts >= thread.updated_ts) {
            changed = true; return { ...thread, title: cached.title };
          }
          return thread;
        });
        return changed ? next : previous;
      });
      if (sessionId && deleted.has(sessionId)) router.replace("/chat");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, sessionId]);

  async function hydrateModelOptions() {
    try {
      const [tiersResp, modelsResp, configResp] = await Promise.allSettled([
        clientApi.llmTiers(),
        clientApi.llmModels(),
        clientApi.llmConfig(),
      ]);
      setModelOptions(
        buildChatModelOptions({
          tiers: tiersResp.status === "fulfilled" ? tiersResp.value : null,
          models: modelsResp.status === "fulfilled" ? modelsResp.value : null,
          config: configResp.status === "fulfilled" ? configResp.value : null,
        }),
      );
    } catch {
      // The chat still works with the runtime default model.
    }
  }

  function approvalIdFromCallback(callbackData: string): string {
    const idx = callbackData.indexOf(":");
    return idx >= 0 ? callbackData.slice(idx + 1).trim() : "";
  }

  function approvalActionFromCallback(callbackData: string): string {
    const idx = callbackData.indexOf(":");
    return (idx >= 0 ? callbackData.slice(0, idx) : callbackData)
      .trim()
      .toLowerCase();
  }

  function approvalEventFromCard(id: string, card: ApprovalCard): LiveEvent {
    const record = card.record ?? {};
    const tool =
      record.tool && typeof record.tool === "object"
        ? (record.tool as Record<string, unknown>)
        : {};
    return {
      kind: "approval.request",
      seq: Number(record.seq || 0),
      ts:
        typeof record.created_at === "number"
          ? record.created_at
          : Date.now() / 1000,
      approval_id: id,
      session_id:
        typeof record.session_id === "string" ? record.session_id : undefined,
      strategy_id:
        typeof record.strategy_id === "string" ? record.strategy_id : undefined,
      turn_id: typeof record.turn_id === "string" ? record.turn_id : undefined,
      call_id: String(
        record.tool_use_id ||
          tool.call_id ||
          card.prompt?.metadata?.tool_use_id ||
          "",
      ),
      prompt: card.prompt,
      record,
      reason: card.prompt?.text || String(record.reason || ""),
    };
  }

  function appendApprovalResolutionEvent(id: string, state: string) {
    if (!id || !sessionId) return;
    const resolved: LiveEvent = {
      kind: "approval.resolved",
      seq: Date.now(),
      ts: Date.now() / 1000,
      approval_id: id,
      state,
      session_id: sessionId,
    };
    updateThread(sessionId, (t) => ({
      ...t,
      messages: t.messages.map((m) => {
        if (m.role !== "assistant") return m;
        const hasApproval = (m.live_events ?? []).some(
          (ev) =>
            (ev.kind === "approval.request" || ev.kind === "approval.resolved") &&
            String(ev.approval_id || "") === id,
        );
        if (!hasApproval) return m;
        return {
          ...m,
          live_events: [...(m.live_events ?? []), resolved],
        };
      }),
    }));
  }

  function attachPendingApprovalEvents(next: Map<string, ApprovalCard>) {
    if (!next.size) return;
    setThreads((prev) =>
      prev.map((thread) => {
        let changed = false;
        const messages = thread.messages.map((m) => ({ ...m }));
        for (const [id, card] of next) {
          const record = card.record ?? {};
          const sessionId = String(record.session_id || "");
          if (sessionId && sessionId !== thread.id) continue;
          const turnId = String(record.turn_id || "");
          let targetIdx = -1;
          if (turnId) {
            targetIdx = messages.findIndex(
              (m) =>
                m.role === "assistant" &&
                (m.turn?.turn_id === turnId ||
                  m.backend_message_id === `${turnId}:assistant`),
            );
          }
          if (targetIdx < 0) {
            for (let i = messages.length - 1; i >= 0; i -= 1) {
              if (messages[i].role === "assistant") {
                targetIdx = i;
                break;
              }
            }
          }
          if (targetIdx < 0) continue;
          const target = messages[targetIdx];
          if (target.role !== "assistant") continue;
          const exists = (target.live_events ?? []).some(
            (ev) => ev.kind === "approval.request" && String(ev.approval_id || "") === id,
          );
          if (exists) continue;
          messages[targetIdx] = {
            ...target,
            live_events: [
              ...(target.live_events ?? []),
              approvalEventFromCard(id, card),
            ],
          };
          changed = true;
        }
        return changed ? { ...thread, messages } : thread;
      }),
    );
  }

  async function refreshApprovals() {
    try {
      const resp = await clientApi.approvalsPending();
      const next = new Map<string, ApprovalCard>();
      for (const card of resp?.approvals ?? []) {
        const id =
          card.prompt?.approval_id ||
          String(card.record?.approval_id || card.record?.id || "");
        if (id) next.set(id, card);
      }
      setPendingApprovals(next);
      attachPendingApprovalEvents(next);
    } catch {
      // Backend may be down while the dashboard is still mounted.
    }
  }

  useEffect(() => {
    void refreshApprovals();
    const timer = setInterval(() => {
      void refreshApprovals();
    }, 2500);
    return () => clearInterval(timer);
  }, []);

  async function buildImportedThread(
    sid: string,
    sessionMeta: { created_at?: string; updated_at?: string; title?: string; source?: string },
    opts: { full?: boolean; max_pairs?:number;anchor_message_id?:string } = {},
  ): Promise<ChatThread | null> {
    const external = isExternalSource(sessionMeta.source) || /^ext_(mcp|tunnel)_[0-9a-f]{32}$/.test(sid);
    const version = historyRevision(sid);
    const t = await clientApi.sessionTranscript(sid, { ...opts, full: opts.full || external });
    if(sid === sessionId)setHistoryMore(Boolean(t.has_more));
    if (historyPending(sid) || version !== historyRevision(sid) || loadDeletedSessionIds().has(sid)) return null;
    if (!t?.ok || !Array.isArray(t.messages)) {
      if (t?.error && !/not found|session_deleted/.test(t.error)) throw new Error(t.error);
      return null;
    }
    const created = parseTs(t.created_at) ?? parseTs(sessionMeta.created_at) ?? Date.now();
    const updated = parseTs(t.updated_at) ?? parseTs(sessionMeta.updated_at) ?? created;
    const msgs: ChatMessage[] = [];
    let firstUser = "";
    for (const m of t.messages) {
      const ts = parseTs(m.ts) ?? created;
      if (m.role === "user") {
        if (m.meta?.source === "approval_continue") continue;
        if (!firstUser) firstUser = m.content;
        msgs.push({
          id: m.message_id || uuid(),
          role: "user",
          command_id: typeof m.meta?.source_command_id === 'string' ? m.meta.source_command_id : undefined,
          ts,
          text: m.content,
          edited_at: typeof m.meta?.edited_at === "number" ? m.meta.edited_at : undefined,
          attachments: Array.isArray(m.meta?.attachments) ? m.meta.attachments as ChatAttachment[] : undefined,
          external_request: m.meta?.external_request as UserMessage['external_request'],
          backend_message_id: m.message_id,
        });
      } else {
        // May-01 2026 — assistant rows now carry the full turn payload
        // (blocks / tool_trace / actions / budget) persisted by the
        // kernel. Prefer it over the bare ``{reply_text, turn_id}``
        // fallback so rehydrated sessions keep the tool_use timeline
        // the user saw during the live turn. Older rows that predate
        // the write still fall back to the minimal shape.
        const persistedTurn =
          m.turn && typeof m.turn === "object"
            ? (m.turn as TurnPayload)
            : null;
        const turn: TurnPayload = persistedTurn
          ? {
              ...persistedTurn,
              reply_text:
                typeof persistedTurn.reply_text === "string" &&
                persistedTurn.reply_text
                  ? persistedTurn.reply_text
                  : m.content,
              turn_id:
                typeof persistedTurn.turn_id === "string" &&
                persistedTurn.turn_id
                  ? persistedTurn.turn_id
                  : m.turn_id,
            }
          : { reply_text: m.content, turn_id: m.turn_id };
        msgs.push({
          id: m.message_id || uuid(),
          role: "assistant",
          command_id: typeof turn.command_id === 'string' ? turn.command_id : undefined,
          command_revision: typeof m.meta?.command_revision === 'number' ? m.meta.command_revision : undefined,
          execution_status: typeof m.meta?.execution_status === 'string' ? m.meta.execution_status : undefined,
          error: typeof m.meta?.error === 'string' ? m.meta.error : typeof turn.error === 'string' ? turn.error : undefined,
          ts,
          turn,
          elapsed_ms: turn.execution_elapsed_ms,
          backend_message_id: m.message_id,
        });
      }
    }
    const savedTitle = t.title?.trim() || sessionMeta.title?.trim();
    const thread: ChatThread = {
      id: sid,
      source: t.source || sessionMeta.source,
      title: savedTitle || deriveTitle(firstUser || `Session ${sid.slice(0, 8)}`),
      created_ts: created,
      updated_ts: updated,
      message_count: msgs.length,
      messages: msgs,
      imported: true,
      imported_at: Date.now(),
      transcript_loaded: true,
      backend_updated_ts: updated,
      strategy_id: t.strategy_id ?? undefined,
      strategy_proposal_id: t.strategy_proposal_id ?? undefined,
    };
    return cacheThreadTranscript(thread);
  }

  async function loadOlderHistory(){
    if(!active||loadingOlder)return;
    setLoadingOlder(true);
    const limit=historyLimit+100;
    const root=scrollRef.current, height=root?.scrollHeight||0,top=root?.scrollTop||0;
    followLatest.current=false;
    try {
      const built=await buildImportedThread(active.id,{title:active.title,source:active.source},{max_pairs:limit});
      if(built){setThreads(previous=>upsertThread(previous,mergeAuthoritativeThread(previous.find(t=>t.id===active.id),built)));setHistoryLimit(limit);requestAnimationFrame(()=>{if(root)root.scrollTop=top+root.scrollHeight-height;});}
    } finally{setLoadingOlder(false);}
  }

  async function hydrateBackendSessions(
    localThreads: ChatThread[],
    opts: { offset?: number; append?: boolean } = {},
  ) {
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    setSessionLoading(true);
    try {
      const resp = await clientApi.sessionList(undefined, SESSION_PAGE_SIZE, { offset });
      const sessions = Array.isArray(resp?.sessions) ? resp.sessions : [];
      setSessionHasMore(Boolean(resp?.has_more));
      setSessionNextOffset(
        typeof resp?.next_offset === "number"
          ? resp.next_offset
          : offset + sessions.length,
      );
      if (sessions.length === 0) return;
      const localById = new Map(localThreads.map((t) => [t.id, t]));
      const refreshed: ChatThread[] = [];
      for (const s of sessions) {
        const sid = String(s.session_id || "");
        if (!sid) continue;
        if (deletedSessionIdsRef.current.has(sid)) continue;
        const existing = localById.get(sid);
        if (threadHasUnpersistedMessages(existing)) continue;
        // Skip locally-grown threads (i.e. created in this browser) —
        // they may be richer than the journal-reconstructed transcript
        // (e.g. carry live_events, blocks, errors). Only import
        // sessions that are entirely new, or refresh ones we
        // previously imported.
        if (existing && !existing.imported) continue;
        const metaThread = threadFromSessionMetadata(s);
        if (metaThread) refreshed.push(metaThread);
      }
      if (refreshed.length === 0) return;
      setThreads((prev) => {
        const byId = new Map(prev.map((t) => [t.id, t]));
        for (const t of refreshed) {
          const current = byId.get(t.id);
          if (
            current &&
            current.messages.length > 0 &&
            current.updated_ts >= t.updated_ts &&
            (current.transcript_loaded || !t.transcript_loaded)
          ) {
            byId.set(t.id, {
              ...current,
              title: current.title || t.title,
              message_count: Math.max(
                current.message_count ?? 0,
                t.message_count ?? 0,
                current.messages.length,
              ),
              backend_updated_ts: Math.max(
                current.backend_updated_ts ?? 0,
                t.backend_updated_ts ?? 0,
              ),
            });
          } else {
            byId.set(t.id, t);
          }
        }
        const merged = Array.from(byId.values());
        merged.sort((a, b) => b.updated_ts - a.updated_ts);
        return merged;
      });
    } catch {
      // Backend unreachable — local threads still render.
    } finally {
      setSessionLoading(false);
    }
  }

  function loadMoreBackendSessions() {
    if (sessionLoading || !sessionHasMore) return;
    setThreads((prev) => {
      void hydrateBackendSessions(prev, {
        offset: sessionNextOffset,
        append: true,
      });
      return prev;
    });
  }

  useEffect(() => {
    if (!hydrated) return;
    saveThreads(threads);
  }, [threads, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    saveRunSettings(settings);
  }, [settings, hydrated]);



  const active = useMemo(
    () => projectExternalThread(sessionId ? threads.find((t) => t.id === sessionId) || null : null),
    [threads, sessionId],
  );
  const externalView = isExternalSource(active?.source) || /^ext_(mcp|tunnel)_[0-9a-f]{32}$/.test(sessionId || '');
  const workbench = useWorkbench(sessionId);
  const commandEngine = useConversationCommands(hydrated && !externalView ? sessionId : undefined, (command, events) => {
    setThreads(previous => {
      const existing = previous.find(thread => thread.id === command.session_id)
        || { ...newThread(command.input), id: command.session_id };
      return upsertThread(previous, projectCommand(existing, command, events));
    });
  });
  useEffect(()=>{
    if(!pendingAutoSend||workbench.connection!=="online")return;
    const next=pendingAutoSend;setPendingAutoSend(null);
    void runAgentTurn(next.text,{visibleUser:true,attachments:next.attachments});
    // Pending first input waits for runtime capability confirmation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[pendingAutoSend,workbench.connection]);

  const commandRunning = Boolean(commandEngine.active);
  useEffect(() => { if (!externalView) setSending(commandRunning); }, [externalView, commandRunning]);
  // Tunnel writes from a separate process, so the in-process event bus is not
  // authoritative. Poll persisted external threads without replacing live chat.
  const externalSnapshot = useRef({ threads, sessionId });
  externalSnapshot.current = { threads, sessionId };
  useEffect(() => {
    if (!hydrated) return;
    let stopped = false;
    let busy = false;
    const loaded = new Map<string, { version: number; at: number }>();
    async function refreshExternal() {
      if (stopped || busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const response = await clientApi.sessionList(undefined, 100);
        if (stopped) return;
        const sessions = (response.sessions || []).filter(s => isExternalSource(s.source));
        const snapshot = externalSnapshot.current;
        const selected = snapshot.threads.find(t => t.id === snapshot.sessionId);
        if (snapshot.sessionId && !sessions.some(s => s.session_id === snapshot.sessionId)
            && (isExternalSource(selected?.source) || /^ext_(mcp|tunnel)_[0-9a-f]{32}$/.test(snapshot.sessionId))) {
          const row = await clientApi.sessionGet(snapshot.sessionId);
          if ("session_id" in row && isExternalSource(row.source)) sessions.push(row);
        }
        let transcript: ChatThread | null = null;
        const selectedMeta = sessions.find(s => s.session_id === snapshot.sessionId);
        if (selectedMeta && !loadDeletedSessionIds().has(selectedMeta.session_id)) {
          const version = parseTs(selectedMeta.updated_at) || 0;
          const previous = loaded.get(selectedMeta.session_id);
          if (!previous || version > previous.version || Date.now() - previous.at > 15_000) {
            transcript = await buildImportedThread(selectedMeta.session_id, {
              ...selectedMeta, title: sessionTitle(selectedMeta, selectedMeta.session_id),
            }, { full: true });
            if (transcript) loaded.set(transcript.id, { version, at: Date.now() });
          }
        }
        if (stopped) return;
        const tombstones = loadDeletedSessionIds();
        setThreads(prev => {
          const byId = new Map(prev.map(t => [t.id, t]));
          let changed = false;
          for (const meta of sessions) {
            if (tombstones.has(meta.session_id)) continue;
            const current = byId.get(meta.session_id);
            if (threadHasUnpersistedMessages(current)) continue;
            const next = threadFromSessionMetadata(meta);
            if (!next) continue;
            if (!current) {
              byId.set(next.id, next);
              changed = true;
            } else if (next.updated_ts > current.updated_ts || current.source !== meta.source || next.title !== current.title) {
              byId.set(next.id, { ...current, source: meta.source, title: sessionTitle(meta, next.id),
                updated_ts: Math.max(current.updated_ts, next.updated_ts), message_count: next.message_count });
              changed = true;
            }
          }
          if (transcript && !tombstones.has(transcript.id)) {
            const current = byId.get(transcript.id);
            if (!threadHasUnpersistedMessages(current) && (!current || transcript.updated_ts >= (current.backend_updated_ts || 0))) {
              byId.set(transcript.id, mergeAuthoritativeThread(current, transcript));
              changed = true;
            }
          }
          return changed ? sortThreadsByUpdated([...byId.values()]) : prev;
        });
      } catch {
        // Keep the last successful trace on transient network errors. Never retry
        // a business tool from a history viewer.
      } finally {
        busy = false;
      }
    }
    const tick = () => { void refreshExternal(); };
    const timer = setInterval(tick, 2500);
    tick();
    document.addEventListener("visibilitychange", tick);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
    // The snapshot ref supplies the current route and local thread state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  const activeApprovalIds = useMemo(
    () => pendingApprovalIdsForThread(active, pendingApprovals),
    [active, pendingApprovals],
  );
  const activeApprovalKey = activeApprovalIds.join("|");
  const activeLiveEventCount = useMemo(
    () =>
      active?.messages.reduce(
        (count, msg) =>
          msg.role === "assistant" ? count + (msg.live_events?.length ?? 0) : count,
        0,
      ) ?? 0,
    [active],
  );
  const awaitingApproval = activeApprovalIds.length > 0;
  const history = useMessageHistory({ thread: active, disabled: sending || awaitingApproval || externalView,
    onCommit: (sid, mid, patch) => updateThread(sid, thread => {
      const messages = patch ? thread.messages.map(message => message.id === mid && message.role === "user" ? { ...message, ...patch } : message)
        : thread.messages.filter(message => message.id !== mid);
      return { ...thread, messages, message_count: messages.length, transcript_loaded: true };
    }) });
  const th = useTranslations("chatHistory");
  const activeTranscriptLoading = Boolean(
    sessionId && loadingTranscriptIds.has(sessionId),
  );
  const agentWork = useAgentWork(active);
  const zh = useLocale().startsWith("zh");
  const results = useMemo(() => collectChatResults(active), [active]);
  const { layoutRef, width: canvasWidth, compact, changeWidth, separatorProps } = useCanvasLayout(hydrated);

  const browserOperations = useMemo(() => {
    const rows = (active?.messages || []).flatMap(message => {
      if (message.role !== 'assistant') return [];
      const events = [...(message.turn?.activity_events || []), ...(message.live_events || [])];
      return browserCalls([...(message.turn?.blocks || []), ...liveEventsToBlocks(events)], events);
    });
    return [...new Map(rows.map(row => [row.id, row])).values()];
  }, [active]);
  function revealAgent(id: string, attempt?: number) {
    setAgentFocus((old) => ({ session: active?.id || "", id, count: old.count + 1, attempt: attempt || 0 }));
    selectWorkspace("agents", true);
  }
  const [inspectedChildResult, setInspectedChildResult] = useState<{ session: string; result: ChatResult } | null>(null);
  const [agentFocus, setAgentFocus] = useState({ session: "", id: "", count: 0, attempt: 1 });
  const agentResults = useMemo(() => {
    const latest = agentWork.rows.filter((a) => a.state === "completed" && a.output != null).map((a) => childResult(a, a.output, a.attempt, zh));
    const prior = inspectedChildResult && inspectedChildResult.session === active?.id && agentWork.rows.some((a) => a.id === inspectedChildResult.result.agentId) ? [inspectedChildResult.result] : [];
    return [...new Map([...prior, ...latest].map((r) => [r.id, r])).values()].filter((r) => r.text);
  }, [agentWork.rows, active?.id, inspectedChildResult, zh]);
  function openChildResult(result: ChatResult) {
    setInspectedChildResult({ session: active?.id || "", result });
    openResult(result.id);
  }
  const strategyId = active?.strategy_id || (hydrated && !sessionId ? strategyIdFromLocation() : '');
  const strategyProposal = active?.strategy_proposal_id || (hydrated && !sessionId ? new URLSearchParams(window.location.search).get('proposal') : null);
  const strategyReports = useStrategyReports(strategyId, (active?.messages.length || 0) + results.length);
  const [strategyDirty, setStrategyDirty] = useState(false);
  const hasBrowser = browserOperations.length > 0;
  const resources = useMemo(() => collectThreadItems(active), [active]);
  const snapshots = useMemo(() => collectPortfolioArtifacts(active), [active]);
  const allResults = [...results, ...agentResults];
  function resultTabId(result: ChatResult): TaskDockTab {
    const message = active?.messages.find(message => message.id === result.id);
    return ('result:' + (result.agentId ? result.id : message?.backend_message_id || result.turnId || result.id)) as TaskDockTab;
  }
  const research = useMemo(() => collectResearchVisuals(active), [active]);
  const researchSession = active?.id || sessionId || ('new:' + strategyId);
  const [researchFocus, setResearchFocus] = useState<{ session: string; chartId: string } | null>(null);
  const showResearch = researchFocus?.session === researchSession && research.studies.length > 0;
  const [instrumentFocus, setInstrumentFocus] = useState<{ session: string; instrument: ResearchInstrument; charts: ChartBlockShape[] } | null>(null);
  const focusedInstrument = instrumentFocus?.session === researchSession ? instrumentFocus : null;
  const detailInstruments = [...new Map([...research.instruments, ...(focusedInstrument ? [focusedInstrument.instrument] : [])].map(item => [item.id, item])).values()];
  const instrumentTabs = detailInstruments.map(item => ({ id: ('instrument:' + item.id) as TaskDockTab, label: item.market }));
  const automaticTabs = [
    ...(strategyId ? [{ id: 'strategy' as TaskDockTab, label: i18nCopy(zh, "copy.components_chat_ChatView.001") }] : []),
    ...strategyReports.runs.map(run => ({ id: ('backtest:' + run.ts) as TaskDockTab, label: (i18nCopy(zh, "copy.components_chat_ChatView.002")) + run.ts })),
    ...(hasBrowser ? [{ id: 'browser' as TaskDockTab, label: i18nCopy(zh, "copy.components_chat_ChatView.003") }] : []),
    ...allResults.map((result, index) => ({ id: resultTabId(result), label: i18nCopy(zh, "copy.components_chat_ChatView.017", { index: index + 1, title: result.title }) })),
    ...resources.map(item => ({ id: ('resource:' + item.id) as TaskDockTab, label: item.path?.split('/').pop() || item.title })),
    ...snapshots.map((item, index) => ({ id: item.id as TaskDockTab, label: i18nCopy(zh, "copy.components_chat_ChatView.018", { index: index + 1 }) })),
    ...(agentWork.rows.length ? [{ id: 'agents' as TaskDockTab, label: i18nCopy(zh, "copy.components_chat_ChatView.004") }] : []),
  ];
  const toolTabs = [{ id: 'files' as TaskDockTab, label: i18nCopy(zh, "copy.components_chat_ChatView.005") }, { id: 'browser' as TaskDockTab, label: i18nCopy(zh, "copy.components_chat_ChatView.006") }, { id: 'terminal' as TaskDockTab, label: i18nCopy(zh, "copy.components_chat_ChatView.007") }];
  const dockChoices = [...new Map([...toolTabs, ...automaticTabs, ...instrumentTabs].map(tab => [tab.id, tab])).values()];
  // On compact layouts the workspace replaces, rather than sits beside, chat.
  // Discovering old results must not navigate away from the conversation.
  const taskDock = useTaskDock(researchSession, [...automaticTabs, ...instrumentTabs].map(tab => tab.id), automaticTabs.map(tab => tab.id), true);
  const fileTabKey = JSON.stringify(taskDock.tabs.filter(id => id.startsWith('file:')));
  const openedFiles = useMemo(() => (JSON.parse(fileTabKey) as string[]).map(id => ({ id, item: workspaceFileItem(id.slice(5)) })), [fileTabKey]);
  const dockTabs = taskDock.tabs.flatMap(id => { const tab = dockChoices.find(tab => tab.id === id); return tab ? [tab] : id.startsWith('file:') ? [{ id, label: id.slice(5).split('/').pop() || id.slice(5) }] : []; });
  useEffect(() => {
    if (!hydrated || new URLSearchParams(window.location.search).get('panel') !== 'browser') return;
    taskDock.select('browser');
    const url = new URL(window.location.href); url.searchParams.delete('panel');
    window.history.replaceState(window.history.state, '', url);
  }, [hydrated, taskDock]);
  const canvasVisible = taskDock.open;
  const fullCanvas = taskDock.expanded;
  const hideSource = canvasVisible && (compact || fullCanvas);
  const canvasTrigger = useRef<HTMLElement | null>(null);
  const focusDock = (tab: string) => requestAnimationFrame(() => (document.getElementById("task-dock-tab-" + tab) || document.getElementById("task-dock-add"))?.focus({ preventScroll: true }));
  function closeCanvas() {
    taskDock.close();
    requestAnimationFrame(() => {
      const trigger = canvasTrigger.current;
      if (trigger?.isConnected && trigger.getClientRects().length && !trigger.closest('#task-workspace')) trigger.focus({ preventScroll: true });
      else document.getElementById('task-workspace-toggle')?.focus({ preventScroll: true });
    });
  }
  function selectWorkspace(tab: string, focus = false) {
    if (tab === 'conversation') { setResearchFocus(null); closeCanvas(); return; }
    if (!dockChoices.some(item => item.id === tab) && !taskDock.tabs.includes(tab as TaskDockTab)) return;
    if (!canvasVisible) canvasTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    taskDock.select(tab as TaskDockTab);
    if (focus) focusDock(tab);
  }
  function openResearchCharts(chartId = '') {
    setResearchFocus({ session: researchSession, chartId });
    if (compact || fullCanvas) closeCanvas();
  }
  function openResearchInstrument(instrument: ResearchInstrument, charts: ChartBlockShape[]) {
    canvasTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setInstrumentFocus({ session: researchSession, instrument, charts });
    taskDock.select(('instrument:' + instrument.id) as TaskDockTab);
    focusDock('instrument:' + instrument.id);
  }
  function openResearchVisual(block: ChartBlockShape) {
    const instrument = research.instruments.find(item => item.chartIds.includes(block.chart_id));
    if (instrument) selectWorkspace('instrument:' + instrument.id, true);
    else openResearchCharts(block.chart_id);
  }
  function openDock() { taskDock.show(); focusDock(taskDock.selected); }
  function openBrowserDock() {
    canvasTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    taskDock.select('browser');
    focusDock('browser');
  }
  async function removeDockTab(id: string) {
    if (id === 'strategy' && strategyDirty && !await confirmDialog({ message: i18nCopy(zh, "copy.components_chat_ChatView.008"), tone: 'warning' })) return;
    taskDock.remove(id as TaskDockTab);
    if (id === 'strategy') setStrategyDirty(false);
    requestAnimationFrame(() => (document.querySelector<HTMLElement>('#task-workspace [role="tab"][aria-selected="true"]') || document.getElementById('task-dock-add'))?.focus());
  }
  function toggleCanvasSize() { taskDock.toggleSize(); }
  function openResult(id: string) {
    canvasTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const result = allResults.find(result => result.id === id);
    const tab = result ? resultTabId(result) : ('result:' + id) as TaskDockTab;
    taskDock.select(tab);
    focusDock(tab);
  }
  function revealResult(id: string) {
    const child = agentResults.find((r) => r.id === id);
    if (child?.agentId) {
      setAgentFocus((old) => ({ session: active?.id || "", id: child.agentId!, count: old.count + 1, attempt: child.attempt || 1 }));
      selectWorkspace("agents", true);
      return;
    }
    followLatest.current = false; setReadingHistory(true);
    selectWorkspace("conversation");
    requestAnimationFrame(() => {
      const message=active?.messages.find(m=>m.id===id);
      const turnId=message?.role==="assistant"?message.turn?.turn_id:undefined;
      const placeholder=turnId?document.getElementById("turn-"+encodeURIComponent(turnId)):null;
      placeholder?.scrollIntoView({block:"start"});
      const article = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("[data-turn-id]") || []).find((el) => el.dataset.turnId === id);
      article?.scrollIntoView({ block: "start" });
      article?.focus({ preventScroll: true });
    });
  }
  function pendingFirstMessageThreadId(): string {
    try {
      const raw = sessionStorage.getItem("nerya.chat.pendingFirstMessage");
      if (!raw) return "";
      const parsed = JSON.parse(raw) as { threadId?: unknown };
      return typeof parsed.threadId === "string" ? parsed.threadId : "";
    } catch {
      return "";
    }
  }

  // When the URL points at a saved session, treat the backend transcript
  // as authoritative. LocalStorage is only a UI cache and may contain an
  // older partial import from a previous dashboard load.
  useEffect(() => {
    setTranscriptLoadFailed(false);
    if (!hydrated || !sessionId) {
      setMissingSession(false);
      return;
    }
    if (pendingFirstMessageThreadId() === sessionId) {
      setMissingSession(false);
      return;
    }
    if (deletedSessionIdsRef.current.has(sessionId)) {
      setMissingSession(true);
      return;
    }
    const minUpdated = active?.backend_updated_ts || active?.updated_ts || 0;
    if (active?.transcript_loaded) {
      setMissingSession(false);
      return;
    }
    if (active && active.messages.length > 0 && !active.imported) {
      setMissingSession(false);
      return;
    }
    const cached = loadCachedThreadTranscript(sessionId, minUpdated);
    if (cached) {
      setThreads((prev) => {
        const current = prev.find((t) => t.id === sessionId);
        return upsertThread(prev, mergeAuthoritativeThread(current, cached));
      });
      setMissingSession(false);
      return;
    }
    let cancelled = false;
    setLoadingTranscriptIds((prev) => new Set(prev).add(sessionId));
    (async () => {
      try {
        const built = await buildImportedThread(
          sessionId,
          {
            created_at: isoFromMs(active?.created_ts),
            updated_at: isoFromMs(active?.updated_ts),
            title: active?.title,
          },
          { max_pairs:historyLimit,anchor_message_id:new URLSearchParams(window.location.search).get("message")||undefined },
        );
        if (cancelled) return;
        if (built) {
          setThreads((prev) => {
            const current = prev.find((t) => t.id === sessionId);
            return upsertThread(prev, mergeAuthoritativeThread(current, built));
          });
          setMissingSession(false);
        } else {
          setMissingSession(true);
        }
      } catch {
        // Transport/library error — the session may well exist. Surface a
        // retryable failure instead of claiming it is missing.
        if (!cancelled) setTranscriptLoadFailed(true);
      } finally {
        if (!cancelled) {
          setLoadingTranscriptIds((prev) => {
            const next = new Set(prev);
            next.delete(sessionId);
            return next;
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      setLoadingTranscriptIds((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, sessionId, transcriptRetry]);

  // Pick up a first message that was staged on `/chat` before the route
  // switched to `/chat/[id]`. Running it here keeps the turn alive across
  // the unmount/remount caused by navigation.
  useEffect(() => {
    if (!hydrated || !sessionId) return;
    let pending: PendingFirstMessage | null =
      pendingFirstMessages.get(sessionId) ?? null;
    if (pending) {
      pendingFirstMessages.delete(sessionId);
    }
    try {
      const raw = sessionStorage.getItem("nerya.chat.pendingFirstMessage");
      if (!pending && raw) pending = JSON.parse(raw);
    } catch {
      if (!pending) pending = null;
    }
    if (!pending || pending.threadId !== sessionId) return;
    sessionStorage.removeItem("nerya.chat.pendingFirstMessage");
    // Legacy pre-command handoffs carry no receipt ID. Restore them as drafts,
    // never automatically replay an input whose admission cannot be proven.
    setInput(pending.text);
    setAttachments(pending.attachments ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, sessionId]);

  useEffect(() => {
    followLatest.current = !hasReadingAnchor(active?.id||""); lastScrollTop.current = 0; setReadingHistory(!followLatest.current);
  }, [active?.id]);

  useEffect(() => {
    const viewport = scrollRef.current, content = transcriptRef.current;
    if (!viewport || !content) return;
    // Streaming and late-loading content follow only while the reader is at the end.
    const follow = () => {
      if (followLatest.current && viewport.clientHeight) {
        viewport.scrollTo({ top: viewport.scrollHeight });
        lastScrollTop.current = viewport.scrollTop;
      } else if (viewport.clientHeight) {
        setReadingHistory(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 80);
      }
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(content); observer.observe(viewport);
    return () => observer.disconnect();
  }, [active?.id, active?.messages.length, hydrated]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.clientHeight && followLatest.current) {
      el.scrollTo({ top: el.scrollHeight }); lastScrollTop.current = el.scrollTop;
    }
  }, [active?.messages.length, activeLiveEventCount, activeApprovalKey]);

  /** Strategy binding requested via ``/chat?strategy=<id>`` (the "+"
   * button on a sidebar strategy). Read lazily from the location so we
   * don't need a Suspense boundary for ``useSearchParams``. */
  function strategyIdFromLocation(): string {
    if (typeof window === "undefined") return "";
    try {
      return new URLSearchParams(window.location.search).get("strategy") || "";
    } catch {
      return "";
    }
  }

  function createThread(seedText?: string, id?: string): ChatThread {
    const minted = id ? { ...newThread(seedText), id } : newThread(seedText);
    const strategyId = strategyIdFromLocation();
    const t = strategyId ? { ...minted, strategy_id: strategyId, strategy_proposal_id: new URLSearchParams(window.location.search).get("proposal") } : minted;
    setThreads((prev) => upsertThread(prev, t));
    return t;
  }

  function updateThread(id: string, fn: (t: ChatThread) => ChatThread) {
    setThreads((prev) =>
      prev.map((t) => (t.id === id ? { ...fn(t), updated_ts: Date.now() } : t))
    );
  }

  async function resolveApproval(callbackData: string) {
    const approvalId = approvalIdFromCallback(callbackData);
    const action = approvalActionFromCallback(callbackData);
    if (!approvalId) return;
    const approvalKind = String(
      pendingApprovals.get(approvalId)?.record?.kind || "",
    ).toLowerCase();
    const isAutoResumedFinancialApproval = [
      "trade_intent",
      "wallet_swap",
    ].includes(approvalKind);
    setResolvingApprovalIds((prev) => new Set(prev).add(approvalId));
    try {
      const res = await clientApi.approvalCallback({
        callback_data: callbackData,
        actor_id: "dashboard",
      });
      const state = String(res?.state || "").toLowerCase();
      const resolvedApprovalKind = String(
        res?.approval_kind || approvalKind,
      ).toLowerCase();
      const resolvedAutoResumedFinancialApproval =
        isAutoResumedFinancialApproval ||
        ["trade_intent", "wallet_swap"].includes(resolvedApprovalKind);
      if (state === "approved" || state === "rejected") {
        const resolvedIds =
          Array.isArray(res?.approval_ids) && res.approval_ids.length
            ? res.approval_ids.filter((id): id is string => typeof id === "string" && !!id)
            : [approvalId];
        for (const id of resolvedIds) appendApprovalResolutionEvent(id, state);
        setPendingApprovals((prev) => {
          if (!resolvedIds.some((id) => prev.has(id))) return prev;
          const next = new Map(prev);
          for (const id of resolvedIds) next.delete(id);
          return next;
        });
      }
      await refreshApprovals();
      if (res?.ok && action === "approve" && state === "approved" && !isExternalSource(active?.source)) {
        await runAgentTurn(
          resolvedAutoResumedFinancialApproval
            ? `Financial approval ${approvalId} was approved. The frozen financial action is resumed automatically by the approval handler. Do not submit or retry the order, trade intent, or wallet transaction. Query the existing approval, order, or transaction status, report the resulting state, and continue the original task from that result.`
            : "The requested permission was approved. Continue from the pending tool call, retry the approved action, and proceed with the original task.",
          {
            visibleUser: false,
            source: "approval_continue",
            kind: "approval.continue",
            channel: "approval_continue",
            payloadExtra: {
              approval_id: approvalId,
              approval_callback_data: callbackData,
              approval_action: action,
              approval_state: state,
            },
          },
        );
      }
    } finally {
      setResolvingApprovalIds((prev) => {
        const next = new Set(prev);
        next.delete(approvalId);
        return next;
      });
    }
  }

  async function runAgentTurn(text: string, options: {
    visibleUser?: boolean; attachments?: ChatAttachment[]; source?: string; kind?: string;
    channel?: string; payloadExtra?: Record<string, unknown>; resumeTurnId?: string;
    commandKind?: "send" | "resume" | "guide";
  } = {}) {
    const clean = text.trim(), outgoing = options.attachments ?? [];
    if (workbench.connection !== "online") return;
    if (commandEngine.pending.length) { toast({ tone:'warn',message:commandErrorText('delivery_unconfirmed',zh) }); return; }
    if ((!clean && !outgoing.length) || turnInFlightRef.current || history.pending || history.edit) return;
    const approvalContinue = options.source === "approval_continue" || options.kind === "approval.continue";
    if (awaitingApproval && !approvalContinue) return;
    if (workbench.view?.pending_interactions.length) return;
    if (active && historyPending(active.id)) return;
    const thread = active || createThread(clean || outgoing[0]?.name || "Conversation", sessionId);
    const sid = thread.id, originRoute = sessionId;
    const commandKind = options.commandKind || (options.resumeTurnId ? "resume" : "send");
    const body: Record<string, unknown> = {
      source: options.source || "user_chat", kind: options.kind || "user.chat", target: "main",
      payload: { text: clean || "Please review the attached files.", channel: options.channel || "dashboard",
        attachments: outgoing.map(attachmentForRequest), ...(options.payloadExtra ?? {}) },
      ...(thread.strategy_id ? { strategy_id: thread.strategy_id, strategy_proposal_id: thread.strategy_proposal_id || undefined } : {}),
      reasoning_effort: settings.reasoning_effort === "off" ? undefined : settings.reasoning_effort,
      reasoning_summary: settings.reasoning_effort === "off" ? undefined : "auto",
      work_mode: settings.work_mode || "execute",
      permission_mode: settings.permission_mode, model_tier: settings.model_tier || undefined,
      model_provider: settings.model_provider || undefined, model_id: settings.model_id || undefined,
      model_context_window: settings.model_context_window, max_iterations: settings.max_iterations,
      max_total_tool_calls: settings.max_total_tool_calls, max_wall_seconds: settings.max_wall_seconds,
      evidence_contract: settings.evidence_contract,
      ...(options.resumeTurnId ? { resume_turn_id: options.resumeTurnId, continuation_feedback: clean } : {}),
    };
    turnInFlightRef.current = true; setSubmitting(true);
    let keepRoute = false;
    // This cache is navigation scaffolding only, never evidence of admission.
    if (!active) saveThreads(upsertThread(loadThreads(), thread));
    try {
      const command = await submitCommand(sid, commandKind, body);
      keepRoute = true;
      setThreads(previous => {
        const current = previous.find(item => item.id === sid) || thread;
        return upsertThread(previous, projectCommand(current, command));
      });
      if (externalSnapshot.current.sessionId === originRoute && options.visibleUser !== false) {
        setInput(value => value.trim() === clean ? "" : value);
        const ids = new Set(outgoing.map(file => file.id));
        setAttachments(files => files.filter(file => !ids.has(file.id)));
      }
      commandEngine.refresh();
    } catch (error) {
      keepRoute = error instanceof CommandClientError && error.uncertain;
      toast({ tone: "warn", message: commandErrorText(commandErrorCode(error), zh) });
    } finally {
      turnInFlightRef.current = false; setSubmitting(false);
      // The backend continues independently of this route's lifetime. A late
      // ACK must not navigate the user away from another conversation.
      if (!originRoute && keepRoute && externalSnapshot.current.sessionId === originRoute) router.replace(`/chat/${sid}`);
    }
  }

  async function retryFailedTurn(assistantMsgId: string) {
    if (!active || submitting || sending) return;
    const index = active.messages.findIndex(message => message.id === assistantMsgId);
    const failed = active.messages[index], previous = active.messages[index-1];
    if (failed?.role !== "assistant" || failed.execution_status === "unconfirmed" || previous?.role !== "user") return;
    const accepted = await confirmDialog({
      title: zh ? "重新运行任务" : "Run the task again",
      message: zh ? "这会新建一轮，可能重新获取数据或执行动作。原失败记录和已完成操作会保留；有可用断点时优先使用“从断点继续”。" : "This starts a new turn and may fetch data or execute actions again. The previous record and completed actions remain. Prefer a checkpoint when available.",
      okLabel: zh ? "新建一轮运行" : "Start a new turn", cancelLabel: zh ? "取消" : "Cancel",
    });
    if (accepted) await runAgentTurn(previous.text, { attachments: previous.attachments ?? [] });
  }

  async function send(text: string) {
    if (externalView) {
      if (!active) return;
      const sid = active.id, clean = text.trim();
      if (!clean || externalSendBusy.current) return;
      if (clean.length > 8000) { toast({ tone: 'warn', message: zh ? '消息最多 8000 字符。' : 'Messages are limited to 8000 characters.' }); return; }
      externalSendBusy.current = true;
      setExternalSending(true);
      const previous = externalMessageAttempt.current;
      const attempt = previous?.sid === sid && previous.text === clean ? previous : { sid, text: clean, key: uuid() };
      externalMessageAttempt.current = attempt;
      try {
        const response = await callApi<{ ok: boolean; error?: string; message: UserMessage }>(
          '/agent/session/message/append', { method: 'POST', body: { session_id: sid, text: clean, client_request_id: attempt.key } });
        if (!response.ok || !response.message?.id) throw new Error(response.error || 'Message was not saved');
        const saved = { ...response.message, ts: conversationTimestamp(response.message.ts) ?? Date.now(), backend_message_id: response.message.id };
        updateThread(sid, thread => ({ ...thread, messages: thread.messages.some(message => message.backend_message_id === saved.id || message.id === saved.id)
          ? thread.messages : [...thread.messages, saved] }));
        if (externalSnapshot.current.sessionId === sid) setInput(value => value.trim() === clean ? '' : value);
        externalMessageAttempt.current = null;
      } catch {
        toast({ tone: 'warn', message: zh ? '消息未确认保存，草稿已保留。再次发送将核对同一个请求。' : 'Message not confirmed saved. The draft and original request ID are retained.' });
      } finally { externalSendBusy.current = false; setExternalSending(false); }
      return;
    }
    await runAgentTurn(text, { visibleUser: true, attachments });
  }

  async function cancel() {
    if (!commandEngine.active || stopPending) return;
    setStopPending(true);
    try { await commandEngine.control("stop", commandEngine.active); }
    catch (error) { toast({ tone: "warn", message: commandErrorText(commandErrorCode(error), zh) }); }
    finally { setStopPending(false); }
  }

  function continueCheckpoint(turnId: string) {
    void runAgentTurn(zh ? "从已保存的断点继续，保留已完成步骤，不要重新执行已经完成的外部操作。" : "Continue from the saved checkpoint. Preserve completed work and do not repeat completed external actions.",
      { visibleUser: false, resumeTurnId: turnId, attachments: [] });
  }

  if (!hydrated) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ChatTaskHeader thread={null} agents={[]} results={[]} sending={false} approvalCount={0} loading showTabs={false}
          tab="conversation" canvasVisible={false} onSelect={selectWorkspace} onToggleCanvas={openDock} onOpenResult={openResult} />
        <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-ink-500">{t("loadingChat")}</div>
      </div>
    );
  }

  const conversationEmpty = !active || active.messages.length === 0;
  const hasCommandState = Boolean(commandEngine.data?.commands.length || commandEngine.pending.length);
  const showMissing = Boolean(sessionId && missingSession && conversationEmpty && !hasCommandState);
  const showLoadFailure = Boolean(
    sessionId && transcriptLoadFailed && conversationEmpty && !hasCommandState,
  );
  // A URL that addresses a session is still being resolved until we either
  // load its transcript or confirm it's missing. Treat that window as
  // "loading" so we never flash the new-chat hero for a session the user
  // deliberately opened (cold cache / slow transcript fetch). The pending
  // first-message case is the one exception: that thread is genuinely a
  // brand-new local chat the composer is about to populate.
  const resolvingAddressedSession =
    Boolean(sessionId) &&
    conversationEmpty && !active?.transcript_loaded &&
    !showMissing &&
    !showLoadFailure &&
    pendingFirstMessageThreadId() !== sessionId && !hasCommandState;
  const showLoading =
    conversationEmpty &&
    !showMissing &&
    !showLoadFailure &&
    (activeTranscriptLoading || resolvingAddressedSession);
  // Codex-style new-chat surface: a centred composer in the middle of
  // the canvas instead of a docked input + suggestion page. Only the
  // home route (no sessionId) or a fresh pending-first-message thread
  // reaches it now.
  const showHero =
    conversationEmpty && !externalView && !showMissing && !showLoadFailure && !showLoading && !workbench.view?.pending_interactions.length && !draft.recovery.length && !draft.storageError;

  const composerProps = {
    sessionId: active?.id,
    value: input,
    onChange: setInput,
    onSend: () => { followLatest.current = true; setReadingHistory(false); send(input); },
    onCancel: externalView ? undefined : () => { void cancel(); },
    onGuide: !externalView && commandEngine.active?.state === "running" ? () => { void runAgentTurn(input, { commandKind: "guide", attachments: [] }); } : undefined,
    submitting: externalView ? externalSending : submitting,
    stopping: stopPending || commandEngine.active?.state === "stopping",
    sending: externalView ? externalSending : sending,
    locked: externalView ? !active : workbench.connection !== "online" || Boolean(workbench.view?.pending_interactions.length) || awaitingApproval || history.pending || Boolean(history.edit),
    external: externalView,
    placeholder: externalView ? (zh ? '向此会话追加消息…' : 'Add a message to this session…') : sending ? (zh ? '补充任务，发送后排队；也可指导本轮…' : 'Queue a follow-up, or guide this turn…') : undefined,
    lockMessage: awaitingApproval ? t("approvalPaused") : th("editLabel"),
    settings,
    onSettingsChange: (next:ChatRunSettings)=>{setSettings(next);draft.setSettings(next);},
    modelOptions,
    attachments: externalView ? [] : attachments,
    onAttachmentsChange: externalView ? undefined : setAttachments,
  };

  return (
    <FinanceDraftContext.Provider value={{ disabled: sending || awaitingApproval, append: (text) => {
      setInput((previous) => appendReviewDraft(previous, text));
      selectWorkspace("conversation");
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('#chat-workspace-panel-conversation [data-chat-composer] textarea')?.focus());
      toast({ tone: "ok", message: i18nCopy(zh, "copy.components_chat_ChatView.009") });
    } }}>
    {forkTarget?.sessionId === active?.id && forkTarget && <ForkMessageDialog key={forkTarget.sessionId+forkTarget.message.id} sessionId={forkTarget.sessionId} message={forkTarget.message}
      onClose={() => setForkTarget(null)} onCreated={id => { setForkTarget(null); router.push(`/chat/${id}`); }} />}
    <ResearchVisualContext.Provider value={openResearchVisual}>
    <ResearchInstrumentContext.Provider value={openResearchInstrument}>
    <div className={`${styles.workbench} flex h-full min-h-0 min-w-0 flex-col`} data-testid="chat-workbench">
      <RuntimeNotice workbench={workbench} />
      <ChatTaskHeader workStatus={taskStatus(active,commandEngine.commands,workbench.view)} connection={workbench.connection} thread={active} agents={agentWork.rows} results={[...agentResults, ...results]} sending={sending}
        approvalCount={activeApprovalIds.length} loading={showLoading} showTabs tab={taskDock.selected || ''}
        workspaceAvailable canvasVisible={canvasVisible} onSelect={(tab) => selectWorkspace(tab, true)}
        onToggleBrowser={openBrowserDock}
        onToggleCanvas={() => { if (canvasVisible) closeCanvas(); else { taskDock.show(); focusDock(taskDock.selected || ''); } }} onOpenResult={openResult} />
      <TaskProvenance thread={active}/>
      {commandEngine.data?.branch_of && <div className="shrink-0 border-b border-[color:var(--line)] px-5 py-2 text-xs text-[color:var(--text-muted)]" data-testid="branch-origin">
        {zh ? '此分支保留了原会话上下文，不包含原操作的可执行副本。' : 'This branch retains conversation context, not executable copies of prior actions.'}
        <a className="ml-2 underline" href={`/chat/${encodeURIComponent(commandEngine.data.branch_of.session_id)}`}>{zh ? '查看原会话' : 'View original conversation'}</a>
      </div>}
      {!showHero && awaitingApproval && hideSource ? <div role="status" className="flex shrink-0 items-center justify-between gap-3 border-b border-warn/25 bg-warn/10 px-4 py-2 text-xs text-warn">
        <span>{t("approvalPausedCount", { count: activeApprovalIds.length })}</span>
        <button type="button" onClick={() => selectWorkspace("conversation", true)} className="min-h-8 rounded px-2 underline">{i18nCopy(zh, "copy.components_chat_ChatView.010")}</button>
      </div> : null}
      {externalView && hideSource && <div className="flex shrink-0 items-center border-b border-[color:var(--line)] px-4 py-2">
        <button type="button" data-testid="return-to-external-conversation" className="inline-flex min-h-9 items-center gap-2 rounded-lg px-3 text-sm hover:bg-[color:var(--panel-bg)]" onClick={() => selectWorkspace('conversation')}>
          <ConversationSourceIcon source={active?.source} size={16} />{zh ? '返回对话与工具记录' : 'Back to conversation and tools'}
        </button>
      </div>}
      <div ref={layoutRef} className="flex min-h-0 min-w-0 flex-1" data-testid="workspace-split" data-compact={compact ? "true" : "false"}>
      <div hidden={hideSource} className={!hideSource ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"} data-testid="workspace-source">
      <section id="chat-workspace-panel-conversation" aria-label={i18nCopy(zh, "copy.components_chat_ChatView.011")} className="flex min-h-0 flex-1 flex-col min-w-0">
        {showHero ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
          <AgentStart value={input} onChange={setInput} disabled={sending || awaitingApproval}
            composer={<><ConversationControls key={sessionId || 'new'} engine={commandEngine} onContinue={continueCheckpoint} onReuse={text => setInput(value => value ? value+'\n'+text : text)} /><ChatInput {...composerProps} variant="hero" /></>} />
          </div>
        ) : (
          <>
            {active && isExternalSource(active.source) && <div data-testid="external-session" className="flex flex-wrap items-center gap-2 border-b border-[color:var(--line)] px-5 py-3 text-xs text-[color:var(--text-muted)]">
              <ConversationSourceIcon source={active.source} size={18} />
              <span className="font-medium text-[color:var(--text-base)]">{active.source === "tunnel" ? "Tunnel" : "MCP"} · {zh ? "外部工作会话" : "External work session"}</span>
              <details><summary>{zh ? "会话详情" : "Session details"}</summary><code className="break-all select-all">{active.id}</code></details>
            </div>}
            {research.studies.length > 0 && <ResearchChartTabs open={showResearch} count={research.studies.length} onConversation={() => setResearchFocus(null)} onCharts={() => openResearchCharts()} />}
            {showResearch && <ResearchCharts charts={research.studies} selected={researchFocus?.chartId || ''} onSelect={openResearchCharts} />}
            <div hidden={showResearch} className={styles.transcriptViewport}>
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" data-testid="transcript-scroll"
              onWheel={(e) => { if (e.deltaY < 0) followLatest.current = false; }}
              onPointerDownCapture={(e) => { if (e.target instanceof Element && e.target.closest("summary")) followLatest.current = false; }}
              onKeyDownCapture={(e) => { if (["PageUp", "Home", "ArrowUp"].includes(e.key) || (["Enter", " "].includes(e.key) && e.target instanceof Element && e.target.closest("summary"))) followLatest.current = false; }}
              onScroll={(e) => {
                const el = e.currentTarget;
                if (!el.clientHeight) return;
                const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                if (near) followLatest.current = true;
                else if (el.scrollTop < lastScrollTop.current - 1) followLatest.current = false;
                lastScrollTop.current = el.scrollTop;
                setReadingHistory(!followLatest.current && !near);
              }}>
              {showLoadFailure ? (
                <div className="max-w-xl mx-auto px-6 py-16 text-center">
                  <h2 className="text-lg text-white font-semibold mb-2">
                    {t("transcriptLoadFailed")}
                  </h2>
                  <div className="flex items-center justify-center gap-3">
                    <button
                      onClick={() => {
                        setTranscriptLoadFailed(false);
                        setTranscriptRetry((c) => c + 1);
                      }}
                      className="btn-primary px-4 py-2 text-sm"
                    >
                      {tCommon("retry")}
                    </button>
                    <button
                      onClick={() => router.push("/chat")}
                      className="glass hover:bg-white/[0.05] hover:border-brand-500/30 px-4 py-2 text-sm text-white transition-colors"
                    >
                      {t("startNewChat")}
                    </button>
                  </div>
                </div>
              ) : showMissing ? (
                <div className="max-w-xl mx-auto px-6 py-16 text-center">
                  <h2 className="text-lg text-white font-semibold mb-2">
                    {t("sessionNotFound")}
                  </h2>
                  <p className="text-sm text-ink-400 mb-6">
                    {t.rich("sessionNotFoundBody", {
                      sessionId,
                      code: (chunks) => (
                        <span className="font-mono">{chunks}</span>
                      ),
                    })}
                  </p>
                  <button
                    onClick={() => router.push("/chat")}
                    className="glass hover:bg-white/[0.05] hover:border-brand-500/30 px-4 py-2 text-sm text-white transition-colors"
                  >
                    {t("startNewChat")}
                  </button>
                </div>
              ) : showLoading ? (
                <div className="h-full flex items-center justify-center text-ink-500 text-sm">
                  {t("loadingConversation")}
                </div>
              ) : (
                <div ref={transcriptRef} className={styles.conversation} data-testid="conversation-content">
                  {isExternalSource(active?.source) ? <ExternalSessionTimeline traces={active!.messages.flatMap(m => m.role === "assistant" && m.turn?.external_call ? [m.turn.external_call] : [])} userMessages={active!.messages.filter((m): m is UserMessage => m.role === 'user')} pendingApprovals={pendingApprovals} onApprovalAction={resolveApproval} resolvingApprovalIds={resolvingApprovalIds} /> : <ConversationTimeline messages={active!.messages} session={active!.id} scrollRef={scrollRef} hasMore={historyMore} loadingOlder={loadingOlder} onOlder={()=>void loadOlderHistory()} renderMessage={(m,mi)=>
                    m.role === "user" ? (
                      <UserBubble
                        key={m.id}
                        msg={m}
                        onFork={() => setForkTarget({ sessionId:active!.id,message:m })}
                        onEdit={() => { void history.start(m.id); }}
                        onDelete={() => { void history.requestDelete(m.id); }}
                        editing={history.edit?.message.id === m.id}
                        editValue={history.edit?.message.id === m.id ? history.edit.draft : ""}
                        editOriginal={history.edit?.original}
                        onEditChange={history.change}
                        onSaveEdit={() => { void history.save(); }}
                        onCancelEdit={() => { void history.cancel(); }}
                        saving={history.pending}
                        editError={history.editError}
                        actionsDisabled={sending || awaitingApproval || history.pending || externalView}
                      />
                    ) : m.turn?.external_call ? (
                      <ExternalCallMessage key={m.id} trace={m.turn.external_call} />
                    ) : (
                      <AssistantBubble
                        key={m.id}
                        conversationId={active!.id}
                        onOpenBrowser={openBrowserDock}
                        msg={m}
                        onOpenResult={() => openResult(m.id)}
                        pendingApprovals={pendingApprovals}
                        onApprovalAction={resolveApproval}
                        resolvingApprovalIds={resolvingApprovalIds}
                        onRetry={
                          m.error && !m.loading && m.execution_status !== "unconfirmed" && active!.messages[mi - 1]?.role === "user"
                            ? () => void retryFailedTurn(m.id)
                            : undefined
                        }
                      />
                    )
                  }/>}
                </div>
              )}
            </div>
            {readingHistory ? <button type="button" className={styles.jump} data-testid="jump-to-latest" onClick={jumpToLatest}>{i18nCopy(zh, "copy.components_chat_ChatView.012")}<span aria-hidden>↓</span></button> : null}
            </div>
            {awaitingApproval ? (
              <div
                className="border-t border-warn/25 bg-warn/[0.06] px-4 py-2 text-xs text-warn"
                role="status"
              >
                <div className="max-w-[860px] mx-auto flex items-center justify-between gap-3">
                  <span>{t("approvalPausedCount", { count: activeApprovalIds.length })}</span>
                  <span className="font-mono text-[10px] text-warn/80">
                    {activeApprovalIds[0]?.slice(0, 18)}
                  </span>
                </div>
              </div>
            ) : null}
            {draft.recovery.length>0&&<div className="mx-auto flex w-full max-w-[800px] flex-wrap items-center gap-2 px-4 text-xs" role="status"><span>{zh?"找到其他窗口保存的草稿":"Saved drafts from other windows"}</span>{draft.recovery.slice(0,3).map(row=><button type="button" key={row.key} className="min-h-11 underline" onClick={()=>draft.restore(row)}>{zh?"恢复：":"Restore: "}{row.draft.text.slice(0,40)||row.draft.attachments[0]?.name}</button>)}<button type="button" className="min-h-11" onClick={draft.dismissRecovery}>{zh?"忽略":"Dismiss"}</button></div>}
            {draft.storageError&&<p role="status" className="mx-auto max-w-[800px] px-4 text-xs text-warn">{zh?"持久化草稿暂不可用，当前输入仍保留在此窗口。":"Persistent draft storage is unavailable. Current input remains in this window."}</p>}
            <CollaborationSummary agents={agentWork.rows} onOpen={()=>selectWorkspace("agents",true)}/>
            {!externalView&&<ComposerContextSummary thread={active} settings={settings}/>}
            {workbench.view?.pending_interactions.length ? <InteractionPanel items={workbench.view.pending_interactions} onResolved={()=>{workbench.refresh();commandEngine.refresh();}} /> : null}
            {!externalView && <ConversationControls key={sessionId || 'new'} engine={commandEngine} onContinue={continueCheckpoint} onReuse={text => setInput(value => value ? value+"\n"+text : text)} />}
            {!externalView && <ChatInput {...composerProps} variant="docked" taskHeader={agentWork.rows.length ? (
              <AgentTaskBar source={agentWork} open={canvasVisible && taskDock.selected === 'agents'} onOpen={() => selectWorkspace("agents", true)} />
            ) : undefined} />}
          </>
        )}
      </section>
      </div>
      {canvasVisible && !compact && !fullCanvas ? <div role="separator" tabIndex={0} aria-label={i18nCopy(zh, "copy.components_chat_ChatView.013")} aria-orientation="vertical"
        aria-valuemin={38} aria-valuemax={62} aria-valuenow={Math.round(canvasWidth)} aria-controls="task-workspace"
        {...separatorProps} onDoubleClick={() => changeWidth(48)} onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault(); changeWidth(event.key === "Home" ? 38 : event.key === "End" ? 62 : canvasWidth + (event.key === "ArrowLeft" ? 2 : -2));
        }} className="w-1 shrink-0 touch-none cursor-col-resize bg-[color:var(--line)] hover:bg-brand-400/50 focus-visible:bg-brand-400 focus-visible:outline-none" /> : null}
      {<section id="task-workspace" role="complementary" aria-label={i18nCopy(zh, "copy.components_chat_ChatView.014")}
        hidden={!canvasVisible} className={canvasVisible ? "flex min-h-0 min-w-0 flex-col bg-[color:var(--card)]" : "hidden"}
        style={canvasVisible ? { width: fullCanvas || compact ? "100%" : `${canvasWidth}%`, flexShrink: 0 } : undefined}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented && !(event.target instanceof HTMLElement && event.target.closest("select, textarea, input, [role='dialog'], [role='menu']"))) {
            event.preventDefault(); closeCanvas();
          }
        }}>
        <TaskDockHeader tabs={dockTabs} choices={dockChoices} onRemove={id => void removeDockTab(id)} selected={taskDock.selected || ''} onSelect={tab => selectWorkspace(tab, true)} expanded={fullCanvas} onToggleSize={toggleCanvasSize} onClose={closeCanvas}/>
        {!dockTabs.length && <div className="flex min-h-0 flex-1 items-center justify-center px-6" data-testid="workspace-launcher"><div className="w-full max-w-md space-y-1">
          {toolTabs.map(tab => <button type="button" key={tab.id} onClick={() => selectWorkspace(tab.id, true)} className="flex min-h-11 w-full items-center gap-3 rounded-lg bg-[color:var(--panel-bg)] px-4 text-left text-sm hover:bg-[color:var(--line)] focus-visible:ring-2"><NeryaGlyph name={tab.id === 'files' ? 'folder' : tab.id === 'browser' ? 'globe' : 'terminal'} size={18} className="text-[color:var(--text-muted)]" />{tab.label}</button>)}
        </div></div>}
        {taskDock.tabs.includes('strategy') && strategyId && <section id="task-dock-panel-strategy" role="tabpanel" aria-labelledby="task-dock-tab-strategy" hidden={taskDock.selected !== 'strategy'} className={taskDock.selected === 'strategy' ? 'min-h-0 flex-1 overflow-auto' : 'hidden'}>
          {strategyReports.error && <div role="alert" className="flex items-center justify-between gap-2 px-4 py-2 text-xs text-warn"><span>{i18nCopy(zh, "copy.components_chat_ChatView.015")}</span><button type="button" onClick={strategyReports.retry} className="underline">{i18nCopy(zh, "copy.components_chat_ChatView.016")}</button></div>}
          <StrategyWorkflowPanel key={strategyId} embedded strategyId={strategyId} proposalId={strategyProposal} onDirtyChange={setStrategyDirty} onSaved={(view) => {
            if (active) updateThread(active.id, thread => ({ ...thread, strategy_proposal_id: view.source.proposal_id }));
            else { const url = new URL(window.location.href); if (view.source.proposal_id) url.searchParams.set('proposal', view.source.proposal_id); window.history.replaceState(window.history.state, '', url); }
            strategyReports.retry();
          }} />
        </section>}
        {strategyReports.runs.filter(run => taskDock.tabs.includes(('backtest:' + run.ts) as TaskDockTab)).map(run => <section key={run.ts} id={'task-dock-panel-backtest:' + run.ts} role="tabpanel" aria-labelledby={'task-dock-tab-backtest:' + run.ts} hidden={taskDock.selected !== 'backtest:' + run.ts} className={taskDock.selected === 'backtest:' + run.ts ? 'min-h-0 flex-1 overflow-auto p-4' : 'hidden'}>
          {taskDock.selected === 'backtest:' + run.ts && <BacktestChart strategyId={strategyId} ts={run.ts} />}
        </section>)}
        {taskDock.tabs.includes('files') && <section id="task-dock-panel-files" role="tabpanel" aria-labelledby="task-dock-tab-files" hidden={taskDock.selected !== 'files'} className={taskDock.selected === 'files' ? 'min-h-0 flex-1' : 'hidden'}><WorkspaceFiles key={active?.id || 'new'} onOpenFile={path => { taskDock.select(('file:' + path) as TaskDockTab); focusDock('file:' + path); }} /></section>}
        {taskDock.tabs.includes('terminal') && <section id="task-dock-panel-terminal" role="tabpanel" aria-labelledby="task-dock-tab-terminal" hidden={taskDock.selected !== 'terminal'} className={taskDock.selected === 'terminal' ? 'min-h-0 flex-1' : 'hidden'}><WorkspaceTerminal thread={active} /></section>}
        {taskDock.tabs.includes("browser") && <section id="task-dock-panel-browser" role="tabpanel" aria-labelledby="task-dock-tab-browser" hidden={taskDock.selected !== 'browser'} className={taskDock.selected === 'browser' ? 'min-h-0 flex-1' : 'hidden'}>
          <BrowserWorkspacePanel key={active?.id} conversationId={active?.id || ''} calls={browserOperations} active={canvasVisible && taskDock.selected === 'browser'} />
        </section>}
        {allResults.filter(result => taskDock.tabs.includes(resultTabId(result))).map(result => <section key={result.id} id={'task-dock-panel-' + resultTabId(result)} role="tabpanel" aria-labelledby={'task-dock-tab-' + resultTabId(result)} hidden={taskDock.selected !== resultTabId(result)} className={taskDock.selected === resultTabId(result) ? 'min-h-0 flex-1' : 'hidden'}>
          {canvasVisible && taskDock.selected === resultTabId(result) && <ChatResultsPanel results={[result]} selectedId={result.id} hidePicker onReveal={revealResult} onOpenFile={path=>{taskDock.select(("file:"+path) as TaskDockTab);focusDock("file:"+path);}} />}
        </section>)}
        {resources.filter(item => taskDock.tabs.includes(('resource:' + item.id) as TaskDockTab)).map(item => <section key={item.id} id={'task-dock-panel-resource:' + item.id} role="tabpanel" aria-labelledby={'task-dock-tab-resource:' + item.id} hidden={taskDock.selected !== 'resource:' + item.id} className={taskDock.selected === 'resource:' + item.id ? 'min-h-0 flex-1' : 'hidden'}>
          {taskDock.selected === 'resource:' + item.id && <WorkspaceResource item={item} />}
        </section>)}
        {openedFiles.map(({ id, item }) => <section key={id} id={'task-dock-panel-' + id} role="tabpanel" aria-labelledby={'task-dock-tab-' + id} hidden={taskDock.selected !== id} className={taskDock.selected === id ? 'min-h-0 flex-1' : 'hidden'}><WorkspaceResource item={item} /></section>)}
        {snapshots.filter(item => taskDock.tabs.includes(item.id as TaskDockTab)).map(item => <section key={item.id} id={'task-dock-panel-' + item.id} role="tabpanel" aria-labelledby={'task-dock-tab-' + item.id} hidden={taskDock.selected !== item.id} className={taskDock.selected === item.id ? 'min-h-0 flex-1 overflow-auto p-4' : 'hidden'}><PortfolioSnapshot accounts={item.accounts} /></section>)}
        {detailInstruments.filter(item => taskDock.tabs.includes(('instrument:' + item.id) as TaskDockTab)).map(item => <section key={item.id} id={'task-dock-panel-instrument:' + item.id} role="tabpanel" aria-labelledby={'task-dock-tab-instrument:' + item.id} hidden={taskDock.selected !== 'instrument:' + item.id} className={taskDock.selected === 'instrument:' + item.id ? 'min-h-0 flex-1 overflow-auto' : 'hidden'}>
          {canvasVisible && taskDock.selected === 'instrument:' + item.id && <ResearchInstrumentPanel key={researchSession + item.id + item.seenAt} instrument={item} charts={focusedInstrument?.instrument.id === item.id ? focusedInstrument.charts : research.charts} />}
        </section>)}
        {taskDock.tabs.includes("agents") && <section id="task-dock-panel-agents" role="tabpanel" aria-labelledby="task-dock-tab-agents" hidden={taskDock.selected !== 'agents'} className={taskDock.selected === 'agents' ? 'min-h-0 flex-1' : 'hidden'}>
          <AgentWorkPanel key={active?.id} source={agentWork} active={canvasVisible && taskDock.selected === 'agents'} onOpenResult={openChildResult}
            focusRequest={agentFocus.session === active?.id ? agentFocus : undefined}/>
        </section>}
      </section>}
      </div>
      {externalView && <ChatInput {...composerProps} variant="docked" taskHeader={<p className="px-1 pb-2 text-xs text-[color:var(--text-muted)]" data-testid="external-composer-hint">
        {zh ? '消息随工具结果交给外部 Agent，不会启动本地模型。' : 'Delivered with tool results; no local model is started.'}
      </p>} />}
    </div>
    </ResearchInstrumentContext.Provider>
    </ResearchVisualContext.Provider>
      <HistoryDeleteDialog open={Boolean(history.deleteTarget)} title={th("deleteMessage")} description={th("deleteMessageHelp")}
        preview={history.deleteTarget?.original || history.deleteTarget?.message.attachments?.map(file => file.name).join(", ") || ""}
        busy={history.pending} error={history.deleteError} onConfirm={() => { void history.confirmDelete(); }} onCancel={history.cancelDelete} />
    </FinanceDraftContext.Provider>
  );
}
