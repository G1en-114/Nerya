"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ErrorBanner, PageBody, PageHeader } from "./Page";
import { SettingsWorkspace } from "./SettingsWorkspace";
import { AddAccountForm } from "./accounts/AddAccountForm";
import { clientApi, type AccountSummary, type AuthStatus } from "../lib/clientApi";
import { setStoredAuthToken } from "../lib/auth";
import { confirm, toast } from "../lib/dialogs";

import type { SetupReadinessEnvelope } from "../lib/operatorTypes";
import { STEPS, SetupSteps, setupSaved, resolveSetupStep, pendingSetupStep, type Step } from "./setup/SetupSteps";
// Version the cursor: the old wizard started with password, not model setup.
const STEP_STORAGE_KEY = "nerya.setup.step.v2";

type StepProps = {
  onComplete: () => void;
  onBusyChange?: (busy: boolean) => void;
};

function AccountStep({ onComplete, onBusyChange }: StepProps) {
  const t = useTranslations("setupWizard");
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    clientApi.accountsList().then((result) => {
      if (!active) return;
      if (!Array.isArray(result.accounts)) throw new Error(t("loadFailed"));
      setAccounts(result.accounts);
      setAdding(result.accounts.length === 0);
    }).catch((value: unknown) => {
      if (active) setError(value instanceof Error ? value.message : String(value));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
    // A locale change must not reset an account draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  useEffect(() => {
    if (!adding) onBusyChange?.(loading);
  }, [adding, loading, onBusyChange]);

  if (loading) return <p role="status">{t("loading")}</p>;
  if (error) return <ErrorBanner error={error} onRetry={() => setAttempt(value => value + 1)} />;
  if (adding) return <AddAccountForm
    setupMode
    formId="nerya-setup-account"
    onBusyChange={onBusyChange}
    onCancel={accounts.length ? () => setAdding(false) : undefined}
    onSaved={(account) => {
      setAccounts(previous => [...previous.filter(row => row.profile.id !== account.profile.id), account]);
      setAdding(false);
      onComplete();
    }}
  />;

  return <form id="nerya-setup-account" onSubmit={(event) => { event.preventDefault(); onComplete(); }} className="space-y-4">
    <p role="status" className="text-sm text-[color:var(--text-base)]">{t("account.configured", { count: accounts.length })}</p>
    <ul className="divide-y divide-[color:var(--line)] rounded-lg border border-[color:var(--line)] px-4">
      {accounts.map(({ profile }) => <li key={profile.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
        <span className="break-all font-medium">{profile.id}</span>
        <span className="text-[color:var(--text-muted)]">{profile.venue} · {profile.mode}</span>
      </li>)}
    </ul>
    <p className="text-sm text-[color:var(--text-muted)]">{t("account.keepExisting")}</p>
    <button type="button" className="btn btn-secondary" onClick={() => setAdding(true)}>{t("account.add")}</button>
  </form>;
}

function PasswordStep({ onComplete, onBusyChange }: StepProps) {
  const t = useTranslations("setupWizard");
  const tAuth = useTranslations("settings.authCard");
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [rotate, setRotate] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError("");
    clientApi.authStatus().then(value => {
      if (!value.ok) throw new Error(t("loadFailed"));
      if (active) setStatus(value);
    }).catch((value: unknown) => {
      if (active) setLoadError(value instanceof Error ? value.message : String(value));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [attempt]);
  useEffect(() => { onBusyChange?.(loading || saving); }, [loading, saving, onBusyChange]);

  async function submit() {
    if (loading || saving || !status || loadError) return;
    setError("");
    if (status.password_configured && !rotate) { onComplete(); return; }
    if (password.length < 8) { setError(tAuth("tooShort")); return; }
    if (password !== confirmation) { setError(tAuth("mismatch")); return; }
    setSaving(true);
    try {
      const result = await clientApi.authSetPassword({
        new_password: password,
        ...(status.password_configured ? { current_password: currentPassword } : {}),
      });
      if (!result.ok) throw new Error(result.detail || result.error || t("saveFailed"));
      setCurrentPassword(""); setPassword(""); setConfirmation("");
      setStatus(previous => previous ? { ...previous, password_configured: true } : previous);
      setRotate(false); setVisible(false);
      // Keep this transaction mounted until completion/readiness resolves. A same-tab
      // auth refresh here would discard other steps' drafts and rewrite the cursor.
      if (result.token) setStoredAuthToken(result.token, result.expires_at, { notify: false });
      onComplete();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally { setSaving(false); }
  }

  return <form id="nerya-setup-password" onSubmit={(event) => { event.preventDefault(); void submit(); }} className="space-y-4">
    <ErrorBanner error={loadError} onRetry={() => setAttempt(value => value + 1)} />
    {loading ? <p role="status">{t("loading")}</p> : null}
    <fieldset disabled={loading || saving || !!loadError} className="min-w-0 space-y-4">
      {status?.password_configured ? <div className="space-y-2 rounded-lg border border-[color:var(--line)] p-4">
        <p role="status" className="text-sm">{t("passwordConfigured")}</p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={rotate} onChange={event => setRotate(event.target.checked)} />
          {t("changePassword")}
        </label>
      </div> : null}
      {!status?.password_configured || rotate ? <>
        {status?.password_configured ? <label className="block space-y-2 text-sm" htmlFor="setup-current-password">
          <span>{tAuth("currentPassword")}</span>
          <input id="setup-current-password" className="input-dark w-full" type="password" autoComplete="current-password" required
            value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} />
        </label> : null}
        <label className="block space-y-2 text-sm" htmlFor="setup-password">
          <span>{tAuth("newPassword")}</span>
          <input id="setup-password" className="input-dark w-full" type={visible ? "text" : "password"} autoComplete="new-password" required minLength={8}
            aria-describedby="setup-password-hint" value={password} onChange={event => setPassword(event.target.value)} />
        </label>
        <p id="setup-password-hint" className="text-xs text-[color:var(--text-muted)]">{tAuth("minLength")}</p>
        <label className="block space-y-2 text-sm" htmlFor="setup-confirm-password">
          <span>{tAuth("confirmPassword")}</span>
          <input id="setup-confirm-password" className="input-dark w-full" type={visible ? "text" : "password"} autoComplete="new-password" required
            value={confirmation} onChange={event => setConfirmation(event.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-sm text-[color:var(--text-muted)]">
          <input type="checkbox" checked={visible} onChange={event => setVisible(event.target.checked)} />{t("showPassword")}
        </label>
      </> : null}
    </fieldset>
    {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    <p className="text-sm leading-6 text-[color:var(--text-muted)]">{t("passwordNote")}</p>
  </form>;
}

/** Only configuration is required here; runtime diagnostics never gate onboarding. */
export function SetupWizard() {
  const t = useTranslations("setupWizard");
  const router = useRouter();
  const heading = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [visited, setVisited] = useState<Step[]>([]);
  const [furthest, setFurthest] = useState(0);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Set<Step>>(new Set());
  const [readiness, setReadiness] = useState<SetupReadinessEnvelope | null>(null);
  const [statusError, setStatusError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const working = busy || confirming;

  useEffect(() => {
    let active = true;
    setStatusError("");
    clientApi.setupReadiness().then(env => {
      if (!Array.isArray(env.data?.checks)) throw new Error();
      if (!active) return;
      const query = new URLSearchParams(window.location.search);
      let requested = query.get("mode") === "quick" ? "llm" : query.get("step");
      if (!requested) {
        try { requested = window.localStorage.getItem(STEP_STORAGE_KEY); } catch { /* UI preference only. */ }
      }
      const initial = resolveSetupStep(env, requested);
      const missing = pendingSetupStep(env, new Set());
      setReadiness(env); setStep(initial); setVisited([initial]);
      setFurthest(missing ? STEPS.indexOf(missing) : STEPS.length - 1);
    }).catch(() => { if (active) setStatusError(t("loadFailed")); });
    return () => { active = false; };
    // Locale changes must not reload/reset in-memory drafts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  useEffect(() => {
    if (!step) return;
    try { window.localStorage.setItem(STEP_STORAGE_KEY, step); } catch { /* UI preference only. */ }
    heading.current?.focus({ preventScroll: true });
    heading.current?.closest("main")?.scrollTo({ top: 0 });
  }, [step]);

  useEffect(() => {
    if (!drafts.size) return;
    const protectDrafts = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protectDrafts);
    return () => window.removeEventListener("beforeunload", protectDrafts);
  }, [drafts]);

  function goTo(next: Step) {
    setBusy(false);
    setVisited(previous => previous.includes(next) ? previous : [...previous, next]);
    setStep(next);
  }

  async function complete(completed: Step, saved = true) {
    const remainingDrafts = new Set(drafts);
    // Retrying a status read must never mark an unsaved form as saved.
    if (saved) remainingDrafts.delete(completed);
    setDrafts(remainingDrafts);
    setConfirming(true); setStatusError("");
    try {
      const env = await clientApi.setupReadiness();
      if (!Array.isArray(env.data?.checks)) throw new Error();
      setReadiness(env);
      if (!setupSaved(env, completed) || remainingDrafts.has(completed)) {
        setStatusError(t("notSaved")); return;
      }
      const index = STEPS.indexOf(completed);
      const missing = pendingSetupStep(env, remainingDrafts);
      if (missing && STEPS.indexOf(missing) <= index) {
        goTo(missing); setStatusError(t("notSaved")); return;
      }
      if (index === STEPS.length - 1) {
        try { window.localStorage.removeItem(STEP_STORAGE_KEY); } catch { /* UI preference only. */ }
        toast({ message: t("finishedDescription"), tone: "ok" });
        router.replace("/");
      } else {
        setFurthest(previous => Math.max(previous, index + 1));
        goTo(STEPS[index + 1]);
      }
    } catch { setStatusError(t("confirmFailed")); }
    finally { setConfirming(false); }
  }

  async function openSettings() {
    if (drafts.size && !(await confirm({ title: t("leaveTitle"), message: t("leaveDescription"), tone: "warning" }))) return;
    router.push("/settings");
  }

  if (!step) return <PageBody>
    {statusError ? <ErrorBanner error={statusError} onRetry={() => setAttempt(value => value + 1)} />
      : <p role="status" className="py-10">{t("loading")}</p>}
  </PageBody>;
  const index = STEPS.indexOf(step);
  return <PageBody>
    <div className="mx-auto w-full max-w-3xl space-y-5" data-testid="setup-wizard">
    <PageHeader eyebrow={t("eyebrow")} title={t("title")} description={t("description")}
      actions={<button type="button" className="btn btn-ghost" disabled={working} onClick={() => void openSettings()}>{t("openSettings")}</button>} />
    <SetupSteps current={step} busy={working} furthest={furthest} saved={readiness} drafts={drafts} onChange={goTo} />
    <ErrorBanner error={statusError} onRetry={working ? undefined : () => void complete(step, false)} />
    <div className="space-y-2 pt-3">
      <p className="text-xs text-[color:var(--text-muted)]">{t("stepLabel", { current: index + 1, total: STEPS.length })}</p>
      <h2 ref={heading} tabIndex={-1} style={{ outline: "none" }} className="text-xl font-semibold">{t(`steps.${step}`)}</h2>
      <p className="text-sm leading-6 text-[color:var(--text-muted)]">{t(`steps.${step}Desc`)}</p>
    </div>
    {/* Keep visited panels mounted so Back never discards an in-memory draft. */}
    {visited.map(item => <section key={item} hidden={item !== step} aria-label={t(`steps.${item}`)}
      onChangeCapture={() => { setStatusError(""); setDrafts(previous => new Set(previous).add(item)); }}>
      <fieldset disabled={confirming} className="min-w-0">
      {item === "llm" ? <SettingsWorkspace forceSection="models" hideHeader setupMode
        onSetupComplete={() => complete("llm")} onSetupBusyChange={item === step ? setBusy : undefined} />
        : item === "account" ? <AccountStep onComplete={() => complete("account")} onBusyChange={item === step ? setBusy : undefined} />
        : <PasswordStep onComplete={() => complete("password")} onBusyChange={item === step ? setBusy : undefined} />}
      </fieldset>
    </section>)}
    <footer className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-[color:var(--line)] bg-[color:var(--bg)] py-4">
      <button type="button" className="btn btn-ghost" disabled={working || index === 0} onClick={() => goTo(STEPS[index - 1])}>{t("back")}</button>
      <button type="submit" form={`nerya-setup-${step}`} className="btn btn-primary" disabled={working}>
        {working ? t("working") : step === "password" ? t("finish") : t("saveContinue")}
      </button>
    </footer>
    <p className="text-center text-xs leading-5 text-[color:var(--text-muted)]">{t("onlyThreeSteps")}</p>
    </div>
  </PageBody>;
}
