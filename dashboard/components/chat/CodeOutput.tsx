"use client";
import { memo, useMemo, useState } from "react";
import { useLocale } from "next-intl";
import { diffLines } from "../../lib/toolOutputPresentation";
import { CopyButton } from "./tool-cards/atoms";
import { FileIcon } from "../icons";
import styles from "./ExecutionTimeline.module.css";

export const CodeOutput = memo(function CodeOutput({ text, path = "", diff = false, label }: { text: string; path?: string; diff?: boolean; label?: string }) {
  const zh = useLocale().startsWith("zh"), [large, setLarge] = useState(false);
  const preview = text.slice(0, 64000);
  const rows = useMemo(() => diff ? diffLines(preview) : [], [diff, preview]);
  const added = rows.filter(row => row.kind === "added").length;
  const removed = rows.filter(row => row.kind === "removed").length;
  const target = path || /^\+\+\+ (?:b\/)?([^\n]+)/m.exec(text)?.[1] || "";
  return <div className={styles.codeOutput} data-testid={diff ? "tool-diff-preview" : "tool-code-preview"}>
    <div className={styles.codeHeader}>
      <FileIcon size={13}/><span className={styles.codeTitle} title={target}>{target.split("/").pop() || label || (diff ? (zh ? "文件变更" : "File changes") : (zh ? "输出" : "Output"))}</span>
      {diff && <span className={styles.diffStats} aria-label={zh ? `新增 ${added} 行，删除 ${removed} 行` : `${added} added, ${removed} removed`}><span>+{added}</span><span>−{removed}</span></span>}
      <button type="button" onClick={() => setLarge(!large)} aria-expanded={large} className={styles.textButton}>{large ? (zh ? "收起" : "Collapse") : (zh ? "展开" : "Expand")}</button>
      <CopyButton text={text}/>
    </div>
    <div className={styles.codeViewport} data-expanded={large} tabIndex={0} aria-label={label || (diff ? (zh ? "代码差异" : "Code diff") : (zh ? "代码输出" : "Code output"))}>
      {diff ? <table className={styles.diffTable}><tbody>{rows.map((row, index) => <tr key={index} data-line-kind={row.kind}>
        <td aria-hidden="true">{row.oldLine}</td><td aria-hidden="true">{row.newLine}</td><td><code>{row.text || " "}</code></td>
      </tr>)}</tbody></table> : <pre>{preview}</pre>}
    </div>
    {text.length > preview.length && <p className={styles.caption}>{zh ? "显示前 64,000 个字符；复制可获取当前收到的完整内容。" : "Showing the first 64,000 characters. Copy includes all received content."}</p>}
  </div>;
});
