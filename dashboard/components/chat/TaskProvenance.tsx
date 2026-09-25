"use client";
import Link from "next/link";
import {useLocale} from "next-intl";
import type {ChatThread} from "../../lib/chat";
export function TaskProvenance({thread}:{thread:ChatThread|null}){
 const zh=useLocale().startsWith("zh");
 if(!thread?.strategy_id)return null;
 const query=new URLSearchParams({strategy_id:thread.strategy_id,session_id:thread.id});
 if(thread.strategy_proposal_id)query.set("proposal_id",thread.strategy_proposal_id);
 return <nav className="flex min-h-10 flex-wrap items-center gap-3 border-b border-[color:var(--line)] px-4 text-xs text-[color:var(--text-muted)]" aria-label={zh?"关联资源":"Related resources"}>
  <Link className="min-h-10 py-3 underline" href={"/strategies?"+query}>{thread.strategy_id} · {thread.strategy_proposal_id?(zh?"候选版本":"Candidate version"):(zh?"已发布策略":"Published strategy")}</Link>
  <Link className="min-h-10 py-3 underline" href={"/orders?strategy="+encodeURIComponent(thread.strategy_id)}>{zh?"查看订单":"View orders"}</Link>
  <span>{zh?"候选、发布和实际运行分别记录":"Candidate, published and running versions are tracked separately"}</span>
 </nav>;
}
