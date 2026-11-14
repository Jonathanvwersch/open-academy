import type { CourseDetailPayload, StudyMapPayload } from '@academy/contracts/course';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config.js';
import { loadContent } from '../../src/content/load.js';
import type { ContentIndex } from '../../src/content/types.js';
import { createDb } from '../../src/db/client.js';
import {
  courseEnrollments,
  diagnosticRuns,
  lessonRuns,
  mastery,
  users,
} from '../../src/db/schema.js';

const db = createDb(env.TEST_DATABASE_URL);
const userId = '00000000-0000-4000-8000-000000000097';
let app: ReturnType<typeof createApp>;
let content: ContentIndex;

beforeAll(async () => {
  const loaded = await loadContent();
  const template = loaded.concepts[0];
  const course = loaded.courses[0];
  if (!template || !course) throw new Error('Expected curriculum fixtures');
  const concepts = ['foundation', 'shared', 'first', 'second', 'untouched'].map((id) => ({
    ...template,
    id,
    title: id,
    status: 'authored' as const,
    prereqs: (id === 'first' ? ['foundation'] : id === 'second' ? ['first'] : []).map((id) => ({
      id,
      strength: 'hard' as const,
    })),
  }));
  const courses = [
    {
      ...course,
      id: 'one',
      title: 'One',
      units: [{ title: 'One', concepts: ['shared', 'first'] }],
    },
    {
      ...course,
      id: 'two',
      title: 'Two',
      units: [{ title: 'Two', concepts: ['shared', 'second', 'untouched'] }],
    },
  ];
  content = {
    ...loaded,
    concepts,
    conceptsById: new Map(concepts.map((entry) => [entry.id, entry])),
    courses,
    coursesById: new Map(courses.map((entry) => [entry.id, entry])),
    curriculum: loaded.curriculum
      ? { ...loaded.curriculum, courses: ['one', 'two'], default_course: 'one' }
      : undefined,
  };
  app = createApp({ db, content, tutorProvider: null });
});
beforeEach(async () => {
  await db.delete(users);
  await db.insert(users).values({
    id: userId,
    displayName: 'Map learner',
    timezone: 'UTC',
    studySetInitializedAt: new Date(),
  });
});
afterAll(async () => {
  await db.delete(users);
  await db.$client.end();
});

test('deduplicates study topics, connects groups and shares course progress inputs', async () => {
  await db
    .insert(courseEnrollments)
    .values(
      ['two', 'one'].map((courseId) => ({ userId, courseId, startMethod: 'beginning' as const })),
    );
  await db.insert(lessonRuns).values([
    { userId, conceptId: 'first', status: 'quiz' },
    { userId, conceptId: 'shared', status: 'needs_retry' },
  ]);
  await db.insert(mastery).values(
    ['foundation', 'shared'].flatMap((conceptId) =>
      (content.conceptsById.get(conceptId)?.dimensions ?? []).map((dimension) => ({
        userId,
        conceptId,
        dimension,
        state: 'retained' as const,
        evidence: {},
      })),
    ),
  );
  await db.insert(diagnosticRuns).values({
    userId,
    kind: 'placement',
    status: 'completed',
    state: { known: ['foundation', 'shared'] },
  });
  const response = await app.request('/api/study-map');
  expect(response.status).toBe(200);
  const payload: StudyMapPayload = await response.json();
  expect(payload.groups.map((group) => group.id)).toEqual(['foundations', 'one', 'two']);
  expect(payload.nodes.filter((node) => node.id === 'shared')).toHaveLength(1);
  expect(payload.nodes.find((node) => node.id === 'shared')).toMatchObject({
    groupId: 'one',
    status: 'in_progress',
    placedOut: false,
  });
  expect(payload.nodes.find((node) => node.id === 'foundation')).toMatchObject({
    groupId: 'foundations',
    status: 'complete',
    placedOut: true,
  });
  expect(payload.nodes.find((node) => node.id === 'second')).toMatchObject({
    status: 'locked',
    missingPrereqTitles: ['first'],
  });
  expect(payload.edges).toEqual(
    expect.arrayContaining([
      { from: 'first', to: 'second' },
      { from: 'foundation', to: 'first' },
    ]),
  );
  for (const courseId of ['one', 'two']) {
    const courseResponse = await app.request(`/api/courses/${courseId}`);
    expect(courseResponse.status).toBe(200);
    const course: CourseDetailPayload = await courseResponse.json();
    for (const topic of course.units.flatMap((unit) => unit.topics)) {
      expect(payload.nodes.find((node) => node.id === topic.conceptId)).toMatchObject({
        status: topic.status,
        placedOut: topic.placedOut,
        lessonAvailable: topic.hasLesson,
      });
    }
  }
  expect(new Set(payload.nodes.map((node) => node.status)).size).toBeGreaterThan(2);
});

test('empty, paused and completed study sets have no map nodes', async () => {
  expect(await (await app.request('/api/study-map')).json()).toEqual({
    groups: [],
    nodes: [],
    edges: [],
  });
  await db.insert(courseEnrollments).values([
    { userId, courseId: 'one', startMethod: 'beginning', status: 'paused' },
    { userId, courseId: 'two', startMethod: 'beginning', status: 'completed' },
  ]);
  expect(await (await app.request('/api/study-map')).json()).toEqual({
    groups: [],
    nodes: [],
    edges: [],
  });
});
