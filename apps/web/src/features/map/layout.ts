import type { StudyMapPayload } from '@academy/contracts/course';
import dagre from '@dagrejs/dagre';
import { type Edge, MarkerType, type Node } from '@xyflow/react';

export type TopicNode = Node<StudyMapPayload['nodes'][number], 'topic'>;
export type GroupNode = Node<
  { title: string; titleStrip?: number; sharedTopicMessage?: string },
  'courseGroup'
>;
export type GroupTitleNode = Node<{ title: string }, 'groupTitle'>;

export const mapGroupSpacing = { padding: 24, titleStrip: 40, gap: 64 };
export const maxGroupTitleWidth = 1152;
export const estimateGroupTitleWidth = (title: string) => title.length * 18;

export function sharedTopicMessage(
  group: StudyMapPayload['groups'][number],
  groups: StudyMapPayload['groups'],
) {
  const titles = group.sharedTopicGroupIds
    .map((id) => groups.find((other) => other.id === id)?.title)
    .filter((title): title is string => !!title);
  const joined =
    titles.length < 2 ? titles.join('') : `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}`;
  return joined ? `All topics are shown in ${joined}.` : 'No topics in this group.';
}

export function orderStudyMapGroups(data: StudyMapPayload) {
  const remaining = new Set(data.groups.map((group) => group.id));
  const nodeGroups = new Map(data.nodes.map((node) => [node.id, node.groupId]));
  const outgoing = new Map(data.groups.map((group) => [group.id, new Set<string>()]));
  const indegree = new Map(data.groups.map((group) => [group.id, 0]));
  for (const edge of data.edges) {
    const from = nodeGroups.get(edge.from);
    const to = nodeGroups.get(edge.to);
    if (!from || !to || from === to || !remaining.has(from) || !remaining.has(to)) continue;
    const targets = outgoing.get(from);
    if (!targets || targets.has(to)) continue;
    targets.add(to);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }
  const ordered: StudyMapPayload['groups'] = [];
  while (remaining.size) {
    const next =
      data.groups.find((group) => remaining.has(group.id) && indegree.get(group.id) === 0) ??
      data.groups.find((group) => remaining.has(group.id));
    if (!next) break;
    ordered.push(next);
    remaining.delete(next.id);
    for (const target of outgoing.get(next.id) ?? [])
      indegree.set(target, (indegree.get(target) ?? 0) - 1);
  }
  return ordered;
}

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
  groups: StudyMapPayload['groups'];
  nodes: Array<TopicNode | GroupNode | GroupTitleNode>;
  edges: Edge[];
} {
  const reduced = reducePrerequisiteEdges(data.edges);
  const groupKey = (id: string) => `group:${id}`;
  const groups: GroupNode[] = [];
  const titles: GroupTitleNode[] = [];
  const topics: TopicNode[] = [];
  const orderedGroups = orderStudyMapGroups(data);
  const { padding, gap } = mapGroupSpacing;
  let top = padding;
  for (const group of orderedGroups) {
    const children = data.nodes.filter((node) => node.groupId === group.id);
    const graph = new dagre.graphlib.Graph();
    graph.setGraph({
      rankdir: 'LR',
      nodesep: 16,
      ranksep: 64,
      ranker: 'longest-path',
      align: 'DL',
    });
    graph.setDefaultEdgeLabel(() => ({}));
    const childIds = new Set(children.map((node) => node.id));
    for (const node of children) graph.setNode(node.id, { width: 220, height: 100 });
    for (const edge of reduced)
      if (childIds.has(edge.from) && childIds.has(edge.to)) graph.setEdge(edge.from, edge.to);
    dagre.layout(graph);
    const boxes = children.map((node) => graph.node(node.id));
    const left = boxes.length ? Math.min(...boxes.map((box) => box.x - 110)) : 0;
    const upper = boxes.length ? Math.min(...boxes.map((box) => box.y - 50)) : 0;
    const width = Math.max(
      (boxes.length ? Math.max(...boxes.map((box) => box.x + 110)) - left : 220) + padding * 2,
      Math.min(estimateGroupTitleWidth(group.title), maxGroupTitleWidth) + padding * 2,
    );
    const titleWidth = Math.min(width - padding * 2, maxGroupTitleWidth);
    const titleStrip = Math.max(
      mapGroupSpacing.titleStrip,
      Math.ceil(estimateGroupTitleWidth(group.title) / titleWidth) * 24 + 12,
    );
    const message = boxes.length ? undefined : sharedTopicMessage(group, orderedGroups);
    const emptyHeight = message ? Math.ceil((message.length * 8) / (width - padding * 2)) * 20 : 0;
    const height =
      (boxes.length ? Math.max(...boxes.map((box) => box.y + 50)) - upper : emptyHeight) +
      titleStrip +
      padding * 2;
    groups.push({
      id: groupKey(group.id),
      type: 'courseGroup',
      data: { title: group.title, titleStrip, sharedTopicMessage: message },
      position: { x: padding, y: top },
      style: { width, height },
      initialWidth: width,
      initialHeight: height,
      selectable: false,
      focusable: false,
      zIndex: 0,
    });
    titles.push({
      id: `title:${group.id}`,
      type: 'groupTitle',
      data: { title: group.title },
      parentId: groupKey(group.id),
      position: { x: padding, y: padding / 2 },
      style: { width: titleWidth, height: titleStrip - 4, pointerEvents: 'none' },
      initialWidth: titleWidth,
      initialHeight: titleStrip - 4,
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
        position: { x: box.x - 110 - left + padding, y: box.y - 50 - upper + titleStrip + padding },
        style: { width: 220, height: 100 },
        initialWidth: 220,
        initialHeight: 100,
        focusable: false,
        zIndex: 2,
      });
    }
    top += height + gap;
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
  return { groups: orderedGroups, nodes: [...groups, ...titles, ...topics], edges };
}
