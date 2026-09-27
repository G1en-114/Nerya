"use client";
import { useLocale } from "next-intl";
import { useState } from "react";
import { contentValue, fieldLabel, record, safeLink } from "../../lib/agentConversation";
import type { ToolFamily } from "../../lib/toolSemantics";
import { interactionReceipt, isUnifiedDiff } from "../../lib/toolOutputPresentation";
import { Markdown } from "./Markdown";
import { CodeOutput } from "./CodeOutput";
import { InteractionReceipt } from "./InteractionReceipt";
import { CheckIcon } from "../icons";
import styles from "./ExecutionTimeline.module.css";

/** Small, typed previews. Full transport remains available in the diagnostic disclosure. */
export function ToolResultContent({value,family,path="",depth=0}:{value:unknown;family:ToolFamily;path?:string;depth?:number}) {
  const zh=useLocale().startsWith("zh");
  if(depth>5)return <p className={styles.caption}>{zh?"更多嵌套字段见诊断详情。":"Further nested fields are available in diagnostics."}</p>;
  const raw=record(value),structured=raw.structuredContent||raw.structured_content;
  const media=Array.isArray(raw.content)?raw.content.filter(part=>record(part).type!=="text"):[];
  if(structured&&typeof structured==="object"&&media.length) return <>
    <ToolResultContent value={structured} family={family} path={path} depth={depth+1}/>
    <ToolResultContent value={{content:media}} family={family} path={path} depth={depth+1}/>
  </>;
  const decoded=contentValue(value),data=record(decoded);
  if(Array.isArray(data.content)) return <div className={styles.contentParts} data-testid="tool-content-parts">{data.content.slice(0,40).map((part,index)=>{
    const item=record(part),resource=record(item.resource);
    if(item.type==="diff")return <CodeOutput key={index} diff text={String(item.text||item.diff||"")} path={String(record(item.metadata).path||item.path||path)}/>;
    if(item.type==="code")return <CodeOutput key={index} text={String(item.text||"")} path={String(record(item.metadata).path||item.path||path)}/>;
    if(item.type==="json"||item.type==="shell")return <ToolResultContent key={index} value={item.data??item.text} family={item.type==="shell"?"shell":family} path={path} depth={depth+1}/>;
    if(item.type==="text"&&typeof item.text==="string")return <ToolResultContent key={index} value={item.text} family={family} path={path} depth={depth+1}/>;
    const mime=String(item.mimeType||item.mime_type||item.media_type||"");
    if(item.type==="image"&&/^image\/(png|jpeg|webp|gif)$/.test(mime)&&typeof item.data==="string"&&item.data.length<7000000)
      // eslint-disable-next-line @next/next/no-img-element
      return <img key={index} src={`data:${mime};base64,${item.data}`} alt={zh?"工具返回的图像":"Image returned by tool"} className={styles.outputImage} loading="lazy"/>;
    if(item.type==="resource"&&typeof resource.text==="string")return <CodeOutput key={index} text={resource.text} path={String(resource.uri||"")}/>;
    return <p key={index} className={styles.caption}>{zh?"其他内容见诊断详情":"Additional content is available in diagnostics"}</p>;
  })}</div>;
  if(typeof data.diff==="string")return <CodeOutput diff text={data.diff} path={String(data.path||path)}/>;
  if(typeof decoded==="string") {
    const receipt=interactionReceipt(decoded);
    if(receipt)return <InteractionReceipt receipt={receipt}/>;
    if(isUnifiedDiff(decoded))return <CodeOutput diff text={decoded} path={path}/>;
    // Transport fragments are not prose. Never hand damaged/compacted JSON to Markdown.
    if(/^\s*(?:\{\s*"|\[\s*\{|"[\w/-]+"\s*:)/.test(decoded)||decoded.includes("[compacted_kept]"))return <p className={styles.caption}>{zh?"已收到结构化结果；当前记录不完整，可在诊断详情查看原始内容。":"Structured output received. This record is incomplete; inspect the original in diagnostics."}</p>;
    if(family==="read"&&/\.(?:py|tsx?|jsx?|json|ya?ml|toml|sh|rs|css|sql)(?:$|\?)/i.test(path))return <CodeOutput text={decoded} path={path}/>;
    return <div className={styles.resultBody}><Markdown className={styles.compactMarkdown}>{decoded.slice(0,24000)}</Markdown>{decoded.length>24000&&<p className={styles.caption}>{zh?"预览已截断，完整记录见诊断详情。":"Preview truncated; see diagnostics for the full record."}</p>}</div>;
  }
  if(typeof data.stdout==="string"||typeof data.stderr==="string")return <CodeOutput text={[data.stdout,data.stderr].filter(Boolean).join("\n")} label={typeof data.exit_code==="number"?`${zh?"退出码":"Exit"} ${data.exit_code}`:undefined}/>;
  const tasks=Array.isArray(data.todos)?data.todos:Array.isArray(data.tasks)?data.tasks:family==="plan"&&Array.isArray(decoded)?decoded:null;
  if(tasks) return <div className={styles.checklist} data-testid="tool-task-checklist">{tasks.slice(0,80).map((task,index)=>{
    const row=record(task),status=String(row.status||"pending"),done=["completed","done","succeeded"].includes(status);
    return <div key={String(row.id||index)} className={styles.checkItem} data-state={status}>
      {done?<CheckIcon size={14}/>:<span className={styles.checkCircle}/>}
      <span>{String(row.content||row.title||row.text||row.description||"")}</span>
      <span className={styles.state}>{done?(zh?"已完成":"Done"):status==="in_progress"||status==="running"?(zh?"进行中":"In progress"):(zh?"待处理":"Pending")}</span>
    </div>;
  })}{tasks.length>80&&<p>{zh?"仅展示前 80 项；完整数据见诊断详情。":"Showing 80 items; full data is in diagnostics."}</p>}</div>;
  const sources=Array.isArray(data.sources)?data.sources:family==="search"&&Array.isArray(data.results)?data.results:null;
  if(sources?.some(item=>safeLink(record(item).url||record(item).link))) return <div className={styles.sources} data-testid="tool-source-results">
    {sources.slice(0,12).map((item,index)=>{const row=record(item),url=safeLink(row.url||row.link);return <div key={url||index} className={styles.source}>
      {url?<a href={url} target="_blank" rel="noopener noreferrer">{String(row.title||row.name||url)}</a>:<span>{String(row.title||row.name||"")}</span>}
      {row.snippet||row.description?<p>{String(row.snippet||row.description).slice(0,400)}</p>:null}
    </div>;})}
    {sources.length>12&&<p>{zh?`共 ${sources.length} 项，展示前 12 项。`:`${sources.length} sources; showing the first 12.`}</p>}
  </div>;
  const candles=Array.isArray(data.candles)?data.candles:family==="market"&&Array.isArray(data.rows)?data.rows:null;
  if(candles?.length&&candles.every(row=>Array.isArray(row)||"close" in record(row)))return <div className={styles.tableWrap} data-testid="tool-market-preview">
    <p className={styles.caption}>{[data.market||data.symbol,data.timeframe].filter(Boolean).join(" · ")} · {zh?`共 ${candles.length} 条，展示末尾 ${Math.min(8,candles.length)} 条`:`${candles.length} candles; last ${Math.min(8,candles.length)} shown`}</p>
    <table><thead><tr>{(zh?["时间","开","高","低","收","量"]:["Time","Open","High","Low","Close","Volume"]).map(label=><th key={label}>{label}</th>)}</tr></thead>
      <tbody>{candles.slice(-8).map((item,index)=>{const row=record(item),cells=Array.isArray(item)?item.slice(0,6):[row.time||row.timestamp||row.ts,row.open,row.high,row.low,row.close,row.volume];return <tr key={index}>{cells.map((cell,i)=><td key={i}>{cell==null?"—":String(cell)}</td>)}</tr>;})}</tbody>
    </table>
  </div>;
  if(decoded==null)return null;
  if(typeof decoded!=="object")return <p>{String(decoded)}</p>;
  return <StructuredResult value={decoded} family={family} depth={depth}/>;
}

const fieldNames:Record<string,[string,string]>={strategy_id:["策略","Strategy"],status:["状态","Status"],state:["状态","State"],name:["名称","Name"],title:["名称","Title"],path:["文件","File"],main_path:["策略脚本","Script"],strategy_yml_path:["配置","Configuration"],strategy_md_path:["说明","Documentation"],workflow_path:["工作流","Workflow"],tests_path:["测试","Tests"],proposal_id:["版本记录","Version record"],next_steps:["后续说明","Next steps"],files:["相关文件","Files"],bytes_after:["文件字节数","File bytes"],lines_after:["文件行数","File lines"],occurrences_replaced:["替换次数","Replacements"],count:["数量","Count"],market:["交易品种","Market"],symbol:["品种","Symbol"],timeframe:["周期","Timeframe"],validation:["验证","Validation"],metrics:["指标","Metrics"]};
const internalFields=new Set(["kind","type","role","call_id","tool_use_id","content_hash","sha256","tokens","usage","next_steps"]);
function StructuredResult({value,family,depth}:{value:unknown;family:ToolFamily;depth:number}) {
  const zh=useLocale().startsWith("zh");
  const data=record(value);
  const proseKeys=["summary","message","answer","markdown","final_text"];
  const prose=proseKeys.filter(key=>typeof data[key]==="string"&&data[key]);
  const entries=Array.isArray(value)?value.slice(0,12).map((item,index)=>[String(index+1),item] as const):Object.entries(data).filter(([key,val])=>!internalFields.has(key)&&!prose.includes(key)&&val!=null&&val!=="");
  const count=Array.isArray(value)?value.length:entries.length;
  return <div className={styles.structuredResult} data-testid="tool-structured-result">
    {prose.map(key=><ToolResultContent key={key} value={data[key]} family={family} depth={depth+1}/>)}
    <dl className={styles.resultFields}>{entries.slice(0,12).map(([key,item])=>{
      const label=fieldNames[key]?.[zh?0:1]||fieldLabel(key,zh);
      const simple=typeof item==="string"||typeof item==="number"||typeof item==="boolean";
      const file=simple&&typeof item==="string"&&(key.endsWith("_path")||key==="path");
      return <div key={key}><dt>{label}</dt><dd>{simple?<span className={file?styles.fileValue:undefined} title={file?String(item):undefined}>{file?String(item).split("/").pop():typeof item==="boolean"?(item?(zh?"是":"Yes"):(zh?"否":"No")):String(item)}</span>:<NestedResult value={item} family={family} depth={depth+1}/>}</dd></div>;
    })}</dl>
    {count>12&&<p className={styles.caption}>{zh?`另有 ${count-12} 项，见诊断详情。`:`${count-12} more items in diagnostics.`}</p>}
    {Array.isArray(data.next_steps)&&<details className={styles.nestedResult}><summary>{zh?"后续说明":"Next steps"}</summary><ul>{data.next_steps.slice(0,12).map((item,index)=><li key={index}>{typeof item==="string"?item:fieldLabel(String(index+1),zh)}</li>)}</ul></details>}
    {!entries.length&&!prose.length&&<p className={styles.caption}>{zh?"没有附加输出。":"No additional output."}</p>}
  </div>;
}

function NestedResult({value,family,depth}:{value:unknown;family:ToolFamily;depth:number}) {
  const zh=useLocale().startsWith("zh"),[open,setOpen]=useState(false);
  return <details className={styles.nestedResult} onToggle={event=>setOpen(event.currentTarget.open)}><summary>{Array.isArray(value)?`${value.length} ${zh?"项":"items"}`:`${Object.keys(record(value)).length} ${zh?"个字段":"fields"}`}</summary>{open&&<ToolResultContent value={value} family={family} depth={depth}/>}</details>;
}
