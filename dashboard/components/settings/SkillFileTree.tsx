"use client";

import { useTranslations } from "next-intl";

type Node = { files: string[]; folders: Map<string, Node> };
function tree(paths: string[]): Node {
  const root: Node = { files: [], folders: new Map() };
  for (const path of paths) {
    const parts = path.split("/"); let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.folders.has(part)) node.folders.set(part, { files: [], folders: new Map() });
      node = node.folders.get(part)!;
    }
    node.files.push(parts[parts.length - 1]);
  }
  return root;
}

export function SkillFileTree({ files, selected, disabled, onSelect }: {
  files: string[]; selected: string; disabled: boolean; onSelect: (path: string) => void;
}) {
  const t = useTranslations("settings.skillManagement");
  function branch(node: Node, prefix = "") {
    return <ul className="space-y-1">
      {Array.from(node.folders).sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => <li key={name}><details open><summary className="cursor-pointer break-all rounded px-2 py-1.5 text-xs font-medium">{name}/</summary><div className="ml-3 border-l border-[color:var(--line)] pl-2">{branch(child, prefix + name + "/")}</div></details></li>)}
      {node.files.sort((a, b) => a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b)).map(name => <li key={name}><button type="button" title={prefix + name} aria-current={selected === prefix + name ? "page" : undefined} disabled={disabled} onClick={() => onSelect(prefix + name)} className={"w-full break-all rounded px-2 py-2 text-left font-mono text-xs hover:bg-brand-500/10 " + (selected === prefix + name ? "bg-brand-500/10 font-semibold text-brand-500" : "")}>{name}</button></li>)}
    </ul>;
  }
  return <nav aria-label={t("fileTree")}>{branch(tree(files))}</nav>;
}
