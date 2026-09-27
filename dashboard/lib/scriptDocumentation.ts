/** Documentation only: annotations neither execute code nor prove a step ran. */
export type DocumentedStep = {
  id: string; title: string; description: string; line: number;
  inputs: string[]; outputs: string[]; risks: string[];
  next: Array<{ id: string; condition: string }>;
};
export type ScriptDocumentation = {
  title: string; description: string; inputs: string[]; outputs: string[]; risks: string[];
  logic: string; rationale: string; scope: string[]; validation: string[];
  changes: Array<{ target: string; before: string; after: string; reason: string }>;
  steps: DocumentedStep[]; warnings: number;
};

// Conservative Python string/comment scanning; never evaluate the script.
function standaloneComments(source: string): Array<{ text: string; line: number }> {
  const result: Array<{ text: string; line: number }> = [];
  let quote = "";
  for (const [index, line] of source.slice(0, 200_000).split(/\r?\n/).entries()) {
    for (let i = 0; i < line.length; i += 1) {
      if (quote) {
        if (line[i] === "\\") { i += 1; continue; }
        if (line.startsWith(quote, i)) { i += quote.length - 1; quote = ""; }
      } else if (line[i] === "#") {
        if (!line.slice(0, i).trim()) result.push({ text: line.slice(i), line: index + 1 });
        break;
      } else if (line[i] === "'" || line[i] === '"') {
        const triple = line[i].repeat(3);
        quote = line.startsWith(triple, i) ? triple : line[i];
        i += quote.length - 1;
      }
    }
    // Recover a single-line string while the user is editing incomplete code.
    if (quote.length === 1 && !line.endsWith("\\")) quote = "";
  }
  return result;
}

export function parseScriptDocumentation(source: string): ScriptDocumentation {
  const doc: ScriptDocumentation = { title: "", description: "", logic: "", rationale: "", scope: [], validation: [], changes: [], inputs: [], outputs: [], risks: [], steps: [], warnings: source.length > 200_000 ? 1 : 0 };
  let step: DocumentedStep | undefined;
  for (const comment of standaloneComments(source)) {
    const match = /^#\s*@nerya\.(version|title|description|logic|rationale|scope|change|validation|input|output|risk|step|next)(?:\s*:\s*|\s+)(.+)$/.exec(comment.text);
    if (!match) { if (/^#\s*@nerya\./.test(comment.text)) doc.warnings += 1; continue; }
    const [, tag, raw] = match;
    const value = raw.trim().slice(0, 2000);
    if (tag === "version") { if (value !== "1") doc.warnings += 1; }
    else if (tag === "scope" || tag === "validation") { if (doc[tag].length < 30) doc[tag].push(value); }
    else if (tag === "change") {
      const [target, before, after, ...reason] = value.split("|").map((part) => part.trim());
      if (!target || !before || !after || !reason.join("") || doc.changes.length >= 30) doc.warnings += 1;
      else doc.changes.push({ target, before, after, reason: reason.join(" | ") });
    } else if (tag === "logic" || tag === "rationale") doc[tag] = value;
    else if (tag === "step") {
      const [id, title, ...description] = value.split("|").map((part) => part.trim());
      if (!/^[a-zA-Z][\w-]{0,63}$/.test(id) || !title || doc.steps.some((item) => item.id === id) || doc.steps.length >= 100) { doc.warnings += 1; step = undefined; continue; }
      step = { id, title, description: description.join(" | "), line: comment.line, inputs: [], outputs: [], risks: [], next: [] };
      doc.steps.push(step);
    } else if (tag === "title") doc.title = value;
    else if (tag === "description") doc.description = value;
    else if (tag === "next") {
      const [id, ...condition] = value.split("|").map((part) => part.trim());
      if (step && /^[a-zA-Z][\w-]{0,63}$/.test(id)) step.next.push({ id, condition: condition.join(" | ") });
      else doc.warnings += 1;
    } else {
      const key = tag === "input" ? "inputs" : tag === "output" ? "outputs" : "risks";
      const target = step || doc;
      if (target[key].length < 30) target[key].push(value);
    }
  }
  for (const item of doc.steps) for (const next of item.next) {
    if (!doc.steps.some((target) => target.id === next.id)) doc.warnings += 1;
  }
  // Older packages often have a module docstring. Preserve that authored prose,
  // but never infer trading behavior from identifiers or execute Python.
  if (!doc.description) {
    const moduleDoc = /^(?:\uFEFF)?(?:[ \t]*(?:#[^\n]*)?\r?\n)*[ \t]*[rRuU]?("""|''')([\s\S]*?)\1/.exec(source.slice(0, 200_000));
    if (moduleDoc) doc.description = moduleDoc[2].trim().slice(0, 2000);
  }
  return doc;
}
