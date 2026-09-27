"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { AUTH_EVENT, AUTH_TOKEN_KEY, AUTH_EXPIRES_KEY, getStoredAuthToken, redirectToLogin } from "../lib/auth";
import { clientApi, invalidateReadCache } from "../lib/clientApi";
import { ErrorBanner } from "./Page";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const t = useTranslations("common");
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    let revision = 0;
    async function evaluate() {
      const current = ++revision;
      setReady(false);
      setError("");
      try {
        const status = await clientApi.authStatus();
        if (!active || current !== revision) return;
        if (status.local_access === true) { setReady(true); return; }
        if (!getStoredAuthToken()) { redirectToLogin(); return; }
        // Validate the bearer before mounting panels that fan out settings reads.
        await clientApi.workspace();
        if (active && current === revision) setReady(true);
      } catch (value) {
        if (active && current === revision) setError(value instanceof Error ? value.message : String(value));
      }
    }
    const refresh = () => { invalidateReadCache(); void evaluate(); };
    void evaluate();
    // Other windows persist chat/UI state frequently. Only authentication
    // changes may remount the gated workspace; otherwise focus and menus reset.
    const storage=(event:StorageEvent)=>{
      if(event.storageArea===localStorage&&(event.key===null||event.key===AUTH_TOKEN_KEY||event.key===AUTH_EXPIRES_KEY))refresh();
    };
    window.addEventListener(AUTH_EVENT, refresh);
    window.addEventListener("storage", storage);
    return () => {
      active = false;
      window.removeEventListener(AUTH_EVENT, refresh);
      window.removeEventListener("storage", storage);
    };
  }, [pathname, attempt]);

  if (!ready) return <div className="p-6" data-testid="auth-gate">
    {error ? <><ErrorBanner error={error} /><button type="button" className="btn btn-secondary mt-3" onClick={() => { invalidateReadCache(); setAttempt(value => value + 1); }}>{t("retry")}</button></>
      : <p role="status">{t("loading")}</p>}
  </div>;
  return <>{children}</>;
}
