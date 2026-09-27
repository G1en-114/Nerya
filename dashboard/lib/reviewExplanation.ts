import type { EvolutionTimelineItem } from "./evolutionTypes";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const rows = (value: unknown) => Array.isArray(value) ? value.map(object) : [];
const texts = (value: unknown): string[] => typeof value === "string" ? [value].filter(Boolean) : Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item.trim()) : [];

/** Read the recorded output; never turn replacement source or a raw JSON blob into prose. */
export function reviewOutput(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return object(value);
  if (value.length > 200_000) return {};
  try { return object(JSON.parse(value.trim().replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```$/, ""))); } catch { return {}; }
}

export function reviewExplanation(record: Record<string, unknown>, rawOutput?: unknown) {
  const saved = reviewOutput(record.subagent_output);
  const output = Object.keys(saved).length ? saved : reviewOutput(rawOutput);
  const proposed = rows(output.proposed_changes);
  const dropped = rows(record.dropped_changes);
  const changes = proposed.map((change) => {
    const target = text(change.file) || text(change.target);
    const rejection = dropped.find((row) => { const entry = object(row.entry); return target && target === (text(entry.file) || text(entry.target)); });
    return { target, summary: text(change.summary), rationale: text(change.rationale),
      scope: texts(change.scope), before: text(change.before_summary), after: text(change.after_summary),
      advisory: change.kind === "advisory", rejected: !!rejection, rejection: text(rejection?.reason) };
  });
  const report = object(record.optimizer_report);
  const candidate = rows(report.candidates).find((row) => typeof report.selected_candidate_id === "string" && row.candidate_id === report.selected_candidate_id && row.selection_eligible !== false);
  return {
    summary: text(output.summary) || text(record.summary) || text(record.reason),
    rationale: text(output.rationale),
    scope: texts(output.scope ?? record.mutation_scope),
    changes, changesRecorded: Array.isArray(output.proposed_changes), partial: output.changes_truncated === true,
    expected: typeof output.expected_effect === "string" ? (output.expected_effect.trim() ? [["effect", output.expected_effect]] : []) : Object.entries(object(output.expected_effect)).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value) && value !== "").map(([key, value]) => [key, String(value)]),
    risks: texts(output.risk_flags ?? output.risks),
    evidence: rows(output.evidence).map((row) => ({ source: text(row.source), finding: text(row.finding) || text(row.summary) })).filter((row) => row.finding),
    validation: texts(output.validation_plan),
    validationStatus: text(record.validation_status) || text(candidate?.validation_status),
    error: text(record.error) || text(object(record.error).message),
  };
}

/** Timeline previews may be truncated; only complete recorded JSON is decoded. */
export function timelineReview(item: EvolutionTimelineItem) {
  const artifacts = [...(item.process?.artifacts || []), ...(item.process?.sections || []).flatMap((section) => section.artifacts)];
  const outputs = artifacts.filter((artifact) => artifact.kind === "output").map((artifact) => artifact.metadata?.review_explanation ? reviewOutput(artifact.metadata.review_explanation) : artifact.truncated ? {} : reviewOutput(artifact.preview));
  const raw = object(item.raw);
  const saved = reviewOutput(raw.subagent_output);
  const output = Object.keys(saved).length ? saved : outputs.find((value) => value.summary || Array.isArray(value.proposed_changes));
  return { record: { ...raw, summary: item.summary || item.title, mutation_scope: item.mutation_scope, validation_status: item.validation_status, proposal_id: item.proposal_id }, output };
}
