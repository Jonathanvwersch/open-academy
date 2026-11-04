import { beforeAll, expect, test } from 'vitest';
import { loadContent } from '../src/server/content/load.js';
import type { ContentIndex } from '../src/server/content/types.js';
import { deriveLearningDebt } from '../src/server/learning/debt.js';
import {
  createDiagnosticState,
  diagnosticComplete,
  markDiagnosticUnassessed,
  nextDiagnosticExercise,
  recordDiagnosticAnswer,
} from '../src/server/learning/diagnostic.js';
import { mapReviewRating, newReviewCard, scheduleReview } from '../src/server/learning/fsrs.js';
import {
  calculateCredit,
  DefaultMasteryModel,
  inferPrerequisite,
  recordLessonViewed,
} from '../src/server/learning/mastery.js';
import type { SchedulerState } from '../src/server/learning/scheduler.js';
import { planSession, replan } from '../src/server/learning/scheduler.js';
import { initialMastery } from '../src/server/learning/types.js';

const now = new Date('2026-01-14T12:00:00.000Z');
let content: ContentIndex;

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Missing fixture ${label}`);
  }
  return value;
}

beforeAll(async () => {
  content = await loadContent('tests/fixtures/content');
});

function emptyState(): SchedulerState {
  return {
    mastery: [],
    cards: [],
    recentAttempts: [],
    remediationFlags: [],
    projectProgress: [],
    startDate: '2026-01-05T00:00:00.000Z',
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
  expect(first.mastery.state).toBe('introduced');
  expect(first.event?.rule).toBe('attempt_introduced');
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

test('diagnostic success is provisional and hard prerequisites are inferred', () => {
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
  expect(inferPrerequisite(undefined, 'vectors', 'conceptual', now).mastery.inferred).toBe(true);
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
  const result = scheduleReview(card, now, 'good', false);
  expect(result.card.reps).toBeGreaterThan(0);
  expect(result.card.due.getTime()).toBeGreaterThan(now.getTime());
});

test('diagnostic ladders interleave domains and move up or down one rung', () => {
  const state = createDiagnosticState(content);
  const math = required(nextDiagnosticExercise(state, content), 'math diagnostic exercise');
  expect(math.id).toBe('dx-derivatives');
  const first = recordDiagnosticAnswer(state, math, true, content, now);
  expect(first.state.domains.math?.position).toBe(2);
  expect(first.inferredPrerequisiteIds).toEqual(['vectors']);
  const next = required(nextDiagnosticExercise(first.state, content), 'next diagnostic exercise');
  expect(next.id).toBe('dx-loss-functions');
  const second = recordDiagnosticAnswer(first.state, next, false, content, now);
  expect(second.state.domains.ml?.position).toBe(0);
  const skipped = markDiagnosticUnassessed(second.state, 'math', now);
  expect(skipped.domains.math?.status).toBe('unassessed');
  expect(diagnosticComplete(skipped)).toBe(false);
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

test('Repeated failure triggers remediation targeting the weakest prerequisite', () => {
  const state = emptyState();
  state.remediationFlags = [{ conceptId: 'gradient-descent', targetPrereqId: 'gradients' }];
  state.mastery = [
    { ...initialMastery('gradients', 'math'), state: 'introduced' },
    { ...initialMastery('loss-functions', 'math'), state: 'assisted' },
  ];
  const plan = planSession(state, content, now, 60);
  expect(
    plan.activities.some(
      (activity) => activity.kind === 'remediate' && activity.conceptId === 'gradients',
    ),
  ).toBe(true);
});

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
  expect(
    planSession(state, content, now, 60).activities.some((activity) => activity.kind === 'review'),
  ).toBe(true);
});

test('Project prerequisites receive a priority term', () => {
  const state = emptyState();
  const vectors = required(content.conceptsById.get('vectors'), 'vectors concept');
  state.mastery = vectors.dimensions.map((dimension) => ({
    ...initialMastery('vectors', dimension),
    state: 'assisted',
  }));
  const plan = planSession(state, content, new Date('2026-01-06T12:00:00.000Z'), 60);
  const prerequisite = plan.activities.find((activity) => activity.conceptId === 'linear-models');
  expect(prerequisite?.reason.terms.project).toBe(3);
});

test('Time budget is respected', () => {
  const plan = planSession(emptyState(), content, now, 17);
  expect(
    plan.activities.reduce((sum, activity) => sum + activity.plannedMinutes, 0),
  ).toBeLessThanOrEqual(17);
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
  const plan = replan(emptyState(), content, now, 20, [inProgress]);
  expect(plan.activities[0]).toMatchObject({ status: 'in_progress', conceptId: 'vectors' });
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
