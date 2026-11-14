import type { StudyMapPayload } from '@academy/contracts/course';
import { expect, test } from 'vitest';
import { layoutStudyMap } from './layout.js';

const topic = (id: string, groupId: string): StudyMapPayload['nodes'][number] => ({
  id,
  groupId,
  title: id,
  status: 'not_started',
  placedOut: false,
  lessonAvailable: true,
  missingPrereqTitles: [],
});

test('compound layout reserves label space and positions children within their parents', () => {
  const data: StudyMapPayload = {
    groups: [
      { id: 'one', title: 'One', kind: 'course' },
      { id: 'two', title: 'Two', kind: 'course' },
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
  expect(graph.edges[0]?.style?.strokeWidth).toBe(2);
});

test('empty maps have no layout elements', () => {
  expect(layoutStudyMap({ groups: [], nodes: [], edges: [] })).toEqual({ nodes: [], edges: [] });
});
