"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "next-intl";
import { ApiError, callApi } from "../lib/clientApi";
import { caseCopy, type MandateDemo } from "../lib/mandateDemo";
import styles from "../app/dashboard/safety/safety.module.css";

type Request = { scenario: string; allowed_market: string; request_market: string; amount: number; ceiling: number; max_cost: number; budget: number; allow_long: boolean };
type Job = { id: string; state: "running" | "completed" | "failed"; request: Request; result: MandateDemo | null; error: string | null };
type Reply = { ok: boolean; error?: string; missing?: string[]; job?: Job | null };
const initial: Request = { scenario: "custom", allowed_market: "mock:BTC/USDT", request_market: "mock:BTC/USDT", amount: 100, ceiling: 101, max_cost: 110, budget: 500, allow_long: true };

export function MandatePlayground({ onResult }: { onResult: (result: MandateDemo) => void }) {
  const zh = useLocale().startsWith("zh");
  const t = (cn: string, en: string) => zh ? cn : en;
  const [form, setForm] = useState(initial);
  const [job, setJob] = useState<Job | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const [available, setAvailable] = useState(false);
  const [checking, setChecking] = useState(true);
  const inFlight = useRef(false);
  const retry = useRef<{ id: string; key: string } | null>(null);
  const lastResult = useRef("");
  const mounted = useRef(true);
  const busy = pending || job?.state === "running";
  const accept = useCallback((reply: Reply) => {
    if (!mounted.current) return;
    if (!reply.ok) throw new Error(reply.error || "demo_unavailable");
    setAvailable(true); setMissing(reply.missing || []); setError("");
    if (reply.job) {
      setJob(reply.job);
      if (reply.job.state === "completed" && reply.job.result && lastResult.current !== reply.job.id) {
        lastResult.current = reply.job.id; onResult(reply.job.result);
      }
      if (reply.job.state === "failed") setError(reply.job.error || "demo_execution_failed");
    } else setJob(null);
  }, [onResult]);
  const check = useCallback(async () => {
    try { accept(await callApi<Reply>("/safety/demo/status", { signal: AbortSignal.timeout(15000) })); }
    catch { if (mounted.current) { setError("demo_unavailable"); setAvailable(false); } }
    finally { if (mounted.current) setChecking(false); }
  }, [accept]);
  useEffect(() => { mounted.current = true; void check(); return () => { mounted.current = false; }; }, [check]);
  useEffect(() => {
    if (job?.state !== "running") return;
    let disposed = false;
    const timer = setTimeout(async () => {
      try {
        const reply = await callApi<Reply>(`/safety/demo/status?job_id=${encodeURIComponent(job.id)}`, { signal: AbortSignal.timeout(15000) });
        if (!disposed) accept(reply);
      } catch { if (!disposed) setError("demo_status_unavailable"); }
      // Trigger another bounded poll even after a temporary transport error.
      if (!disposed) setJob(current => current ? { ...current } : null);
    }, 1000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [job, accept]);
  async function run() {
    if (inFlight.current || busy) return;
    inFlight.current = true; setPending(true); setError("");
    const key = JSON.stringify(form);
    try {
      if (retry.current?.key !== key) retry.current = { key, id: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("") };
      const reply = await callApi<Reply>("/safety/demo/run", { method: "POST", signal: AbortSignal.timeout(15000), body: { request_id: retry.current.id, request: form } });
      accept(reply);
      retry.current = null;
    } catch (value) {
      if (mounted.current) {
        if (value instanceof ApiError && value.message.includes("ModuleNotFoundError")) {
          setError("demo_runtime_missing"); setAvailable(false);
        } else setError(value instanceof ApiError && value.status >= 500 ? "demo_server_error" : value instanceof Error && value.message.startsWith("demo_") ? value.message : "demo_start_failed");
      }
    } finally { inFlight.current = false; if (mounted.current) setPending(false); }
  }
  const errors: Record<string, string> = {
    demo_runtime_missing: t("后端缺少演示执行模块，任务没有启动。代码更新后，请重启 Nerya 后端，再点击检查连接。", "The backend cannot load the demo runner. No job started. Restart the backend after updating the code, then check the connection."),
    demo_server_error: t("后端启动演示时发生错误，尚未获得运行结果。请检查后端服务，不要把连接成功当作执行成功。", "The backend failed to start the demo. No result is available; a connected API does not mean execution succeeded."),
    demo_unavailable: t("演示 API 尚未连接。首次更新后请重启 Nerya 后端，再点击检查连接。", "Demo API unavailable. Restart the Nerya backend after this update, then check the connection."),
    demo_busy: t("后端已有演示正在运行，点击检查连接查看状态。", "A demo is already running. Check the connection to retrieve its status."),
    demo_start_failed: t("启动响应未确认。可以重试，同一请求不会重复创建任务。", "Start was not confirmed. Retry safely; the same request will not create another job."),
    demo_status_unavailable: t("暂时无法读取进度，正在重新查询；不会自动重新下单。", "Status temporarily unavailable. Polling again without submitting another action."),
    demo_execution_failed: t("本次运行失败。请检查 Anvil、合约构建和 Python 依赖后重试；未返回成功结果。", "This run failed. Check Anvil, the contract build and Python dependencies, then retry. No successful outcome is assumed."),
    demo_dependencies_missing: t("缺少运行依赖，请查看下方提示。", "Runtime dependencies are missing; see the instructions below."),
  };
  const presets = [["custom", "自定义授权", "Custom policy"], ["allowed", "正常执行", "Allowed action"], ["market", "市场越界", "Market boundary"], ["fees", "费用后超限", "Fees exceed limit"], ["long", "禁止新开多头", "No long opening"], ["tamper", "篡改动作", "Tampered plan"], ["replay", "重复提交", "Replay"], ["revoke", "撤销后再尝试", "Revoke, then attempt"], ["suite", "完整 7 案例", "All 7 cases"]];
  const descriptions: Record<string, [string, string]> = {
    allowed: ["授权 BTC，提交 100 USD 开多请求，动作成本上限 101 USD。检查能否完成模拟成交。", "Authorize BTC, request a $100 long opening with a $101 action ceiling, and check paper execution."],
    market: ["用户只允许 ETH，Agent 却请求买入 BTC。检查是否在创建执行器之前停止。", "The user permits only ETH; the agent requests BTC. Check whether it stops before creating an executor."],
    fees: ["请求金额 99 USD，动作成本上限也为 99 USD。合约登记后，再检查手续费和滑点是否使运行时拒绝。", "The order and signed ceiling are both $99. After chain registration, check whether fees and slippage cause runtime rejection."],
    long: ["用户禁止新开多头，Agent 仍请求 100 USD 开多。检查签名授权是否真正限制方向。", "The user prohibits new longs; the agent requests a $100 long opening. Check enforcement of the direction constraint."],
    tamper: ["先完成一笔正常请求，再把已签署动作的金额从 100 改为 777 USD。检查改动能否被发现。", "Complete a normal request, then change its signed amount from $100 to $777. Check whether the change is detected."],
    replay: ["先完成一笔模拟成交，再通过恢复路径重发同一动作。检查是否会重复成交。", "Complete a paper fill, then resubmit the same action through the resume path. Check whether another fill occurs."],
    revoke: ["先登记 80 USD 请求的授权，由测试 owner 发出撤销交易，再尝试执行。检查撤销后的请求是否被停止。", "Anchor an $80 request, submit a revocation as the test owner, then attempt execution. Check whether the revoked request stops."],
    suite: ["依次运行正常执行、市场越界、费用超限、禁止开多、篡改、重放和撤销，汇总每次实际结果。", "Run all seven scenarios and collect the actual outcome of each: allowed, market, fees, direction, tampering, replay and revocation."],
  };
  const completed = !busy && !error && job?.state === "completed" ? job.result : null;
  const lastCase = completed?.cases.at(-1);
  return <section className={`${styles.panel} ${styles.playground}`} data-testid="mandate-playground">
    <div className={styles.sectionHead}><div className={styles.eyebrow}>TRY IT / {t("现场操作", "INTERACTIVE RUN")}</div><h2>{t("亲自设定边界，再让 Agent 尝试", "Set the boundary. Let the agent try.")}</h2>
      <p>{t("每次运行创建独立的本地链与模拟账户，后端实际验签、登记授权并检查执行。可以修改条件后再次运行，对比结果。", "Each run creates an isolated local chain and paper account. The backend verifies signatures, registers authorization and checks execution. Change the conditions and run again to compare outcomes.")}</p></div>
    <p className={styles.stepLabel}>{t("1. 选择一个场景，或自定义授权", "1. Choose a scenario or set your own policy")}</p>
    <div className={styles.presets} role="group" aria-label={t("选择运行场景", "Choose a scenario")}>{presets.map(([key, cn, en]) => <button key={key} className={styles.button} disabled={busy} aria-pressed={form.scenario === key} onClick={() => setForm({ ...initial, scenario: key })}>{t(cn, en)}</button>)}</div>
    <form onSubmit={event => { event.preventDefault(); void run(); }}>
      <fieldset disabled={busy}>
        {form.scenario === "custom" ? <>
          <div className={styles.formGrid}>
            <label>{t("允许的市场", "Permitted market")}<select aria-label={t("允许的市场", "Permitted market")} value={form.allowed_market} onChange={e => setForm({ ...form, allowed_market: e.target.value })}><option>mock:BTC/USDT</option><option>mock:ETH/USDT</option></select></label>
            <label>{t("Agent 请求市场", "Requested market")}<select aria-label={t("Agent 请求市场", "Requested market")} value={form.request_market} onChange={e => setForm({ ...form, request_market: e.target.value })}><option>mock:BTC/USDT</option><option>mock:ETH/USDT</option></select></label>
            {([["max_cost", "单笔上限（USD）", "Per-action limit (USD)"], ["budget", "累计授权预算（USD）", "Policy budget (USD)"], ["amount", "请求名义金额（USD）", "Requested notional (USD)"], ["ceiling", "动作成本上限（USD）", "Signed action ceiling (USD)"]] as const).map(([key, cn, en]) => <label key={key}>{t(cn, en)}<input type="number" min={1} max={1000} step={1} required value={Number.isNaN(form[key]) ? "" : form[key]} onChange={e => setForm({ ...form, [key]: e.target.valueAsNumber })}/></label>)}
          </div>
          <label className={styles.check}><input type="checkbox" checked={form.allow_long} onChange={e => setForm({ ...form, allow_long: e.target.checked })}/>{t("允许新开多头（本次请求为开多）", "Allow new long openings (this request opens a long)")}</label>
        </> : <p className={styles.presetHint}>{t(...descriptions[form.scenario])}</p>}
      </fieldset>
      <p className={styles.stepLabel}>{t("2. 点击运行，等待后端返回实际结果", "2. Run the check and wait for the backend result")}</p>
      <div className={styles.actions}>
        <button type="submit" className={styles.primary} disabled={busy || checking || !available || missing.length > 0}>{busy ? t("正在运行本地链与安全检查…", "Running local chain & safety checks…") : t("运行安全检查", "Run safety check")}</button>
        <button type="button" className={styles.button} onClick={() => void check()} disabled={pending}>{checking ? t("连接中…", "Connecting…") : t("检查连接 / 恢复进度", "Check connection / recover progress")}</button>
      </div>
    </form>
    <div role="status" aria-live="polite" className={styles.liveStatus}>
      {busy ? <p>{t("后端正在运行。离开页面不会取消任务，重新打开可恢复状态。", "The backend is running. Leaving this page does not cancel the job; reopening retrieves its status.")}</p> : !error && job?.state === "completed" ? <p className={styles.allow}>{t("本次运行已完成，结果已更新到下方。", "Run completed. The results below have been updated.")}</p> : !error && available && !missing.length ? <p>{t("运行环境已连接，可以开始。", "Runtime connected. Ready to run.")}</p> : null}
      {job && <code data-testid="demo-job-id">Job {job.id}</code>}
      {error && <p role="alert">{errors[error] || t("请求未完成，请检查连接后重试。", "Request incomplete. Check the connection and retry.")}</p>}
      {!!missing.length && <><p>{t("缺少依赖", "Missing dependencies")}: {missing.join(", ")}</p><pre>python -m pip install ".[mandates]"{`\n`}forge build --root contracts/mandates</pre></>}
    </div>
    {completed && lastCase && <section className={styles.runResult} data-testid="live-demo-result" aria-label={t("本次实际结果", "Actual run result")}>
      <div className={styles.eyebrow}>{t("3. 本次实际结果", "3. ACTUAL RUN RESULT")}</div>
      <h3 className={lastCase.status === "rejected" ? styles.deny : styles.allow}>{completed.cases.length > 1 ? t(`已完成 ${completed.cases.length} 个检查`, `${completed.cases.length} checks completed`) : lastCase.status === "rejected" ? t("已拒绝：请求未进入执行", "Rejected: request stopped before execution") : t("授权范围内，模拟成交完成", "Within policy: paper fill completed")}</h3>
      <p>{caseCopy(lastCase, zh).description}</p>
      <dl className={styles.outcome}><div><dt>{t("允许 / 拒绝", "Filled / Rejected")}</dt><dd>{completed.cases.filter(c => c.status === "filled").length} / {completed.cases.filter(c => c.status === "rejected").length}</dd></div><div><dt>{t("拒绝案例新增执行器", "New executors in rejected cases")}</dt><dd>{completed.cases.filter(c => c.status === "rejected").reduce((total, c) => total + c.newExecutors, 0)}</dd></div><div><dt>{t("本地链收据", "Local-chain receipts")}</dt><dd>{completed.receipts.length}</dd></div></dl>
      <p><code>{lastCase.reason}</code></p>
      <button className={styles.button} onClick={() => { onResult(completed); document.getElementById("safety-results")?.scrollIntoView({ block: "start" }); }}>{t("查看本次详细证据 ↓", "Inspect this run's evidence ↓")}</button>
    </section>}
    <p className={styles.muted}>{t("这是可实际运行的隔离演示：测试 owner 与 Agent 自动签名，使用合成行情，不连接真实资金。撤销只作用于本次演示授权；不代表已接入真人钱包授权流程。", "This is an executable isolated demonstration: test-owner and agent signatures are automated, prices are synthetic, and no real funds are connected. Revocation affects this demo only; this is not a human-wallet authorization flow.")}</p>
  </section>;
}
