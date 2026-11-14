import type { StudyMapPayload } from '@academy/contracts/course';
import dagre from '@dagrejs/dagre';
import { type Edge, MarkerType, type Node } from '@xyflow/react';

export type TopicNode = Node<StudyMapPayload['nodes'][number], 'topic'>;
export type GroupNode = Node<{ title: string }, 'courseGroup'>;
export type GroupTitleNode = Node<{ title: string }, 'groupTitle'>;

export function reducePrerequisiteEdges(edges: StudyMapPayload['edges']) {
  const unique = [
    ...new Map(edges.map((edge) => [JSON.stringify([edge.from, edge.to]), edge])).values(),
  ];
  const next = new Map<string, Set<string>>();
  for (const edge of unique) {
    const targets = next.get(edge.from) ?? new Set<string>();
    targets.add(edge.to);
    next.set(edge.from, targets);
  }
  return unique.filter((edge) => {
    const pending = [...(next.get(edge.from) ?? [])].filter((id) => id !== edge.to);
    const visited = new Set([edge.from]);
    while (pending.length) {
      const id = pending.pop();
      if (!id || visited.has(id)) continue;
      if (id === edge.to) return false;
      visited.add(id);
      pending.push(...(next.get(id) ?? []));
    }
    return true;
  });
}

export function layoutStudyMap(data: StudyMapPayload): {
  nodes: Array<TopicNode | GroupNode | GroupTitleNode>;
  edges: Edge[];
} {
  const reduced = reducePrerequisiteEdges(data.edges);
  const groupKey = (id: string) => `group:${id}`;
  const groups: GroupNode[] = [];
  const titles: GroupTitleNode[] = [];
  const topics: TopicNode[] = [];
  let top = 24;
  for (const group of data.groups) {
    const children = data.nodes.filter((node) => node.groupId === group.id);
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({ rankdir: 'LR', nodesep: 32, ranksep: 64 });
    graph.setDefaultEdgeLabel(() => ({}));
    const childIds = new Set(children.map((node) => node.id));
    for (const node of children) graph.setNode(node.id, { width: 220, height: 100 });
    for (const edge of reduced)
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
    const titleWidth = width - 48;
    titles.push({
      id: `title:${group.id}`,
      type: 'groupTitle',
      data: { title: group.title },
      parentId: groupKey(group.id),
      position: { x: 24, y: 12 },
      style: { width: titleWidth, height: 36, pointerEvents: 'none' },
      initialWidth: titleWidth,
      initialHeight: 36,
      selectable: false,
      focusable: false,
      zIndex: 3,
    });
    for (const node of children) {
      const box = graph.node(node.id);
      topics.push({
        id: node.id,
        type: 'topic',
        data: node,
        parentId: groupKey(group.id),
        position: { x: box.x - 110 - left + 24, y: box.y - 50 - upper + 64 },
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
  const edges: Edge[] = reduced.map((edge) => {
    const crossGroup = groupById.get(edge.from) !== groupById.get(edge.to);
    const color = crossGroup ? 'var(--primary)' : 'var(--muted-foreground)';
    return {
      id: `${edge.from}:${edge.to}`,
      source: edge.from,
      target: edge.to,
      type: 'default',
      zIndex: 1,
      style: {
        stroke: color,
        strokeWidth: crossGroup ? 1.5 : 1,
        opacity: crossGroup ? 0.85 : 0.55,
      },
      markerEnd: { type: MarkerType.ArrowClosed, color },
    };
  });
  return { nodes: [...groups, ...titles, ...topics], edges };
}
