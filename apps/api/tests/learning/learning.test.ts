import { fsrs, generatorParameters, Rating, State } from 'ts-fsrs';
import { beforeAll, expect, test } from 'vitest';
import { loadContent } from '../../src/content/load.js';
import { isTemplate } from '../../src/content/templates.js';
import type { ContentIndex } from '../../src/content/types.js';
import { deriveLearningDebt } from '../../src/learning/debt.js';
import {
  mapReviewRating,
  newReviewCard,
  scheduleInitialReview,
  scheduleReview,
} from '../../src/learning/fsrs.js';
import { countHintsSincePreviousAttempt } from '../../src/learning/hints.js';
import {
  calculateCredit,
  DefaultMasteryModel,
  recordLessonViewed,
} from '../../src/learning/mastery.js';
import {
  compareOutlinePosition,
  courseFoundationIds,
  masteryKey,
  outlinePosition,
  prerequisiteMet,
} from '../../src/learning/prerequisites.js';
import { reviewTopicsForActivity } from '../../src/learning/review-topics.js';
import type { Candidate, PlannedActivity, SchedulerState } from '../../src/learning/scheduler.js';
import {
  currentLearnerUnit,
  interleaveReviewExercises,
  mixReviewActivities,
  planSession,
  replan,
  SCHEDULER_CONFIG,
} from '../../src/learning/scheduler.js';
import { initialMastery } from '../../src/learning/types.js';

const now = new Date('2026-01-14T12:00:00.000Z');
let content: ContentIndex;
let courseContent: ContentIndex;

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Missing fixture ${label}`);
  }
  return value;
}

function reviewCandidate(
  conceptId: string,
  courseId: string,
  score: number,
  exerciseIds = [`${conceptId}-1`, `${conceptId}-2`, `${conceptId}-3`],
): Candidate {
  return {
    activity: {
      kind: 'review',
      conceptId,
      exerciseIds,
      plannedMinutes: exerciseIds.length * 2,
      reason: {
        courseId,
        terms: {
          goal: 0,
          week_fit: 0,
          project: 0,
          unlock: 0,
          gap: 0,
          review: score,
          cost: 0,
        },
        summary: `Review ${conceptId}.`,
      },
    },
    score,
    adjustedMinutes: exerciseIds.length * 2,
    newConcept: false,
    courseId,
  };
}

beforeAll(async () => {
  content = await loadContent('tests/fixtures/content');
  courseContent = await loadContent('content');
});

test('in-progress review topics omit topics whose exercises have attempts', () => {
  const vectorsExercise = required(
    content.exercisesByConcept.get('vectors')?.[0],
    'vectors exercise',
  );
  const derivativesExercise = required(
    content.exercisesByConcept.get('derivatives')?.[0],
    'derivatives exercise',
  );
  const activity = {
    kind: 'review',
    status: 'in_progress',
    exerciseIds: [vectorsExercise.id, derivativesExercise.id],
  };

  expect(
    reviewTopicsForActivity(activity, content, new Set([vectorsExercise.id])).map(
      (topic) => topic.conceptId,
    ),
  ).toEqual(['derivatives']);
  expect(
    reviewTopicsForActivity(
      { ...activity, status: 'planned' },
      content,
      new Set(activity.exerciseIds),
    ).map((topic) => topic.conceptId),
  ).toEqual(['vectors', 'derivatives']);
});

function emptyState(): SchedulerState {
  return {
    activeCourseId: null,
    studyCourseIds: ['fixture-course'],
    recentLearnMinutesByConcept: {},
    mastery: [],
    cards: [],
    reviewedTodayConceptIds: [],
    recentAttempts: [],
    remediationFlags: [],
    projectProgress: [],
    completedPaperIds: [],
    startDate: '2026-01-05T00:00:00.000Z',
  };
}

function studyState(courseIds: string[], index: ContentIndex = courseContent): SchedulerState {
  const courseConceptIds = new Set(
    courseIds.flatMap(
      (courseId) => index.coursesById.get(courseId)?.units.flatMap((unit) => unit.concepts) ?? [],
    ),
  );
  const hardPrerequisiteIds = new Set(
    courseIds.flatMap(
      (courseId) =>
        index.coursesById
          .get(courseId)
          ?.units.flatMap((unit) => unit.concepts)
          .flatMap(
            (conceptId) =>
              index.conceptsById
                .get(conceptId)
                ?.prereqs.filter((prerequisite) => prerequisite.strength === 'hard')
                .map((prerequisite) => prerequisite.id) ?? [],
          ) ?? [],
    ),
  );
  const mastery = [...hardPrerequisiteIds].flatMap((conceptId) => {
    const concept = index.conceptsById.get(conceptId);
    return (concept?.dimensions ?? []).map((dimension) => ({
      ...initialMastery(conceptId, dimension),
      state: 'independent' as const,
    }));
  });
  return {
    ...emptyState(),
    activeCourseId: courseIds[0] ?? null,
    studyCourseIds: courseIds,
    mastery: mastery.filter((record) => !courseConceptIds.has(record.conceptId)),
  };
}

function studyCourseOwner(
  conceptId: string,
  courseIds: string[],
  index: ContentIndex = courseContent,
): string | undefined {
  return courseIds.find((courseId) => {
    const course = index.coursesById.get(courseId);
    return (
      course?.units.some((unit) => unit.concepts.includes(conceptId)) ||
      courseFoundationIds(index, courseId).has(conceptId)
    );
  });
}

function schedulerContentWithTopics(
  topicsByCourse: Record<string, string[]>,
  index: ContentIndex = content,
): ContentIndex {
  const courses = index.courses.map((course) => {
    const topics = topicsByCourse[course.id];
    if (!topics) return course;
    const firstUnit = course.units[0];
    if (!firstUnit) return course;
    return {
      ...course,
      units: [
        { ...firstUnit, concepts: topics },
        ...course.units.slice(1).map((unit) => ({ ...unit, concepts: [] })),
      ],
    };
  });
  return {
    ...index,
    courses,
    coursesById: new Map(courses.map((course) => [course.id, course])),
  };
}

function schedulerContentWithUnits(
  courseId: string,
  topicsByUnit: string[][],
  index: ContentIndex = content,
): ContentIndex {
  const courses = index.courses.map((course) =>
    course.id === courseId
      ? {
          ...course,
          units: course.units.map((unit, unitIndex) => ({
            ...unit,
            concepts: topicsByUnit[unitIndex] ?? [],
          })),
        }
      : course,
  );
  return {
    ...index,
    courses,
    coursesById: new Map(courses.map((course) => [course.id, course])),
  };
}

function schedulerContentWithConfusables(
  index: ContentIndex,
  pairs: Array<[string, string]>,
): ContentIndex {
  const confusablesById = new Map(
    [...index.confusablesById].map(
      ([conceptId, confusableIds]) => [conceptId, new Set(confusableIds)] as const,
    ),
  );
  for (const [left, right] of pairs) {
    const leftConfusables = confusablesById.get(left);
    const rightConfusables = confusablesById.get(right);
    if (!leftConfusables || !rightConfusables) {
      throw new Error(`Missing confusable fixture concepts: ${left}, ${right}`);
    }
    leftConfusables.add(right);
    rightConfusables.add(left);
  }
  return { ...index, confusablesById };
}

function schedulerContentWithSubjects(
  index: ContentIndex,
  subjects: Array<{ id: string; title: string }>,
  subjectByCourse: Record<string, string>,
  courseOrder?: string[],
): ContentIndex {
  if (!index.curriculum) throw new Error('Missing curriculum for scheduler fixture');
  const courses = index.courses.map((course) => ({
    ...course,
    ...(subjectByCourse[course.id] ? { subject: subjectByCourse[course.id] } : {}),
  }));
  const coursesById = new Map(courses.map((course) => [course.id, course]));
  const subjectsByCourseId = new Map(
    courses.map((course) => {
      const subject = subjects.find((candidate) => candidate.id === course.subject);
      return [
        course.id,
        subject
          ? { id: subject.id, title: subject.title }
          : { id: 'default', title: index.curriculum?.subject?.title ?? 'Courses' },
      ] as const;
    }),
  );
  return {
    ...index,
    courses,
    coursesById,
    subjectsByCourseId,
    curriculum: {
      ...index.curriculum,
      courses: courseOrder ?? index.curriculum.courses,
      subjects,
    },
  };
}

test('mastery credit follows hint, retry, LLM, and self caps', () => {
  expect(
    calculateCredit({ correct: 1, hintsUsed: 0, attemptNo: 1, gradedBy: 'deterministic' }),
  ).toBe(1);
  expect(
    calculateCredit({ correct: 1, hintsUsed: 1, attemptNo: 1, gradedBy: 'deterministic' }),
  ).toBe(0.7);
  expect(
    calculateCredit({ correct: 1, hintsUsed: 2, attemptNo: 2, gradedBy: 'deterministic' }),
  ).toBe(0.25);
  expect(
    calculateCredit({ correct: 1, hintsUsed: 5, attemptNo: 1, gradedBy: 'deterministic' }),
  ).toBe(0.1);
  expect(calculateCredit({ correct: 1, hintsUsed: 0, attemptNo: 1, gradedBy: 'llm' })).toBe(0.5);
  expect(calculateCredit({ correct: 1, hintsUsed: 0, attemptNo: 1, gradedBy: 'self' })).toBe(0.5);
});

test('mastery introduces attempts, requires distinct independent items, and retains delayed recall', () => {
  const model = new DefaultMasteryModel();
  const base = initialMastery('vectors', 'math');
  const first = model.applyAttempt(
    base,
    {
      conceptId: 'vectors',
      dimension: 'math',
      attemptId: 'a1',
      exerciseId: 'vectors-magnitude',
      correct: 1,
      hintsUsed: 0,
      attemptNo: 1,
      mode: 'practice',
      itemRole: 'core',
      gradedBy: 'deterministic',
    },
    now,
  );
  expect(first.mastery.state).toBe('assisted');
  expect(first.event?.rule).toBe('independent_correct_assisted');
  const second = model.applyAttempt(
    first.mastery,
    {
      conceptId: 'vectors',
      dimension: 'math',
      attemptId: 'a2',
      exerciseId: 'vectors-component-sum',
      correct: 1,
      hintsUsed: 0,
      attemptNo: 1,
      mode: 'practice',
      itemRole: 'core',
      gradedBy: 'deterministic',
    },
    now,
  );
  expect(second.mastery.state).toBe('independent');
  expect(second.event?.rule).toBe('two_distinct_independent_items');
  const delayed = model.applyAttempt(
    second.mastery,
    {
      conceptId: 'vectors',
      dimension: 'math',
      attemptId: 'a3',
      exerciseId: 'vectors-magnitude',
      correct: 1,
      hintsUsed: 0,
      attemptNo: 1,
      mode: 'review',
      itemRole: 'review',
      gradedBy: 'deterministic',
    },
    new Date('2026-01-18T12:00:00.000Z'),
  );
  expect(delayed.mastery.state).toBe('retained');
  expect(delayed.event?.rule).toBe('delayed_recall_retained');
});

test('a hinted correct answer also raises introduced mastery to assisted', () => {
  const result = new DefaultMasteryModel().applyAttempt(
    initialMastery('vectors', 'math'),
    {
      conceptId: 'vectors',
      dimension: 'math',
      attemptId: 'hinted-1',
      exerciseId: 'vectors-magnitude',
      correct: 1,
      hintsUsed: 1,
      attemptNo: 1,
      mode: 'practice',
      itemRole: 'core',
      gradedBy: 'deterministic',
    },
    now,
  );

  expect(result.mastery.state).toBe('assisted');
});

test('hint counts reset after the previous attempt and respect activity scope', () => {
  const at = (minute: number) =>
    new Date(`2026-01-14T12:${minute.toString().padStart(2, '0')}:00.000Z`);
  const attempts = [
    {
      userId: 'learner',
      exerciseId: 'item',
      activityId: 'activity-1',
      createdAt: at(1),
    },
    {
      userId: 'learner',
      exerciseId: 'item',
      activityId: 'activity-2',
      createdAt: at(4),
    },
  ];
  const hints = [
    { userId: 'learner', exerciseId: 'item', activityId: 'activity-1', createdAt: at(0) },
    { userId: 'learner', exerciseId: 'item', activityId: 'activity-1', createdAt: at(2) },
    { userId: 'learner', exerciseId: 'item', activityId: 'activity-2', createdAt: at(3) },
    { userId: 'learner', exerciseId: 'item', activityId: 'activity-2', createdAt: at(5) },
    { userId: 'other', exerciseId: 'item', activityId: 'activity-1', createdAt: at(6) },
    { userId: 'learner', exerciseId: 'another-item', activityId: 'activity-1', createdAt: at(6) },
  ];

  expect(
    countHintsSincePreviousAttempt({ userId: 'learner', exerciseId: 'item', attempts, hints }),
  ).toBe(1);
  expect(
    countHintsSincePreviousAttempt({
      userId: 'learner',
      exerciseId: 'item',
      activityId: 'activity-1',
      attempts,
      hints,
    }),
  ).toBe(1);
});

test('placement success is provisional', () => {
  const model = new DefaultMasteryModel();
  const result = model.applyAttempt(
    undefined,
    {
      conceptId: 'matrix-products',
      dimension: 'math',
      attemptId: 'diagnostic-1',
      exerciseId: 'matrix-products-diagnostic',
      correct: 1,
      hintsUsed: 0,
      attemptNo: 1,
      mode: 'diagnostic',
      itemRole: 'diagnostic',
      gradedBy: 'deterministic',
    },
    now,
  );
  expect(result.mastery).toMatchObject({ state: 'independent', provisional: true });
  expect(recordLessonViewed(undefined, 'vectors', 'math', now).mastery.state).toBe('introduced');
});

test('independent failure demotes mastery and opens remediation after two failures', () => {
  const model = new DefaultMasteryModel();
  const mastered = {
    ...initialMastery('vectors', 'math'),
    state: 'independent' as const,
    independentItemIds: ['a', 'b'],
    independentDeterministicCount: 2,
    lastIndependentCorrect: true,
  };
  const failed = (attemptId: string) =>
    model.applyAttempt(
      mastered,
      {
        conceptId: 'vectors',
        dimension: 'math',
        attemptId,
        exerciseId: attemptId,
        correct: 0,
        hintsUsed: 0,
        attemptNo: 1,
        mode: 'assessment',
        itemRole: 'core',
        gradedBy: 'deterministic',
      },
      now,
    );
  const first = failed('failure-1');
  expect(first.mastery.state).toBe('assisted');
  expect(first.event?.rule).toBe('independent_failure_demotion');
  const second = model.applyAttempt(
    first.mastery,
    {
      conceptId: 'vectors',
      dimension: 'math',
      attemptId: 'failure-2',
      exerciseId: 'failure-2',
      correct: 0,
      hintsUsed: 0,
      attemptNo: 1,
      mode: 'assessment',
      itemRole: 'core',
      gradedBy: 'deterministic',
    },
    now,
  );
  expect(second.remediationFlagOpen).toBe(true);
  expect(second.remediationReason).toBe('independent_failure_streak');
});

test('FSRS rating mapping never assigns Easy and schedules a review card', () => {
  expect(mapReviewRating({ correct: 0, hintsUsed: 0, attemptNo: 1 })).toBe(1);
  expect(mapReviewRating({ correct: 1, hintsUsed: 1, attemptNo: 1 })).toBe(2);
  expect(mapReviewRating({ correct: 1, hintsUsed: 0, attemptNo: 1 })).toBe(3);
  const card = newReviewCard(now);
  const result = scheduleReview(card, now, 'good', 'UTC', false);
  expect(result.card.reps).toBeGreaterThan(0);
  expect(result.card.due.getTime()).toBeGreaterThan(now.getTime());
});

test('FSRS schedules new cards in day-scale intervals without short-term steps', () => {
  const day = 86_400_000;
  for (const [rating, expectedDays] of [
    ['again', 1],
    ['hard', 2],
    ['good', 3],
  ] as const) {
    const scheduled = scheduleReview(newReviewCard(now), now, rating, 'UTC', false);
    expect(scheduled.card.due.getTime() - now.getTime()).toBe(expectedDays * day);
  }
});

test('reviewing a stored learning-state card schedules at least a day ahead', () => {
  const shortTermScheduler = fsrs(generatorParameters({ enable_fuzz: false }));
  const learning = shortTermScheduler.next(newReviewCard(now), now, Rating.Again).card;
  expect(learning.state).toBe(State.Learning);

  const reviewNow = new Date(now.getTime() + 5 * 60_000);
  const scheduled = scheduleReview(learning, reviewNow, 'good', 'UTC', false);
  expect(scheduled.card.due.getTime()).toBeGreaterThanOrEqual(
    new Date('2026-01-15T00:00:00.000Z').getTime(),
  );
});

test('a newly scheduled review is due no earlier than the next learner calendar day', () => {
  const scheduled = scheduleInitialReview(newReviewCard(now), now, 'good', 'Europe/London', false);
  const dateInZone = (date: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(date);

  expect(scheduled.card.reps).toBeGreaterThan(0);
  expect(scheduled.card.due.getTime()).toBeGreaterThan(now.getTime());
  expect(dateInZone(scheduled.card.due)).not.toBe(dateInZone(now));
});

test('learning debt derives implementation gaps, demotions, hints, and open flags', () => {
  const debt = deriveLearningDebt({
    mastery: [
      { ...initialMastery('gradients', 'conceptual'), state: 'independent' },
      { ...initialMastery('gradients', 'implementation'), state: 'introduced' },
    ],
    events: [
      {
        conceptId: 'vectors',
        dimension: 'math',
        fromState: 'independent',
        toState: 'assisted',
        rule: 'independent_failure_demotion',
        createdAt: now.toISOString(),
      },
    ],
    attempts: [
      { conceptId: 'vectors', dimension: 'conceptual', correct: 1, hintsUsed: 2 },
      { conceptId: 'vectors', dimension: 'conceptual', correct: 1, hintsUsed: 2 },
      { conceptId: 'vectors', dimension: 'conceptual', correct: 1, hintsUsed: 2 },
    ],
    remediationFlags: [{ conceptId: 'gradients', targetPrereqId: 'derivatives' }],
  });
  expect(debt.map((entry) => entry.reason)).toEqual(
    expect.arrayContaining([
      'implementation_below_assisted',
      'mastery_demotion',
      'high_hint_dependence',
      'open_remediation',
    ]),
  );
});

test('No-knowledge user gets foundational concepts', () => {
  const plan = planSession(emptyState(), content, now, 60);
  expect(
    plan.activities.some(
      (activity) => activity.kind === 'learn' && activity.conceptId === 'vectors',
    ),
  ).toBe(true);
});

test('learn duration uses the concept estimate', () => {
  const concept = required(content.conceptsById.get('vectors'), 'vectors concept');
  const plan = planSession(emptyState(), content, now, concept.est_minutes);
  const learn = plan.activities.find(
    (activity) => activity.kind === 'learn' && activity.conceptId === concept.id,
  );

  expect(learn?.plannedMinutes).toBe(concept.est_minutes);
});

test('weekday planning never learns two unlocked confusable topics on the same day', () => {
  const topicsContent = schedulerContentWithTopics({
    'fixture-course': ['vectors', 'supervised-learning'],
  });
  const confusableContent = schedulerContentWithConfusables(topicsContent, [
    ['vectors', 'supervised-learning'],
  ]);
  const state = studyState(['fixture-course'], confusableContent);

  const plan = planSession(state, confusableContent, now, 120);
  const learnedConcepts = plan.activities
    .filter((activity) => activity.kind === 'learn')
    .map((activity) => activity.conceptId);

  expect(learnedConcepts).toHaveLength(1);
  expect(learnedConcepts[0]).toBe('vectors');
});

test('an interfering subject yields to the next subject with an eligible topic', () => {
  const topicsContent = schedulerContentWithTopics({
    'fixture-course': ['vectors', 'supervised-learning'],
    'fixture-switching-course': ['switching-topic'],
  });
  const subjectContent = schedulerContentWithSubjects(
    topicsContent,
    [
      { id: 'math', title: 'Mathematics' },
      { id: 'ml', title: 'Machine learning' },
    ],
    {
      'fixture-course': 'math',
      'fixture-switching-course': 'ml',
    },
    ['fixture-course', 'fixture-switching-course'],
  );
  const confusableContent = schedulerContentWithConfusables(subjectContent, [
    ['vectors', 'supervised-learning'],
  ]);
  const state = studyState(['fixture-course', 'fixture-switching-course'], confusableContent);

  const plan = planSession(state, confusableContent, now, 120);
  const learnedConcepts = plan.activities
    .filter((activity) => activity.kind === 'learn')
    .map((activity) => activity.conceptId);

  expect(learnedConcepts).toContain('vectors');
  expect(learnedConcepts).not.toContain('supervised-learning');
  expect(learnedConcepts).toContain('switching-topic');
});

test('weekday planning skips a confusable topic when its partner started a lesson earlier today', () => {
  const topicsContent = schedulerContentWithTopics({
    'fixture-course': ['vectors', 'supervised-learning'],
  });
  const confusableContent = schedulerContentWithConfusables(topicsContent, [
    ['vectors', 'supervised-learning'],
  ]);
  const state = studyState(['fixture-course'], confusableContent);
  state.timezone = 'America/Los_Angeles';
  state.lessonRuns = [
    {
      conceptId: 'vectors',
      status: 'completed',
      startedAt: '2026-01-13T23:00:00.000Z',
    },
  ];
  state.mastery.push(
    ...required(confusableContent.conceptsById.get('vectors'), 'vectors concept').dimensions.map(
      (dimension) => ({
        ...initialMastery('vectors', dimension),
        state: 'independent' as const,
      }),
    ),
  );

  const plan = planSession(state, confusableContent, new Date('2026-01-14T07:30:00.000Z'), 120);

  expect(
    plan.activities
      .filter((activity) => activity.kind === 'learn')
      .map((activity) => activity.conceptId),
  ).toEqual([]);
});

test('weekday planning prefers a different unit when another unlocked topic is available', () => {
  const index = schedulerContentWithUnits('fixture-course', [
    ['vectors', 'supervised-learning'],
    ['loss-functions'],
  ]);
  const state = studyState(['fixture-course'], index);

  const plan = planSession(state, index, now, 120);
  const course = required(index.coursesById.get('fixture-course'), 'fixture course');
  const unitByConcept = new Map(
    course.units.flatMap((unit, unitIndex) =>
      unit.concepts.map((conceptId) => [conceptId, unitIndex + 1] as const),
    ),
  );
  const learnedUnits = plan.activities
    .filter((activity) => activity.kind === 'learn')
    .flatMap((activity) => {
      const unit = activity.conceptId ? unitByConcept.get(activity.conceptId) : undefined;
      return unit === undefined ? [] : [unit];
    });

  expect(learnedUnits).toHaveLength(2);
  expect(new Set(learnedUnits)).toEqual(new Set([1, 2]));
});

test('weekday planning still selects two topics when they are the only topics in one unit', () => {
  const index = schedulerContentWithTopics({
    'fixture-switching-course': ['linear-models', 'switching-topic'],
  });
  const state = studyState(['fixture-switching-course'], index);

  const plan = planSession(state, index, now, 120);
  const learnedConcepts = plan.activities
    .filter((activity) => activity.kind === 'learn')
    .map((activity) => activity.conceptId);

  expect(new Set(learnedConcepts)).toEqual(new Set(['linear-models', 'switching-topic']));
});

test('new lessons follow outline order even when a later candidate has a higher score', async () => {
  const fullContent = await loadContent();
  const ids = new Set(['vectors', 'derivatives', 'probability-basics', 'supervised-learning']);
  const probabilityExerciseTemplate = fullContent.exercisesByConcept
    .get('supervised-learning')
    ?.find((exercise) => exercise.dimension === 'conceptual' && exercise.role === 'core');
  if (!probabilityExerciseTemplate) throw new Error('Missing supervised-learning core exercise');
  const probabilityExercise = {
    ...probabilityExerciseTemplate,
    id: 'probability-basics-order-test',
    concept: 'probability-basics',
  };
  const concepts = fullContent.concepts
    .filter((concept) => ids.has(concept.id))
    .map((concept) => {
      if (concept.id === 'derivatives') return { ...concept, goal_weight: 100 };
      if (concept.id === 'probability-basics') return { ...concept, status: 'authored' as const };
      return concept;
    });
  const conceptsById = new Map(concepts.map((concept) => [concept.id, concept]));
  const exercises = [
    ...fullContent.exercises.filter((exercise) => ids.has(exercise.concept)),
    probabilityExercise,
  ];
  const defaultCourse = fullContent.coursesById.get('ml-foundations');
  const firstUnit = defaultCourse?.units[0];
  if (!defaultCourse || !firstUnit) throw new Error('Missing default course unit');
  const rankedCourse = {
    ...defaultCourse,
    units: [
      {
        ...firstUnit,
        concepts: [...firstUnit.concepts.filter((id) => ids.has(id)), 'probability-basics'],
      },
    ],
  };
  const courses = fullContent.courses.map((course) =>
    course.id === rankedCourse.id ? rankedCourse : course,
  );
  const rankedContent: ContentIndex = {
    ...fullContent,
    courses,
    coursesById: new Map(courses.map((course) => [course.id, course])),
    concepts,
    conceptsById,
    exercises,
    exercisesById: new Map(exercises.map((exercise) => [exercise.id, exercise])),
    exercisesByConcept: new Map(
      concepts.map((concept) => [
        concept.id,
        concept.id === 'probability-basics'
          ? [probabilityExercise]
          : (fullContent.exercisesByConcept.get(concept.id) ?? []),
      ]),
    ),
    lessons: fullContent.lessons.filter((lesson) => ids.has(lesson.concept)),
    lessonsByConcept: new Map(
      [...fullContent.lessonsByConcept].filter(([conceptId]) => ids.has(conceptId)),
    ),
  };
  const state = emptyState();
  state.studyCourseIds = ['ml-foundations'];
  state.mastery = [{ ...initialMastery('vectors', 'conceptual'), inferred: true }];
  const masteryByKey = new Map(
    state.mastery.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
  );
  expect(
    [...ids].every((id) =>
      (conceptsById.get(id)?.prereqs ?? [])
        .filter((prerequisite) => prerequisite.strength === 'hard')
        .every((prerequisite) => prerequisiteMet(prerequisite.id, masteryByKey, [], rankedContent)),
    ),
  ).toBe(true);

  const plansByConcept = new Map(
    [...ids].map((conceptId) => [
      conceptId,
      planSession({ ...state, inProgressConceptId: conceptId }, rankedContent, now, 60),
    ]),
  );
  expect(
    [...plansByConcept].every(([conceptId, plan]) =>
      plan.activities.some(
        (activity) => activity.kind === 'learn' && activity.conceptId === conceptId,
      ),
    ),
  ).toBe(true);
  const plan = planSession(state, rankedContent, now, 60);
  const learnIds = plan.activities
    .filter((activity) => activity.kind === 'learn')
    .map((activity) => activity.conceptId);

  expect(conceptsById.get('derivatives')?.goal_weight).toBeGreaterThan(
    conceptsById.get('vectors')?.goal_weight ?? 0,
  );
  expect(learnIds).toEqual(['supervised-learning', 'vectors']);
  const score = (activity: PlannedActivity | undefined) => {
    if (!activity) throw new Error('Expected a planned lesson');
    const weighted = Object.entries(activity.reason.terms).reduce(
      (total, [term, value]) =>
        total + value * SCHEDULER_CONFIG.weights[term as keyof typeof SCHEDULER_CONFIG.weights],
      0,
    );
    return weighted / Math.sqrt(activity.plannedMinutes);
  };
  expect(
    score(
      plansByConcept
        .get('supervised-learning')
        ?.activities.find((activity) => activity.conceptId === 'supervised-learning'),
    ),
  ).toBeLessThan(
    score(
      plansByConcept
        .get('derivatives')
        ?.activities.find((activity) => activity.conceptId === 'derivatives'),
    ),
  );
});

test('outline positions place missing concepts last', async () => {
  const fullContent = await loadContent();
  expect(outlinePosition('vectors', fullContent)).toEqual([0, 2]);
  expect(compareOutlinePosition('vectors', 'not-in-outline', fullContent)).toBeLessThan(0);
});

test('a completed KP lesson satisfies a prerequisite despite introduced mastery', async () => {
  const fullContent = await loadContent();
  const masteryByKey = new Map([
    [
      masteryKey('supervised-learning', 'conceptual'),
      { ...initialMastery('supervised-learning', 'conceptual'), state: 'introduced' as const },
    ],
  ]);

  expect(
    prerequisiteMet(
      'supervised-learning',
      masteryByKey,
      [{ conceptId: 'supervised-learning', status: 'completed' }],
      fullContent,
    ),
  ).toBe(true);
});

test('stub concepts never satisfy a prerequisite', async () => {
  const fullContent = await loadContent();
  const stub = fullContent.concepts.find((concept) => concept.status === 'stub');
  if (!stub) throw new Error('Expected a stub concept');
  const masteryByKey = new Map([
    [
      masteryKey(stub.id, stub.dimensions[0] ?? 'conceptual'),
      { state: 'independent' as const, inferred: true },
    ],
  ]);

  expect(
    prerequisiteMet(
      stub.id,
      masteryByKey,
      [{ conceptId: stub.id, status: 'completed' }],
      fullContent,
    ),
  ).toBe(false);
});

test('an existing lesson run requires quiz completion regardless of assisted mastery', async () => {
  const fullContent = await loadContent();
  const masteryByKey = new Map([
    [
      masteryKey('supervised-learning', 'conceptual'),
      { ...initialMastery('supervised-learning', 'conceptual'), state: 'assisted' as const },
    ],
  ]);
  expect(
    prerequisiteMet(
      'supervised-learning',
      masteryByKey,
      [{ conceptId: 'supervised-learning', status: 'quiz' }],
      fullContent,
    ),
  ).toBe(false);
  expect(prerequisiteMet('supervised-learning', masteryByKey, [], fullContent)).toBe(true);
  expect(
    prerequisiteMet(
      'supervised-learning',
      masteryByKey,
      [{ conceptId: 'supervised-learning', status: 'completed' }],
      fullContent,
    ),
  ).toBe(true);
});

test('unfinished knowledge-point lessons are prioritized regardless of mastery, but completed ones are not relearned', () => {
  const concept = required(content.conceptsById.get('supervised-learning'), 'supervised-learning');
  const base = emptyState();
  base.mastery = [
    ...concept.dimensions.map((dimension) => ({
      ...initialMastery(concept.id, dimension),
      state: 'independent' as const,
    })),
    ...concept.prereqs
      .filter((prerequisite) => prerequisite.strength === 'hard')
      .flatMap((prerequisite) => {
        const requiredConcept = content.conceptsById.get(prerequisite.id);
        return (
          requiredConcept?.dimensions.map((dimension) => ({
            ...initialMastery(prerequisite.id, dimension),
            state: 'independent' as const,
          })) ?? []
        );
      }),
  ];
  for (const status of ['in_progress', 'needs_retry', 'quiz'] as const) {
    const state = {
      ...base,
      lessonRuns: [{ conceptId: concept.id, status }],
    };
    expect(
      planSession(state, content, now, 60).activities.find(
        (activity) => activity.conceptId === concept.id,
      )?.kind,
    ).toBe('learn');
  }
  expect(
    planSession(
      { ...base, lessonRuns: [{ conceptId: concept.id, status: 'completed' }] },
      content,
      now,
      60,
    ).activities.find((activity) => activity.conceptId === concept.id)?.kind,
  ).not.toBe('learn');
});

test('weekday plans avoid duplicate concepts, cap activities, and never add empty fillers', () => {
  const state = emptyState();
  state.cards = [{ conceptId: 'vectors', dimension: 'math', dueAt: '2026-01-14T11:00:00.000Z' }];
  state.mastery = [
    {
      ...initialMastery('vectors', 'math'),
      state: 'independent',
      provisional: true,
    },
  ];
  const plan = planSession(state, content, now, 90);
  const conceptIds = plan.activities
    .map((activity) => activity.conceptId)
    .filter((id): id is string => Boolean(id));

  expect(new Set(conceptIds).size).toBe(conceptIds.length);
  expect(plan.activities.length).toBeLessThanOrEqual(6);
  expect(
    plan.activities.every(
      (activity) => ['lab', 'paper'].includes(activity.kind) || activity.exerciseIds.length > 0,
    ),
  ).toBe(true);
});

test.each(['weekday', 'saturday', 'sunday', 'custom'] as const)(
  'the %s plan omits quick checks, standalone transfer, teachback, and reflection',
  (kind) => {
    const state = emptyState();
    state.mastery = [
      {
        ...initialMastery('vectors', 'math'),
        state: 'independent',
        provisional: true,
      },
    ];
    state.lessonRuns = [{ conceptId: 'linear-models', status: 'completed' }];
    state.cards = [{ conceptId: 'vectors', dimension: 'math', dueAt: now.toISOString() }];
    const plan = planSession(state, content, now, 300, kind);

    expect(
      plan.activities.some((activity) =>
        ['quick_check', 'transfer', 'teachback', 'reflect'].includes(activity.kind),
      ),
    ).toBe(false);
  },
);

test('a placed-out topic has no quick check candidate', () => {
  const state = emptyState();
  state.mastery = [
    { ...initialMastery('vectors', 'math'), state: 'independent', provisional: true },
  ];
  const plan = planSession(state, content, now, 60);
  expect(plan.activities.some((activity) => activity.kind === 'quick_check')).toBe(false);
});

test('Knowledgeable user skips mastered prerequisites', () => {
  const state = emptyState();
  const vectors = required(content.conceptsById.get('vectors'), 'vectors concept');
  state.mastery = vectors.dimensions.map((dimension) => ({
    ...initialMastery('vectors', dimension),
    state: 'retained',
  }));
  const plan = planSession(state, content, now, 60);
  expect(
    plan.activities.some(
      (activity) => activity.kind === 'learn' && activity.conceptId === 'vectors',
    ),
  ).toBe(false);
  expect(
    plan.activities.some(
      (activity) => activity.kind === 'learn' && activity.conceptId === 'derivatives',
    ),
  ).toBe(true);
});

test('Scheduler never assigns lessons or practice to stub concepts', () => {
  const stub = required(content.conceptsById.get('matrix-products'), 'stub concept');
  const coreExercise = required(
    content.exercisesByConcept.get('vectors')?.find((exercise) => exercise.role === 'core'),
    'core exercise',
  );
  const stubExercise = {
    ...coreExercise,
    id: 'matrix-products-core',
    concept: stub.id,
  };
  const stubContent = {
    ...content,
    exercises: [...content.exercises, stubExercise],
    exercisesByConcept: new Map(content.exercisesByConcept).set(stub.id, [stubExercise]),
    exercisesById: new Map(content.exercisesById).set(stubExercise.id, stubExercise),
  };
  const state = emptyState();
  const prerequisite = required(content.conceptsById.get('linear-algebra'), 'stub prerequisite');
  state.mastery = prerequisite.dimensions.map((dimension) => ({
    ...initialMastery(prerequisite.id, dimension),
    state: 'retained',
  }));
  state.inProgressConceptId = stub.id;

  const plan = planSession(state, stubContent, now, 60);

  expect(
    plan.activities.some(
      (activity) =>
        activity.conceptId === stub.id &&
        (activity.kind === 'learn' || activity.kind === 'practice'),
    ),
  ).toBe(false);
});

test.each([
  { sessionKind: 'weekday' as const, budget: 60 },
  { sessionKind: 'saturday' as const, budget: 300 },
  { sessionKind: 'sunday' as const, budget: 60 },
])(
  'open remediation flags do not schedule remediation on $sessionKind',
  ({ sessionKind, budget }) => {
    const state = emptyState();
    state.remediationFlags = [{ conceptId: 'gradient-descent', targetPrereqId: 'gradients' }];
    const plan = planSession(state, content, now, budget, sessionKind);
    expect(plan.activities.some((activity) => activity.kind === 'remediate')).toBe(false);
  },
);

test('Independent success outranks hinted success', () => {
  const independent = calculateCredit({
    correct: 1,
    hintsUsed: 0,
    attemptNo: 1,
    gradedBy: 'deterministic',
  });
  const hinted = calculateCredit({
    correct: 1,
    hintsUsed: 2,
    attemptNo: 1,
    gradedBy: 'deterministic',
  });
  expect(independent).toBeGreaterThan(hinted);
});

test('Overdue reviews are scheduled', () => {
  const state = emptyState();
  state.cards = [
    {
      conceptId: 'vectors',
      dimension: 'math',
      dueAt: '2026-01-13T00:00:00.000Z',
      retrievability: 0.7,
    },
  ];
  const review = planSession(state, content, now, 60).activities.find(
    (activity) => activity.kind === 'review',
  );
  expect(review).toBeDefined();
  expect(review?.reason.summary).toContain('Due since 13 Jan 2026');
  expect(review?.reason.summary).toContain('~70% recall');
});

test('three due topics from two courses become one interleaved mixed review', () => {
  const reviews = [
    reviewCandidate('vectors', 'fixture-course', 9, ['v1', 'v2', 'v3']),
    reviewCandidate('derivatives', 'fixture-course', 8, ['d1', 'd2', 'd3']),
    reviewCandidate('switching-topic', 'fixture-switching-course', 7, ['s1', 's2', 's3']),
  ];

  const [mixed] = mixReviewActivities(reviews, content);

  expect(mixed?.activity).toMatchObject({
    kind: 'review',
    conceptId: null,
    exerciseIds: ['v1', 's1', 'd1', 'v2', 's2', 'd2', 'v3', 's3', 'd3'],
    plannedMinutes: 18,
    reason: {
      summary: 'Mixed review: Vectors, Switching topic, Derivatives.',
      terms: { review: 9 },
    },
  });
});

test('one selected due topic stays a single-topic review', () => {
  const onlyReview = reviewCandidate('vectors', 'fixture-course', 4);
  const [result] = mixReviewActivities([onlyReview], content);
  expect(result).toBe(onlyReview);
  expect(result?.activity.conceptId).toBe('vectors');
});

test('a review alongside a lesson of the same concept stays separate', () => {
  const learn: Candidate = {
    ...reviewCandidate('vectors', 'fixture-course', 1, ['learn']),
    activity: {
      kind: 'learn',
      conceptId: 'vectors',
      exerciseIds: ['learn'],
      plannedMinutes: 5,
      reason: reviewCandidate('vectors', 'fixture-course', 1).activity.reason,
    },
  };
  const sameConceptReview = reviewCandidate('vectors', 'fixture-course', 10, ['vr']);
  const otherReviews = [
    reviewCandidate('derivatives', 'fixture-course', 8, ['d1', 'd2']),
    reviewCandidate('switching-topic', 'fixture-switching-course', 7, ['s1', 's2']),
  ];

  const result = mixReviewActivities([learn, sameConceptReview, ...otherReviews], content);

  expect(result[0]).toBe(learn);
  expect(result).toContain(sameConceptReview);
  expect(result.filter((candidate) => candidate.activity.kind === 'review')).toHaveLength(2);
  expect(result.find((candidate) => candidate.activity.kind === 'review')?.activity.conceptId).toBe(
    'vectors',
  );
  expect(
    result.find((candidate) => candidate.activity.conceptId === null)?.activity.exerciseIds,
  ).toEqual(['d1', 's1', 'd2', 's2']);
});

test('four due topics spread into two mixed reviews of two topics each', () => {
  const reviews = [
    reviewCandidate('vectors', 'fixture-course', 9),
    reviewCandidate('derivatives', 'fixture-course', 8),
    reviewCandidate('switching-topic', 'fixture-switching-course', 7),
    reviewCandidate('linear-models', 'fixture-switching-course', 6),
  ];

  const result = mixReviewActivities(reviews, content);

  expect(result).toHaveLength(2);
  expect(result.every((candidate) => candidate.activity.conceptId === null)).toBe(true);
  expect(result.map((candidate) => candidate.activity.exerciseIds)).toEqual([
    [
      'vectors-1',
      'switching-topic-1',
      'vectors-2',
      'switching-topic-2',
      'vectors-3',
      'switching-topic-3',
    ],
    [
      'derivatives-1',
      'linear-models-1',
      'derivatives-2',
      'linear-models-2',
      'derivatives-3',
      'linear-models-3',
    ],
  ]);
});

test('a due review remains planned on the day of an ungraded attempt', () => {
  const state = emptyState();
  state.timezone = 'UTC';
  state.cards = [
    {
      conceptId: 'vectors',
      dimension: 'math',
      dueAt: '2026-01-13T00:00:00.000Z',
      retrievability: 0.7,
    },
  ];
  state.recentAttempts = [
    {
      conceptId: 'vectors',
      exerciseId: 'vectors-magnitude',
      dimension: 'math',
      correct: 1,
      itemRole: 'core',
      createdAt: '2026-01-13T11:30:00.000Z',
    },
  ];

  const sameDayPlan = planSession(state, content, new Date('2026-01-13T12:00:00.000Z'), 60);
  expect(
    sameDayPlan.activities.some(
      (activity) => activity.kind === 'review' && activity.conceptId === 'vectors',
    ),
  ).toBe(true);

  const nextDayPlan = planSession(state, content, new Date('2026-01-14T00:30:00.000Z'), 60);
  expect(
    nextDayPlan.activities.some(
      (activity) => activity.kind === 'review' && activity.conceptId === 'vectors',
    ),
  ).toBe(true);
});

test('a prior-day London attempt does not suppress a review after local midnight', () => {
  const state = emptyState();
  state.timezone = 'Europe/London';
  state.cards = [
    {
      conceptId: 'vectors',
      dimension: 'math',
      dueAt: '2026-03-29T20:00:00.000Z',
      retrievability: 0.7,
    },
  ];
  state.recentAttempts = [
    {
      conceptId: 'vectors',
      exerciseId: 'vectors-magnitude',
      dimension: 'math',
      correct: 1,
      itemRole: 'core',
      createdAt: '2026-03-29T22:30:00.000Z',
    },
  ];

  const plan = planSession(state, content, new Date('2026-03-29T23:30:00.000Z'), 60);
  expect(
    plan.activities.some(
      (activity) => activity.kind === 'review' && activity.conceptId === 'vectors',
    ),
  ).toBe(true);
});

test('due review prefers a fresh practice exercise over a recent review exercise', () => {
  const vectorExercises = content.exercisesByConcept.get('vectors') ?? [];
  const reviewExercise = required(
    vectorExercises.find((exercise) => exercise.id === 'vectors-magnitude'),
    'vectors-magnitude exercise',
  );
  const practiceExercise = required(
    vectorExercises.find((exercise) => exercise.id === 'vectors-fixture-practice-1'),
    'vectors-fixture-practice-1 exercise',
  );
  const exercisesByConcept = new Map(content.exercisesByConcept);
  exercisesByConcept.set('vectors', [
    { ...reviewExercise, role: 'review' as const },
    { ...practiceExercise, role: 'practice' as const },
  ]);
  const reviewContent: ContentIndex = { ...content, exercisesByConcept };
  const state = emptyState();
  state.cards = [
    {
      conceptId: 'vectors',
      dimension: 'math',
      dueAt: '2026-01-13T00:00:00.000Z',
      retrievability: 0.7,
    },
  ];
  state.recentAttempts = [
    {
      conceptId: 'vectors',
      exerciseId: reviewExercise.id,
      dimension: 'math',
      correct: 1,
      itemRole: 'review',
      createdAt: '2026-01-13T12:00:00.000Z',
    },
  ];

  const review = planSession(state, reviewContent, now, 60).activities.find(
    (activity) => activity.kind === 'review' && activity.conceptId === 'vectors',
  );
  expect(review?.exerciseIds[0]).toBe(practiceExercise.id);
});

test('due reviews can select a basics exercise', () => {
  const basics = required(
    (content.exercisesByConcept.get('vectors') ?? []).find(
      (exercise) => exercise.id === 'vectors-fixture-1-basics',
    ),
    'vectors basics exercise',
  );
  const exercisesByConcept = new Map(content.exercisesByConcept);
  exercisesByConcept.set('vectors', [basics]);
  const reviewContent: ContentIndex = { ...content, exercisesByConcept };
  const state = emptyState();
  state.cards = [
    {
      conceptId: 'vectors',
      dimension: 'conceptual',
      dueAt: '2026-01-13T00:00:00.000Z',
      retrievability: 0.7,
    },
  ];

  const review = planSession(state, reviewContent, now, 60).activities.find(
    (activity) => activity.kind === 'review' && activity.conceptId === 'vectors',
  );
  expect(review?.exerciseIds).toContain(basics.id);
});

test('due review falls back to a recent exercise when no fresh choice exists', () => {
  const reviewExercise = required(
    (content.exercisesByConcept.get('vectors') ?? []).find(
      (exercise) => exercise.id === 'vectors-magnitude',
    ),
    'vectors-magnitude exercise',
  );
  const exercisesByConcept = new Map(content.exercisesByConcept);
  exercisesByConcept.set('vectors', [{ ...reviewExercise, role: 'review' as const }]);
  const reviewContent: ContentIndex = { ...content, exercisesByConcept };
  const state = emptyState();
  state.cards = [
    {
      conceptId: 'vectors',
      dimension: 'math',
      dueAt: '2026-01-13T00:00:00.000Z',
      retrievability: 0.7,
    },
  ];
  state.recentAttempts = [
    {
      conceptId: 'vectors',
      exerciseId: reviewExercise.id,
      dimension: 'math',
      correct: 1,
      itemRole: 'review',
      createdAt: '2026-01-13T12:00:00.000Z',
    },
  ];

  const review = planSession(state, reviewContent, now, 60).activities.find(
    (activity) => activity.kind === 'review' && activity.conceptId === 'vectors',
  );
  expect(review?.exerciseIds[0]).toBe(reviewExercise.id);
});

test('due reviews use non-template practice exercises when no higher-priority role exists', () => {
  const practiceOnlyContent: ContentIndex = {
    ...content,
    exercisesByConcept: new Map(content.exercisesByConcept),
  };
  const vectorExercises = content.exercisesByConcept.get('vectors') ?? [];
  const practiceOnlyExercises = vectorExercises.map((exercise) =>
    exercise.dimension === 'math' ? { ...exercise, role: 'practice' as const } : exercise,
  );
  const eligibleIds = new Set(
    practiceOnlyExercises
      .filter(
        (exercise) =>
          exercise.dimension === 'math' && exercise.role === 'practice' && !isTemplate(exercise),
      )
      .map((exercise) => exercise.id),
  );
  practiceOnlyContent.exercisesByConcept.set('vectors', practiceOnlyExercises);
  const state = emptyState();
  state.cards = [
    {
      conceptId: 'vectors',
      dimension: 'math',
      dueAt: new Date(now.getTime() - 86_400_000).toISOString(),
      retrievability: 0.7,
    },
  ];

  const review = planSession(state, practiceOnlyContent, now, 60).activities.find(
    (activity) => activity.kind === 'review',
  );
  const selectedId = review?.exerciseIds[0] ?? '';
  expect(eligibleIds.has(selectedId)).toBe(true);
  expect(
    practiceOnlyExercises.some((exercise) => exercise.id === selectedId && !isTemplate(exercise)),
  ).toBe(true);
});

test('due reviews skip lesson-only exercises even when they are the only practice item', () => {
  const practiceExercise = required(
    (content.exercisesByConcept.get('vectors') ?? []).find(
      (exercise) => exercise.dimension === 'math' && !isTemplate(exercise),
    ),
    'vector math practice exercise',
  );
  const exercisesByConcept = new Map(content.exercisesByConcept);
  exercisesByConcept.set('vectors', [
    { ...practiceExercise, role: 'practice' as const, lesson_only: true },
  ]);
  const reviewContent: ContentIndex = { ...content, exercisesByConcept };
  const state = emptyState();
  state.cards = [
    {
      conceptId: 'vectors',
      dimension: 'math',
      dueAt: '2026-01-13T00:00:00.000Z',
      retrievability: 0.7,
    },
  ];

  const review = planSession(state, reviewContent, now, 60).activities.find(
    (activity) => activity.kind === 'review' && activity.conceptId === 'vectors',
  );
  expect(review).toBeUndefined();
});

test('Project prerequisites receive a priority term', () => {
  const state = emptyState();
  const vectors = required(content.conceptsById.get('vectors'), 'vectors concept');
  state.mastery = vectors.dimensions.map((dimension) => ({
    ...initialMastery('vectors', dimension),
    state: 'assisted',
  }));
  state.inProgressConceptId = 'linear-models';
  const plan = planSession(state, content, new Date('2026-01-06T12:00:00.000Z'), 60);
  const prerequisite = plan.activities.find((activity) => activity.conceptId === 'linear-models');
  expect(prerequisite?.reason.terms.project).toBe(3);
  expect(prerequisite?.reason.summary).toContain('needed for the optional project');
  if (prerequisite?.reason.terms.week_fit) {
    expect(prerequisite.reason.summary).toContain('ML fundamentals focus');
  }
  if (prerequisite?.reason.terms.unlock) {
    expect(prerequisite.reason.summary).toContain('unlocks');
  }
});

test('weekday plan omits practice filler and respects the budget', () => {
  const state = emptyState();
  state.mastery = ['vectors', 'linear-algebra'].flatMap((conceptId) => {
    const concept = content.conceptsById.get(conceptId);
    return (concept?.dimensions ?? []).map((dimension) => ({
      ...initialMastery(conceptId, dimension),
      state: 'independent' as const,
      provisional: true,
    }));
  });
  const plan = planSession(state, content, now, 60);
  expect(
    plan.activities.filter((activity) => activity.kind === 'learn').length,
  ).toBeLessThanOrEqual(2);
  expect(plan.activities.some((activity) => activity.kind === 'learn')).toBe(true);
  expect(plan.activities.some((activity) => activity.kind === 'practice')).toBe(false);
  expect(
    plan.activities.some((activity) =>
      activity.reason.summary.startsWith('Practice unseen core and review items'),
    ),
  ).toBe(false);
  expect(
    plan.activities.reduce((sum, activity) => sum + activity.plannedMinutes, 0),
  ).toBeLessThanOrEqual(60);
});

test('a due review selects up to three distinct exercises for its concept and dimension', () => {
  const eligible = (content.exercisesByConcept.get('vectors') ?? [])
    .filter(
      (exercise) =>
        exercise.dimension === 'math' &&
        ['review', 'core', 'practice', 'transfer', 'basics'].includes(exercise.role) &&
        !exercise.lesson_only &&
        !isTemplate(exercise),
    )
    .slice(0, 3);
  if (eligible.length < 3) throw new Error('Expected at least three vector math exercises');
  const reviewContent: ContentIndex = {
    ...content,
    exercisesByConcept: new Map(content.exercisesByConcept).set('vectors', eligible),
  };
  const state = emptyState();
  state.cards = [
    {
      conceptId: 'vectors',
      dimension: 'math',
      dueAt: '2026-01-13T00:00:00.000Z',
      retrievability: 0.7,
    },
  ];

  const plan = planSession(state, reviewContent, now, 60);
  expect(plan.activities.filter((activity) => activity.kind === 'review')).toHaveLength(1);
  const review = plan.activities.find((activity) => activity.kind === 'review');
  expect(review?.exerciseIds).toHaveLength(3);
  expect(new Set(review?.exerciseIds).size).toBe(3);
  for (const exerciseId of review?.exerciseIds ?? []) {
    const exercise = reviewContent.exercisesById.get(exerciseId);
    expect(exercise).toMatchObject({ concept: 'vectors', dimension: 'math' });
  }
  expect(review?.plannedMinutes).toBe(
    Math.ceil(eligible.reduce((sum, exercise) => sum + exercise.est_minutes, 0)),
  );
});

test('a practice attempt today does not hide a due review', () => {
  const state = emptyState();
  state.cards = [
    {
      conceptId: 'vectors',
      dimension: 'math',
      dueAt: '2026-01-13T00:00:00.000Z',
      retrievability: 0.7,
    },
  ];
  state.recentAttempts = [
    {
      conceptId: 'vectors',
      exerciseId: 'vectors-fixture-practice-1',
      dimension: 'math',
      correct: 1,
      itemRole: 'core',
      createdAt: now.toISOString(),
    },
  ];

  const plan = planSession(state, content, now, 60);
  expect(
    plan.activities.some(
      (activity) =>
        activity.kind === 'review' &&
        activity.exerciseIds.some(
          (exerciseId) => content.exercisesById.get(exerciseId)?.concept === 'vectors',
        ),
    ),
  ).toBe(true);
});

test('a review log today hides every due dimension for that topic', () => {
  const state = emptyState();
  state.cards = [
    {
      conceptId: 'vectors',
      dimension: 'math',
      dueAt: '2026-01-13T00:00:00.000Z',
      retrievability: 0.7,
    },
    {
      conceptId: 'vectors',
      dimension: 'conceptual',
      dueAt: '2026-01-13T00:00:00.000Z',
      retrievability: 0.7,
    },
  ];
  state.reviewedTodayConceptIds = ['vectors'];

  const plan = planSession(state, content, now, 60);
  expect(
    plan.activities.some(
      (activity) =>
        activity.kind === 'review' &&
        activity.exerciseIds.some(
          (exerciseId) => content.exercisesById.get(exerciseId)?.concept === 'vectors',
        ),
    ),
  ).toBe(false);
});

test('a large review budget fits due topics after review candidates are mixed', () => {
  const dueConcepts = [
    'vectors',
    'derivatives',
    'gradients',
    'linear-algebra',
    'switching-topic',
    'linear-models',
  ];
  const state = emptyState();
  state.cards = dueConcepts.map((conceptId) => ({
    conceptId,
    dimension: 'math',
    dueAt: '2026-01-13T00:00:00.000Z',
  }));

  const plan = planSession(state, content, now, 6000);
  const plannedConcepts = new Set(
    plan.activities
      .filter((activity) => activity.kind === 'review')
      .flatMap((activity) =>
        activity.exerciseIds.flatMap((exerciseId) => {
          const conceptId = content.exercisesById.get(exerciseId)?.concept;
          return conceptId ? [conceptId] : [];
        }),
      ),
  );
  expect(dueConcepts.filter((conceptId) => !plannedConcepts.has(conceptId))).toEqual([]);
});

test('a review combines due dimensions for one concept and alternates their exercises', () => {
  const state = emptyState();
  state.cards = [
    {
      conceptId: 'vectors',
      dimension: 'math',
      dueAt: '2026-01-13T00:00:00.000Z',
      retrievability: 0.7,
    },
    {
      conceptId: 'vectors',
      dimension: 'conceptual',
      dueAt: '2026-01-12T00:00:00.000Z',
      retrievability: 0.5,
    },
  ];

  const plan = planSession(state, content, now, 180);
  const vectorsReviews = plan.activities.filter(
    (activity) =>
      activity.kind === 'review' &&
      activity.exerciseIds.some(
        (exerciseId) => content.exercisesById.get(exerciseId)?.concept === 'vectors',
      ),
  );
  expect(vectorsReviews).toHaveLength(1);
  const review = vectorsReviews[0];
  if (!review) throw new Error('Expected one vector review activity');
  expect(review.exerciseIds.length).toBeGreaterThanOrEqual(2);
  expect(review.exerciseIds.length).toBeLessThanOrEqual(4);
  expect(new Set(review.exerciseIds).size).toBe(review.exerciseIds.length);

  const dimensions = review.exerciseIds.map((exerciseId) => {
    const exercise = content.exercisesById.get(exerciseId);
    if (!exercise) throw new Error(`Missing exercise ${exerciseId}`);
    return exercise.dimension;
  });
  expect(new Set(dimensions)).toEqual(new Set(['math', 'conceptual']));
  for (let index = 1; index < dimensions.length; index += 1) {
    expect(dimensions[index]).not.toBe(dimensions[index - 1]);
  }
  expect(review.reason.summary).toBe('Due since 12 Jan 2026 · ~50% recall.');
});

test('mixed review questions greedily alternate topic queues', () => {
  const reviews = [
    { topicId: 'a', exerciseIds: ['a1', 'a2', 'a3', 'a4'] },
    { topicId: 'b', exerciseIds: ['b1', 'b2'] },
    { topicId: 'c', exerciseIds: ['c1'] },
  ];
  const topics = new Map(
    reviews.flatMap(({ topicId, exerciseIds }) => exerciseIds.map((id) => [id, topicId])),
  );
  const ordered = interleaveReviewExercises(reviews);
  expect(ordered.map((id) => topics.get(id))).toEqual(['a', 'b', 'a', 'b', 'a', 'c', 'a']);
  expect(
    ordered.every(
      (id, index) => index === 0 || topics.get(id) !== topics.get(ordered[index - 1] ?? ''),
    ),
  ).toBe(true);
  expect(
    interleaveReviewExercises([
      { topicId: 'a', exerciseIds: ['a1'] },
      { topicId: 'b', exerciseIds: ['b1'] },
    ]),
  ).toEqual(['a1', 'b1']);
});

test('replanning does not repeat a completed mixed-review topic', () => {
  const state = emptyState();
  state.cards = [
    { conceptId: 'vectors', dimension: 'math', dueAt: '2026-01-13T00:00:00.000Z' },
    { conceptId: 'derivatives', dimension: 'math', dueAt: '2026-01-13T00:00:00.000Z' },
  ];
  const mixed: PlannedActivity = {
    kind: 'review',
    conceptId: null,
    exerciseIds: ['vectors-fixture-practice-1', 'derivatives-fixture-practice-1'],
    plannedMinutes: 10,
    status: 'completed',
    reason: {
      terms: { goal: 0, week_fit: 0, project: 0, unlock: 0, gap: 0, review: 0, cost: 0 },
      summary: '',
    },
  };
  const plan = replan(state, content, now, 60, [mixed]);
  expect(
    plan.activities.some(
      (activity) =>
        activity.kind === 'review' &&
        activity.exerciseIds.some(
          (exerciseId) => content.exercisesById.get(exerciseId)?.concept === 'vectors',
        ),
    ),
  ).toBe(false);
});

test('a concept with multiple due dimensions appears in only one review activity', () => {
  const state = {
    ...emptyState(),
    lessonRuns: [{ conceptId: 'vectors', status: 'in_progress' as const }],
    usedExerciseIds: ['vectors-fixture-final'],
  };
  state.cards = [
    {
      conceptId: 'vectors',
      dimension: 'math',
      dueAt: '2026-01-13T00:00:00.000Z',
      retrievability: 0.7,
    },
    {
      conceptId: 'derivatives',
      dimension: 'math',
      dueAt: '2026-01-13T00:00:00.000Z',
      retrievability: 0.6,
    },
    {
      conceptId: 'linear-models',
      dimension: 'math',
      dueAt: '2026-01-13T00:00:00.000Z',
      retrievability: 0.6,
    },
    {
      conceptId: 'vectors',
      dimension: 'conceptual',
      dueAt: '2026-01-13T00:00:00.000Z',
      retrievability: 0.7,
    },
  ];

  const plan = planSession(state, content, now, 240);
  const conceptAppearances = new Map<string, number>();
  const reviewActivities = plan.activities.filter((activity) => activity.kind === 'review');
  for (const activity of reviewActivities) {
    const concepts = new Set(
      activity.exerciseIds.map((exerciseId) => {
        const exercise = content.exercisesById.get(exerciseId);
        if (!exercise) throw new Error(`Missing exercise ${exerciseId}`);
        return exercise.concept;
      }),
    );
    expect(concepts.size).toBeLessThanOrEqual(3);
    for (const conceptId of concepts) {
      conceptAppearances.set(conceptId, (conceptAppearances.get(conceptId) ?? 0) + 1);
    }
  }

  for (const conceptId of ['vectors', 'derivatives', 'linear-models']) {
    expect(conceptAppearances.get(conceptId)).toBe(1);
  }
});

test('a non-due dimension attempt does not hide another due dimension', () => {
  const state = emptyState();
  state.cards = [
    {
      conceptId: 'vectors',
      dimension: 'conceptual',
      dueAt: '2026-01-13T00:00:00.000Z',
      retrievability: 0.7,
    },
  ];
  state.recentAttempts = [
    {
      conceptId: 'vectors',
      dimension: 'math',
      exerciseId: 'vectors-magnitude',
      createdAt: now.toISOString(),
      correct: 1,
      itemRole: 'review',
    },
  ];

  const plan = planSession(state, content, now, 180);
  const review = plan.activities.find((activity) => activity.kind === 'review');
  expect(review).toBeDefined();
  for (const exerciseId of review?.exerciseIds ?? []) {
    expect(content.exercisesById.get(exerciseId)?.dimension).toBe('conceptual');
  }
});

test('a due review uses fewer than three exercises when fewer are available', () => {
  const onlyExercise = required(
    (content.exercisesByConcept.get('vectors') ?? []).find(
      (exercise) =>
        exercise.dimension === 'math' &&
        ['review', 'core', 'practice', 'transfer', 'basics'].includes(exercise.role) &&
        !isTemplate(exercise),
    ),
    'eligible vector math review exercise',
  );
  const reviewContent: ContentIndex = {
    ...content,
    exercisesByConcept: new Map(content.exercisesByConcept).set('vectors', [onlyExercise]),
  };
  const state = emptyState();
  state.cards = [
    {
      conceptId: 'vectors',
      dimension: 'math',
      dueAt: '2026-01-13T00:00:00.000Z',
      retrievability: 0.7,
    },
  ];

  const review = planSession(state, reviewContent, now, 60).activities.find(
    (activity) => activity.kind === 'review',
  );
  expect(review?.exerciseIds).toEqual([onlyExercise.id]);
});

test('Time budget is respected', () => {
  const plan = planSession(emptyState(), content, now, 17);
  expect(
    plan.activities.reduce((sum, activity) => sum + activity.plannedMinutes, 0),
  ).toBeLessThanOrEqual(17);
});

test('resumed lessons and due reviews stay within the activity limit', () => {
  const eligibleReviewExercise = (conceptId: string, excludedId?: string) =>
    (courseContent.exercisesByConcept.get(conceptId) ?? []).find(
      (exercise) =>
        exercise.id !== excludedId &&
        !isTemplate(exercise) &&
        !exercise.lesson_only &&
        ['review', 'core', 'practice', 'transfer', 'basics'].includes(exercise.role),
    );
  const course = courseContent.courses.find((candidate) => {
    const lessonConcepts = new Set(
      candidate.units
        .flatMap((unit) => unit.concepts)
        .filter((conceptId) => {
          const lesson = courseContent.lessonsByConcept.get(conceptId);
          return (
            (lesson?.knowledge_points.length ?? 0) > 0 &&
            eligibleReviewExercise(conceptId, lesson?.final) !== undefined
          );
        }),
    );
    return lessonConcepts.size >= 2;
  });
  if (!course) throw new Error('Expected a course with two lesson concepts');
  const resumedConceptIds = [...new Set(course.units.flatMap((unit) => unit.concepts))]
    .filter((conceptId) => {
      const lesson = courseContent.lessonsByConcept.get(conceptId);
      return (
        (lesson?.knowledge_points.length ?? 0) > 0 &&
        eligibleReviewExercise(conceptId, lesson?.final) !== undefined
      );
    })
    .slice(0, 2);
  expect(resumedConceptIds).toHaveLength(2);
  const dueConceptIds = [
    ...new Set([
      ...resumedConceptIds,
      ...courseContent.concepts
        .filter(
          (concept) =>
            concept.status !== 'stub' && eligibleReviewExercise(concept.id) !== undefined,
        )
        .map((concept) => concept.id),
    ]),
  ].slice(0, 12);
  const state = studyState([course.id], courseContent);
  const masteryByKey = new Map(
    state.mastery.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
  );
  for (const conceptId of dueConceptIds) {
    const concept = required(courseContent.conceptsById.get(conceptId), conceptId);
    for (const dimension of concept.dimensions) {
      masteryByKey.set(masteryKey(conceptId, dimension), {
        ...initialMastery(conceptId, dimension),
        state: 'retained',
      });
    }
  }
  state.mastery = [...masteryByKey.values()];
  state.lessonRuns = resumedConceptIds.map((conceptId) => ({
    conceptId,
    status: 'in_progress' as const,
  }));
  state.usedExerciseIds = resumedConceptIds.flatMap((conceptId) => {
    const finalId = courseContent.lessonsByConcept.get(conceptId)?.final;
    return finalId ? [finalId] : [];
  });
  state.cards = dueConceptIds.flatMap((conceptId) => {
    const exercise = eligibleReviewExercise(conceptId);
    return exercise
      ? [
          {
            conceptId,
            dimension: exercise.dimension,
            dueAt: '2026-01-13T00:00:00.000Z',
            retrievability: 0.6,
          },
        ]
      : [];
  });

  const plan = planSession(state, courseContent, now, 600);

  expect(
    plan.activities
      .filter((activity) => activity.kind === 'learn')
      .map((activity) => activity.conceptId),
  ).toEqual(expect.arrayContaining(resumedConceptIds));
  expect(
    plan.activities.length,
    JSON.stringify(
      plan.activities.map((activity) => `${activity.kind}:${activity.conceptId ?? ''}`),
    ),
  ).toBeLessThanOrEqual(SCHEDULER_CONFIG.weekday.maxActivities);
});

test('Interrupted session resumes its in-progress activity during replanning', () => {
  const inProgress = {
    kind: 'learn' as const,
    conceptId: 'vectors',
    exerciseIds: ['vectors-magnitude'],
    plannedMinutes: 15,
    status: 'in_progress' as const,
    reason: {
      terms: { goal: 3, week_fit: 3, project: 0, unlock: 1, gap: 0, review: 0, cost: -1 },
      summary: 'Resume vectors.',
    },
  };
  const state = {
    ...emptyState(),
    lessonRuns: [{ conceptId: 'vectors', status: 'in_progress' as const }],
  };
  const plan = replan(state, content, now, 20, [inProgress]);
  expect(plan.activities[0]).toMatchObject({ status: 'in_progress', conceptId: 'vectors' });
  expect(
    plan.activities.filter(
      (activity) => activity.kind === 'learn' && activity.conceptId === 'vectors',
    ),
  ).toHaveLength(1);
});

test('Replanning does not regenerate a completed learn activity', () => {
  const completed = {
    kind: 'learn' as const,
    conceptId: 'vectors',
    exerciseIds: [],
    plannedMinutes: 15,
    status: 'completed' as const,
    reason: {
      terms: { goal: 3, week_fit: 3, project: 0, unlock: 1, gap: 0, review: 0, cost: -1 },
      summary: 'Vectors completed.',
    },
  };
  const plan = replan(emptyState(), content, now, 20, [completed]);

  expect(
    plan.activities.filter(
      (activity) => activity.kind === 'learn' && activity.conceptId === 'vectors',
    ),
  ).toHaveLength(0);
});

test('Every mastery state change has an evidence event', () => {
  const model = new DefaultMasteryModel();
  const result = model.applyAttempt(
    undefined,
    {
      conceptId: 'vectors',
      dimension: 'math',
      attemptId: 'attempt-1',
      exerciseId: 'vectors-magnitude',
      correct: 0,
      hintsUsed: 0,
      attemptNo: 1,
      mode: 'practice',
      itemRole: 'core',
      gradedBy: 'deterministic',
    },
    now,
  );
  expect(result.event).toMatchObject({
    fromState: 'not_assessed',
    toState: 'introduced',
    attemptId: 'attempt-1',
    rule: 'attempt_introduced',
  });
});

test('Exercise assignment avoids items seen within seven days', () => {
  const state = emptyState();
  state.recentAttempts = [
    {
      conceptId: 'vectors',
      exerciseId: 'vectors-magnitude',
      correct: 1,
      itemRole: 'core',
      createdAt: '2026-01-13T12:00:00.000Z',
    },
  ];
  const plan = planSession(state, content, now, 60);
  const vectors = plan.activities.find(
    (activity) => activity.kind === 'learn' && activity.conceptId === 'vectors',
  );
  expect(vectors?.exerciseIds).not.toContain('vectors-magnitude');
});

test('planner schedules optional paper and project after reviews and lessons', () => {
  const plan = planSession(emptyState(), content, now, 200);
  const paperIndex = plan.activities.findIndex((activity) => activity.kind === 'paper');
  const labIndex = plan.activities.findIndex((activity) => activity.kind === 'lab');
  const requiredIndexes = plan.activities.flatMap((activity, index) =>
    activity.kind === 'review' || activity.kind === 'learn' ? [index] : [],
  );

  expect(paperIndex).toBeGreaterThan(Math.max(-1, ...requiredIndexes));
  expect(labIndex).toBeGreaterThan(paperIndex);
  expect(
    plan.activities.reduce((sum, activity) => sum + activity.plannedMinutes, 0),
  ).toBeLessThanOrEqual(200);
});

test('scheduler skips an unavailable current project and falls back to the latest available project', () => {
  const plan = planSession(emptyState(), content, now, 300);
  expect(plan.activities.find((activity) => activity.kind === 'lab')?.projectId).toBe(
    'linreg-numpy',
  );
});

test('scheduler omits labs when no available project has verifier tests', () => {
  const projects = content.projects.map((project) =>
    project.id === 'linreg-numpy' ? { ...project, tests: [] } : project,
  );
  const testlessContent: ContentIndex = {
    ...content,
    projects,
    projectsById: new Map(projects.map((project) => [project.id, project])),
  };
  const plan = planSession(emptyState(), testlessContent, now, 300);
  expect(plan.activities.some((activity) => activity.kind === 'lab')).toBe(false);
});

test('a completed project does not add practice filler', () => {
  const state = emptyState();
  state.currentProjectId = 'linreg-numpy';
  state.projectProgress = [{ projectId: 'linreg-numpy', status: 'completed' }];
  const plan = planSession(state, content, now, 300);
  expect(plan.activities.some((activity) => activity.kind === 'lab')).toBe(false);
  expect(plan.activities.some((activity) => activity.kind === 'practice')).toBe(false);
  expect(plan.activities.some((activity) => activity.kind === 'remediate')).toBe(false);
});

test('fresh learners start in unit 1', () => {
  expect(currentLearnerUnit(emptyState(), courseContent)).toBe(1);
});

test('paper read state does not change the current learner unit', () => {
  const firstUnit = content.coursesById.get('fixture-course')?.units[0];
  if (!firstUnit?.papers?.length) throw new Error('Expected first-unit paper fixture');
  const unreadState = emptyState();
  const readState = {
    ...unreadState,
    completedPaperIds: firstUnit.papers,
  };

  expect(currentLearnerUnit(readState, content)).toBe(currentLearnerUnit(unreadState, content));
});

test('an uncompleted trailing stub does not hold back the current learner unit', () => {
  const sourceStub = courseContent.conceptsById.get('experimental-design');
  const defaultCourse = courseContent.coursesById.get('ml-foundations');
  if (!defaultCourse || !sourceStub) throw new Error('Expected course and stub fixture');

  const stubId = 'unit-one-fixture-stub';
  const stub = { ...sourceStub, id: stubId, prereqs: [] };
  const courseWithStub = {
    ...defaultCourse,
    units: defaultCourse.units.map((unit, index) =>
      index === 0 ? { ...unit, concepts: [...unit.concepts, stubId] } : unit,
    ),
  };
  const courses = courseContent.courses.map((course) =>
    course.id === courseWithStub.id ? courseWithStub : course,
  );
  const contentWithStub: ContentIndex = {
    ...courseContent,
    courses,
    coursesById: new Map(courses.map((course) => [course.id, course])),
    concepts: [...courseContent.concepts, stub],
    conceptsById: new Map(courseContent.conceptsById).set(stubId, stub),
  };
  const state = emptyState();
  state.lessonRuns = courseWithStub.units
    .flatMap((unit) => unit.concepts)
    .filter((id) => id !== stubId && contentWithStub.conceptsById.get(id)?.status !== 'stub')
    .map((conceptId) => ({ conceptId, status: 'completed' as const }));
  expect(currentLearnerUnit(state, contentWithStub)).toBe(courseWithStub.units.length);
});

test('an incomplete first-unit concept remains current when later topics are complete', () => {
  const course = required(courseContent.coursesById.get('ml-foundations'), 'default course');
  const conceptIds = course.units.flatMap((unit) => unit.concepts);
  const state = emptyState();
  state.lessonRuns = conceptIds
    .filter((conceptId) => conceptId !== 'what-is-ml')
    .map((conceptId) => ({ conceptId, status: 'completed' as const }));
  expect(currentLearnerUnit(state, courseContent)).toBe(1);
});

test('all completed course concepts put the learner in the last unit', () => {
  const course = required(courseContent.coursesById.get('ml-foundations'), 'default course');
  const state = emptyState();
  state.lessonRuns = course.units.flatMap((unit) =>
    unit.concepts.map((conceptId) => ({ conceptId, status: 'completed' as const })),
  );
  expect(currentLearnerUnit(state, courseContent)).toBe(course.units.length);
});

test('placement-inferred mastery counts as met for the current unit', () => {
  const firstUnit = required(
    courseContent.coursesById.get('ml-foundations')?.units[0],
    'first default unit',
  );
  const state = emptyState();
  state.lessonRuns = firstUnit.concepts
    .filter((id) => id !== 'what-is-ml')
    .map((conceptId) => ({ conceptId, status: 'completed' as const }));
  state.mastery = [{ ...initialMastery('what-is-ml', 'conceptual'), inferred: true }];
  expect(currentLearnerUnit(state, courseContent)).toBe(2);
});

test('current unit is computed per active course, with null and unknown falling back to default', () => {
  const fixtureCourse = required(content.coursesById.get('fixture-course'), 'fixture course');
  const firstUnitRuns =
    fixtureCourse.units[0]?.concepts.map((conceptId) => ({
      conceptId,
      status: 'completed' as const,
    })) ?? [];
  const state = { ...emptyState(), lessonRuns: firstUnitRuns };
  expect(currentLearnerUnit(state, content)).toBe(2);
  expect(
    currentLearnerUnit({ ...state, activeCourseId: 'fixture-switching-course' }, content),
  ).toBe(1);
  expect(currentLearnerUnit({ ...state, activeCourseId: 'missing-course' }, content)).toBe(2);
  expect(currentLearnerUnit(state, content)).toBe(2);
});

test('a new concept only in another course is not offered', () => {
  const plan = planSession(
    {
      ...emptyState(),
      activeCourseId: 'fixture-switching-course',
      studyCourseIds: ['fixture-switching-course'],
    },
    content,
    now,
    60,
  );
  expect(plan.activities.some((activity) => activity.conceptId === 'derivatives')).toBe(false);
});

test('an unmet external hard prerequisite is offered as a foundation', () => {
  const fixtureCourse = required(content.coursesById.get('fixture-course'), 'fixture course');
  const courseWithoutVectors = {
    ...fixtureCourse,
    units: fixtureCourse.units.map((unit) => ({
      ...unit,
      concepts: unit.concepts.filter((conceptId) => conceptId !== 'vectors'),
    })),
  };
  const courses = content.courses.map((course) =>
    course.id === courseWithoutVectors.id ? courseWithoutVectors : course,
  );
  const foundationContent: ContentIndex = {
    ...content,
    courses,
    coursesById: new Map(courses.map((course) => [course.id, course])),
  };
  const plan = planSession(emptyState(), foundationContent, now, 60);
  expect(
    plan.activities.some(
      (activity) => activity.kind === 'learn' && activity.conceptId === 'vectors',
    ),
  ).toBe(true);
});

test.each(['in_progress', 'quiz'] as const)(
  'a %s lesson in a study course resumes outside the viewed course',
  (status) => {
    const state = {
      ...emptyState(),
      activeCourseId: 'fixture-switching-course',
      studyCourseIds: ['fixture-course'],
      lessonRuns: [
        { conceptId: 'vectors', status: 'completed' as const },
        { conceptId: 'derivatives', status },
      ],
    };
    const plan = planSession(state, content, now, 60);
    expect(
      plan.activities.some(
        (activity) => activity.kind === 'learn' && activity.conceptId === 'derivatives',
      ),
    ).toBe(true);
  },
);

test('an unfinished lesson from a paused course is not resumed', () => {
  const state = {
    ...emptyState(),
    activeCourseId: 'fixture-switching-course',
    studyCourseIds: ['fixture-switching-course'],
    lessonRuns: [
      { conceptId: 'vectors', status: 'completed' as const },
      { conceptId: 'derivatives', status: 'in_progress' as const },
    ],
  };
  const plan = planSession(state, content, now, 60);

  expect(
    plan.activities.some(
      (activity) => activity.kind === 'learn' && activity.conceptId === 'derivatives',
    ),
  ).toBe(false);
  const resumed = planSession({ ...state, studyCourseIds: ['fixture-course'] }, content, now, 60);
  expect(
    resumed.activities.some(
      (activity) => activity.kind === 'learn' && activity.conceptId === 'derivatives',
    ),
  ).toBe(true);
});

test('reviews outside the active course remain planned', () => {
  const state = {
    ...emptyState(),
    activeCourseId: 'fixture-switching-course',
    studyCourseIds: ['fixture-switching-course'],
    mastery: [{ ...initialMastery('derivatives', 'math'), state: 'independent' as const }],
    cards: [{ conceptId: 'derivatives', dimension: 'math' as const, dueAt: now.toISOString() }],
  };
  const plan = planSession(state, content, now, 60);
  expect(
    plan.activities.some(
      (activity) => activity.kind === 'review' && activity.conceptId === 'derivatives',
    ),
  ).toBe(true);
});

test('each study course receives a new lesson when the plan has room for two concepts', () => {
  const courseIds = ['fixture-course', 'fixture-switching-course'];
  const schedulerContent = schedulerContentWithTopics({
    'fixture-course': ['vectors'],
    'fixture-switching-course': ['supervised-learning'],
  });
  const plan = planSession(studyState(courseIds, schedulerContent), schedulerContent, now, 200);
  const learnActivities = plan.activities.filter(
    (activity) => activity.kind === 'learn' && activity.conceptId,
  );
  const scheduledCourseIds = new Set(
    learnActivities.flatMap((activity) => {
      const courseId = studyCourseOwner(activity.conceptId ?? '', courseIds, schedulerContent);
      return courseId ? [courseId] : [];
    }),
  );

  expect(scheduledCourseIds).toEqual(new Set(courseIds));
});

test('subject balancing gives the next concept to the subject with less recent learning', () => {
  const courseIds = ['fixture-course', 'fixture-switching-course'];
  const topicsContent = schedulerContentWithTopics({
    'fixture-course': ['vectors'],
    'fixture-switching-course': ['supervised-learning'],
  });
  const subjectContent = schedulerContentWithSubjects(
    topicsContent,
    [
      { id: 'math', title: 'Math' },
      { id: 'ai', title: 'AI' },
    ],
    { 'fixture-course': 'math', 'fixture-switching-course': 'ai' },
    courseIds,
  );
  const concepts = subjectContent.concepts.map((concept) =>
    ['vectors', 'supervised-learning'].includes(concept.id) ? { ...concept, prereqs: [] } : concept,
  );
  const schedulerContent = {
    ...subjectContent,
    concepts,
    conceptsById: new Map(concepts.map((concept) => [concept.id, concept])),
  };
  const firstCourse = required(
    schedulerContent.coursesById.get(courseIds[0] ?? ''),
    'first study course',
  );
  const firstCourseConcepts = new Set([
    ...firstCourse.units.flatMap((unit) => unit.concepts),
    ...courseFoundationIds(schedulerContent, firstCourse.id),
  ]);
  const state = {
    ...studyState(courseIds, schedulerContent),
    recentLearnMinutesByConcept: Object.fromEntries(
      [...firstCourseConcepts].map((conceptId) => [conceptId, 60]),
    ),
  };
  const firstLearn = planSession(state, schedulerContent, now, 200).activities.find(
    (activity) => activity.kind === 'learn',
  );

  expect(firstLearn?.conceptId).toBeDefined();
  expect(studyCourseOwner(firstLearn?.conceptId ?? '', courseIds, schedulerContent)).toBe(
    'fixture-switching-course',
  );
});

test('subject balancing splits two new topics between three AI courses and History', () => {
  const courseIds = ['ml-foundations', 'deep-learning', 'transformers-llms', 'maths-for-ml'];
  const topicsByCourse = Object.fromEntries(
    courseIds.map((courseId) => {
      const course = required(courseContent.coursesById.get(courseId), courseId);
      const topic = course.units.flatMap((unit) => unit.concepts)[0];
      if (!topic) throw new Error(`Missing topic in ${courseId}`);
      return [courseId, [topic]];
    }),
  );
  const topicsContent = schedulerContentWithTopics(topicsByCourse, courseContent);
  const concepts = topicsContent.concepts.map((concept) =>
    courseIds.some((courseId) => topicsByCourse[courseId]?.includes(concept.id))
      ? { ...concept, prereqs: [] }
      : concept,
  );
  const schedulerContent = schedulerContentWithSubjects(
    {
      ...topicsContent,
      concepts,
      conceptsById: new Map(concepts.map((concept) => [concept.id, concept])),
    },
    [
      { id: 'ai', title: 'AI' },
      { id: 'history', title: 'History' },
    ],
    {
      'ml-foundations': 'ai',
      'deep-learning': 'ai',
      'transformers-llms': 'ai',
      'maths-for-ml': 'history',
    },
    courseIds,
  );
  const plan = planSession(studyState(courseIds, schedulerContent), schedulerContent, now, 200);
  const learned = plan.activities.filter(
    (activity) => activity.kind === 'learn' && activity.conceptId,
  );

  expect(learned).toHaveLength(2);
  expect(learned.map((activity) => activity.conceptId)).toContain(
    topicsByCourse['ml-foundations']?.[0],
  );
  expect(learned.map((activity) => activity.conceptId)).toContain(
    topicsByCourse['maths-for-ml']?.[0],
  );
});

test('a single subject keeps the same plan with or without subject metadata', () => {
  const topicsContent = schedulerContentWithTopics({ 'fixture-course': ['vectors'] });
  const subjectContent = schedulerContentWithSubjects(
    topicsContent,
    [{ id: 'math', title: 'Math' }],
    { 'fixture-course': 'math' },
    ['fixture-course'],
  );
  const state = studyState(['fixture-course'], topicsContent);

  expect(planSession(state, subjectContent, now, 60)).toEqual(
    planSession(state, topicsContent, now, 60),
  );
});

test('unknown focus behaves like All', () => {
  const courseIds = ['fixture-course', 'fixture-switching-course'];
  const topicsContent = schedulerContentWithTopics({
    'fixture-course': ['vectors'],
    'fixture-switching-course': ['supervised-learning'],
  });
  const schedulerContent = schedulerContentWithSubjects(
    topicsContent,
    [
      { id: 'math', title: 'Math' },
      { id: 'ai', title: 'AI' },
    ],
    { 'fixture-course': 'math', 'fixture-switching-course': 'ai' },
    courseIds,
  );
  const state = studyState(courseIds, schedulerContent);

  expect(planSession({ ...state, focusSubjectId: 'unknown' }, schedulerContent, now, 100)).toEqual(
    planSession(state, schedulerContent, now, 100),
  );
  const singleSubjectState = { ...state, studyCourseIds: ['fixture-course'] };
  expect(
    planSession({ ...singleSubjectState, focusSubjectId: 'ai' }, schedulerContent, now, 100),
  ).toEqual(planSession(singleSubjectState, schedulerContent, now, 100));
});

test('ML Foundations gets new topics before Transformers in the AI course sequence', () => {
  const courseIds = ['ml-foundations', 'deep-learning', 'transformers-llms'];
  const topicsByCourse = Object.fromEntries(
    courseIds.map((courseId) => {
      const course = required(courseContent.coursesById.get(courseId), courseId);
      const topic = course.units.flatMap((unit) => unit.concepts)[0];
      if (!topic) throw new Error(`Missing topic in ${courseId}`);
      return [courseId, [topic]];
    }),
  );
  const schedulerContent = schedulerContentWithTopics(topicsByCourse, courseContent);
  const plan = planSession(studyState(courseIds, schedulerContent), schedulerContent, now, 200);
  const learned = plan.activities
    .filter((activity) => activity.kind === 'learn')
    .map((activity) => activity.conceptId);
  const transformersTopic = topicsByCourse['transformers-llms']?.[0];

  expect(learned).toContain(topicsByCourse['ml-foundations']?.[0]);
  expect(learned).not.toContain(transformersTopic);
});

test('a later AI course gets new learning when an earlier course is blocked on Maths', () => {
  const courseIds = ['ml-foundations', 'deep-learning'];
  const topicsByCourse = Object.fromEntries(
    courseIds.map((courseId) => {
      const course = required(courseContent.coursesById.get(courseId), courseId);
      const topic = course.units.flatMap((unit) => unit.concepts)[0];
      if (!topic) throw new Error(`Missing topic in ${courseId}`);
      return [courseId, [topic]];
    }),
  );
  const topicsContent = schedulerContentWithTopics(topicsByCourse, courseContent);
  const blockedId = topicsByCourse['ml-foundations']?.[0];
  const laterId = topicsByCourse['deep-learning']?.[0];
  if (!blockedId || !laterId) throw new Error('Missing AI sequence topics');
  const concepts = topicsContent.concepts.map((concept) =>
    concept.id === blockedId
      ? { ...concept, prereqs: [{ id: 'maths-only-prerequisite', strength: 'hard' as const }] }
      : concept,
  );
  const schedulerContent = {
    ...topicsContent,
    concepts,
    conceptsById: new Map(concepts.map((concept) => [concept.id, concept])),
  };
  const plan = planSession(studyState(courseIds, schedulerContent), schedulerContent, now, 200);
  const learned = plan.activities
    .filter((activity) => activity.kind === 'learn')
    .map((activity) => activity.conceptId);

  expect(learned).not.toContain(blockedId);
  expect(learned).toContain(laterId);
});

test('AI focus allows Maths Foundations but excludes other Maths learning and reviews', () => {
  const aiCourseId = 'ml-foundations';
  const mathsCourseId = 'maths-for-ml';
  const topicsContent = schedulerContentWithTopics(
    {
      [aiCourseId]: ['vectors'],
      [mathsCourseId]: ['derivatives', 'probability-basics'],
    },
    courseContent,
  );
  const concepts = topicsContent.concepts.map((concept) => {
    if (concept.id === 'vectors') {
      return { ...concept, prereqs: [{ id: 'derivatives', strength: 'hard' as const }] };
    }
    if (concept.id === 'derivatives') return { ...concept, prereqs: [] };
    return concept;
  });
  const schedulerContent = {
    ...topicsContent,
    concepts,
    conceptsById: new Map(concepts.map((concept) => [concept.id, concept])),
  };
  const state = studyState([aiCourseId, mathsCourseId], schedulerContent);
  const probability = required(
    schedulerContent.conceptsById.get('probability-basics'),
    'probability topic',
  );
  const dimension = probability.dimensions[0];
  if (!dimension) throw new Error('Missing probability dimension');
  state.focusSubjectId = 'ai';
  state.mastery.push({ ...initialMastery(probability.id, dimension), state: 'independent' });
  state.cards = [{ conceptId: probability.id, dimension, dueAt: now.toISOString() }];
  const plan = planSession(state, schedulerContent, now, 200);
  const learnConcepts = plan.activities
    .filter((activity) => activity.kind === 'learn')
    .map((activity) => activity.conceptId);

  expect(learnConcepts).toContain('derivatives');
  expect(learnConcepts).not.toContain('probability-basics');
  expect(
    plan.activities.some(
      (activity) => activity.kind === 'review' && activity.conceptId === 'probability-basics',
    ),
  ).toBe(false);
});

test('a concept shared by two study courses is scheduled only once', () => {
  const courseIds = ['fixture-course', 'fixture-switching-course'];
  const schedulerContent = schedulerContentWithTopics({
    'fixture-course': ['linear-models'],
    'fixture-switching-course': ['linear-models'],
  });
  const state = studyState(courseIds, schedulerContent);
  const plan = planSession(state, schedulerContent, now, 180);

  expect(
    plan.activities.filter(
      (activity) => activity.kind === 'learn' && activity.conceptId === 'linear-models',
    ),
  ).toHaveLength(1);
});

test('due cards from outside the selected course remain reviews', () => {
  const concept = required(courseContent.conceptsById.get('perceptron'), 'perceptron');
  const state = {
    ...studyState(['maths-for-ml'], courseContent),
    cards: [
      {
        conceptId: concept.id,
        dimension: concept.dimensions[0] ?? 'conceptual',
        dueAt: now.toISOString(),
      },
    ],
  };
  const plan = planSession(state, courseContent, now, 120);

  expect(
    plan.activities.some(
      (activity) => activity.kind === 'learn' && activity.conceptId === concept.id,
    ),
  ).toBe(false);
  expect(
    plan.activities.some(
      (activity) => activity.kind === 'review' && activity.conceptId === concept.id,
    ),
  ).toBe(true);
});

test('an empty study set plans due reviews only', () => {
  const state = {
    ...emptyState(),
    studyCourseIds: [],
    cards: [{ conceptId: 'vectors', dimension: 'math' as const, dueAt: now.toISOString() }],
  };

  const plan = planSession(state, content, now, 60);

  expect(plan.activities.length).toBeGreaterThan(0);
  expect(plan.activities.every((activity) => activity.kind === 'review')).toBe(true);
});

test.each(['weekday', 'saturday', 'sunday'] as const)(
  'planner uses progress for the next unit paper on %s',
  (kind) => {
    const fixtureCourse = required(content.coursesById.get('fixture-course'), 'fixture course');
    const lessonRuns = (fixtureCourse.units[0]?.concepts ?? []).map((conceptId) => ({
      conceptId,
      status: 'completed' as const,
    }));
    for (const startDate of ['2000-01-01T00:00:00.000Z', '2026-01-15T00:00:00.000Z']) {
      const state = { ...emptyState(), startDate, lessonRuns };
      const plan = planSession(state, content, now, 200, kind);
      const paper = plan.activities.find((activity) => activity.kind === 'paper');
      expect(paper?.reason.summary).toBe('Optional paper for Optimization.');
    }
  },
);

test('planner caps optional paper time and uses the remaining time for a project', () => {
  const state = emptyState();
  const plan = planSession(state, content, now, 200);
  const paper = plan.activities.find((activity) => activity.kind === 'paper');
  expect(paper?.plannedMinutes).toBe(90);
  expect(paper?.reason.summary).toBe('Optional paper for ML fundamentals.');
  expect(
    plan.activities.find((activity) => activity.kind === 'lab')?.plannedMinutes,
  ).toBeGreaterThan(0);
});

test('planner omits paper reading when all current-unit papers are completed', () => {
  const papers = content.coursesById.get('fixture-course')?.units[0]?.papers ?? [];
  const state = {
    ...emptyState(),
    completedPaperIds: papers,
  };
  const plan = planSession(state, content, now, 200);
  expect(plan.activities.some((activity) => activity.kind === 'paper')).toBe(false);
});

test('planner omits paper reading when less than 30 minutes remain', () => {
  const state = emptyState();
  const plan = planSession(state, content, now, 35);
  expect(plan.activities.some((activity) => activity.kind === 'paper')).toBe(false);
});

test('due reviews use at most 30% of a normal budget', () => {
  const budget = 60;
  const state = emptyState();
  state.cards = ['vectors', 'derivatives', 'linear-models'].map((conceptId) => ({
    conceptId,
    dimension: 'math',
    dueAt: now.toISOString(),
  }));
  const plan = planSession(state, content, now, budget);
  const reviewMinutes = plan.activities
    .filter((activity) => activity.kind === 'review')
    .reduce((sum, activity) => sum + activity.plannedMinutes, 0);

  expect(reviewMinutes).toBeLessThanOrEqual(Math.floor(budget * 0.3));
});

test('planner schedules one due review when the budget is 10 minutes', () => {
  const state = emptyState();
  state.cards = [
    {
      conceptId: 'vectors',
      dimension: 'math',
      dueAt: now.toISOString(),
    },
  ];

  const plan = planSession(state, content, now, 10);

  expect(plan.activities.filter((activity) => activity.kind === 'review')).toHaveLength(1);
});
