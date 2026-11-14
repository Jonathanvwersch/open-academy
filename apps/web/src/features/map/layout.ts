import type { StudyMapPayload } from '@academy/contracts/course';
import dagre from '@dagrejs/dagre';
import { type Edge, MarkerType, type Node } from '@xyflow/react';

export type TopicNode = Node<StudyMapPayload['nodes'][number], 'topic'>;
export type GroupNode = Node<{ title: string }, 'courseGroup'>;
export type GroupTitleNode = Node<{ title: string }, 'groupTitle'>;
export type ColumnEdge = Edge<
  {
    centerX: number;
    corridorY?: number;
    targetCenterX?: number;
  },
  'column'
>;

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
  edges: ColumnEdge[];
} {
  const reduced = reducePrerequisiteEdges(data.edges);
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: 'LR', nodesep: 32, ranksep: 96 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of data.nodes) graph.setNode(node.id, { width: 220, height: 100 });
  for (const edge of reduced) graph.setEdge(edge.from, edge.to);
  dagre.layout(graph);
  const groupKey = (id: string) => `group:${id}`;
  const groups: GroupNode[] = [];
  const titles: GroupTitleNode[] = [];
  const topics: TopicNode[] = [];
  const absoluteTopics = new Map<string, { x: number; y: number; bandTop: number }>();
  let top = 24;
  for (const group of data.groups) {
    const children = data.nodes.filter((node) => node.groupId === group.id);
    const columns = new Map<number, typeof children>();
    for (const node of children) {
      const x = graph.node(node.id).x - 110 + 48;
      const column = columns.get(x) ?? [];
      column.push(node);
      columns.set(x, column);
    }
    const left = columns.size ? Math.min(...columns.keys()) - 24 : 24;
    const width = columns.size ? Math.max(...columns.keys()) - left + 244 : 268;
    const rows = Math.max(0, ...[...columns.values()].map((column) => column.length));
    const height = 88 + rows * 100 + Math.max(0, rows - 1) * 32;
    groups.push({
      id: groupKey(group.id),
      type: 'courseGroup',
      data: { title: group.title },
      position: { x: left, y: top },
      style: { width, height },
      initialWidth: width,
      initialHeight: height,
      selectable: false,
      focusable: false,
      zIndex: 0,
    });
    const titleWidth = Math.min(width - 32, 360);
    titles.push({
      id: `title:${group.id}`,
      type: 'groupTitle',
      data: { title: group.title },
      parentId: groupKey(group.id),
      position: { x: 16, y: 10 },
      style: { width: titleWidth, height: 36, pointerEvents: 'none' },
      initialWidth: titleWidth,
      initialHeight: 36,
      selectable: false,
      focusable: false,
      zIndex: 3,
    });
    for (const [x, column] of columns) {
      column.sort((a, b) => graph.node(a.id).y - graph.node(b.id).y);
      for (const [row, node] of column.entries()) {
        absoluteTopics.set(node.id, { x, y: top + 64 + row * 132, bandTop: top });
        topics.push({
          id: node.id,
          type: 'topic',
          data: node,
          parentId: groupKey(group.id),
          position: { x: x - left, y: 64 + row * 132 },
          style: { width: 220, height: 100 },
          initialWidth: 220,
          initialHeight: 100,
          focusable: false,
          zIndex: 2,
        });
      }
    }
    top += height + 64;
  }
  const groupById = new Map(data.nodes.map((node) => [node.id, node.groupId]));
  const edges = reduced.flatMap<ColumnEdge>((edge) => {
    const crossGroup = groupById.get(edge.from) !== groupById.get(edge.to);
    const color = crossGroup ? 'var(--primary)' : 'var(--muted-foreground)';
    const source = absoluteTopics.get(edge.from);
    const target = absoluteTopics.get(edge.to);
    if (!source || !target) return [];
    const centerX = source.x + 220 + 48;
    const blocked = [...absoluteTopics.values()].some(
      (node) =>
        node.x > source.x &&
        node.x < target.x &&
        node.y < target.y + 50 &&
        node.y + 100 > target.y + 50,
    );
    return [
      {
        id: `${edge.from}:${edge.to}`,
        source: edge.from,
        target: edge.to,
        type: 'column',
        data: blocked
          ? { centerX, targetCenterX: target.x - 48, corridorY: target.bandTop + 52 }
          : { centerX },
        zIndex: 1,
        style: { stroke: color, strokeWidth: crossGroup ? 2 : 1 },
        markerEnd: { type: MarkerType.ArrowClosed, color },
      },
    ];
  });
  return { nodes: [...groups, ...titles, ...topics], edges };
}
