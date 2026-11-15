import { expect, test } from 'vitest';
import { buildContentIndex } from '../content/index.js';
import type { IndexedConcept, IndexedCourse } from '../content/types.js';
import { lessonCourseContext } from './lesson-course-context.js';
import { courseFoundationIds } from './prerequisites.js';

const content = buildContentIndex({
  courses: [],
  concepts: [],
  lessons: [],
  exercises: [],
  projects: [],
  papers: [],
});
content.courses = [
  { id: 'large', title: 'Large', units: [{ title: 'One', concepts: ['other', 'shared'] }] },
  { id: 'small', title: 'Small', units: [{ title: 'Two', concepts: ['shared'] }] },
  { id: 'unrelated', title: 'Unrelated', units: [{ title: 'Three', concepts: ['other'] }] },
] as IndexedCourse[];
content.coursesById = new Map(content.courses.map((course) => [course.id, course]));
content.subjectsByCourseId = new Map(
  content.courses.map((course) => [course.id, { id: 'default', title: 'Courses' }]),
);
content.conceptsById = new Map([
  [
    'other',
    {
      id: 'other',
      status: 'authored',
      prereqs: [{ id: 'shared', strength: 'hard' }],
    } as IndexedConcept,
  ],
  ['shared', { id: 'shared', status: 'authored', prereqs: [] } as unknown as IndexedConcept],
]);

test('preferred course wins and uses course outline numbering', () => {
  expect(
    lessonCourseContext(content, {
      conceptId: 'shared',
      studyCourseIds: ['small'],
      preferredCourseId: 'large',
    }),
  ).toEqual({
    courseId: 'large',
    courseTitle: 'Large',
    unitNumber: 1,
    unitTitle: 'One',
    position: '1.2',
  });
});
test('preferred course not containing the concept falls through', () => {
  expect(
    lessonCourseContext(content, {
      conceptId: 'shared',
      studyCourseIds: ['large'],
      preferredCourseId: 'unrelated',
    })?.courseId,
  ).toBe('large');
});
test('smallest active course wins shared topics', () => {
  expect(
    lessonCourseContext(content, { conceptId: 'shared', studyCourseIds: ['large', 'small'] })
      ?.courseId,
  ).toBe('small');
});
test('catalogue fallback chooses smallest', () => {
  expect(lessonCourseContext(content, { conceptId: 'shared', studyCourseIds: [] })?.courseId).toBe(
    'small',
  );
});
test('Foundations-only membership is ignored', () => {
  expect(courseFoundationIds(content, 'unrelated').has('shared')).toBe(true);
  expect(
    lessonCourseContext(content, { conceptId: 'shared', studyCourseIds: ['unrelated'] })?.courseId,
  ).toBe('small');
});
test('unknown concept returns null', () => {
  expect(
    lessonCourseContext(content, { conceptId: 'missing', studyCourseIds: ['large'] }),
  ).toBeNull();
});
