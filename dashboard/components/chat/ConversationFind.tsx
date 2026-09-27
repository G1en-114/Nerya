"use client";

import {useCallback,useEffect,useMemo,useRef,useState,type RefObject} from "react";
import {createPortal} from "react-dom";
import {useLocale} from "next-intl";
import {Icon,SearchIcon,XIcon} from "../icons";
import styles from "./WorkbenchChrome.module.css";
import { conversationMatches, type FindEntry, type TimelineMatch } from "./timelineReveal";

export const OPEN_CONVERSATION_FIND="nerya:find-in-conversation";
export type { FindEntry } from "./timelineReveal";

/** Like ZCode's TaskFindDialog: an optional, nonmodal tool above the reading pane. */
export function ConversationFind({entries,scrollRef,onReveal,onCancelReveal,hasMore,onOlder,loadingOlder,session=""}:{
  entries:FindEntry[];scrollRef:RefObject<HTMLDivElement>;onReveal:(id:string,match:TimelineMatch,signal:AbortSignal)=>void|boolean|Promise<void|boolean>;
  session?:string;
  onCancelReveal?:()=>void;
  hasMore?:boolean;onOlder?:()=>void;loadingOlder?:boolean;
}){
  const zh=useLocale().startsWith("zh");
  const [open,setOpen]=useState(false),[query,setQuery]=useState(""),[index,setIndex]=useState(-1);
  const input=useRef<HTMLInputElement>(null),previousFocus=useRef<HTMLElement|null>(null);
  const hits=useMemo(()=>conversationMatches(entries,query),[entries,query]);
  const pending=useRef<AbortController|null>(null);
  const [locating,setLocating]=useState(false),[missed,setMissed]=useState(false);
  const cancel=useCallback(()=>{pending.current?.abort();pending.current=null;onCancelReveal?.();setLocating(false);setMissed(false);},[onCancelReveal]);
  useEffect(()=>{cancel();setIndex(-1);},[query,session,cancel]);
  useEffect(()=>()=>{pending.current?.abort();},[]);
  const close=useCallback(()=>{cancel();setOpen(false);if(previousFocus.current?.isConnected)previousFocus.current.focus({preventScroll:true});},[cancel]);
  useEffect(()=>{
    const show=()=>{previousFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;setOpen(true);requestAnimationFrame(()=>{input.current?.focus();input.current?.select();});};
    const key=(event:KeyboardEvent)=>{
      if(event.isComposing)return;
      if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==="f"&&!document.querySelector('[aria-modal="true"]')){event.preventDefault();show();}
      if(event.key==="Escape"&&open){event.preventDefault();close();}
    };
    window.addEventListener(OPEN_CONVERSATION_FIND,show);window.addEventListener("keydown",key);
    return()=>{window.removeEventListener(OPEN_CONVERSATION_FIND,show);window.removeEventListener("keydown",key);};
  },[open,close]);
  const move=async(delta:number)=>{
    if(!hits.length)return;
    cancel();const controller=new AbortController();pending.current=controller;
    const next=index<0?(delta<0?hits.length-1:0):(index+delta+hits.length)%hits.length;
    setIndex(next);setLocating(true);
    try { const found=await onReveal(hits[next].id,hits[next],controller.signal);if(!controller.signal.aborted)setMissed(found===false); }
    catch { if(!controller.signal.aborted)setMissed(true); }
    finally { if(!controller.signal.aborted){setLocating(false);input.current?.focus({preventScroll:true});} }
  };
  const host=scrollRef.current?.parentElement;
  if(!open||!host)return null;
  return createPortal(<section className={styles.find} role="dialog" aria-modal="false" aria-label={zh?"在会话中查找":"Find in conversation"} data-testid="conversation-find">
    <div className={styles.findRow}>
      <SearchIcon size={15}/><input ref={input} autoFocus type="search" aria-label={zh?"在会话中查找":"Find in conversation"} placeholder={zh?"在会话中查找":"Find in conversation"} value={query}
        onChange={event=>{cancel();setQuery(event.target.value);setIndex(-1);}}
        onKeyDown={event=>{if(event.nativeEvent.isComposing)return;if(event.key==="Enter"){event.preventDefault();if(event.shiftKey)move(-1);else move(1);}}}/>
      <span className={styles.findCount} aria-live="polite">{hits.length&&index>=0?Math.min(index+1,hits.length):0}/{hits.length}</span>
      <button type="button" disabled={!hits.length} onClick={()=>move(-1)} aria-label={zh?"上一处":"Previous match"} title={zh?"上一处 · Shift Enter":"Previous · Shift Enter"}><Icon name="arrowDown" className="rotate-180" size={14}/></button>
      <button type="button" disabled={!hits.length} onClick={()=>move(1)} aria-label={zh?"下一处":"Next match"} title={zh?"下一处 · Enter":"Next · Enter"}><Icon name="arrowDown" size={14}/></button>
      <button type="button" onClick={close} aria-label={zh?"关闭查找":"Close find"} title="Esc"><XIcon size={15}/></button>
    </div>
    {(locating||missed)&&<p className={styles.findFooter} role="status">{locating?(zh?"正在定位…":"Locating match…"):(zh?"未能定位正文中的这一处命中。记录已显示。":"Could not locate this occurrence in rendered text. The entry is shown.")}</p>}
    {query&&hasMore&&<div className={styles.findFooter}><span>{zh?"仅查找已加载记录":"Searching loaded messages"}</span><button type="button" disabled={loadingOlder} onClick={onOlder}>{zh?"加载更早记录":"Load older history"}</button></div>}
  </section>,host);
}
