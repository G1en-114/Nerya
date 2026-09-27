"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { configureDesktop, desktopStatus, isDesktop, testDesktopNotification, openNotificationSettings, type DesktopOptions, type DesktopState } from "../../lib/desktop";
import { confirm } from "../../lib/dialogs";
import { Row, SettingsGroup } from "./SettingsFields";

/** Only rendered inside Settings > Login. Web hosting remains independent. */
export function DesktopSettings({ passwordConfigured }: { passwordConfigured: boolean }) {
  const t = useTranslations("desktop");
  const locale = useLocale();
  const [state, setState] = useState<DesktopState | null>(null);
  const [native, setNative] = useState(false);
  const [externalUrl, setExternalUrl] = useState("");
  const [port, setPort] = useState("18400");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  function applyState(value: DesktopState) {
    setState(value);
    setExternalUrl(value.external_url || "");
    setPort(String(value.port ?? 18400));
    setError(value.notification_error || "");
  }
  useEffect(() => {
    setNative(isDesktop());
    if (!isDesktop()) return;
    let active = true;
    const read = () => desktopStatus().then(value => { if (active) applyState(value); })
      .catch(() => { if (active) setError("generic"); });
    void read();
    window.addEventListener("focus", read);
    return () => { active = false; window.removeEventListener("focus", read); };
  }, []);
  function failure(value: unknown) {
    const code = String(value).replace(/^Error:\s*/, "");
    setError(t.has(`errors.${code}`) ? code : "generic");
  }
  async function update(options: DesktopOptions): Promise<boolean> {
    setBusy(true); setError(""); setMessage("");
    try {
      applyState(await configureDesktop({ ...options, language: locale === "zh" ? "zh" : "en" }));
      return true;
    } catch (value) {
      failure(value);
      return false;
    } finally { setBusy(false); }
  }
  function accessOptions(): Pick<DesktopOptions, "external_url" | "port"> | null {
    const number = Number(port);
    if (!Number.isInteger(number) || number < 1024 || number > 65535) {
      setError("port_must_be_between_1024_and_65535");
      return null;
    }
    return { external_url: externalUrl.trim(), port: number };
  }
  async function saveAccess() {
    const options = accessOptions();
    if (!options) return;
    if (await update(options)) setMessage(t("saved"));
  }
  async function sharing() {
    if (state?.sharing) return update({ sharing: false });
    const options = accessOptions();
    if (!options) return;
    if (await confirm({ title: t("confirmTitle"), message: t("confirmMessage") })) await update({ ...options, sharing: true });
  }
  async function test() {
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await testDesktopNotification();
      setMessage(t(result.delivery === "delivered" ? "testDelivered" : "testSent"));
      applyState(await desktopStatus());
    } catch (value) { failure(value); }
    finally { setBusy(false); }
  }
  if (!native) return null;
  const blocked = state?.notification_permission === "denied" || error === "notification_permission_denied";
  const needsPermission = blocked || state?.notification_permission === "prompt";
  return <section data-testid="desktop-settings" aria-label={t("title")}>
    <SettingsGroup title={t("title")}>
      <Row label={t("notifications")} desc={t("notificationsHint")}>
        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-secondary" role="switch" aria-label={t("notifications")}
            aria-checked={state?.notifications && !needsPermission || false} disabled={busy || state?.phase !== "ready"}
            onClick={() => void update({ notifications: !state?.notifications || needsPermission })}>{state?.notifications && !needsPermission ? t("disable") : t("enable")}</button>
          <button type="button" className="btn btn-ghost" disabled={busy || !state?.notifications} onClick={() => void test()}>{t("test")}</button>
        </div>
      </Row>
      {blocked && <div className="px-3 py-2 text-sm text-warn">
        {t("errors.notification_permission_denied")} <button type="button" className="underline" onClick={() => void openNotificationSettings().catch(failure)}>{t("systemSettings")}</button>
      </div>}
      {state?.notification_permission === "quiet" && <p className="px-3 py-2 text-xs text-warn">{t("quiet")} <button type="button" className="underline" onClick={() => void openNotificationSettings().catch(failure)}>{t("systemSettings")}</button></p>}
      <Row label={t("externalUrl")} desc={t("externalUrlHint")}>
        <input className="input-dark w-full max-w-[320px] font-mono text-xs" value={externalUrl} disabled={busy}
          onChange={event => setExternalUrl(event.target.value)} placeholder="http://192.168.1.20" />
      </Row>
      <Row label={t("port")} desc={t("portHint")}>
        <div className="flex items-center gap-2">
          <input className="input-dark w-28 font-mono text-xs" type="number" min={1024} max={65535} value={port} disabled={busy}
            onChange={event => setPort(event.target.value)} />
          <button type="button" className="btn btn-ghost" disabled={busy || state?.phase !== "ready"} onClick={() => void saveAccess()}>{t("saveAccess")}</button>
        </div>
      </Row>
      {state?.access_url && <div className="px-3 py-3 text-xs text-[color:var(--text-muted)]">
        <div className="flex items-center gap-3"><span>{t("localAccess")}</span><code className="select-all break-all">{state.access_url}</code><button type="button" className="underline" onClick={() => void navigator.clipboard.writeText(state.access_url!).then(() => setMessage(t("copied"))).catch(failure)}>{t("copy")}</button></div>
      </div>}
      <Row label={t("sharing")} desc={passwordConfigured ? t("sharingHint") : t("passwordHint")}>
        <button type="button" role="switch" aria-label={t("sharing")} aria-checked={state?.sharing ?? false}
          className="btn btn-secondary" disabled={busy || state?.phase !== "ready" || (!passwordConfigured && !state?.sharing)} onClick={() => void sharing()}>
          {state?.sharing ? t("disable") : t("enable")}
        </button>
      </Row>
      {state?.sharing && <div className="px-3 py-3 text-xs text-[color:var(--text-muted)] space-y-2">
        {state.external_url ? <div className="flex items-center gap-3"><span>{t("externalUrl")}</span><code className="select-all break-all">{state.external_url}</code></div> : null}
        {(state.shared_addresses?.length ? state.shared_addresses : [`http://<LAN-IP>:${state.port}`]).map(address => <div key={address} className="flex items-center gap-3">
          <code className="select-all break-all">{address}</code><button type="button" className="underline" onClick={() => void navigator.clipboard.writeText(address).then(() => setMessage(t("copied"))).catch(failure)}>{t("copy")}</button>
        </div>)}
        <p>{t("security")}</p>
      </div>}
      {!state && !error && <p className="px-3 py-2 text-sm" role="status">{t("loading")}</p>}
      {error && !blocked && <p className="px-3 py-2 text-sm text-danger" role="alert">{t(`errors.${t.has(`errors.${error}`) ? error : "generic"}`)}</p>}
      {message && <p className="px-3 py-2 text-sm" role="status">{message}</p>}
    </SettingsGroup>
  </section>;
}
