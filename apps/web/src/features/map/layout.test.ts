import type { StudyMapPayload } from '@academy/contracts/course';
import { expect, test } from 'vitest';
import {
  estimateGroupTitleWidth,
  layoutStudyMap,
  mapGroupSpacing,
  maxGroupTitleWidth,
  orderStudyMapGroups,
  reducePrerequisiteEdges,
  sharedTopicMessage,
} from './layout.js';

const topic = (id: string, groupId: string): StudyMapPayload['nodes'][number] => ({
  id,
  groupId,
  title: id,
  status: 'not_started',
  placedOut: false,
  lessonAvailable: true,
  missingPrereqTitles: [],
});

test('dependency ordering puts prerequisite groups before dependents without mutating payload order', () => {
  const data: StudyMapPayload = {
    groups: [
      { id: 'foundations', title: 'Foundations', kind: 'foundations', sharedTopicGroupIds: [] },
      { id: 'ml', title: 'ML', kind: 'course', sharedTopicGroupIds: [] },
      { id: 'llm', title: 'LLM', kind: 'course', sharedTopicGroupIds: [] },
    ],
    nodes: [topic('f', 'foundations'), topic('m', 'ml'), topic('l', 'llm')],
    edges: [
      { from: 'm', to: 'f' },
      { from: 'f', to: 'l' },
      { from: 'm', to: 'f' },
    ],
  };
  expect(orderStudyMapGroups(data).map((group) => group.id)).toEqual(['ml', 'foundations', 'llm']);
  const graph = layoutStudyMap(data);
  expect(graph.groups).toEqual(orderStudyMapGroups(data));
  expect(graph.nodes.filter((node) => node.type === 'courseGroup').map((node) => node.id)).toEqual([
    'group:ml',
    'group:foundations',
    'group:llm',
  ]);
  expect(data.groups.map((group) => group.id)).toEqual(['foundations', 'ml', 'llm']);
});

test('group ordering resolves every available tie by payload order', () => {
  const data: StudyMapPayload = {
    groups: ['dependent', 'source', 'peer'].map((id) => ({
      id,
      title: id,
      kind: 'course',
      sharedTopicGroupIds: [],
    })),
    nodes: ['dependent', 'source', 'peer'].map((id) => topic(id, id)),
    edges: [
      { from: 'source', to: 'dependent' },
      { from: 'source', to: 'source' },
    ],
  };
  expect(orderStudyMapGroups(data).map((group) => group.id)).toEqual([
    'source',
    'dependent',
    'peer',
  ]);
  expect(orderStudyMapGroups({ ...data, edges: [] })).toEqual(data.groups);
});

test('cycles fall back to the earliest remaining group deterministically', () => {
  const data: StudyMapPayload = {
    groups: ['a', 'b', 'tail', 'free'].map((id) => ({
      id,
      title: id,
      kind: 'course',
      sharedTopicGroupIds: [],
    })),
    nodes: ['a', 'b', 'tail', 'free'].map((id) => topic(id, id)),
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
      { from: 'b', to: 'tail' },
    ],
  };
  expect(orderStudyMapGroups(data).map((group) => group.id)).toEqual(['free', 'a', 'b', 'tail']);
  expect(orderStudyMapGroups({ ...data, edges: [...data.edges].reverse() })).toEqual(
    orderStudyMapGroups(data),
  );
  expect(orderStudyMapGroups({ groups: [], nodes: [], edges: [] })).toEqual([]);
  expect(orderStudyMapGroups({ ...data, edges: [{ from: 'missing', to: 'a' }] })).toEqual(
    data.groups,
  );
});

test('band layout reserves label space and positions children within their parents', () => {
  const data: StudyMapPayload = {
    groups: [
      { id: 'one', title: 'One', kind: 'course', sharedTopicGroupIds: [] },
      { id: 'two', title: 'Two', kind: 'course', sharedTopicGroupIds: [] },
    ],
    nodes: [topic('a', 'one'), topic('b', 'two')],
    edges: [{ from: 'a', to: 'b' }],
  };
  const graph = layoutStudyMap(data);
  for (const node of graph.nodes.filter((node) => node.type === 'topic')) {
    const parent = graph.nodes.find((parent) => parent.id === node.parentId);
    expect(parent).toBeDefined();
    expect(node.position.y).toBeGreaterThanOrEqual(48);
    expect(node.position.x).toBeGreaterThanOrEqual(0);
    expect(node.position.x + 220).toBeLessThanOrEqual(Number(parent?.style?.width));
    expect(node.position.y + 100).toBeLessThanOrEqual(Number(parent?.style?.height));
  }
  expect(graph.nodes.slice(0, 2).every((node) => node.type === 'courseGroup')).toBe(true);
  expect(graph.edges[0]?.style?.strokeWidth).toBe(1.5);
});

test('large groups, cross-group dependencies and a singleton keep disjoint tight bands', () => {
  const data: StudyMapPayload = {
    groups: [
      { id: 'foundations', title: 'Foundations', kind: 'foundations', sharedTopicGroupIds: [] },
      { id: 'large', title: 'Large course', kind: 'course', sharedTopicGroupIds: [] },
      { id: 'singleton', title: 'Single topic course', kind: 'course', sharedTopicGroupIds: [] },
      { id: 'last', title: 'Last course', kind: 'course', sharedTopicGroupIds: [] },
    ],
    nodes: [
      ...Array.from({ length: 4 }, (_, i) => topic(`foundation-${i}`, 'foundations')),
      ...Array.from({ length: 20 }, (_, i) => topic(`large-${i}`, 'large')),
      topic('single', 'singleton'),
      ...Array.from({ length: 6 }, (_, i) => topic(`last-${i}`, 'last')),
    ],
    edges: [
      ...Array.from({ length: 15 }, (_, i) => ({ from: `large-${i}`, to: `large-${i + 5}` })),
      { from: 'foundation-0', to: 'large-0' },
      { from: 'foundation-2', to: 'large-11' },
      { from: 'large-19', to: 'single' },
      { from: 'single', to: 'last-0' },
      { from: 'large-5', to: 'last-4' },
    ],
  };
  const { nodes, edges } = layoutStudyMap(data);
  const groups = nodes.filter((node) => node.type === 'courseGroup');
  expect(groups.map((node) => node.id)).toEqual(data.groups.map((group) => `group:${group.id}`));
  for (const [index, group] of groups.entries()) {
    expect(group.position.x).toBeGreaterThanOrEqual(24);
    const previous = groups[index - 1];
    if (previous)
      expect(group.position.y).toBe(previous.position.y + Number(previous.style?.height) + 64);
    const children = nodes.filter((node) => node.type === 'topic' && node.parentId === group.id);
    for (const child of children) {
      expect(child.position.x).toBeGreaterThanOrEqual(24);
      expect(child.position.y).toBeGreaterThanOrEqual(64);
      expect(child.position.x + 220).toBeLessThanOrEqual(Number(group.style?.width) - 24);
      expect(child.position.y + 100).toBeLessThanOrEqual(Number(group.style?.height) - 24);
    }
    expect(Math.min(...children.map((node) => node.position.x))).toBe(24);
    expect(Math.min(...children.map((node) => node.position.y))).toBe(64);
    expect(Number(group.style?.width)).toBe(
      Math.max(
        Math.max(...children.map((node) => node.position.x + 220)) + 24,
        Math.min(estimateGroupTitleWidth(group.data.title), maxGroupTitleWidth) + 48,
      ),
    );
    expect(Math.max(...children.map((node) => node.position.y + 100)) + 24).toBe(
      group.style?.height,
    );
  }
  const boxes = nodes.map((node) => {
    const parent = groups.find((group) => group.id === node.parentId);
    return {
      id: node.id,
      type: node.type,
      x: node.position.x + (parent?.position.x ?? 0),
      y: node.position.y + (parent?.position.y ?? 0),
      width: Number(node.style?.width),
      height: Number(node.style?.height),
    };
  });
  for (const [index, a] of boxes.entries())
    for (const b of boxes.slice(index + 1).filter((b) => b.type === a.type))
      expect(
        a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y,
      ).toBe(true);
  expect(edges.every((edge) => edge.type === 'default')).toBe(true);
  for (const edge of edges) {
    const source = data.nodes.find((node) => node.id === edge.source);
    const target = data.nodes.find((node) => node.id === edge.target);
    const crossGroup = source?.groupId !== target?.groupId;
    expect(edge.style).toMatchObject({
      stroke: crossGroup ? 'var(--primary)' : 'var(--muted-foreground)',
      strokeWidth: crossGroup ? 1.5 : 1,
      opacity: crossGroup ? 0.85 : 0.55,
    });
  }
  for (const title of nodes.filter((node) => node.type === 'groupTitle')) {
    const parent = groups.find((group) => group.id === title.parentId);
    expect(title.position.x).toBeGreaterThanOrEqual(0);
    expect(title.position.y).toBeGreaterThanOrEqual(0);
    expect(title.position.x + Number(title.style?.width)).toBeLessThanOrEqual(
      Number(parent?.style?.width),
    );
    expect(title.zIndex).toBeGreaterThan(2);
    expect(title.position.y + Number(title.style?.height)).toBeLessThan(64);
    expect(title.focusable).toBe(false);
  }
});

test('transitive reduction drops implied prerequisites but keeps their reachability', () => {
  const chain = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'd' },
    { from: 'other', to: 'd' },
  ];
  expect(
    reducePrerequisiteEdges([
      ...chain,
      { from: 'a', to: 'c' },
      { from: 'a', to: 'd' },
      { from: 'b', to: 'd' },
      { from: 'a', to: 'b' },
    ]),
  ).toEqual(chain);
  expect(reducePrerequisiteEdges([])).toEqual([]);
  const locked = {
    ...topic('d', 'one'),
    status: 'locked' as const,
    missingPrereqTitles: ['A', 'B', 'C'],
  };
  const graph = layoutStudyMap({
    groups: [{ id: 'one', title: 'One', kind: 'course', sharedTopicGroupIds: [] }],
    nodes: [topic('a', 'one'), topic('b', 'one'), topic('c', 'one'), locked],
    edges: [...chain.slice(0, 3), { from: 'a', to: 'd' }],
  });
  expect(graph.edges.map((edge) => edge.id)).toEqual(['a:b', 'b:c', 'c:d']);
  expect(graph.nodes.find((node) => node.id === 'd')?.data).toEqual(locked);
});

test('empty maps have no layout elements', () => {
  expect(layoutStudyMap({ groups: [], nodes: [], edges: [] })).toEqual({
    groups: [],
    nodes: [],
    edges: [],
  });
});

test('every nonempty frame has exactly the configured padding on all four sides', () => {
  const graph = layoutStudyMap({
    groups: ['wide', 'branched', 'single'].map((id) => ({
      id,
      title: id,
      kind: 'course',
      sharedTopicGroupIds: [],
    })),
    nodes: [
      topic('a', 'wide'),
      topic('b', 'wide'),
      topic('c', 'wide'),
      topic('d', 'branched'),
      topic('e', 'branched'),
      topic('f', 'branched'),
      topic('g', 'single'),
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'd', to: 'e' },
      { from: 'd', to: 'f' },
    ],
  });
  const { padding, titleStrip } = mapGroupSpacing;
  for (const frame of graph.nodes.filter((node) => node.type === 'courseGroup')) {
    const boxes = graph.nodes
      .filter((node) => node.type === 'topic' && node.parentId === frame.id)
      .map((node) => ({
        x: frame.position.x + node.position.x,
        y: frame.position.y + node.position.y,
        width: Number(node.style?.width),
        height: Number(node.style?.height),
      }));
    expect(Math.min(...boxes.map((box) => box.x)) - frame.position.x).toBe(padding);
    expect(Math.min(...boxes.map((box) => box.y)) - frame.position.y).toBe(titleStrip + padding);
    expect(
      frame.position.x +
        Number(frame.style?.width) -
        Math.max(...boxes.map((box) => box.x + box.width)),
    ).toBe(padding);
    expect(
      frame.position.y +
        Number(frame.style?.height) -
        Math.max(...boxes.map((box) => box.y + box.height)),
    ).toBe(padding);
  }
});

test('an empty group still has a contained title and reserves the fixed gap', () => {
  const { nodes } = layoutStudyMap({
    groups: [
      { id: 'empty', title: 'Empty', kind: 'course', sharedTopicGroupIds: [] },
      { id: 'next', title: 'Next', kind: 'course', sharedTopicGroupIds: [] },
    ],
    nodes: [topic('a', 'next')],
    edges: [],
  });
  const empty = nodes[0];
  const next = nodes[1];
  const title = nodes.find((node) => node.id === 'title:empty');
  expect(next?.position.y).toBe(Number(empty?.position.y) + Number(empty?.style?.height) + 64);
  expect(Number(title?.position.y) + Number(title?.style?.height)).toBeLessThan(
    Number(empty?.style?.height),
  );
  expect(Number(title?.position.x) + Number(title?.style?.width)).toBeLessThan(
    Number(empty?.style?.width),
  );
});

test('titles reserve generous width and wrap only beyond the maximum title width', () => {
  for (const title of ['Mathematics for Machine Learning', 'Long title '.repeat(40)]) {
    const graph = layoutStudyMap({
      groups: [{ id: 'one', title, kind: 'course', sharedTopicGroupIds: [] }],
      nodes: [topic('a', 'one')],
      edges: [],
    });
    const frame = graph.nodes[0];
    const label = graph.nodes.find((node) => node.type === 'groupTitle');
    const child = graph.nodes.find((node) => node.type === 'topic');
    expect(Number(frame?.style?.width)).toBeGreaterThanOrEqual(
      Math.min(estimateGroupTitleWidth(title), maxGroupTitleWidth) + mapGroupSpacing.padding * 2,
    );
    expect(Number(label?.style?.width)).toBeLessThanOrEqual(maxGroupTitleWidth);
    expect(Number(label?.position.y) + Number(label?.style?.height)).toBeLessThan(
      Number(child?.position.y),
    );
  }
});

test('shared-only groups explain where topics are shown in a compact frame', () => {
  const groups: StudyMapPayload['groups'] = ['one', 'two', 'three', 'empty'].map((id) => ({
    id,
    title: id,
    kind: 'course',
    sharedTopicGroupIds: [],
  }));
  const empty = groups[3];
  if (!empty) throw new Error('Expected empty group');
  for (const [ids, joined] of [
    [['one'], 'one'],
    [['one', 'two'], 'one and two'],
    [['one', 'two', 'three'], 'one, two and three'],
  ] as const) {
    empty.sharedTopicGroupIds = [...ids];
    expect(sharedTopicMessage(empty, groups)).toBe(`All topics are shown in ${joined}.`);
  }
  const graph = layoutStudyMap({
    groups,
    nodes: [topic('a', 'one'), topic('b', 'two'), topic('c', 'three')],
    edges: [],
  });
  const frame = graph.nodes.find((node) => node.id === 'group:empty');
  expect(frame?.data).toMatchObject({
    sharedTopicMessage: 'All topics are shown in one, two and three.',
  });
  expect(Number(frame?.style?.height)).toBeLessThan(160);
  expect(graph.nodes.some((node) => node.type === 'topic' && node.parentId === frame?.id)).toBe(
    false,
  );
});
