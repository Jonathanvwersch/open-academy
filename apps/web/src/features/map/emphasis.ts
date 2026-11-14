import type { layoutStudyMap } from './layout.js';

export function emphasizeStudyMap(
  graph: ReturnType<typeof layoutStudyMap>,
  activeId: string | null,
) {
  if (!activeId || !graph.nodes.some((node) => node.id === activeId && node.type === 'topic'))
    return graph;
  const adjacent = new Set([activeId]);
  for (const edge of graph.edges)
    if (edge.source === activeId || edge.target === activeId) {
      adjacent.add(edge.source);
      adjacent.add(edge.target);
    }
  return {
    nodes: graph.nodes.map((node) =>
      node.type === 'topic'
        ? { ...node, style: { ...node.style, opacity: adjacent.has(node.id) ? 1 : 0.2 } }
        : node,
    ),
    edges: graph.edges.map((edge) => {
      const highlighted = edge.source === activeId || edge.target === activeId;
      return {
        ...edge,
        className: highlighted ? 'map-edge-highlighted' : 'map-edge-dimmed',
        style: {
          ...edge.style,
          opacity: highlighted ? 1 : 0.1,
          strokeWidth: Number(edge.style?.strokeWidth ?? 1) + (highlighted ? 0.75 : 0),
        },
      };
    }),
  };
}
