import { subjectForCourse } from '@open-academy/engine/course/index';
import type { ContentIndex } from '@open-academy/engine/course/types';
import { initialMastery } from '@open-academy/engine/memory/types';
import { buildProgress } from '@open-academy/engine/progress/progress';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '../../src/content/load.js';
import { buildProgressSubjects } from '../../src/features/progress/service.js';

let content: ContentIndex;

beforeAll(async () => {
  content = await loadContent('tests/fixtures/content');
});

function progressInput(
  overrides: Partial<Parameters<typeof buildProgress>[0]> = {},
): Parameters<typeof buildProgress>[0] {
  return {
    content,
    records: [],
    events: [],
    attempts: [],
    flags: [],
    submissions: [],
    subjects: [],
    xpEvents: [],
    now: new Date('2026-01-02T00:30:00.000Z'),
    timeZone: 'UTC',
    ...overrides,
  };
}

describe('buildProgress', () => {
  it('sums recorded XP minutes for study time and active-course topics for the summary', () => {
    const subjects = [
      {
        id: 'math',
        title: 'Mathematics',
        courses: [
          {
            id: 'math-course',
            title: 'Mathematics',
            topicsDone: 3,
            topicsTotal: 10,
            masteryCounts: {
              not_assessed: 7,
              introduced: 1,
              assisted: 1,
              independent: 1,
              retained: 0,
            },
            lessonsComingSoon: 2,
          },
        ],
      },
      {
        id: 'ai',
        title: 'AI',
        courses: [
          {
            id: 'ai-course',
            title: 'AI',
            topicsDone: 2,
            topicsTotal: 8,
            masteryCounts: {
              not_assessed: 6,
              introduced: 1,
              assisted: 0,
              independent: 1,
              retained: 0,
            },
            lessonsComingSoon: 0,
          },
        ],
      },
    ];
    const result = buildProgress(
      progressInput({
        subjects,
        xpEvents: [
          { amount: 90, localDate: '2026-01-01' },
          { amount: 30, localDate: '2026-01-02' },
        ],
      }),
    );
    expect(result).toMatchObject({
      topicsDone: 5,
      topicsTotal: 18,
      studyTimeHours: 2,
      subjects,
    });
    expect(result).not.toHaveProperty('goal');
    expect(result).not.toHaveProperty('planHours');
    expect(result).not.toHaveProperty('domains');
  });

  it('counts a streak using XP dates recorded in the learner timezone', () => {
    const result = buildProgress(
      progressInput({
        now: new Date('2026-01-02T00:30:00.000Z'),
        timeZone: 'America/Los_Angeles',
        xpEvents: [
          { amount: 10, localDate: '2026-01-01' },
          { amount: 10, localDate: '2025-12-31' },
        ],
      }),
    );
    expect(result.streakDays).toBe(2);
  });

  it('links learning debt to a course containing the topic', () => {
    const concept = content.concepts.find((item) =>
      content.courses.some((course) =>
        course.units.some((unit) => unit.concepts.includes(item.id)),
      ),
    );
    if (!concept) throw new Error('Fixture must include a course topic');
    const record = initialMastery(concept.id, concept.dimensions[0] ?? 'conceptual');
    const result = buildProgress(
      progressInput({
        records: [record],
        flags: [{ conceptId: concept.id, targetPrereqId: 'prerequisite' }],
      }),
    );
    expect(result.debt[0]?.studyUrl).toMatch(/^\/courses\/[^/]+$/);
    expect(result.debt[0]?.studyUrl).not.toContain('/map');
  });
});

describe('buildProgressSubjects', () => {
  it('orders active courses by subject and curriculum course order', () => {
    const courseIds = content.courses.map(({ id }) => id).reverse();
    const curriculumCourseIds = content.curriculum?.courses ?? content.courses.map(({ id }) => id);
    const curriculumSubjects = content.curriculum?.subjects ?? [];
    const expected = curriculumSubjects.length
      ? curriculumSubjects.flatMap((subject) =>
          curriculumCourseIds.filter(
            (courseId) =>
              courseIds.includes(courseId) && subjectForCourse(content, courseId).id === subject.id,
          ),
        )
      : curriculumCourseIds.filter((courseId) => courseIds.includes(courseId));
    const subjects = buildProgressSubjects(content, courseIds, [], []);
    expect(subjects.flatMap((subject) => subject.courses.map((course) => course.id))).toEqual(
      expected,
    );
  });

  it('groups active courses by subject and counts each topic by its best mastery state', () => {
    const stub = content.concepts.find((concept) => concept.status === 'stub');
    const course = content.courses.find(
      (candidate) =>
        candidate.units
          .flatMap((unit) => unit.concepts)
          .every((id) => {
            const concept = content.conceptsById.get(id);
            return concept?.status !== 'stub';
          }) &&
        candidate.units
          .flatMap((unit) => unit.concepts)
          .some((id) => {
            const concept = content.conceptsById.get(id);
            return concept?.status === 'authored' && concept.dimensions.length > 1;
          }),
    );
    const authored = course?.units
      .flatMap((unit) => unit.concepts)
      .map((id) => content.conceptsById.get(id))
      .find((concept) => concept?.status === 'authored' && concept.dimensions.length > 1);
    const completeConcept = course?.units
      .flatMap((unit) => unit.concepts)
      .map((id) => content.conceptsById.get(id))
      .find(
        (concept) =>
          concept?.status === 'authored' &&
          concept.id !== authored?.id &&
          concept.dimensions.length > 0,
      );
    if (!stub || !course || !authored || !completeConcept) {
      throw new Error('Fixture must include a stub and two authored course topics');
    }
    const scopedCourse = {
      ...course,
      units: [...course.units, { title: 'Coming soon', concepts: [stub.id] }],
    };
    const scopedContent: ContentIndex = {
      ...content,
      courses: content.courses.map((candidate) =>
        candidate.id === course.id ? scopedCourse : candidate,
      ),
      coursesById: new Map(content.coursesById).set(course.id, scopedCourse),
    };
    const [firstDimension, secondDimension] = authored.dimensions;
    if (!firstDimension || !secondDimension) throw new Error('Expected two mastery dimensions');
    const records = [
      { ...initialMastery(authored.id, firstDimension), state: 'introduced' as const },
      { ...initialMastery(authored.id, secondDimension), state: 'retained' as const },
      ...completeConcept.dimensions.map((dimension) => ({
        ...initialMastery(completeConcept.id, dimension),
        state: 'assisted' as const,
      })),
    ];

    const subjects = buildProgressSubjects(scopedContent, [course.id], records, []);
    const row = subjects[0]?.courses[0];
    const authoredCount = scopedCourse.units
      .flatMap((unit) => unit.concepts)
      .filter((id) => scopedContent.conceptsById.get(id)?.status === 'authored').length;
    expect(subjects.map(({ id, title }) => ({ id, title }))).toEqual([
      {
        id: subjectForCourse(content, course.id).id,
        title: subjectForCourse(content, course.id).title,
      },
    ]);
    expect(row).toMatchObject({
      id: course.id,
      topicsDone: 1,
      topicsTotal: scopedCourse.units.flatMap((unit) => unit.concepts).length,
      lessonsComingSoon: 1,
      masteryCounts: {
        retained: 1,
        introduced: 0,
        assisted: 1,
        not_assessed: authoredCount - 2,
      },
    });
  });
});
