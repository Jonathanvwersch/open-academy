import type { StudyMapPayload } from '@academy/contracts/course';
import dagre from '@dagrejs/dagre';
import { type Edge, MarkerType, type Node } from '@xyflow/react';

export type TopicNode = Node<StudyMapPayload['nodes'][number], 'topic'>;
export type GroupNode = Node<{ title: string }, 'courseGroup'>;

export function layoutStudyMap(data: StudyMapPayload): {
  nodes: Array<TopicNode | GroupNode>;
  edges: Edge[];
} {
  const groupKey = (id: string) => `group:${id}`;
  const groups: GroupNode[] = [];
  const topics: TopicNode[] = [];
  let top = 24;
  for (const group of data.groups) {
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: 'LR', nodesep: 32, ranksep: 64 });
    graph.setDefaultEdgeLabel(() => ({}));
    const children = data.nodes.filter((node) => node.groupId === group.id);
    const childIds = new Set(children.map((node) => node.id));
    for (const node of children) graph.setNode(node.id, { width: 220, height: 100 });
    for (const edge of data.edges)
      if (childIds.has(edge.from) && childIds.has(edge.to)) graph.setEdge(edge.from, edge.to);
    dagre.layout(graph);
    const boxes = children.map((node) => graph.node(node.id));
    const left = boxes.length ? Math.min(...boxes.map((box) => box.x - 110)) : 0;
    const upper = boxes.length ? Math.min(...boxes.map((box) => box.y - 50)) : 0;
    const width = boxes.length ? Math.max(...boxes.map((box) => box.x + 110)) - left + 48 : 268;
    const height = boxes.length ? Math.max(...boxes.map((box) => box.y + 50)) - upper + 88 : 88;
    groups.push({
      id: groupKey(group.id),
      type: 'courseGroup',
      data: { title: group.title },
      position: { x: 24, y: top },
      style: { width, height },
      initialWidth: width,
      initialHeight: height,
      selectable: false,
      focusable: false,
      zIndex: 0,
    });
    for (const node of children) {
      const box = graph.node(node.id);
      topics.push({
        id: node.id,
        type: 'topic',
        data: node,
        parentId: groupKey(node.groupId),
        position: {
          x: box.x - 110 - left + 24,
          y: box.y - 50 - upper + 64,
        },
        style: { width: 220, height: 100 },
        initialWidth: 220,
        initialHeight: 100,
        focusable: false,
        zIndex: 2,
      });
    }
    top += height + 64;
  }
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
