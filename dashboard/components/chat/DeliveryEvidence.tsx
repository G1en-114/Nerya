"use client";
import { useLocale } from "next-intl";
import type { ChatResult } from "../../lib/chatResults";
import { recordOf } from "../../lib/externalCalls";

export function DeliveryEvidence({result,onOpenFile,onReveal}:{result:ChatResult;onOpenFile?:(path:string)=>void;onReveal?:()=>void}) {
  const zh=useLocale().startsWith("zh"), evidence=result.evidence;
  const files=[...new Set([...(evidence?.artifacts?.created||[]),...(evidence?.artifacts?.modified||[])])];
  const tests=evidence?.artifacts?.tests_run||[];
  const risks=evidence?.artifacts?.unverified_risks||[];
  const errors=evidence?.artifacts?.errors||[];
  const failed=tests.some(raw=>{const t=recordOf(raw);return t.ok===false||(typeof t.exit_code==="number"&&t.exit_code!==0);})||errors.length>0||evidence?.verifier?.hard_status==="failed"||evidence?.verifier?.hard_passed===false;
  return <section aria-label={zh?"交付与验证":"Delivery and verification"} data-testid="delivery-evidence" className="mb-6 space-y-3 border-b border-[color:var(--line)] pb-5 text-sm">
    <h2 className="text-base font-semibold">{zh?"交付与验证":"Delivery and verification"}</h2>
    <p>{failed?(zh?"存在验证失败或未处理错误，请查看具体范围。":"Failed checks or unresolved errors are recorded. Review their scope below."):evidence?.verifier?.hard_passed===true?(zh?"本轮有成功的验证记录。验证范围见下方。":"This turn has successful validation evidence. See its scope below."):(zh?"尚无成功验证的证据。":"No successful validation evidence recorded.")}</p>
    {failed&&evidence?.verifier?.hard_passed!==true&&<p className="text-xs text-[color:var(--text-muted)]">{zh?"尚无成功验证的证据；正文中的完成描述不代表验证通过。":"No successful validation evidence recorded; completion claims in the body are not verification."}</p>}
    {files.length>0&&<div><h3 className="font-medium">{zh?"交付文件":"Files"}</h3><ul className="mt-1 space-y-1">{files.map(path=><li key={path} className="break-all">{onOpenFile?<button type="button" className="min-h-11 text-left underline" onClick={()=>onOpenFile(path)}>{path}</button>:<code>{path}</code>}</li>)}</ul></div>}
    {tests.length>0&&<div><h3 className="font-medium">{zh?"验证记录":"Validation records"}</h3><ul className="mt-1 space-y-2">{tests.map((raw,i)=>{const t=recordOf(raw);return <li key={i} className="break-words"><code>{String(t.command||t.cmd||t.action||t.tool||"Validation")}</code><span className="ml-2 text-xs">{typeof t.exit_code==="number"?"exit "+t.exit_code:t.ok===true?(zh?"成功":"Passed"):t.ok===false?(zh?"失败":"Failed"):(zh?"结果未报告":"Result not reported")}</span></li>;})}</ul></div>}
    {(risks.length>0||errors.length>0)&&<div><h3 className="font-medium text-warn">{zh?"待处理与未验证事项":"Open issues and unverified work"}</h3><ul className="mt-1 list-disc space-y-1 pl-5">{[...risks,...errors].map((raw,i)=>{const r=recordOf(raw);return <li key={i}>{String(r.message||r.reason||r.kind||r.path||r.error||"Unverified")}</li>;})}</ul></div>}
    {result.turnId&&onReveal&&<button type="button" className="inline-flex min-h-11 items-center text-[color:var(--text-muted)] underline" onClick={onReveal}>{zh?"查看原始轮次":"View source turn"}</button>}
  </section>;
}
