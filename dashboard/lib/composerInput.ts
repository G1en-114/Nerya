/** Editor-independent composer protocol. ZCode reference: promptInputTriggers.ts.
 * A bare trigger must never consume the prose following the caret.
 */
export type ComposerReferenceKind = "file" | "skill" | "agent" | "strategy" | "session";
export type ComposerOption = {
  key: string; kind: ComposerReferenceKind | "folder"; id: string; label: string; detail: string;
};
export type ComposerTrigger = {
  mark: "@" | "/" | "\\"; mode: "context" | "command"; query: string; start: number; end: number;
};

export function composerTrigger(text: string, cursor: number, selectionEnd = cursor): ComposerTrigger | null {
  if (cursor !== selectionEnd || cursor < 0 || cursor > text.length) return null;
  const before = text.slice(0, cursor);
  // Leave code examples, email addresses, URLs and Windows paths alone.
  const fences = before.match(/^\s*(?:```|~~~)/gm) ?? [];
  if (fences.length % 2) return null;
  const line = before.slice(before.lastIndexOf("\n") + 1);
  if ((line.match(/(?<!\\)`/g) ?? []).length % 2) return null;
  const match = /(^|[\s\p{Script=Han}\u3000-\u303f\uff00-\uffef])(@)([^\s@\\]*)$/u.exec(before)
    ?? /(^|\s)([/\\])([^\s/@\\]*)$/.exec(before);
  if (!match) return null;
  const [, , mark, query] = match;
  return { mark: mark as ComposerTrigger["mark"], mode: mark === "@" ? "context" : "command",
    query, start: cursor - query.length - 1, end: cursor };
}

export function triggerSignature(trigger: ComposerTrigger | null): string {
  return trigger ? `${trigger.mark}:${trigger.start}:${trigger.query}` : "";
}

export function replaceComposerTrigger(text: string, trigger: ComposerTrigger, replacement: string, candidate = "") {
  let end = trigger.end;
  // /res|earch may complete /research. /|keep this text must preserve everything.
  if (trigger.query && candidate.toLowerCase().startsWith(trigger.query.toLowerCase())) {
    const remaining = candidate.slice(trigger.query.length);
    const tail = /^[^\s/@\\]*/.exec(text.slice(end))?.[0] ?? "";
    const comparable = tail.slice(0, remaining.length);
    if (comparable && remaining.toLowerCase().startsWith(comparable.toLowerCase())) end += comparable.length;
  }
  const suffix = text.slice(end);
  const insert = replacement && replacement !== "@" && suffix && !/^\s/.test(suffix) && !/\s$/.test(replacement)
    ? `${replacement} ` : replacement;
  return { text: text.slice(0, trigger.start) + insert + suffix, cursor: trigger.start + insert.length };
}

function fuzzyScore(value: string, query: string): number {
  const haystack = value.normalize("NFKC").toLowerCase();
  const needle = query.normalize("NFKC").toLowerCase().trim();
  if (!needle) return 0;
  if (haystack === needle) return 0;
  if (haystack.startsWith(needle)) return 10 + (haystack.length - needle.length) / 100;
  const index = haystack.indexOf(needle);
  if (index >= 0) return 100 + index;
  let start = 0, score = 200;
  for (const char of needle) {
    const found = haystack.indexOf(char, start);
    if (found < 0) return Infinity;
    score += found - start; start = found + 1;
  }
  return score;
}

export function filterComposerOptions(options: ComposerOption[], query: string): ComposerOption[] {
  if (!query.trim()) return options;
  return options.map((option, index) => ({ option, index, score: Math.min(
    fuzzyScore(option.id, query), fuzzyScore(option.label, query) + 1, fuzzyScore(option.detail, query) + 300,
  ) })).filter(item => Number.isFinite(item.score))
    .sort((a, b) => a.score - b.score || a.index - b.index).map(item => item.option);
}

export function composerFileQuery(query: string, browsedPath: string) {
  const slash = query.lastIndexOf("/");
  if (slash < 0) return { path: browsedPath, query };
  const path = query.slice(0, slash) || ".";
  if (query.startsWith("/") || path.split("/").includes("..")) return { path: browsedPath, query };
  return { path, query: query.slice(slash + 1) };
}
