"use client";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useLocale } from "next-intl";
import type { ChatMessage } from "../../lib/chat";

type Unit={id:string;messages:ChatMessage[];live:boolean;text:string};
const heights=new Map<string,number>();
const anchors=new Map<string,{id:string;offset:number}>();
export function hasReadingAnchor(session:string){return anchors.has(session);}
export function clearReadingAnchor(session:string){anchors.delete(session);}


/** Each stable turn keeps a measured placeholder; only nearby content mounts. */
const TurnWindow=memo(function TurnWindow({unit,root,children,session}:{unit:Unit;root:RefObject<HTMLDivElement>;children:ReactNode;session:string}){
  const ref=useRef<HTMLDivElement>(null),[visible,setVisible]=useState(unit.live);
  const key=session+":"+unit.id;
  const [height,setHeight]=useState(heights.get(key)||280);
  useEffect(()=>{
    const el=ref.current;if(!el)return;
    const observer=new IntersectionObserver(entries=>setVisible(entries[0].isIntersecting),{root:root.current,rootMargin:"1200px 0px"});
    observer.observe(el);return()=>observer.disconnect();
  },[root,key]);
  useLayoutEffect(()=>{
    const el=ref.current;if(!el||(!visible&&!unit.live))return;
    const observer=new ResizeObserver(()=>{const size=el.getBoundingClientRect().height;if(size>0){heights.set(key,size);setHeight(size);}});
    observer.observe(el);return()=>observer.disconnect();
  },[visible,unit.live,key]);
  return <div ref={ref} id={"turn-"+encodeURIComponent(unit.id)} data-timeline-turn={unit.id} style={!visible&&!unit.live?{height}:undefined}>
    {visible||unit.live?children:null}
  </div>;
});

export const ConversationTimeline=memo(function ConversationTimeline({messages,session,scrollRef,renderMessage,hasMore,onOlder,loadingOlder}:{
  messages:ChatMessage[];session:string;scrollRef:RefObject<HTMLDivElement>;
  renderMessage:(message:ChatMessage,index:number)=>ReactNode;hasMore?:boolean;onOlder?:()=>void;loadingOlder?:boolean;
}){
  const zh=useLocale().startsWith("zh"),[query,setQuery]=useState(""),[match,setMatch]=useState(0);
  const units=useMemo(()=>{
    const result:Unit[]=[];
    for(const message of messages){
      const id=message.role==="assistant"?message.turn?.turn_id:undefined;
      const text=message.role==="user"?message.text:String(message.turn?.reply_text||message.turn?.final_text||"");
      if(message.role==="assistant"&&result.length&&result.at(-1)!.messages.at(-1)?.role==="user"){
        const unit=result.at(-1)!;unit.id=id||unit.id;unit.messages.push(message);unit.text+="\n"+text;unit.live=!!message.loading;
      }else result.push({id:id||message.backend_message_id||message.id,messages:[message],text,live:message.role==="assistant"&&!!message.loading});
    }
    return result;
  },[messages]);
  const indexes=useMemo(()=>new Map(messages.map((m,i)=>[m.id,i])),[messages]);
  const hits=useMemo(()=>query.trim()?units.filter(u=>u.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())):[],[query,units]);
  function jump(id:string){
    const el=document.getElementById("turn-"+encodeURIComponent(id));
    if(el){el.scrollIntoView({block:"center"});el.classList.add("workbench-search-hit");window.setTimeout(()=>el.classList.remove("workbench-search-hit"),2500);}
  }
  const initialized=useRef("");
  useEffect(()=>{
    const root=scrollRef.current;if(!root||!units.length)return;
    if(initialized.current!==session){
      initialized.current=session;
      const saved=anchors.get(session);
      const target=new URLSearchParams(location.search).get("message");
      const selected=target?units.find(u=>u.messages.some(m=>m.id===target||m.backend_message_id===target)):null;
      const id=selected?.id||saved?.id;
      if(id){requestAnimationFrame(()=>{const el=document.getElementById("turn-"+encodeURIComponent(id));if(el)root.scrollTop+=el.getBoundingClientRect().top-root.getBoundingClientRect().top-(saved?.offset||0);});}
    }
    const save=()=>{
      if(root.scrollHeight-root.scrollTop-root.clientHeight<80){anchors.delete(session);return;}
      const top=root.getBoundingClientRect().top;
      const node=[...root.querySelectorAll<HTMLElement>("[data-timeline-turn]")].find(el=>el.getBoundingClientRect().bottom>top);
      if(node)anchors.set(session,{id:node.dataset.timelineTurn!,offset:node.getBoundingClientRect().top-top});
    };
    root.addEventListener("scroll",save,{passive:true});return()=>{save();root.removeEventListener("scroll",save);};
  },[session,units.length,scrollRef]);
  return <>
    <div className="sticky top-0 z-10 mb-4 flex flex-wrap items-center gap-2 bg-[color:var(--bg)] py-2" data-testid="conversation-find">
      <input type="search" className="min-h-10 min-w-0 flex-1 rounded-lg border border-[color:var(--line)] bg-transparent px-3 text-sm" aria-label={zh?"在会话中查找":"Find in conversation"} placeholder={zh?"在会话中查找":"Find in conversation"} value={query}
        onChange={e=>{setQuery(e.target.value);setMatch(0);}} onKeyDown={e=>{if(e.key==="Enter"&&hits.length){e.preventDefault();jump(hits[match%hits.length].id);setMatch((match+1)%hits.length);}if(e.key==="Escape")setQuery("");}}/>
      {query&&<><span className="text-xs text-[color:var(--text-muted)]">{hits.length} {zh?"处":"matches"}</span><button type="button" className="min-h-11 px-2 text-sm" disabled={!hits.length} onClick={()=>{jump(hits[match%hits.length].id);setMatch((match+1)%hits.length);}}>{zh?"下一处":"Next match"}</button></>}
      {hasMore&&<button type="button" className="min-h-11 px-2 text-sm underline" disabled={loadingOlder} onClick={onOlder}>{loadingOlder?(zh?"加载中":"Loading"):(zh?"加载更早记录":"Load older history")}</button>}
      {query&&hasMore&&<p className="w-full text-xs text-[color:var(--text-muted)]">{zh?"搜索当前已加载记录，可继续加载历史。":"Searching loaded history. Load older messages for more results."}</p>}
    </div>
    {units.map(unit=><TurnWindow key={unit.id} unit={unit} root={scrollRef} session={session}>{unit.messages.map(m=>renderMessage(m,indexes.get(m.id)!))}</TurnWindow>)}
  </>;
});
