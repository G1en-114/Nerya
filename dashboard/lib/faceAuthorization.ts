import { ApiError, callApi } from "./clientApi";

export type FaceStatus = { ok: boolean; enabled: boolean; enrolled: boolean; enrolled_at?: number; receipt_seconds: number };
export type FaceReceipt = { ok: boolean; receipt: string; expires_at: number };
export const faceAuthorization = {
  status: () => callApi<FaceStatus>("/security/face/status", { method: "POST", body: {} }),
  enroll: (image: string) => callApi<FaceStatus>("/security/face/enroll", { method: "POST", body: { image } }),
  remove: () => callApi<FaceStatus>("/security/face/delete", { method: "POST", body: {} }),
  verify: (image: string) => callApi<FaceReceipt>("/auth/face/verify", { method: "POST", body: { image } }),
};

export function faceError(error: unknown, zh: boolean): string {
  const code = error instanceof ApiError && error.payload && typeof error.payload === "object"
    ? String((error.payload as { error?: string }).error || "") : error instanceof Error ? error.message : "";
  const messages: Record<string, [string, string]> = {
    invalid_password: ["密码不正确，请重新验证人脸后再输入密码。", "Incorrect password. Verify your face again before retrying the password."],
    admin_password_not_configured: ["请先设置管理员密码，再录入登录人脸。", "Set the administrator password before enrolling a login face."],
    face_verification_required: ["请先完成人脸验证。", "Complete face verification first."],
    one_face_required: ["请让画面中只出现你的一张脸，再拍摄。", "Keep exactly one face in the frame and try again."],
    face_quality_low: ["请靠近摄像头，保持正面和充足光线。", "Move closer, face the camera and improve the lighting."],
    reference_face_mismatch: ["与已录入的人脸不匹配，请使用录入时的本人进行验证。", "The face does not match the enrolled reference. Try again with the enrolled person."],
    liveness_failed: ["防翻拍检测未通过，请直接面对摄像头，在充足光线下重试。", "Anti-spoofing check failed. Face the camera directly and try again in good lighting."],
    face_model_unavailable: ["人脸模型未能启动或下载，请检查后端人脸依赖和网络后重试。", "The face model could not start or download. Check backend face dependencies and network access."],
    face_enrollment_required: ["请先在设置 → 访问与安全中录入当前用户的人脸。", "Enroll your face in Settings → Access and security first."],
    face_enrollment_changed: ["参考人脸已改变，请重新验证。", "The reference face changed. Verify again."],
    face_receipt_invalid_or_expired: ["登录验证已过期，请重新验证。", "Login verification expired. Verify again."],
    face_verification_busy: ["验证服务正在处理其他请求，请稍后重试。", "Verification is busy. Try again shortly."],
    face_retry_later: ["验证失败次数较多，请一分钟后重试。", "Too many failed attempts. Try again in one minute."],
    face_store_unavailable: ["人脸资料无法解密，请检查工作区密钥。", "Face data could not be decrypted. Check the workspace encryption key."],
    NotAllowedError: ["摄像头权限被拒绝，请在浏览器地址栏允许摄像头后重试。", "Camera permission was denied. Allow camera access in the address bar and retry."],
    NotFoundError: ["未找到摄像头，请检查设备连接。", "No camera found. Check your device connection."],
    camera_unavailable: ["此页面无法使用摄像头，请通过 localhost 或 HTTPS 打开。", "Camera access is unavailable. Open this page using localhost or HTTPS."],
    NotReadableError: ["摄像头可能被其他程序占用，请关闭后重试。", "The camera may be in use by another app. Close it and retry."],
  };
  const name = error instanceof Error ? error.name : "";
  const pair = messages[code] || messages[name];
  return pair ? pair[zh ? 0 : 1] : zh ? "操作未完成，请检查连接后重试。" : "The operation did not complete. Check your connection and retry.";
}
