"use client";
import { useEffect,useState } from "react";
import { isDesktop,desktopStatus } from "../../lib/desktop";
import { useLocale } from "next-intl";
import type { useWorkbench } from "./useWorkbench";
export function RuntimeNotice({workbench,diagnostics=false}:{workbench:ReturnType<typeof useWorkbench>;diagnostics?:boolean}) {
  const zh=useLocale().startsWith("zh");
  const {connection,runtime}=workbench;
  const [desktop,setDesktop]=useState("");
  useEffect(()=>{if(isDesktop())void desktopStatus().then(s=>setDesktop(s.desktop_version||"unknown")).catch(()=>setDesktop("unavailable"));},[]);
  if(diagnostics) return <div className="space-y-2 py-1 text-xs text-[color:var(--text-muted)]" data-testid="runtime-diagnostics"><p>API <code>{runtime?.build_id || "—"}</code> · {zh?"协议":"protocol"} {runtime?.protocol_version || "—"}</p><p>Dashboard <code>{process.env.NEXT_PUBLIC_NERYA_BUILD_ID || "development"}</code></p>{desktop&&<p>Desktop {desktop}</p>}</div>;
  if(connection==="online"||connection==="connecting") return null;
  return <div role="status" className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--line)] px-4 py-2 text-xs text-[color:var(--text-muted)]" data-testid="runtime-notice">
    <span>{connection==="incompatible" ? (zh?"当前服务不支持此工作台版本，请更新服务后继续。":"This service does not support the workbench version. Update the service to continue.") : (zh?"连接已中断，正在显示最后已知状态。":"Connection lost. Showing the last known state.")}</span>
    <button type="button" className="min-h-11 underline" onClick={workbench.refresh}>{zh?"重新检查":"Check again"}</button>
    {runtime && <details><summary>{zh?"运行版本":"Runtime version"}</summary><p>{runtime.build_id} · {runtime.protocol_version}</p></details>}
  </div>;
}
