"use client";
import { useEffect,useState } from "react";
import { isDesktop,desktopStatus } from "../../lib/desktop";
import { useLocale } from "next-intl";
import type { useWorkbench } from "./useWorkbench";
export function RuntimeNotice({workbench}:{workbench:ReturnType<typeof useWorkbench>}) {
  const zh=useLocale().startsWith("zh");
  const {connection,runtime}=workbench;
  const [desktop,setDesktop]=useState("");
  useEffect(()=>{if(isDesktop())void desktopStatus().then(s=>setDesktop(s.desktop_version||"unknown")).catch(()=>setDesktop("unavailable"));},[]);
  if(connection==="online") return <details className="absolute right-3 top-[70px] lg:top-14 z-20 rounded bg-[color:var(--bg)] px-2 text-[11px] text-[color:var(--text-muted)]" data-testid="runtime-diagnostics"><summary className="cursor-pointer">{zh?"版本":"Versions"}</summary><p>API {runtime?.build_id} · protocol {runtime?.protocol_version}</p><p>Dashboard {process.env.NEXT_PUBLIC_NERYA_BUILD_ID || "development"}</p>{desktop&&<p>Desktop {desktop}</p>}</details>;
  return <div role="status" className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--line)] px-4 py-2 text-xs text-[color:var(--text-muted)]" data-testid="runtime-notice">
    <span>{connection==="connecting" ? (zh?"正在确认运行环境…":"Checking runtime…") : connection==="incompatible" ? (zh?"当前服务不支持此工作台版本，请更新服务后继续。":"This service does not support the workbench version. Update the service to continue.") : (zh?"连接已中断，正在显示最后已知状态。":"Connection lost. Showing the last known state.")}</span>
    <button type="button" className="min-h-11 underline" onClick={workbench.refresh}>{zh?"重新检查":"Check again"}</button>
    {runtime && <details><summary>{zh?"运行版本":"Runtime version"}</summary><p>{runtime.build_id} · {runtime.protocol_version}</p></details>}
  </div>;
}
