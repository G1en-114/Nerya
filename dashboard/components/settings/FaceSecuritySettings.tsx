"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { Card, Pill } from "../Page";
import { FaceCapture } from "../face/FaceCapture";
import { faceAuthorization, faceError, type FaceStatus } from "../../lib/faceAuthorization";
import { confirm } from "../../lib/dialogs";

export function FaceSecuritySettings() {
  const zh = useLocale().startsWith("zh");
  const [status, setStatus] = useState<FaceStatus | null>(null);
  const [capture, setCapture] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function load() { setError(""); try { setStatus(await faceAuthorization.status()); } catch (e) { setError(faceError(e, zh)); } }
  useEffect(() => { void load(); }, []); // Read only; camera starts on explicit click.
  async function enroll(image: string) {
    setBusy(true); setError("");
    try { setStatus(await faceAuthorization.enroll(image)); setCapture(false); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!await confirm({ title: zh ? "关闭登录人脸验证？" : "Disable login face verification?", message: zh ? "会删除加密的参考人脸，使验证凭据失效，并恢复仅使用管理员密码登录。" : "Deletes the encrypted reference, invalidates receipts and restores password-only administrator login.", tone: "danger" })) return;
    setBusy(true); setError("");
    try { setStatus(await faceAuthorization.remove()); setCapture(false); }
    catch (e) { setError(faceError(e, zh)); }
    finally { setBusy(false); }
  }
  return <Card title={zh ? "管理员登录人脸验证" : "Administrator login face verification"}
    description={zh ? "先验证人脸，再输入管理员密码；登录后交易无需再次刷脸。" : "Verify your face before entering the administrator password. Transactions need no further face checks."}
    actions={<Pill tone={status?.enrolled ? "ok" : "warn"}>{!status ? (zh ? "读取中" : "Loading") : status.enrolled ? (zh ? "已录入" : "Enrolled") : (zh ? "未录入" : "Not enrolled")}</Pill>}>
    <div className="space-y-4">
      {error && <div role="alert" className="text-sm text-danger">{error} <button type="button" className="underline" onClick={() => void load()}>{zh ? "重试" : "Retry"}</button></div>}
      <p className="text-sm leading-6 text-ink-200">{status?.enabled ? (zh ? "管理员登录时先刷脸，再输入密码。验证凭据 120 秒后过期，只能使用一次。" : "Administrator login requires a face check before the password. The receipt expires after 120 seconds and can be used once.") : (zh ? "先设置管理员密码，再录入参考人脸以启用。现有本机免登录策略保持不变。" : "Set the administrator password, then enroll a reference face to enable verification. Existing local login exemptions remain in place.")}</p>
      <p className="text-xs leading-5 text-ink-300">{zh ? "录入时保存加密的人脸特征，不保存原始照片。使用被动防翻拍检测，不等同于可靠的身份认证；首次使用可能下载模型。" : "Enrollment stores encrypted face features, not the original photo. Passive anti-spoofing is not reliable identity authentication. Models may download on first use."}</p>
      {capture ? <>
        <FaceCapture busy={busy} onCapture={enroll} label={zh ? "拍摄并录入" : "Capture and enroll"} />
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setCapture(false)}>{zh ? "取消录入" : "Cancel enrollment"}</button>
      </> : <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary" disabled={busy || !status} onClick={() => setCapture(true)}>{status?.enrolled ? (zh ? "重新录入" : "Enroll again") : (zh ? "录入参考人脸" : "Enroll reference face")}</button>
        {status?.enrolled && <button type="button" className="btn btn-ghost text-danger" disabled={busy} onClick={() => void remove()}>{zh ? "删除参考人脸" : "Delete reference face"}</button>}
      </div>}
    </div>
  </Card>;
}
