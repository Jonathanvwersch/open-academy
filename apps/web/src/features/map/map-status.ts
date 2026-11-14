import type { CourseTopicStatus } from '@academy/contracts/course';
import type { layoutStudyMap } from './layout.js';

export const mapStatuses = ['complete', 'in_progress', 'not_started', 'locked'] as const;
export type MapStatus = (typeof mapStatuses)[number];
export const mapStatus = (status: CourseTopicStatus): MapStatus =>
  status === 'quiz' ? 'in_progress' : status;

export function filterStudyMap(
  graph: Pick<ReturnType<typeof layoutStudyMap>, 'nodes' | 'edges'>,
  selected: ReadonlySet<MapStatus>,
) {
  if (!selected.size) return graph;
  const dimmed = new Set(
    graph.nodes
      .filter((node) => node.type === 'topic' && !selected.has(mapStatus(node.data.status)))
      .map((node) => node.id),
  );
  const dim = (opacity: unknown) => Math.min(Number(opacity ?? 1), 0.25);
  return {
    nodes: graph.nodes.map((node) =>
      dimmed.has(node.id)
        ? { ...node, style: { ...node.style, opacity: dim(node.style?.opacity) } }
        : node,
    ),
    edges: graph.edges.map((edge) =>
      dimmed.has(edge.source) || dimmed.has(edge.target)
        ? { ...edge, style: { ...edge.style, opacity: dim(edge.style?.opacity) } }
        : edge,
    ),
  };
}
