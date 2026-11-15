import { describe, expect, it } from 'vitest';
import { orderCoursesBySubject } from '../content/course-order.js';
import {
  courseTopicAttribution,
  type ProjectionCourse,
  projectCourseFinishes,
} from './finish-projection.js';

const today = '2026-01-01';

function topics(prefix: string, count: number): ProjectionCourse['topics'] {
  return Array.from({ length: count }, (_, index) => ({
    conceptId: `${prefix}-${index + 1}`,
    done: false,
    hardPrereqIds: [],
  }));
}

describe('projectCourseFinishes', () => {
  it('attributes a shared Mathematics topic by subject order before course order', () => {
    const orderedCourses = orderCoursesBySubject(
      [
        {
          id: 'transformers-llms',
          subjectId: 'ai',
          title: 'Transformers and LLMs',
          units: [{ title: 'Post-training', concepts: ['eigen-svd'] }],
        },
        {
          id: 'ml-foundations',
          subjectId: 'ai',
          title: 'ML Foundations',
          units: [{ title: 'Statistics', concepts: ['descriptive-statistics'] }],
        },
        {
          id: 'deep-learning',
          subjectId: 'ai',
          title: 'Deep Learning',
          units: [{ title: 'Neural networks', concepts: ['backpropagation'] }],
        },
        {
          id: 'maths-for-ml',
          subjectId: 'mathematics',
          title: 'Mathematics for ML',
          units: [{ title: 'Linear algebra', concepts: ['eigen-svd'] }],
        },
      ],
      [{ id: 'mathematics' }, { id: 'ai' }],
      ['ml-foundations', 'deep-learning', 'transformers-llms', 'maths-for-ml'],
    );
    const attribution = courseTopicAttribution('eigen-svd', orderedCourses, {
      courseId: 'transformers-llms',
      courseTitle: 'Transformers and LLMs',
      unitTitle: 'Post-training',
    });

    expect(orderedCourses.map(({ id }) => id)).toEqual([
      'maths-for-ml',
      'ml-foundations',
      'deep-learning',
      'transformers-llms',
    ]);
    expect(attribution).toEqual({
      courseId: 'maths-for-ml',
      courseTitle: 'Mathematics for ML',
      unitTitle: 'Linear algebra',
    });
    expect(
      courseTopicAttribution('tokenization', orderedCourses, {
        courseId: 'transformers-llms',
        courseTitle: 'Transformers and LLMs',
        unitTitle: 'Post-training',
      }),
    ).toEqual({
      courseId: 'transformers-llms',
      courseTitle: 'Transformers and LLMs · Foundations',
      unitTitle: 'Post-training',
    });
    expect(
      courseTopicAttribution(
        'descriptive-statistics',
        orderedCourses,
        {
          courseId: 'maths-for-ml',
          courseTitle: 'Mathematics for ML',
          unitTitle: 'Linear algebra',
        },
        'ai',
      ),
    ).toEqual({
      courseId: 'ml-foundations',
      courseTitle: 'ML Foundations',
      unitTitle: 'Statistics',
    });
  });

  it('prefers direct course ownership over a foundations fallback', () => {
    expect(
      courseTopicAttribution(
        'shared-concept',
        [
          {
            id: 'course-a',
            subjectId: 'math',
            title: 'Course A',
            units: [{ title: 'Direct unit', concepts: ['shared-concept'] }],
          },
        ],
        {
          courseId: 'course-b',
          courseTitle: 'Course B · Foundations',
          unitTitle: 'Prerequisites',
        },
      ),
    ).toEqual({
      courseId: 'course-a',
      courseTitle: 'Course A',
      unitTitle: 'Direct unit',
    });
  });

  it('balances independent 10-topic courses at 40 XP per day', () => {
    const result = projectCourseFinishes({
      courses: [
        { id: 'a', subjectId: 'math', topics: topics('a', 10) },
        { id: 'b', subjectId: 'ai', topics: topics('b', 10) },
      ],
      dailyXp: 40,
      today,
    });

    expect(result.byCourse.get('a')).toBe('2026-01-20');
    expect(result.byCourse.get('b')).toBe('2026-01-21');
    expect(result.overall).toBe('2026-01-21');
  });

  it('finishes later courses in a subject after earlier courses', () => {
    const result = projectCourseFinishes({
      courses: [
        {
          id: 'ml-foundations',
          subjectId: 'ai',
          title: 'ML Foundations',
          topics: topics('ml', 2),
        },
        {
          id: 'deep-learning',
          subjectId: 'ai',
          title: 'Deep Learning',
          topics: topics('deep', 1),
        },
      ],
      dailyXp: 1000,
      maxNewTopicsPerDay: 2,
      today,
    });

    expect(result.byCourse.get('ml-foundations')).toBe('2026-01-02');
    expect(result.byCourse.get('deep-learning')).toBe('2026-01-03');
  });

  it('uses curriculum subject order to break equal-minute ties', () => {
    const result = projectCourseFinishes({
      courses: [
        { id: 'ml', subjectId: 'ai', subjectOrder: 1, topics: topics('ml', 1) },
        { id: 'math', subjectId: 'mathematics', subjectOrder: 0, topics: topics('math', 1) },
      ],
      dailyXp: 40,
      maxNewTopicsPerDay: 1,
      today,
    });

    expect(result.upcoming[0]?.courseId).toBe('math');
  });

  it('waits for a prerequisite topic in another active course', () => {
    const alone = projectCourseFinishes({
      courses: [{ id: 'a', topics: topics('a', 2) }],
      dailyXp: 40,
      today,
    });
    const together = projectCourseFinishes({
      courses: [
        {
          id: 'a',
          topics: [
            { conceptId: 'a-1', done: false, hardPrereqIds: [] },
            { conceptId: 'a-2', done: false, hardPrereqIds: ['b-prereq'] },
          ],
        },
        {
          id: 'b',
          topics: [{ conceptId: 'b-prereq', done: false, hardPrereqIds: [] }],
        },
      ],
      dailyXp: 40,
      today,
    });

    expect(alone.byCourse.get('a')).toBe('2026-01-03');
    expect(together.byCourse.get('a')).toBe('2026-01-04');
    expect(together.byCourse.get('b')).toBe('2026-01-03');
  });

  it('learns a shared concept once for every course that includes it', () => {
    const result = projectCourseFinishes({
      courses: [
        {
          id: 'a',
          topics: [{ conceptId: 'shared', done: false, hardPrereqIds: [] }],
        },
        {
          id: 'b',
          topics: [{ conceptId: 'shared', done: false, hardPrereqIds: [] }],
        },
      ],
      dailyXp: 40,
      maxNewTopicsPerDay: 1,
      today,
    });

    expect(result.byCourse.get('a')).toBe('2026-01-02');
    expect(result.byCourse.get('b')).toBe('2026-01-02');
  });

  it('returns null for a course that was already complete', () => {
    const result = projectCourseFinishes({
      courses: [
        {
          id: 'done',
          topics: [{ conceptId: 'done-topic', done: true, hardPrereqIds: [] }],
        },
        { id: 'remaining', topics: topics('remaining', 1) },
      ],
      dailyXp: 40,
      today,
    });

    expect(result.byCourse.get('done')).toBeNull();
    expect(result.byCourse.get('remaining')).toBe('2026-01-02');
    expect(result.overall).toBe('2026-01-02');
  });

  it('omits stub topics and leaves their prerequisites unmet', () => {
    const result = projectCourseFinishes({
      courses: [
        {
          id: 'robotics',
          topics: [
            {
              conceptId: 'stub-frame',
              status: 'stub',
              done: false,
              hardPrereqIds: [],
            },
            {
              conceptId: 'dependent-topic',
              done: false,
              hardPrereqIds: ['stub-frame'],
            },
          ],
        },
      ],
      dailyXp: 40,
      today,
    });

    expect(result.byCourse.get('robotics')).toBeNull();
    expect(result.overall).toBeNull();
    expect(result.upcoming).toEqual([]);
  });

  it('uses real completion dates and lists finished topics newest first', () => {
    const result = projectCourseFinishes({
      courses: [
        {
          id: 'course',
          topics: [
            {
              conceptId: 'older',
              done: true,
              hardPrereqIds: [],
              completionDate: '2025-12-31',
            },
            {
              conceptId: 'newer',
              done: true,
              hardPrereqIds: [],
              completionDate: '2026-01-02',
            },
            { conceptId: 'undated', done: true, hardPrereqIds: [] },
          ],
        },
      ],
      dailyXp: 0,
      today,
    });

    expect(result.finished.map(({ conceptId, date }) => [conceptId, date])).toEqual([
      ['newer', '2026-01-02'],
      ['older', '2025-12-31'],
      ['undated', undefined],
    ]);
  });

  it('continues projecting after topics planned for today are assumed done', () => {
    const result = projectCourseFinishes({
      courses: [
        {
          id: 'transformers',
          topics: [
            { conceptId: 'tokenization', done: false, hardPrereqIds: [] },
            { conceptId: 'embeddings', done: false, hardPrereqIds: ['tokenization'] },
          ],
        },
      ],
      assumedDoneConceptIds: new Set(['tokenization']),
      dailyXp: 40,
      today: '2026-01-02',
    });

    expect(result.upcoming.map(({ conceptId, date }) => [conceptId, date])).toEqual([
      ['embeddings', '2026-01-02'],
    ]);
  });

  it('limits the number of topics completed each day when XP is plentiful', () => {
    const result = projectCourseFinishes({
      courses: [{ id: 'a', topics: topics('a', 5) }],
      dailyXp: 1000,
      maxNewTopicsPerDay: 2,
      today,
    });

    expect(result.byCourse.get('a')).toBe('2026-01-04');
  });

  it('carries partial topic progress into the next day before starting another topic', () => {
    const result = projectCourseFinishes({
      courses: [{ id: 'a', topics: topics('a', 2) }],
      dailyXp: 30,
      xpPerTopic: 40,
      maxNewTopicsPerDay: 2,
      today,
    });

    expect(result.byCourse.get('a')).toBe('2026-01-04');
  });

  it('continues working on a partial topic across multiple days', () => {
    const result = projectCourseFinishes({
      courses: [{ id: 'a', topics: topics('a', 1) }],
      dailyXp: 20,
      xpPerTopic: 50,
      maxNewTopicsPerDay: 2,
      today,
    });

    expect(result.byCourse.get('a')).toBe('2026-01-04');
  });

  it('returns null when a missing hard prerequisite cannot be completed', () => {
    const result = projectCourseFinishes({
      courses: [
        {
          id: 'blocked',
          topics: [{ conceptId: 'topic', done: false, hardPrereqIds: ['missing'] }],
        },
      ],
      dailyXp: 40,
      today,
    });

    expect(result.byCourse.get('blocked')).toBeNull();
    expect(result.overall).toBeNull();
  });

  it('returns no overall date when any remaining course cannot finish', () => {
    const result = projectCourseFinishes({
      courses: [
        { id: 'finishable', topics: topics('finishable', 1) },
        {
          id: 'blocked',
          topics: [{ conceptId: 'blocked-topic', done: false, hardPrereqIds: ['missing'] }],
        },
        {
          id: 'stub-only',
          topics: [
            {
              conceptId: 'stub-topic',
              status: 'stub',
              done: false,
              hardPrereqIds: [],
            },
          ],
        },
      ],
      dailyXp: 40,
      today,
    });

    expect(result.byCourse.get('finishable')).toBe('2026-01-02');
    expect(result.byCourse.get('blocked')).toBeNull();
    expect(result.byCourse.get('stub-only')).toBeNull();
    expect(result.overall).toBeNull();
  });

  it('returns null dates when daily XP is not positive', () => {
    const result = projectCourseFinishes({
      courses: [{ id: 'a', topics: topics('a', 1) }],
      dailyXp: 0,
      today,
    });

    expect(result.byCourse.get('a')).toBeNull();
    expect(result.overall).toBeNull();
  });
});
