import type { WorkflowText } from "./workflowPresentation";

export type VerificationIssue = { code: string; message: string; where?: string };
export type Verification = {
  ok: boolean; error?: string; schema: string;
  target: { strategy_id: string; proposal_id: string | null; state: string; revision: string; source_revision: string; checked_at: string };
  validation: { ok: boolean; scope: string; blockers: VerificationIssue[]; warnings: VerificationIssue[] };
  replay: { status: string; id?: string; provenance?: Record<string, unknown>; metrics?: Record<string, unknown> };
  sources: Array<Record<string, unknown>>; report_warnings: string[];
  operation: { state: string; installed_schedules: Array<Record<string, unknown>> };
  mode: string; evaluation_mode: string; next_step: string; unverified: string[];
};
export function replayLabel(status: string, t: WorkflowText): string {
  return ({ missing: t("copy.lib_workflowVerification.001"), unbound: t("copy.lib_workflowVerification.002"), stale: t("copy.lib_workflowVerification.003"), sample: t("copy.lib_workflowVerification.004"), failed: t("copy.lib_workflowVerification.005"), limited: t("copy.lib_workflowVerification.006"), verified: t("copy.lib_workflowVerification.007") } as Record<string, string>)[status] || t("copy.lib_workflowVerification.008");
}
export function verificationSummary(v: Verification, t: WorkflowText): string {
  if (!v.validation.ok) return t("copy.lib_workflowVerification.009");
  if (v.replay.status === "missing") return t("copy.lib_workflowVerification.010");
  if (v.replay.status === "stale") return t("copy.lib_workflowVerification.011");
  if (v.replay.status === "sample") return t("copy.lib_workflowVerification.012");
  if (v.replay.status === "verified") return t("copy.lib_workflowVerification.013");
  return t("copy.lib_workflowVerification.014");
}
export function verificationPrompt(v: Verification, t: WorkflowText): string {
  const issues = v.validation.blockers.map((issue) => `${issue.where || t("copy.lib_workflowVerification.configuration")}: ${issue.message}`).join("\n");
  return t("copy.lib_workflowVerification.015", { value0: v.target.strategy_id, value1: v.target.proposal_id || t("copy.lib_workflowVerification.currentVersion"), value2: v.target.source_revision, value3: verificationSummary(v, t), value4: issues ? t("copy.lib_workflowVerification.issues", { issues }) : "" });
}
export function exportVerification(value: Verification): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = `${value.target.strategy_id}-verification.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
