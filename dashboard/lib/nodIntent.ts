import { ApiError, callApi } from "./clientApi";

export type NodIntentProof = {
  ok: boolean;
  intent: "nod";
  receipt: string;
  expires_at: number;
  approval_id: string;
  amplitude?: number;
  identity_proven: false;
  demo: true;
};

export const nodIntent = {
  capture: (approvalId: string, frames: string[]) =>
    callApi<NodIntentProof>("/security/nod/intent", {
      method: "POST",
      body: { approval_id: approvalId, frames },
    }),
  /** Camera-scoped warm model worker: open with the camera, close on stop. */
  session: (action: "open" | "close") =>
    callApi<{ ok: boolean; closed?: boolean }>("/security/nod/session", {
      method: "POST",
      body: { action },
    }).catch(() => ({ ok: false })),
};

/** Burst parameters shared with the capture component and its tests. */
export const NOD_BURST = { frames: 12, intervalMs: 170, width: 320 };

export function nodError(error: unknown, zh: boolean): string {
  const code = error instanceof ApiError && error.payload && typeof error.payload === "object"
    ? String((error.payload as { error?: string }).error || "")
    : error instanceof Error
    ? error.message
    : "";
  const messages: Record<string, [string, string]> = {
    trusted_actor_required: ["登录态缺失，请刷新页面后重试。", "No verified session. Refresh the page and retry."],
    nod_not_detected: ["没有识别到明确的点头动作，请正对摄像头再试一次，或直接点击批准按钮。", "No clear nod was detected. Face the camera and retry, or just use the approve button."],
    invalid_frame_count: ["采样的画面帧数不足，请重新点头确认。", "Not enough camera frames were captured. Nod again."],
    face_not_tracked: ["没有持续跟踪到人脸，请正对摄像头、光线充足后重试。", "No face could be tracked. Face the camera in good lighting and retry."],
    one_face_required: ["请让画面中只出现你的一张脸。", "Keep exactly one face in the frame."],
    invalid_camera_frame: ["摄像头画面读取失败，请重试。", "A camera frame could not be read. Try again."],
    nod_kind_not_supported: ["点头确认目前只支持交易类审批卡片。", "Nod confirmation currently applies to trade approval cards only."],
    approval_not_found: ["该审批已不存在或已过期，请刷新后重试。", "This approval no longer exists or expired. Refresh and retry."],
    approval_not_pending: ["该审批已处理完毕，无需再确认。", "This approval was already resolved."],
    nod_verification_busy: ["点头识别正在处理其他请求，请稍后重试。", "Nod detection is busy. Try again shortly."],
    nod_model_unavailable: ["点头识别模型未能启动，请检查后端视觉依赖。", "The nod detection model could not start. Check backend vision dependencies."],
    nod_intent_invalid: ["确认意向回执无效，请重新点头或直接点击批准按钮。", "The intent receipt is invalid. Nod again or use the approve button."],
    nod_intent_used: ["该确认意向已被使用，请重新点头确认。", "This intent receipt was already used. Nod again."],
    nod_intent_expired: ["确认意向已过期，请重新点头确认。", "The nod intent expired. Nod again."],
    nod_intent_stale: ["审批内容已变化，旧确认失效，请核对后重新确认。", "The approval content changed; the old intent is void. Review and confirm again."],
    nod_store_unavailable: ["确认意向存储无法读取，请检查工作区密钥。", "Intent storage could not be read. Check workspace encryption."],
    camera_unavailable: ["此页面无法使用摄像头，请通过 localhost 或 HTTPS 打开。", "Camera access is unavailable. Open this page using localhost or HTTPS."],
    NotAllowedError: ["摄像头权限被拒绝，请在浏览器地址栏允许摄像头后重试。", "Camera permission was denied. Allow camera access in the address bar and retry."],
    NotFoundError: ["未找到摄像头，请检查设备连接。", "No camera found. Check your device connection."],
    NotReadableError: ["摄像头可能被其他程序占用，请关闭后重试。", "The camera may be in use by another app. Close it and retry."],
  };
  const name = error instanceof Error ? error.name : "";
  const pair = messages[code] || messages[name];
  return pair
    ? pair[zh ? 0 : 1]
    : zh
    ? "点头确认未完成，可直接点击批准按钮，不影响审批。"
    : "Nod confirmation did not complete. The approve button still works as usual.";
}
