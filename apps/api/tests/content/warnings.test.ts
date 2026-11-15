import { describe, expect, it } from 'vitest';
import type { Concept, Course } from '../../src/content/schemas.js';
import type { ContentSourceData } from '../../src/content/types.js';
import { contentWarnings } from '../../src/content/warnings.js';

function topic(id: string, prereqs: Concept['prereqs'] = []): Concept {
  return {
    id,
    title: `Topic ${id}`,
    description: `Description of ${id}.`,
    difficulty: 1,
    est_minutes: 20,
    goal_weight: 1,
    dimensions: ['conceptual'],
    prereqs,
    related: [],
    objectives: [{ text: `Understand ${id}.`, dimension: 'conceptual' }],
    projects: [],
    sources: [],
    status: 'stub',
  };
}

function course(id: string, title: string, units: string[][], subject = 'math'): Course {
  return {
    id,
    title,
    description: `Description of ${title}.`,
    subject,
    units: units.map((concepts, index) => ({ title: `Unit ${index + 1}`, concepts })),
  };
}

function contentData(
  concepts: Concept[],
  courses: Course[],
  courseOrder = courses.map(({ id }) => id),
): ContentSourceData {
  const subjects = [...new Set(courses.map(({ subject }) => subject ?? 'default'))].map((id) => ({
    id,
    title: id === 'math' ? 'Mathematics' : id,
  }));
  return {
    curriculum: {
      file: 'curriculum.yaml',
      value: {
        schedule: { mon: 45, tue: 45, wed: 45, thu: 45, fri: 45, sat: 120, sun: 60 },
        domains: [{ id: 'main', title: 'Main', description: 'Main topics.' }],
        courses: courseOrder,
        default_course: courseOrder[0] ?? 'course',
        subjects,
        goals: [],
      },
    },
    courses: courses.map((value) => ({ value, file: `courses/${value.id}.yaml` })),
    concepts: concepts.map((value) => ({ value, domain: 'main', file: 'concepts/main.yaml' })),
    lessons: [],
    exercises: [],
    projects: [],
    papers: [],
  };
}

describe('contentWarnings', () => {
  it('warns once about topics with no prerequisites after the opening of a course', () => {
    const warnings = contentWarnings(
      contentData(
        ['one', 'two', 'three', 'shared', 'unit-two'].map((id) => topic(id)),
        [
          course('early-course', 'Early course', [['one', 'two', 'three', 'shared'], ['unit-two']]),
          course('later-course', 'Later course', [['shared']]),
        ],
      ),
    );

    expect(warnings.filter(({ message }) => message.includes('is a link missing?'))).toEqual([
      {
        file: 'concepts/main.yaml',
        id: 'shared',
        message: 'has no prerequisites but sits in unit 1 of Early course; is a link missing?',
      },
      {
        file: 'concepts/main.yaml',
        id: 'unit-two',
        message: 'has no prerequisites but sits in unit 2 of Early course; is a link missing?',
      },
    ]);
  });

  it('does not warn about an unlinked topic in the opening or one with a soft prerequisite', () => {
    const warnings = contentWarnings(
      contentData(
        [
          topic('one'),
          topic('two'),
          topic('three'),
          topic('four', [{ id: 'background', strength: 'soft' }]),
          topic('background'),
        ],
        [course('course', 'Course', [['one', 'two', 'three', 'four']])],
      ),
    );

    expect(warnings.filter(({ message }) => message.includes('is a link missing?'))).toEqual([]);
  });

  it('warns when every topic in a six-topic course opens one at a time', () => {
    const topics = Array.from({ length: 6 }, (_, index) =>
      topic(`topic-${index + 1}`, index === 0 ? [] : [{ id: `topic-${index}`, strength: 'hard' }]),
    );
    const warnings = contentWarnings(
      contentData(topics, [
        course('sequential', 'Sequential course', [topics.map(({ id }) => id)]),
      ]),
    );

    expect(warnings).toContainEqual({
      file: 'courses/sequential.yaml',
      id: 'sequential',
      message:
        'every topic waits on the one before it, so learners only ever have one topic open; check each hard prerequisite is really needed',
    });
  });

  it('does not warn about a course with a branch point', () => {
    const topics = [
      topic('topic-1'),
      topic('topic-2'),
      topic('topic-3', [{ id: 'topic-1', strength: 'hard' }]),
      topic('topic-4', [{ id: 'topic-1', strength: 'hard' }]),
      topic('topic-5', [{ id: 'topic-2', strength: 'hard' }]),
      topic('topic-6', [{ id: 'topic-3', strength: 'hard' }]),
    ];
    const warnings = contentWarnings(
      contentData(topics, [course('branching', 'Branching course', [topics.map(({ id }) => id)])]),
    );

    expect(warnings.some(({ message }) => message.includes('one topic open'))).toBe(false);
  });

  it('warns when unit 1 requires a topic taught only in a later course of the subject', () => {
    const warnings = contentWarnings(
      contentData(
        [topic('later-topic'), topic('current-topic', [{ id: 'later-topic', strength: 'hard' }])],
        [
          course('current-course', 'Current course', [['current-topic']]),
          course('later-course', 'Later course', [['later-topic']]),
        ],
        ['current-course', 'later-course'],
      ),
    );

    expect(warnings).toContainEqual({
      file: 'courses/current-course.yaml',
      id: 'current-course',
      message:
        'unit 1 needs Topic later-topic from Later course, which comes later in Mathematics; move the topic or reorder the courses',
    });
  });

  it('does not warn when a first-unit prerequisite is also in an earlier course', () => {
    const warnings = contentWarnings(
      contentData(
        [topic('shared-topic'), topic('current-topic', [{ id: 'shared-topic', strength: 'hard' }])],
        [
          course('earlier-course', 'Earlier course', [['shared-topic']]),
          course('current-course', 'Current course', [['current-topic']]),
          course('later-course', 'Later course', [['shared-topic']]),
        ],
        ['earlier-course', 'current-course', 'later-course'],
      ),
    );

    expect(warnings.filter(({ message }) => message.startsWith('unit 1 needs'))).toEqual([]);
  });
});
