import type { WorkflowNode, WorkflowView } from "./workflowTypes";

/** A new conversation is bound to this strategy on the server when created. */
export function strategyChatUrl(strategyId: string, proposalId?: string | null, draftId?: string) {
  const params = new URLSearchParams({ strategy: strategyId });
  if (proposalId) params.set("proposal", proposalId);
  if (draftId) params.set("draft", draftId);
  return "/chat?" + params.toString();
}

/** Reference saved resources, not an unbounded dump of source, prompts or credentials.
 * The URL binds the session; this context also makes the exact edit target explicit
 * in the actual user message, including when it is copied or read in a transcript.
 */
export function strategyEditPrompt(workflow: WorkflowView, request: string, guidance: string, node?: WorkflowNode): string {
  const graph = node && workflow.evolution.nodes.some((item) => item.id === node.id) ? workflow.evolution : workflow.strategy;
  const related = node ? graph.nodes.filter((item) => graph.edges.some((edge) =>
    (edge.source === node.id && edge.target === item.id) || (edge.target === node.id && edge.source === item.id))) : [];
  const resource = (item: WorkflowNode) => ({ node_id: item.id, kind: item.kind, resource: item.resource, binding: item.binding });
  const context = {
    strategy_id: workflow.strategy_id,
    strategy_title: String(workflow.manifest.title || workflow.strategy_id),
    proposal_id: workflow.source.proposal_id,
    base_revision: workflow.revision,
    source_state: workflow.source.state,
    mode: workflow.manifest.mode,
    workflow: graph.id,
    target: node ? resource(node) : { strategy_id: workflow.strategy_id },
    related_resources: related.slice(0, 24).map(resource),
    related_resources_total: related.length,
  };
  return `${guidance}\n\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\`\n\n${request}`;
}
