"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { callApi } from "../../lib/clientApi";
import { ErrorBanner } from "../Page";
import styles from "./Factors.module.css";

type Catalog = {ok:boolean;skills:{id:string;enabled:boolean}[];enabled_revision:string;error?:string};

/** Existing allow-lists are preserved; enabling the new skill is explicit. */
export function FactorSkillAccess(){
  const zh=useLocale().startsWith("zh"),[catalog,setCatalog]=useState<Catalog|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const load=async()=>{
    const result=await callApi<Catalog>("/skills/catalog?scope=all&query=factor_library&limit=200");
    if(!result.ok)throw new Error(result.error||"Skill catalog unavailable");
    setCatalog(result);return result;
  };
  useEffect(()=>{void load().catch(e=>setError(String(e.message||e)));},[]);
  const skill=catalog?.skills.find(item=>item.id==="factor_library");
  if(skill?.enabled)return null;
  if(!catalog&&!error)return null;
  return <div className={`${styles.source} mt-4`}><div><p className="text-sm">{zh?"因子挖掘 Skill":"Factor research Skill"}</p><p className={styles.muted}>{skill ? (zh?"当前工作区尚未启用新 Skill。启用后，Agent 可按统一流程提取、验证和复用因子。":"This workspace has not enabled the new Skill. Enable it for Agent-led extraction, validation and reuse.") : (zh?"运行中的后端尚未提供因子 Skill，请更新并重启 Nerya 服务。":"The runtime has not exposed the factor Skill. Update and restart Nerya.")}</p>{error&&<ErrorBanner error={error}/>}</div>
    {skill&&!skill.enabled&&<button className="btn btn-secondary" disabled={busy} onClick={async()=>{setBusy(true);setError("");try{const latest=await load();const result=await callApi<{ok:boolean;error?:string}>("/skills/manage",{method:"POST",body:{action:"enable",skill_id:"factor_library",scope:"builtin",revision:latest.enabled_revision,summary:"Enable factor research from the factor library page"}});if(!result.ok)throw new Error(result.error||"Enable failed");await load();}catch(e){setError(String(e));}finally{setBusy(false);}}}>{busy?(zh?"启用中…":"Enabling…"):(zh?"启用因子 Skill":"Enable factor Skill")}</button>}
  </div>;
}
