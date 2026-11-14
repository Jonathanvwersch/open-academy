import type { StudyMapPayload } from '@academy/contracts/course';
import { expect, test } from 'vitest';
import { emphasizeStudyMap } from './emphasis.js';
import { layoutStudyMap } from './layout.js';
import { filterStudyMap, mapStatus, mapStatuses } from './map-status.js';

const graph = layoutStudyMap({
  groups: [{ id: 'one', title: 'One', kind: 'course', sharedTopicGroupIds: [] }],
  nodes: ['complete', 'quiz', 'not_started'].map((status, i) => ({
    id: String(i),
    title: String(i),
    groupId: 'one',
    status: status as StudyMapPayload['nodes'][number]['status'],
    placedOut: i === 0,
    lessonAvailable: true,
    missingPrereqTitles: [],
  })),
  edges: [
    { from: '0', to: '1' },
    { from: '1', to: '2' },
  ],
});

test('map has four statuses and quizzes use In progress', () => {
  expect(mapStatuses.map(mapStatus)).toEqual(mapStatuses);
  expect(mapStatus('quiz')).toBe('in_progress');
});

test('no filters returns the original graph; filters dim nodes and either-end edges without mutation', () => {
  expect(filterStudyMap(graph, new Set())).toBe(graph);
  const filtered = filterStudyMap(graph, new Set(['complete', 'in_progress']));
  expect(filtered.nodes.find((node) => node.id === '0')?.style?.opacity).toBeUndefined();
  expect(filtered.nodes.find((node) => node.id === '1')?.style?.opacity).toBeUndefined();
  expect(filtered.nodes.find((node) => node.id === '2')?.style?.opacity).toBe(0.25);
  expect(filtered.edges.map((edge) => edge.style?.opacity)).toEqual([0.55, 0.25]);
  expect(graph.nodes.every((node) => node.style?.opacity === undefined)).toBe(true);
  expect(
    filterStudyMap(graph, new Set(['locked']))
      .nodes.filter((node) => node.type === 'topic')
      .every((node) => node.style?.opacity === 0.25),
  ).toBe(true);
});

test('hover cannot undim a filtered-out node or its highlighted edges', () => {
  const result = filterStudyMap(emphasizeStudyMap(graph, '1'), new Set(['complete']));
  expect(result.nodes.find((node) => node.id === '1')?.style?.opacity).toBe(0.25);
  expect(result.edges.every((edge) => edge.style?.opacity === 0.25)).toBe(true);
});
