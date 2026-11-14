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

test('band layout reserves label space and positions children within their parents', () => {
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

test('large groups, cross-group dependencies and a singleton keep disjoint tight bands', () => {
  const data: StudyMapPayload = {
    groups: [
      { id: 'foundations', title: 'Foundations', kind: 'foundations' },
      { id: 'large', title: 'Large course', kind: 'course' },
      { id: 'singleton', title: 'Single topic course', kind: 'course' },
      { id: 'last', title: 'Last course', kind: 'course' },
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
  const { nodes } = layoutStudyMap(data);
  const groups = nodes.filter((node) => node.type === 'courseGroup');
  expect(groups.map((node) => node.id)).toEqual(data.groups.map((group) => `group:${group.id}`));
  for (const [index, group] of groups.entries()) {
    expect(group.position.x).toBe(24);
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
    expect(Math.max(...children.map((node) => node.position.x + 220)) + 24).toBe(
      group.style?.width,
    );
    expect(Math.max(...children.map((node) => node.position.y + 100)) + 24).toBe(
      group.style?.height,
    );
  }
  const boxes = nodes.map((node) => {
    const parent = groups.find((group) => group.id === node.parentId);
    return {
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
});

test('empty maps have no layout elements', () => {
  expect(layoutStudyMap({ groups: [], nodes: [], edges: [] })).toEqual({ nodes: [], edges: [] });
});
