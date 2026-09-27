/** Presentation of actual tool inputs/results only; never infer trading outcomes. */
export type ToolFamily = "skill" | "shell" | "search" | "read" | "edit" | "plan" | "message" | "backtest" | "strategy" | "market" | "research" | "portfolio" | "agent" | "browser" | "mcp" | "tool";
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const labels: Record<ToolFamily, [string, string]> = {
  skill:["加载技能","Load skill"], shell:["执行命令","Run command"], search:["搜索资料","Search"],
  read:["读取内容","Read"], edit:["修改文件","Edit file"], plan:["更新任务","Update tasks"],
  message:["发送消息","Send message"], backtest:["运行回测","Run backtest"], strategy:["策略操作","Strategy"],
  market:["获取行情","Fetch market data"], research:["投研分析","Research"], portfolio:["查看账户与持仓","Inspect portfolio"],
  agent:["协作执行","Delegate work"], browser:["操作浏览器","Use browser"], mcp:["调用外部工具","Call external tool"], tool:["调用工具","Run tool"],
};
const actions: Record<string, [string, string]> = {
  strategy_view:["查看策略","Inspect strategy"], strategy_list:["列出策略","List strategies"],
  strategy_create:["创建策略","Create strategy"], strategy_update:["更新策略","Update strategy"],
  strategy_backtest:["运行回测","Run backtest"],
  strategy_validate:["验证策略","Validate strategy"], strategy_run_tick:["执行策略轮次","Run strategy tick"],
  strategy_run_history:["读取策略记录","Read strategy history"], strategy_history:["读取策略历史","Read strategy history"],
  research_publish_visuals:["发布投研图表","Publish research visuals"], web_fetch:["读取网页","Read webpage"],
  skill_view:["读取技能","Read skill"], script_run:["运行技能脚本","Run skill script"],
  team_run:["运行 Agent 团队","Run agent team"], subagent_run:["委派 Agent","Delegate to agent"],
  read_file:["读取文件","Read file"], write_file:["写入文件","Write file"], edit_file:["编辑文件","Edit file"],
};

export function toolSemantics(rawName: string, payload: Record<string, unknown>, zh: boolean) {
  const name = rawName.toLowerCase().replace(/^nerya_/, "");
  const skill = text(payload.skill || payload.skill_id);
  const script = text(payload.script || payload.script_path || payload.path);
  // 文件路径只描述目标，不代表动作：读取 backtest.py 不能显示成运行回测。
  const scope = (name === "script_run" ? [name, skill, script].join(" ") : name).toLowerCase();
  const family: ToolFamily = /^(skill|skill_view|skill_load)$/.test(name) ? "skill"
    : /backtest/.test(scope) ? "backtest" : /strategy/.test(scope) ? "strategy"
    : /browser/.test(scope) ? "browser" : /^(team_run|subagent_run|agent_run)$/.test(name) ? "agent"
    : /^(mcp_|mcp\.)/.test(name) ? "mcp" : /market_data|get_candles|ticker|order_book|funding_rate/.test(scope) ? "market"
    : /portfolio|account_list|positions|balances/.test(name) ? "portfolio"
    : (/publish_visual|research/.test(scope) && name === "script_run") || /research_publish/.test(name) ? "research"
    : /todo|plan/.test(name) ? "plan" : /message/.test(name) ? "message"
    : /search|grep|glob/.test(name) ? "search" : /read|fetch|view|list_dir/.test(name) ? "read"
    : /edit|write|patch|create/.test(name) ? "edit" : /shell|bash|exec|command|script_run/.test(name) ? "shell" : "tool";
  const specific = actions[name];
  const title = (specific && !(name === "script_run" && family !== "shell") ? specific : labels[family])[zh ? 0 : 1];
  const target = text(payload.strategy_id || payload.market || payload.symbol || payload.path || payload.file_path || payload.query || payload.search_query || payload.url || payload.command || payload.cmd || payload.pattern || payload.task || payload.goal || payload.description);
  const subject = family === "mcp" ? [text(payload.namespace || payload.server), text(payload.tool || payload.name)].filter(Boolean).join(" / ") || target || name
    : family === "skill" ? skill || text(payload.name) || name
    : name === "script_run" ? [skill, script].filter(Boolean).join(" / ") || target || name
    : target || skill || name.replace(/_/g," ");
  return { family, title, subject };
}

export function toolResultSummary(value: Record<string, unknown>, zh: boolean): string {
  for (const key of ["summary", "message", "description"]) {
    if (typeof value[key] === "string" && value[key]) return String(value[key]).replace(/\s+/g," ").slice(0,160);
  }
  for (const key of ["candles", "sources", "matches", "items", "results", "rows"]) {
    if (Array.isArray(value[key])) return `${(value[key] as unknown[]).length} ${key === "candles" ? (zh ? "条 K 线" : "candles") : key === "sources" ? (zh ? "项来源" : "sources") : (zh ? "项结果" : "results")}`;
  }
  if (typeof value.exit_code === "number") return `${zh ? "退出码" : "Exit"} ${value.exit_code}`;
  if (typeof value.count === "number") return `${value.count} ${zh ? "项结果" : "results"}`;
  return "";
}

export function plainToolOutput(value: unknown, limit = 32000): { text: string; truncated: boolean } {
  const source = typeof value === "string" ? value : "";
  // Strip terminal control sequences, not ordinary Unicode or repeated tokens.
  const cleaned = source.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  return { text: cleaned.slice(-limit), truncated: cleaned.length > limit };
}
