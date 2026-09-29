"use client";

import { FormEvent, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { FaceCapture } from "../../components/face/FaceCapture";
import { faceAuthorization, faceError, type FaceReceipt } from "../../lib/faceAuthorization";
import { NeryaLogo } from "../../components/NeryaLogo";
import { ErrorBanner, Pill } from "../../components/Page";
import { clientApi, type AuthStatus } from "../../lib/clientApi";
import { authHeaders, getStoredAuthToken, handleAuthFailure, safeLoginNext, setStoredAuthToken } from "../../lib/auth";

export default function LoginPage() {
  const t = useTranslations("login");
  const zh = useLocale().startsWith("zh");
  const [faceProof, setFaceProof] = useState<FaceReceipt | null>(null);
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const faceReady = !status?.face_required || !!faceProof;
  // A fresh install can sign in with the demo bootstrap password, so the
  // password form must be usable before any operator password exists.
  const canUsePassword = Boolean(status?.password_configured || status?.demo_password_active);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nextPath, setNextPath] = useState("/dashboard");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNextPath(safeLoginNext(params.get("next")));
    void clientApi.authStatus().then(setStatus).catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  }, []);

  const localHost = status?.local_access === true;

  useEffect(() => {
    if (!faceProof) return;
    const timer = window.setTimeout(() => { setFaceProof(null); setPassword(""); }, Math.max(0, faceProof.expires_at * 1000 - Date.now()));
    return () => window.clearTimeout(timer);
  }, [faceProof]);

  async function verifyFace(image: string) {
    setBusy(true); setError(null);
    try { setFaceProof(await faceAuthorization.verify(image)); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (!status) return;
    if (localHost) { window.location.replace(nextPath); return; }
    if (!getStoredAuthToken()) return;
    // Do not bounce back into the dashboard merely because a stale token exists.
    const controller = new AbortController();
    void fetch("/api/proxy/workspace", { headers: authHeaders(), cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (controller.signal.aborted) return;
        if (response.ok) window.location.replace(nextPath);
        else handleAuthFailure(response.status, await response.text());
      }).catch(() => { /* Keep the login form usable during a network failure. */ });
    return () => controller.abort();
  }, [localHost, nextPath, status]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!faceReady) return;
    setBusy(true);
    setError(null);
    try {
      const res = await clientApi.authLogin({ password, face_receipt: faceProof?.receipt });
      if (!res.ok || !res.token) {
        throw new Error(res.detail || res.error || "login_failed");
      }
      setStoredAuthToken(res.token, res.expires_at);
      window.location.replace(nextPath);
    } catch (err) {
      setFaceProof(null); setPassword("");
      void clientApi.authStatus().then(setStatus).catch(() => {});
      setError(status?.face_required ? faceError(err, zh) : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-ink-950 text-ink-100">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl items-center justify-center px-5 py-10">
        <section className="grid w-full gap-6 lg:grid-cols-[1fr_420px] lg:items-center">
          <div className="hidden lg:block">
            <div className="flex items-center gap-4">
              <div className="relative h-16 w-16 overflow-hidden rounded-2xl bg-black/40 ring-1 ring-brand-500/40">
                <NeryaLogo size={64} />
              </div>
              <div>
                <div className="text-[13px] font-medium text-fluid-300">
                  Nerya
                </div>
                <h1 className="mt-2 text-[34px] font-medium tracking-tight text-white">
                  {t("headline")}
                </h1>
              </div>
            </div>
            <p className="mt-5 max-w-xl text-sm leading-6 text-ink-400">
              {t("description")}
            </p>
          </div>

          <form
            onSubmit={submit}
            className="card p-5"
          >
            <div className="mb-5 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-white">{t("title")}</h2>
                <p className="mt-1 text-[12px] leading-5 text-ink-400">
                  {t("subtitle")}
                </p>
              </div>
              <div className="shrink-0">
                <Pill tone={status?.password_configured ? "ok" : "warn"}>
                  {status?.password_configured ? t("configured") : t("notConfigured")}
                </Pill>
              </div>
            </div>

            {error ? <ErrorBanner error={error} /> : null}

            {status?.demo_password_active ? (
              <div className="mt-4 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[12px] leading-5 text-warn">
                {zh
                  ? "正在使用演示初始密码。登录后请立刻在设置 → 登录与访问中设置自己的密码；设置后初始密码立即失效。"
                  : "The demo bootstrap password is active. Set your own password in Settings → Login & access right after signing in; the bootstrap password stops working immediately."}
              </div>
            ) : null}

            {canUsePassword && status?.face_required && <div className="mt-4 space-y-3">
              <p className="text-sm text-ink-200">{zh ? "1. 人脸验证 → 2. 管理员密码" : "1. Face verification → 2. Administrator password"}</p>
              {faceProof ? <p role="status" className="text-sm text-fluid-300">{zh ? "人脸验证通过，请在两分钟内输入密码。登录后交易无需再次刷脸。" : "Face verified. Enter your password within two minutes. Transactions need no further face checks."}</p> : <FaceCapture busy={busy} onCapture={verifyFace} label={zh ? "拍摄并验证" : "Capture and verify"} />}
            </div>}

            {faceReady && <label className="mt-4 block text-[12px] text-ink-300">
              {t("password")}
              <input
                className="input-dark mt-1"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                disabled={!canUsePassword || busy}
              />
            </label>}

            <button
              type="submit"
              className="btn btn-primary mt-5 w-full justify-center"
              disabled={!canUsePassword || !faceReady || !password || busy}
            >
              {busy ? t("signingIn") : t("signIn")}
            </button>

            {localHost ? (
              <p className="mt-4 text-[11px] leading-5 text-ink-500">
                {t("localNote")}
              </p>
            ) : null}
          </form>
        </section>
      </div>
    </main>
  );
}
