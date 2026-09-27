"use client";
import { Icon as NeryaGlyph } from "../icons";

import { useTranslations } from "next-intl";
import type { SetupReadinessEnvelope } from "../../lib/operatorTypes";

export const STEPS = ["llm", "account", "password"] as const;
export type Step = typeof STEPS[number];
const CHECK_NAMES: Record<Step, string> = {
  llm: "LLM provider", account: "Trading account", password: "Admin password",
};

export function setupSaved(env: SetupReadinessEnvelope, step: Step): boolean {
  return env.data.checks.some(check => check.name === CHECK_NAMES[step] && check.status === "ok");
}

/** The cursor is only a preference: it can never skip unsaved configuration. */
export function resolveSetupStep(env: SetupReadinessEnvelope, requested: string | null): Step {
  const firstMissing = STEPS.findIndex(step => !setupSaved(env, step));
  const limit = firstMissing < 0 ? STEPS.length - 1 : firstMissing;
  const index = STEPS.indexOf(requested as Step);
  return STEPS[index < 0 ? limit : Math.min(index, limit)];
}

export function pendingSetupStep(env: SetupReadinessEnvelope, drafts: ReadonlySet<Step>): Step | undefined {
  // Never inspect the envelope's unrelated diagnostics or operational gates.
  return STEPS.find(step => !setupSaved(env, step) || drafts.has(step));
}

export function SetupSteps({ current, busy, furthest, saved, drafts, onChange }: {
  current: Step;
  busy: boolean;
  furthest: number;
  saved: SetupReadinessEnvelope | null;
  drafts: ReadonlySet<Step>;
  onChange: (step: Step) => void;
}) {
  const t = useTranslations("setupWizard");
  return <nav aria-label={t("stepsLabel")}>
    <ol className="grid grid-cols-3 gap-2 sm:gap-4">
      {STEPS.map((step, index) => <li key={step}>
        <button type="button" aria-current={current === step ? "step" : undefined}
          disabled={busy || index > furthest}
          onClick={() => onChange(step)}
          className={`w-full rounded-lg border px-2 py-3 text-left transition-colors sm:px-3 disabled:cursor-not-allowed disabled:opacity-50 ${current === step ? "border-[color:var(--text-base)] bg-[color:var(--card-hi)]" : "border-[color:var(--line)] text-[color:var(--text-muted)]"}`}>
          <span aria-hidden="true" className="block text-xs tabular-nums">{saved && setupSaved(saved, step) && !drafts.has(step) ? <NeryaGlyph name="check" size={16} /> : String(index + 1).padStart(2, "0")}</span>
          <span className="mt-1 block text-xs font-medium sm:text-sm">{t(`steps.${step}`)}</span>
        </button>
      </li>)}
    </ol>
  </nav>;
}
