import type { StudyMapPayload } from '@academy/contracts/course';
import dagre from '@dagrejs/dagre';
import { type Edge, MarkerType, type Node } from '@xyflow/react';

export type TopicNode = Node<StudyMapPayload['nodes'][number], 'topic'>;
export type GroupNode = Node<{ title: string }, 'courseGroup'>;

export function layoutStudyMap(data: StudyMapPayload): {
  nodes: Array<TopicNode | GroupNode>;
  edges: Edge[];
} {
  const graph = new dagre.graphlib.Graph({ compound: true });
  graph.setGraph({ rankdir: 'LR', nodesep: 90, ranksep: 90, marginx: 24, marginy: 24 });
  graph.setDefaultEdgeLabel(() => ({}));
  const groupKey = (id: string) => `group:${id}`;
  for (const group of data.groups) graph.setNode(groupKey(group.id), {});
  for (const node of data.nodes) {
    graph.setNode(node.id, { width: 220, height: 100 });
    graph.setParent(node.id, groupKey(node.groupId));
  }
  for (const edge of data.edges) graph.setEdge(edge.from, edge.to);
  dagre.layout(graph);
  const groups: GroupNode[] = data.groups.map((group) => {
    const box = graph.node(groupKey(group.id));
    return {
      id: groupKey(group.id),
      type: 'courseGroup',
      data: { title: group.title },
      position: { x: box.x - box.width / 2, y: box.y - box.height / 2 },
      style: { width: box.width, height: box.height },
      initialWidth: box.width,
      initialHeight: box.height,
      selectable: false,
      focusable: false,
      zIndex: 0,
    };
  });
  const topics: TopicNode[] = data.nodes.map((node) => {
    const box = graph.node(node.id);
    const parent = graph.node(groupKey(node.groupId));
    return {
      id: node.id,
      type: 'topic',
      data: node,
      parentId: groupKey(node.groupId),
      position: {
        x: box.x - 110 - (parent.x - parent.width / 2),
        y: box.y - 50 - (parent.y - parent.height / 2),
      },
      style: { width: 220, height: 100 },
      initialWidth: 220,
      initialHeight: 100,
      focusable: false,
      zIndex: 2,
    };
  });
  const groupById = new Map(data.nodes.map((node) => [node.id, node.groupId]));
  const edges: Edge[] = data.edges.map((edge) => {
    const crossGroup = groupById.get(edge.from) !== groupById.get(edge.to);
    const color = crossGroup ? 'var(--primary)' : 'var(--muted-foreground)';
    return {
      id: `${edge.from}:${edge.to}`,
      source: edge.from,
      target: edge.to,
      type: 'smoothstep',
      zIndex: 1,
      style: { stroke: color, strokeWidth: crossGroup ? 2 : 1 },
      markerEnd: { type: MarkerType.ArrowClosed, color },
    };
  });
  return { nodes: [...groups, ...topics], edges };
}
