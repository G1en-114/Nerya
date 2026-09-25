"use client";
import { ConversationActions } from "./ChatHistoryActions";
import Link from "next/link";
import { useEffect,useState } from "react";
import { useLocale } from "next-intl";
import { usePathname } from "next/navigation";
import { callApi } from "../../lib/clientApi";
import { statusLabel,type TaskStatus } from "../../lib/workbench";

type Entry={session_id:string;title:string;source?:string;workbench_status?:TaskStatus;match?:{message_id:string;snippet:string}};
export function TaskList(){
  const zh=useLocale().startsWith("zh"),pathname=usePathname();
  const [filter,setFilter]=useState("all"),[query,setQuery]=useState(""),[rows,setRows]=useState<Entry[]>([]),[error,setError]=useState(false),[loading,setLoading]=useState(true);
  useEffect(()=>{
    let stopped=false;let timer:ReturnType<typeof setTimeout>;const controller=new AbortController();
    async function refresh(){try{
      const params=new URLSearchParams({view:"workbench",state:filter,q:query,limit:"50"});
      const result=await callApi<{sessions:Entry[]}>("/agent/sessions?"+params,{signal:controller.signal});
      if(!Array.isArray(result.sessions))throw new Error("invalid_sessions");
      if(!stopped){setRows(result.sessions);setError(false);}
    }catch{if(!stopped)setError(true);}finally{if(!stopped){setLoading(false);timer=setTimeout(refresh,document.hidden?15000:2000);}}}
    timer=setTimeout(refresh,query?200:0);return()=>{stopped=true;controller.abort();clearTimeout(timer);};
  },[filter,query]);
  return <section className="px-1 py-2" aria-label={zh?"任务":"Tasks"} data-testid="workbench-tasks">
    <div className="mb-2 flex items-center justify-between px-2"><span className="text-xs font-medium">{zh?"任务":"Tasks"}</span><select className="min-h-9 max-w-[130px] bg-transparent text-xs" aria-label={zh?"筛选任务":"Filter tasks"} value={filter} onChange={e=>setFilter(e.target.value)}>
      {[['all',zh?'最近任务':'Recent'],['active',zh?'进行中':'Active'],['attention',zh?'需要处理':'Needs attention'],['completed',zh?'最近完成':'Completed']].map(([v,l])=><option key={v} value={v}>{l}</option>)}
    </select></div>
    <input value={query} onChange={e=>setQuery(e.target.value)} className="mb-2 min-h-9 w-full rounded-lg border border-[color:var(--line)] bg-transparent px-2 text-xs" placeholder={zh?"搜索任务与内容":"Search tasks and content"} aria-label={zh?"搜索任务与内容":"Search tasks and content"}/>
    {error&&<p role="status" className="px-2 text-xs text-warn">{zh?"暂时无法刷新，保留上次结果":"Refresh unavailable; showing previous results"}</p>}
    {loading&&<p className="px-2 text-xs">{zh?"加载任务…":"Loading tasks…"}</p>}
    {!loading&&!rows.length&&<p className="px-2 py-3 text-xs text-[color:var(--text-muted)]">{zh?"没有匹配任务":"No matching tasks"}</p>}
    {rows.map(row=><div key={row.session_id} className="group relative pr-6"><Link href={"/chat/"+encodeURIComponent(row.session_id)+(row.match?"?message="+encodeURIComponent(row.match.message_id):"")} aria-current={pathname==="/chat/"+row.session_id?"page":undefined} className={"mb-1 block rounded-lg px-2 py-2 hover:bg-[color:var(--panel-bg)] "+(pathname==="/chat/"+row.session_id?"bg-[color:var(--panel-bg)]":"")}>
      <span className="block truncate text-[13px]">{row.title|| (zh?"未命名任务":"Untitled task")}</span>
      <span className={"mt-1 block truncate text-[11px] "+(row.workbench_status?.needs_attention?"text-warn":"text-[color:var(--text-muted)]")}>{row.workbench_status?statusLabel(row.workbench_status,zh):""}{row.source==="tunnel"||row.source==="mcp"?" · "+row.source.toUpperCase():""}</span>
      {row.match&&<span className="mt-1 block truncate text-xs text-[color:var(--text-muted)]">{row.match.snippet}</span>}
    </Link><div className="absolute right-0 top-2"><ConversationActions id={row.session_id} title={row.title}/></div></div>)}
  </section>;
}
