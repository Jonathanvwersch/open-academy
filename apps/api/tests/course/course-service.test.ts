import type { CourseTopicStatus } from '@academy/contracts/course';
import { beforeAll, expect, test } from 'vitest';
import { loadContent } from '../../src/content/load.js';
import type { ContentIndex } from '../../src/content/types.js';
import {
  courseQueueStatus,
  type courseTopicState,
  suggestedNextCourses,
} from '../../src/features/course/service.js';

let content: ContentIndex;

beforeAll(async () => {
  content = await loadContent();
});

function topicStateFor(
  statuses: ReadonlyMap<string, CourseTopicStatus> = new Map(),
): ReturnType<typeof courseTopicState> {
  return (concept) => ({
    status: statuses.get(concept.id) ?? 'not_started',
    dimensionStates: concept.dimensions.map(() => 'not_assessed' as const),
    placedOut: false,
    missingPrereqs: concept.prereqs
      .filter((prerequisite) => prerequisite.strength === 'hard')
      .map((prerequisite) => ({ ...prerequisite, done: false })),
  });
}

function lessonedConceptIds(courseId: string): string[] {
  const course = content.coursesById.get(courseId);
  if (!course) throw new Error(`Missing course ${courseId}`);
  return course.units
    .flatMap((unit) => unit.concepts)
    .filter((conceptId) => {
      const concept = content.conceptsById.get(conceptId);
      return (
        concept !== undefined &&
        concept.status !== 'stub' &&
        content.lessonsByConcept.has(conceptId)
      );
    });
}

test('course queue status is null outside the study set and soon without lessons', () => {
  const course = content.courses.find((candidate) => lessonedConceptIds(candidate.id).length === 0);
  if (!course) throw new Error('Missing a course without lessoned topics');

  expect(courseQueueStatus(content, course, [], null, topicStateFor())).toBeNull();
  expect(courseQueueStatus(content, course, [course.id], null, topicStateFor())).toEqual({
    kind: 'soon',
  });
});

test('course queue status reports studying for the front course with an available topic', () => {
  const course = content.coursesById.get('maths-for-ml');
  if (!course) throw new Error('Missing Mathematics course');

  expect(courseQueueStatus(content, course, [course.id], null, topicStateFor())).toEqual({
    kind: 'studying',
  });
});

test('course queue status reports done before applying a focus pause', () => {
  const course = content.coursesById.get('maths-for-ml');
  if (!course) throw new Error('Missing Mathematics course');
  const completeTopics = new Map(
    lessonedConceptIds(course.id).map((conceptId) => [conceptId, 'complete' as const]),
  );

  expect(
    courseQueueStatus(
      content,
      course,
      [course.id, 'ml-foundations'],
      'ai',
      topicStateFor(completeTopics),
    ),
  ).toEqual({ kind: 'done' });
});

test('course queue status pauses courses outside the effective focus', () => {
  const course = content.coursesById.get('maths-for-ml');
  if (!course) throw new Error('Missing Mathematics course');

  expect(
    courseQueueStatus(content, course, [course.id, 'ml-foundations'], 'ai', topicStateFor()),
  ).toEqual({ kind: 'paused', subjectTitle: 'AI' });
});

test('course queue status waits on distinct unmet hard prerequisites outside the course', () => {
  const course = content.courses.find((candidate) => {
    const courseConceptIds = new Set(candidate.units.flatMap((unit) => unit.concepts));
    return lessonedConceptIds(candidate.id).some((conceptId) =>
      content.conceptsById
        .get(conceptId)
        ?.prereqs.some(
          (prerequisite) =>
            prerequisite.strength === 'hard' && !courseConceptIds.has(prerequisite.id),
        ),
    );
  });
  if (!course) throw new Error('Missing course with external hard prerequisites');
  const lockedTopics = new Map(
    lessonedConceptIds(course.id).map((conceptId) => [conceptId, 'locked' as const]),
  );
  const queue = courseQueueStatus(content, course, [course.id], null, topicStateFor(lockedTopics));

  if (queue?.kind !== 'waiting') throw new Error('Expected a waiting queue status');
  expect(queue.topicCount).toBeGreaterThan(0);
  expect(queue.courseTitles.length).toBeGreaterThan(0);
  expect(queue.courseTitles.length).toBeLessThanOrEqual(3);
});

test('a later course with available topics waits until the earlier course starts', () => {
  const course = content.coursesById.get('deep-learning');
  if (!course) throw new Error('Missing Deep Learning course');

  expect(
    courseQueueStatus(content, course, ['ml-foundations', course.id], null, topicStateFor()),
  ).toEqual({
    kind: 'after',
    courseId: 'ml-foundations',
    courseTitle: 'Machine Learning Foundations',
  });
});

test('after names the nearest earlier unfinished course in the subject order', () => {
  const course = content.coursesById.get('transformers-llms');
  if (!course) throw new Error('Missing Transformers and LLMs course');

  expect(
    courseQueueStatus(
      content,
      course,
      ['ml-foundations', 'deep-learning', course.id],
      null,
      topicStateFor(),
    ),
  ).toEqual({
    kind: 'after',
    courseId: 'deep-learning',
    courseTitle: 'Deep Learning',
  });
});

test('a focus on the same subject keeps its front and following courses queued normally', () => {
  const frontCourse = content.coursesById.get('ml-foundations');
  const laterCourse = content.coursesById.get('deep-learning');
  if (!frontCourse || !laterCourse) throw new Error('Missing AI courses');
  const studyCourseIds = [frontCourse.id, laterCourse.id];

  expect(courseQueueStatus(content, frontCourse, studyCourseIds, 'ai', topicStateFor())).toEqual({
    kind: 'studying',
  });
  expect(
    courseQueueStatus(content, laterCourse, studyCourseIds, 'ai', topicStateFor()),
  ).toMatchObject({
    kind: 'after',
    courseId: frontCourse.id,
  });
});

test('suggested next courses rank hard-prerequisite links to the completed course', () => {
  const statuses = new Map<string, 'not_started' | 'active' | 'paused' | 'completed'>(
    content.courses.map((course) => [course.id, 'not_started']),
  );
  statuses.set('ml-foundations', 'completed');

  const suggestions = suggestedNextCourses(content, 'ml-foundations', statuses);

  expect(suggestions[0]).toEqual({
    id: 'deep-learning',
    title: 'Deep Learning',
    reason: 'Builds on Machine Learning Foundations',
  });
  expect(suggestions.length).toBeLessThanOrEqual(2);
});
