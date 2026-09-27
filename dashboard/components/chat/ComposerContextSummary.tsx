"use client";
import {useLocale} from "next-intl";
import * as Popover from "@radix-ui/react-popover";
import {Icon} from "../icons";
import type {ChatRunSettings,ChatThread} from "../../lib/chat";
import styles from "./WorkbenchChrome.module.css";
export function ComposerContextSummary({thread,settings}:{thread:ChatThread|null;settings:ChatRunSettings}){
  const zh=useLocale().startsWith("zh");
  const last=thread?.messages.findLast(m=>m.role==="assistant");
  const budget=last?.role==="assistant"?last.turn?.budget:undefined;
  const prompt=budget?.prompt_tokens_last,window=budget?.context_window;
  if(typeof prompt!=="number"||!Number.isFinite(prompt))return null;
  const percentage=typeof window==="number"&&window>0?Math.round(prompt/window*100):null;
  return <Popover.Root><Popover.Trigger asChild><button type="button" className={styles.contextButton} data-testid="composer-context" aria-label={zh?"上下文用量":"Context usage"} title={zh?"上下文用量":"Context usage"}><Icon name="info" size={13}/>{percentage!==null?percentage+"%":Math.round(prompt/1000)+"k"}</button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="ui-select-menu w-72 p-4 text-xs" side="top" align="end" sideOffset={8} collisionPadding={8}><strong className="mb-2 block">{zh?"最近一次模型请求":"Last model request"}</strong><p>{prompt.toLocaleString()}{typeof window==="number"?" / "+window.toLocaleString():""} tokens</p><p className="mt-2 text-[color:var(--text-muted)]">{zh?"用量来自最近一次请求，不是下一轮的预测。":"Usage is from the last request, not a prediction for the next turn."}</p>{typeof budget?.compaction_count==="number"&&budget.compaction_count>0&&<p className="mt-2">{zh?"已压缩：":"Compactions: "}{budget.compaction_count}</p>}</Popover.Content></Popover.Portal>
  </Popover.Root>;
}
