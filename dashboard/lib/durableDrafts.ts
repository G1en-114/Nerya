import { hasChatDraft, type ChatDraft } from "./chatDraft";
import { getWorkspaceIdentity } from "./workspaceIdentity";

export type SavedDraft={key:string;workspace:string;windowId:string;scope:string;updatedAt:number;draft:ChatDraft};
let database:Promise<IDBDatabase>|undefined;
let windowId="";
const pending=new Map<string,SavedDraft>();
let timer:ReturnType<typeof setTimeout>|undefined;
function db(){
  return database??=new Promise<IDBDatabase>((resolve,reject)=>{
    const req=indexedDB.open("nerya-workbench-drafts",1);
    req.onupgradeneeded=()=>req.result.createObjectStore("drafts",{keyPath:"key"});
    req.onsuccess=()=>resolve(req.result);req.onerror=()=>{database=undefined;reject(req.error);};
  });
}
export function draftWindowId(){
  if(windowId)return windowId;
  try {
    const navigation=performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming|undefined;
    const saved=sessionStorage.getItem("nerya.draft.window");
    // A newly duplicated tab gets a new writer identity. Reload retains its own.
    windowId=navigation?.type==="reload"&&saved?saved:crypto.randomUUID();
    sessionStorage.setItem("nerya.draft.window",windowId);
  }catch{windowId=crypto.randomUUID();}
  return windowId;
}
export function safeDraft(draft:ChatDraft):ChatDraft{
  return {...draft,attachments:draft.attachments.map(file=>({...file,data_url:undefined,text:undefined,
    reason:file.artifact_uri?file.reason:"reselect_required"}))};
}
export async function savedDrafts(workspace:string,scope:string):Promise<SavedDraft[]>{
  if (!workspace || workspace !== getWorkspaceIdentity()) return [];
  const store=(await db()).transaction("drafts").objectStore("drafts");
  return new Promise((resolve,reject)=>{const request=store.getAll();request.onsuccess=()=>resolve(workspace !== getWorkspaceIdentity() ? [] : (request.result as SavedDraft[]).filter(r=>r.workspace===workspace&&r.scope===scope&&hasChatDraft(r.draft)).sort((a,b)=>b.updatedAt-a.updatedAt));request.onerror=()=>reject(request.error);});
}
async function flush(){
  const writes=[...pending.values()];pending.clear();
  if(!writes.length)return;
  try {
    const database=await db();
    await new Promise<void>((resolve,reject)=>{const tx=database.transaction("drafts","readwrite"),store=tx.objectStore("drafts");
      for(const row of writes){if(!hasChatDraft(row.draft))store.delete(row.key);else store.put(row);}
      tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
    });
  } catch {window.dispatchEvent(new Event("nerya:draft-storage-unavailable"));}
}
export function saveDurableDraft(workspace:string,scope:string,draft:ChatDraft){
  if (!workspace || workspace !== getWorkspaceIdentity()) return;
  const id=draftWindowId(),key=JSON.stringify([workspace,id,scope]);
  pending.set(key,{key,workspace,windowId:id,scope,updatedAt:Date.now(),draft:safeDraft(draft)});
  if(timer)clearTimeout(timer);timer=setTimeout(()=>void flush(),120);
}
if(typeof window!=="undefined"){
  window.addEventListener("pagehide",()=>{void flush();});
  document.addEventListener("visibilitychange",()=>{if(document.hidden)void flush();});
}
