import type { WorkflowGraph, WorkflowMetadata, WorkflowNode } from "./workflowTypes";
import type { WorkflowText } from "./workflowPresentation";
export type ResourceGroup = { id: string; title: string; members: WorkflowNode[] };
export type WorkflowProjection = { graph: WorkflowGraph; groups: ResourceGroup[]; supporting: ResourceGroup[]; aliases: Map<string, string> };

/** Keep triggers and executable steps together; supporting configuration stays below the canvas. */
export function compactWorkflow(graph: WorkflowGraph, t: WorkflowText, _metadata?: WorkflowMetadata): WorkflowProjection {
  const aliases = new Map<string, string>();
  if (graph.id.endsWith(":evolution") || graph.id === "evolution") return { graph, groups: [], supporting: [], aliases };
  const nodes = graph.nodes.filter((node) => node.kind === "scheduler" || node.kind === "script" || node.kind === "agent");
  const ids = new Set(nodes.map((node) => node.id));
  const supporting: ResourceGroup[] = [];
  for (const [kind, title] of [["strategy", t("copy.lib_workflowProjection.001")], ["risk", t("copy.lib_workflowProjection.003")], ["account", t("copy.lib_workflowProjection.004")], ["source", t("copy.lib_workflowProjection.005")]]) {
    const members = graph.nodes.filter((node) => node.kind === kind);
    if (kind === "strategy") members.push(...graph.nodes.filter((node) => node.kind === "source" && node.binding.path?.[0] !== "data_sources"));
    const visible = kind === "source" ? members.filter((node) => node.binding.path?.[0] === "data_sources") : members;
    if (visible.length) supporting.push({ id: visible[0].id, title, members: visible });
  }
  return { graph: { ...graph, nodes, edges: graph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)) }, groups: [], supporting, aliases };
}
