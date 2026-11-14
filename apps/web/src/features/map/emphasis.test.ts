import type { StudyMapPayload } from '@academy/contracts/course';
import { expect, test } from 'vitest';
import { emphasizeStudyMap } from './emphasis.js';
import { layoutStudyMap } from './layout.js';

const payload: StudyMapPayload = {
  groups: [
    { id: 'one', title: 'One', kind: 'course' },
    { id: 'two', title: 'Two', kind: 'course' },
  ],
  nodes: ['a', 'b', 'c', 'd'].map((id) => ({
    id,
    title: id,
    groupId: id < 'c' ? 'one' : 'two',
    status: 'not_started',
    placedOut: false,
    lessonAvailable: true,
    missingPrereqTitles: [],
  })),
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'd' },
  ],
};

test('hover or focus highlights incoming and outgoing edges and dims only non-neighbors', () => {
  const graph = layoutStudyMap(payload);
  const emphasized = emphasizeStudyMap(graph, 'b');
  for (const edge of emphasized.edges) {
    const touching = edge.source === 'b' || edge.target === 'b';
    expect(edge.className).toBe(touching ? 'map-edge-highlighted' : 'map-edge-dimmed');
    expect(edge.style?.opacity).toBe(touching ? 1 : 0.1);
    const original = graph.edges.find((item) => item.id === edge.id);
    expect(edge.style?.strokeWidth).toBe(
      Number(original?.style?.strokeWidth) + (touching ? 0.75 : 0),
    );
  }
  for (const node of emphasized.nodes.filter((node) => node.type === 'topic'))
    expect(node.style?.opacity).toBe(node.id === 'd' ? 0.2 : 1);
  expect(graph.edges.every((edge) => edge.className === undefined)).toBe(true);
});

test('clearing focus, unknown nodes and empty maps retain their unmodified styles', () => {
  const graph = layoutStudyMap(payload);
  expect(emphasizeStudyMap(graph, null)).toBe(graph);
  expect(emphasizeStudyMap(graph, 'missing')).toBe(graph);
  const empty = layoutStudyMap({ groups: [], nodes: [], edges: [] });
  expect(emphasizeStudyMap(empty, 'missing')).toBe(empty);
});
