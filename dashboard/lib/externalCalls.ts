export type ExternalSource = "mcp" | "tunnel";

export type ExternalCallNode = {
  call_id: string;
  parent_call_id?: string;
  tool: string;
  arguments?: unknown;
  result?: unknown;
  status: string;
  started_at?: string;
  elapsed_ms?: number | null;
  /** Server-resolved chart/artifact descriptors; execution data stays in result. */
  presentation_blocks?: unknown[];
};

export type ExternalCallTrace = ExternalCallNode & {
  turn_id?: string;
  turn_title?: string;
  sequence?: number;
  activity?: Partial<Record<"intent" | "hypothesis" | "evidence" | "conclusion" | "next" | "status", string>>;
  purpose?: string;
  description?: string;
  source: ExternalSource;
  remote_session_id: string;
  request_id?: unknown;
  client_name?: string;
  nodes?: ExternalCallNode[];
};

export function isExternalSource(source?: string): source is ExternalSource {
  return source === "mcp" || source === "tunnel";
}

/** Numeric DB timestamps are seconds; cached browser timestamps are milliseconds. */
export function conversationTimestamp(value: string | number | null | undefined): number | null {
  if (value == null || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(numeric)) return numeric < 100_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function callDepth(node: ExternalCallNode, nodes: ExternalCallNode[], root: string): number {
  let parent = node.parent_call_id;
  let depth = 0;
  const seen = new Set<string>([node.call_id]);
  while (parent && parent !== root && !seen.has(parent) && depth < 8) {
    seen.add(parent);
    const ancestor = nodes.find(item => item.call_id === parent);
    if (!ancestor) break;
    depth += 1;
    parent = ancestor.parent_call_id;
  }
  return depth;
}

export function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function publicProgress(trace: ExternalCallTrace) {
  return trace.tool === "nerya_progress" ? recordOf(trace.arguments) : {};
}

export function actionTitle(trace: ExternalCallTrace, zh: boolean): string {
  const progress = publicProgress(trace);
  const authored = progress.current || trace.activity?.next || trace.purpose;
  if (typeof authored === "string" && authored.trim()) return authored;
  const name = trace.tool.replace(/^nerya_(native_)?/, "");
  const labels: Record<string, [string, string]> = {
    read_file: ["读取文件", "Read file"], write_file: ["写入文件", "Write file"],
    edit_file: ["修改文件", "Edit file"], list_dir: ["查看目录", "List directory"],
    run_shell: ["执行命令", "Run command"], run_python: ["执行脚本", "Run script"],
    role_list: ["查看 Agent 角色", "List agent roles"], role_get: ["查看角色定义", "Read role"],
    config_get: ["读取配置", "Read configuration"],
    strategy_generate: ["生成策略提案", "Generate strategy proposal"],
    strategy_validate: ["校验策略", "Validate strategy"],
    strategy_backtest: ["执行策略回测", "Backtest strategy"],
    evolve_proposals: ["查看变更提案", "Inspect proposals"], proposals_show: ["读取提案", "Read proposal"],
    progress: ["工作进展", "Work progress"],
  };
  const title = labels[name]?.[zh ? 0 : 1] || trace.tool;
  const args = recordOf(trace.arguments);
  const target = ["path", "target", "strategy_id", "proposal_id", "query"].map(k => args[k]).find(v => typeof v === "string" && v);
  return target ? `${title} · ${String(target).slice(0, 180)}` : title;
}

export type ExternalTask = { id: string; title: string; calls: ExternalCallTrace[] };
export function groupExternalCalls(traces: ExternalCallTrace[]): ExternalTask[] {
  const groups = new Map<string, ExternalTask>();
  // Update by call ID, never by turn ID: a task contains MANY tool calls.
  const unique = new Map(traces.map(trace => [trace.call_id, trace]));
  for (const trace of unique.values()) {
    const id = trace.turn_id || "legacy-calls";
    let task = groups.get(id);
    if (!task) { task = { id, title: trace.turn_title || trace.activity?.intent || "", calls: [] }; groups.set(id, task); }
    task.calls.push(trace);
  }
  for (const task of groups.values()) task.calls.sort((a, b) =>
    (a.sequence || 0) - (b.sequence || 0) || (Date.parse(a.started_at || "") || 0) - (Date.parse(b.started_at || "") || 0));
  return [...groups.values()];
}
