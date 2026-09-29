"use client";
import Link from "next/link";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useLocale } from "next-intl";
import { Advanced, ErrorBanner, PageHeader, Pill } from "../../components/Page";
import { visualEvidence, visualError, type VisualArtifact, type FieldVersion } from "../../lib/visualEvidence";

const blank = () => ({label:"",raw_text:"",normalized_value:"",unit:"",period:"",review_status:"pending_review",quality_flags:[] as string[],bbox:[0,0,1,1]});
export default function VisualEvidencePage() {
  const zh = useLocale().startsWith("zh");
  const copy = (cn:string,en:string)=>zh?cn:en;
  const [items,setItems] = useState<VisualArtifact[]>([]);
  const [doc,setDoc] = useState<VisualArtifact|null>(null);
  const [image,setImage] = useState("");
  const [selected,setSelected] = useState("");
  const [version,setVersion] = useState<number|null>(null);
  const [draft,setDraft] = useState(blank);
  const [busy,setBusy] = useState(false);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState("");
  const [source,setSource] = useState("");
  const [published,setPublished] = useState("");
  const [claim,setClaim] = useState("");
  const drag = useRef<number[]|null>(null);
  const file = useRef<HTMLInputElement>(null);
  const historical = !!selected && version !== null && version !== doc?.fields.find(f=>f.field_id===selected)?.versions.at(-1)?.revision;

  async function open(id:string, fieldId="", revision:number|null=null) {
    setError(""); setLoading(true);
    try { const res=await visualEvidence.get(id); setDoc(res.artifact); setSelected(fieldId); setVersion(revision); }
    catch(e){setError(visualError(e,zh));} finally {setLoading(false);}
  }
  async function refresh() { const res=await visualEvidence.list(); setItems(res.artifacts); }
  useEffect(()=>{ const p=new URLSearchParams(location.search); void refresh().catch(e=>setError(visualError(e,zh))).finally(()=>setLoading(false)); if(p.get("artifact"))void open(p.get("artifact")!,p.get("field")||"",p.get("revision")?Number(p.get("revision")):null); },[]);
  useEffect(()=>{
    if(!doc)return;
    const field=doc.fields.find(f=>f.field_id===selected);
    const v=field?.versions.find(v=>v.revision===version) || field?.versions.at(-1);
    setDraft(v?{...v,normalized_value:v.normalized_value||""}:blank());
  },[doc,selected,version]);
  useEffect(()=>{
    setImage(""); if(!doc)return;
    const controller=new AbortController(); let url="";
    void visualEvidence.image(doc.artifact_id,controller.signal).then(blob=>{if(!controller.signal.aborted){url=URL.createObjectURL(blob);setImage(url);}}).catch(e=>{if(!controller.signal.aborted)setError(visualError(e,zh));});
    return ()=>{controller.abort();if(url)URL.revokeObjectURL(url);};
  },[doc?.artifact_id]);
  async function upload(value:File) {
    if(value.size>4_000_000){setError(visualError(new Error("image_too_large"),zh));return;}
    setBusy(true);setError("");
    try { const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(reader.error);reader.readAsDataURL(value);});
      const res=await visualEvidence.upload({image:data,filename:value.name,source_url:source,published_at:published||null}); setDoc(res.artifact);setSelected("");setVersion(null);setDraft(blank()); await refresh();
    } catch(e){setError(visualError(e,zh));} finally {setBusy(false);if(file.current)file.current.value="";}
  }
  function point(e:PointerEvent<HTMLDivElement>) { const r=e.currentTarget.getBoundingClientRect();return [Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)),Math.min(1,Math.max(0,(e.clientY-r.top)/r.height))]; }
  function move(e:PointerEvent<HTMLDivElement>) {if(!drag.current)return;const p=point(e),a=drag.current;setDraft(d=>({...d,bbox:[Math.min(a[0],p[0]),Math.min(a[1],p[1]),Math.abs(a[0]-p[0]),Math.abs(a[1]-p[1])]}));}
  async function save() {
    if(!doc)return;setBusy(true);setError("");
    try { const res=await visualEvidence.field({...draft,artifact_id:doc.artifact_id,field_id:selected||null,expected_revision:doc.revision});setDoc(res.artifact);setSelected(selected||res.artifact.fields.at(-1)!.field_id);setVersion(null); }
    catch(e){setError(visualError(e,zh));}finally{setBusy(false);}
  }
  async function cite() {
    if(!doc||!selected)return;setBusy(true);setError("");
    try { const current=doc.fields.find(f=>f.field_id===selected)!.versions.at(-1)!;const res=await visualEvidence.cite({artifact_id:doc.artifact_id,expected_revision:doc.revision,title:current.label,claim,field_refs:[{field_id:selected,revision:current.revision}]});setDoc(res.artifact);setClaim(""); }
    catch(e){setError(visualError(e,zh));}finally{setBusy(false);}
  }
  const statuses:Record<string,string>={pending_review:copy("待复核","Pending review"),reviewed:copy("已人工复核","Manually reviewed"),corrected:copy("已人工纠正","Manually corrected"),insufficient_information:copy("信息不足","Insufficient information")};
  const flags:Record<string,string>={blurred:copy("模糊","Blurred"),cropped:copy("裁切不完整","Cropped"),unit_ambiguous:copy("单位歧义","Ambiguous unit"),low_resolution:copy("分辨率低","Low resolution")};
  const [x,y,w,h]=draft.bbox;
  return <>
    <PageHeader title={copy("视觉证据工作台","Visual evidence workbench")} description={copy("框选原图、核对字段，再引用具体版本。当前为人工标注，不进行自动 OCR。","Select a source region, review the field, then cite a specific version. Manual annotation; no automatic OCR.")} actions={<Link href="/evidence" className="btn btn-ghost">{copy("打开证据库","Open evidence vault")}</Link>} />
    {error&&<ErrorBanner error={error}/>}
    <section className="mb-6 flex flex-wrap items-end gap-3">
      <label className="min-w-0 flex-1 text-xs text-[color:var(--text-muted)]">{copy("原始来源网址（可留空）","Original source URL (optional)")}<input type="url" className="input-dark mt-1" value={source} onChange={e=>setSource(e.target.value)} /></label>
      <label className="text-xs text-[color:var(--text-muted)]">{copy("实际发布日期（未知留空）","Actual publication date (optional)")}<input type="date" className="input-dark mt-1" value={published} onChange={e=>setPublished(e.target.value)} /></label>
      <input ref={file} type="file" accept="image/png,image/jpeg" className="sr-only" tabIndex={-1} onChange={e=>{if(e.target.files?.[0])void upload(e.target.files[0]);}}/>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={()=>file.current?.click()}>{busy?copy("保存中…","Saving…"):copy("上传图片","Upload image")}</button>
    </section>
    <div className="mb-5 flex flex-wrap gap-3 items-center"><label className="text-sm">{copy("研究资料","Research source")} <select aria-label={copy("选择研究资料","Select research source")} className="input-dark ml-2 !w-auto max-w-full" value={doc?.artifact_id||""} onChange={e=>void open(e.target.value)}><option value="" disabled>{loading?copy("读取中…","Loading…"):copy("选择已上传图片","Choose an uploaded image")}</option>{items.map(item=><option key={item.artifact_id} value={item.artifact_id}>{item.filename}</option>)}</select></label>{doc&&<Pill tone="warn">{copy("来源未验证 · 人工标注","Unverified source · Manual annotation")}</Pill>}</div>
    {!doc?<div className="border-y border-[color:var(--line)] py-14 text-center text-[color:var(--text-muted)]">{copy("上传一页含简单表格的 PNG 或 JPEG，最大 4 MB。图片与字段会保存为共享工作区研究资料。","Upload one PNG or JPEG page with a simple table, up to 4 MB. Images and fields are shared workspace research material.")}</div>:<>
      <div className="grid gap-7 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,1fr)]">
        <section className="min-w-0">
          <div className="mb-3 flex flex-wrap justify-between gap-2"><h2 className="font-medium">{copy("原始图片 · 第 1 页","Original image · Page 1")}</h2><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>{setSelected("");setVersion(null);setDraft(blank());}}>{copy("标注新字段","Annotate new field")}</button></div>
          <div className="overflow-hidden rounded-lg border border-[color:var(--line)] bg-white">
            {image?<div className="relative touch-none select-none" data-testid="visual-image" onPointerDown={e=>{if(historical||busy)return;e.currentTarget.setPointerCapture(e.pointerId);drag.current=point(e);}} onPointerMove={move} onPointerUp={e=>{move(e);drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}>
              <img src={image} alt={copy("研究资料原图","Original research source")} className="block w-full h-auto" draggable={false}/>
              <div data-testid="visual-region" aria-hidden="true" className="pointer-events-none absolute border-2 border-brand-500 bg-brand-500/15" style={{left:`${x*100}%`,top:`${y*100}%`,width:`${w*100}%`,height:`${h*100}%`}}/>
            </div>:<p role="status" className="p-10 text-black">{copy("读取原图…","Loading original image…")}</p>}
          </div>
          <p className="mt-2 text-xs text-[color:var(--text-muted)]">{copy("拖动框选字段对应区域。键盘用户可在右侧修改区域坐标。","Drag to select the field region. Keyboard users can edit coordinates on the right.")}</p>
          <Advanced title={copy("来源与文件校验","Source and file integrity")}><dl className="space-y-2 break-all text-xs"><div>{copy("文件摘要","SHA-256")}: {doc.file_sha256}</div><div>{copy("采集时间","Captured")}: {doc.captured_at}</div><div>{copy("发布日期","Published")}: {doc.published_at||copy("未知","Unknown")}</div><div>{copy("来源","Source")}: {doc.source_url||copy("未提供","Not provided")}</div><div>{doc.width} × {doc.height} px · {copy("摘要仅用于校验文件一致，不证明内容真实。","A hash verifies file integrity, not factual truth.")}</div></dl></Advanced>
        </section>
        <section className="min-w-0 space-y-4">
          <div className="flex flex-wrap gap-2" aria-label={copy("已标注字段","Annotated fields")}>{doc.fields.map(f=>{const v=f.versions.at(-1)!;return <button type="button" key={f.field_id} aria-pressed={selected===f.field_id} className={`btn ${selected===f.field_id?"btn-secondary":"btn-ghost"}`} disabled={busy} onClick={()=>{setSelected(f.field_id);setVersion(null);}}>{v.label} · v{v.revision}</button>;})}</div>
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-medium">{selected?copy("字段复核","Review field"):copy("新字段","New field")}</h2>{selected&&<select aria-label={copy("字段版本","Field version")} className="input-dark !w-auto" value={version||doc.fields.find(f=>f.field_id===selected)?.versions.at(-1)?.revision} onChange={e=>setVersion(Number(e.target.value))}>{doc.fields.find(f=>f.field_id===selected)?.versions.map(v=><option key={v.revision} value={v.revision}>v{v.revision} · {v.reviewer_id}</option>)}</select>}</div>
          {historical&&<p role="status" className="text-sm text-warn">{copy("正在查看历史版本，只读；引用与原图区域保持当时的内容。","Viewing a read-only historical version. The citation and image region retain their original content.")}</p>}
          <fieldset disabled={busy||historical} className="space-y-3">
            {([['label',copy("字段名称","Field label")],['raw_text',copy("原图文字","Original text")],['normalized_value',copy("数值（不确定留空）","Value (empty if uncertain)")],['unit',copy("单位","Unit")],['period',copy("历史所属期","Historical period")]] as const).map(([key,label])=><label key={key} className="block text-xs text-[color:var(--text-muted)]">{label}<input className="input-dark mt-1" value={draft[key]} onChange={e=>setDraft(d=>({...d,[key]:e.target.value}))}/></label>)}
            <label className="block text-xs text-[color:var(--text-muted)]">{copy("复核状态","Review status")}<select className="input-dark mt-1" value={draft.review_status} onChange={e=>setDraft(d=>({...d,review_status:e.target.value}))}>{Object.entries(statuses).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
            <div className="flex flex-wrap gap-3">{Object.entries(flags).map(([key,label])=><label key={key} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={draft.quality_flags.includes(key)} onChange={e=>setDraft(d=>({...d,quality_flags:e.target.checked?[...d.quality_flags,key]:d.quality_flags.filter(f=>f!==key)}))}/>{label}</label>)}</div>
            <Advanced title={copy("区域坐标（0–1，左上角原点）","Region coordinates (0–1, top-left origin)")}><div className="grid grid-cols-2 gap-2">{['x','y',copy('宽','width'),copy('高','height')].map((label,i)=><label key={i} className="text-xs">{label}<input className="input-dark mt-1" type="number" min="0" max="1" step="0.001" value={draft.bbox[i]} onChange={e=>setDraft(d=>({...d,bbox:d.bbox.map((n,j)=>j===i?Number(e.target.value):n)}))}/></label>)}</div></Advanced>
            <button type="button" className="btn btn-primary" onClick={()=>void save()}>{copy("保存字段新版本","Save field revision")}</button>
          </fieldset>
          {selected&&<p className="text-xs text-[color:var(--text-muted)]">{copy("人工复核记录","Manual review")}: {doc.fields.find(f=>f.field_id===selected)?.versions.find(v=>v.revision===(version||doc.fields.find(f=>f.field_id===selected)?.versions.at(-1)?.revision))?.reviewer_id}</p>}
        </section>
      </div>
      <section className="mt-8 border-t border-[color:var(--line)] pt-5">
        <h2 className="font-medium">{copy("研究结论与证据引用","Research claims and citations")}</h2><p className="mt-1 text-sm text-[color:var(--text-muted)]">{copy("仅引用复核完成的当前字段版本。这里保存的是待验证假设，不代表实验结果或已验证事实。","Cite a reviewed current field revision. These are unvalidated hypotheses, not experiment results or verified facts.")}</p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row"><label className="min-w-0 flex-1 text-xs">{copy("基于当前字段的候选结论","Candidate claim based on selected field")}<textarea className="input-dark mt-1" rows={2} value={claim} onChange={e=>setClaim(e.target.value)}/></label><button type="button" className="btn btn-secondary self-end" disabled={busy||!selected||!claim.trim()||historical} onClick={()=>void cite()}>{copy("保存结论并引用字段","Save claim with citation")}</button></div>
        <div className="mt-5 divide-y divide-[color:var(--line)]">{doc.claims.map(c=><article key={c.claim_id} className="py-4"><div className="mb-2 flex flex-wrap gap-3"><h3 className="font-medium">{c.title}</h3><Pill tone="warn">{c.status==="needs_review"?copy("字段已修正 · 结论待重算","Field changed · Claim needs review"):copy("待验证假设","Unvalidated hypothesis")}</Pill></div><p className="whitespace-pre-wrap text-sm">{c.claim}</p><div className="mt-3 flex flex-wrap gap-4 text-xs">{c.field_refs.map(ref=><Link key={ref.field_id} href={`/visual-evidence?artifact=${doc.artifact_id}&field=${ref.field_id}&revision=${ref.revision}`} className="text-brand-300 underline underline-offset-4">{copy("定位原图字段","Locate source field")} · v{ref.revision}</Link>)}<Link href={`/evidence?id=${c.evidence_id}`} className="text-brand-300 underline underline-offset-4">{copy("查看研究证据","Open research evidence")}</Link></div></article>)}</div>
      </section>
    </>}
  </>;
}
