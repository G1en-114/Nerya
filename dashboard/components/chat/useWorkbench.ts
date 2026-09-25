"use client";
import { useEffect, useState } from "react";
import { ApiError, callApi } from "../../lib/clientApi";
import type { Connection, RuntimeInfo, SessionView } from "../../lib/workbench";

let runtimeRequest: Promise<RuntimeInfo> | undefined;
let runtimeExpires=0;
export function getRuntimeInfo() {
  if(Date.now()>runtimeExpires){runtimeRequest=undefined;runtimeExpires=Date.now()+10000;}
  return runtimeRequest ??= callApi<RuntimeInfo>("/runtime/info").then(info => {
    if (info.protocol_version !== 1 || !Array.isArray(info.capabilities) || !info.capabilities.includes("conversation_commands") || !info.capabilities.includes("session_view")) throw new Error("runtime_incompatible");
    return info;
  }).catch(error => { runtimeRequest = undefined; throw error; });
}

export function useWorkbench(sessionId?: string) {
  const [state, setState] = useState<{ sid?: string; view: SessionView | null; runtime: RuntimeInfo | null; connection: Connection }>({ view:null, runtime:null, connection:"connecting" });
  const [revision,setRevision] = useState(0);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    let active=false;
    async function tick() {
      let info: RuntimeInfo | null = null;
      try {
        info = await getRuntimeInfo();
        let view: SessionView | null = null;
        if (sessionId) {
          try { view = await callApi<SessionView>("/agent/sessions/view?session_id="+encodeURIComponent(sessionId), {signal:controller.signal}); }
          catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
          if (view && (!view.status || view.session_id !== sessionId)) throw new Error("runtime_incompatible");
        }
        active=Boolean(view&&["running","stopping","queued"].includes(view.status.execution));
        if (!stopped) setState(old => old.sid === sessionId && old.connection === "online" && old.view?.revision === view?.revision && old.runtime === info ? old : {sid:sessionId,view,runtime:info,connection:"online"});
      } catch(error) {
        runtimeRequest=undefined;
        if (!stopped) setState(old => ({sid:sessionId,view:old.sid===sessionId ? old.view:null,runtime:info || old.runtime,
          connection: error instanceof Error && error.message === "runtime_incompatible" || error instanceof ApiError && [404,405].includes(error.status) ? "incompatible" : "offline"}));
      } finally {
        if (!stopped) timer=setTimeout(tick,document.hidden ? 10000 : active ? 500 : 2000);
      }
    }
    void tick();
    return () => { stopped=true; controller.abort(); clearTimeout(timer); };
  },[sessionId,revision]);
  return {...state,view:state.sid===sessionId ? state.view:null,refresh:()=>{runtimeRequest=undefined;setRevision(v=>v+1);}};
}
