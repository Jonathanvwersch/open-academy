import { expect, test } from 'vitest';
import { courseHasEvidence, courseStartStatus, needsCourseChoice } from './course-start.js';

test('a learner without a course or evidence needs to choose a course', () => {
  expect(needsCourseChoice({ activeCourseId: null, mastery: [], lessonRuns: [] })).toBe(true);
  expect(
    needsCourseChoice({
      activeCourseId: 'ml-foundations',
      mastery: [],
      lessonRuns: [],
    }),
  ).toBe(false);
});

test('course evidence is limited to unit concepts and includes lesson runs or assessed mastery', () => {
  expect(courseHasEvidence(['a'], [{ conceptId: 'other', state: 'independent' }], [])).toBe(false);
  expect(courseHasEvidence(['a'], [], [{ conceptId: 'a' }])).toBe(true);
  expect(courseHasEvidence(['a'], [{ conceptId: 'a', state: 'introduced' }], [])).toBe(true);
});

test('an active placement needs continuation until an enrollment exists', () => {
  const input = {
    courseConceptIds: ['a'],
    mastery: [],
    lessonRuns: [],
    activePlacementRunId: 'run-1',
  };
  expect(courseStartStatus({ ...input, enrolled: false })).toEqual({
    needed: true,
    placementRunId: 'run-1',
  });
  expect(courseStartStatus({ ...input, enrolled: true })).toEqual({
    needed: false,
    placementRunId: 'run-1',
  });
});
