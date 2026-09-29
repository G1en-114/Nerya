import { ApiError, callApi } from "./clientApi";
import { authHeaders, handleAuthFailure } from "./auth";

export type FieldVersion = {
  label: string; raw_text: string; normalized_value: string | null; unit: string; period: string;
  bbox: number[]; page: number; revision: number; review_status: string; reviewer_id: string;
  reviewed_at: string; quality_flags: string[]; extraction_mode: string; extractor_version: string;
};
export type VisualField = { field_id: string; versions: FieldVersion[] };
export type VisualClaim = { claim_id: string; title: string; claim: string; status: string; evidence_id: string; field_refs: {field_id: string; revision: number}[] };
export type VisualArtifact = {
  artifact_id: string; filename: string; width: number; height: number; revision: number;
  file_sha256: string; source_url: string | null; published_at: string | null; captured_at: string;
  source_verification: string; quality_flags: string[]; fields: VisualField[]; claims: VisualClaim[];
};
const base = "/evidence/visual";
export const visualEvidence = {
  list: () => callApi<{artifacts: VisualArtifact[]}>(`${base}/list`),
  get: (id: string) => callApi<{artifact: VisualArtifact}>(`${base}/get?artifact_id=${encodeURIComponent(id)}`),
  upload: (body: unknown) => callApi<{artifact: VisualArtifact}>(`${base}/upload`, {method:"POST", body}),
  field: (body: unknown) => callApi<{artifact: VisualArtifact}>(`${base}/field`, {method:"POST", body}),
  cite: (body: unknown) => callApi<{artifact: VisualArtifact}>(`${base}/cite`, {method:"POST", body}),
  image: async (id: string, signal: AbortSignal) => {
    const response = await fetch(`/api/proxy${base}/image?artifact_id=${encodeURIComponent(id)}`, {headers:authHeaders(), signal, cache:"no-store"});
    if (!response.ok) { const body = await response.text(); handleAuthFailure(response.status, body); throw new Error("image_unavailable"); }
    return response.blob();
  }
};
export function visualError(error: unknown, zh: boolean) {
  const code = error instanceof ApiError && error.payload && typeof error.payload === "object" ? String((error.payload as {error?:string}).error) : error instanceof Error ? error.message : "";
  const labels: Record<string, [string,string]> = {
    revision_conflict:["资料已被修改，请刷新后重新编辑。","The document changed. Refresh before editing."],
    field_revision_conflict:["引用版本已改变，请重新选择字段。","The field revision changed. Select it again."],
    value_unit_period_required:["标记为复核完成前，请填写数值、单位和所属期；不确定时选择信息不足。","Fill value, unit and period before marking reviewed; otherwise select insufficient information."],
    field_review_required:["请先复核字段，再生成引用。","Review the field before citing it."],
    visual_dependency_missing:["后端缺少图片依赖，请安装 nerya[visual]。","Install nerya[visual] on the backend."],
    image_too_large:["图片超过 4 MB，请导出较小的 PNG 或 JPEG。","The image exceeds 4 MB. Export a smaller PNG or JPEG."],
    invalid_numeric_value:["数值请使用有限的数字；无法确定时留空并标记信息不足。","Use a finite number, or leave it empty and mark insufficient information."],
    invalid_bbox:["请在图片内框选有效区域，也可修改坐标。","Select a region inside the image, or edit its coordinates."],
    export_upright_image:["请将图片旋转为正向后导出 PNG，再上传。","Export an upright PNG and upload again."],
    image_unavailable:["原图无法读取或校验失败，请刷新检查。","The original image could not be read or verified. Refresh and check."],
    label_and_raw_text_required:["请填写字段名称和原文。","Enter a field label and its original text."],
  };
  return labels[code]?.[zh ? 0:1] || (zh ? "操作未完成，请检查输入和连接后重试。" : "Could not complete the operation. Check input and connection, then retry.");
}
