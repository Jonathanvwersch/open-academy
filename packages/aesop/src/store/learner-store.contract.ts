import { Rating } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import type { Dimension } from '../course/schemas.js';
import { newReviewCard, scheduleReview } from '../memory/fsrs.js';
import { countHintsSincePreviousAttempt } from '../memory/hints.js';
import { initialMastery, type MasteryRecord } from '../memory/types.js';
import { activeSessionForDate } from '../planner/session-state.js';
import type { QuizExercise } from '../quizzes/mixed-quiz.js';
import type { Attempt, CoreStore, Enrollment, NewRow, XpEvent } from './core-store.js';
import type { CourseStore } from './course-store.js';
import type { TimedQuizItem, TimedQuizRun } from './flow-store.js';
import type { NewReviewCard } from './learner-store.js';
import type { LessonProblem, LessonQuizItem, LessonRun, RemediationFlag } from './lesson-store.js';
import type { DiagnosticRun, PlacementGrant } from './placement-review-store.js';
import type { Activity, Session, SessionStore } from './session-store.js';

type StoreFixture = {
  store: CourseStore;
  learnerId: string;
  otherLearnerId: string;
  activityId: string;
  addOpenFlag(conceptId: string, targetPrereqId: string | null): Promise<void>;
  resolveOpenFlag(id: string): Promise<void>;
};

const date = new Date('2026-01-17T12:00:00.000Z');
const later = new Date('2026-01-18T12:00:00.000Z');
const exerciseId = 'vectors-q1';

function timedQuizRow(): NewRow<TimedQuizRun> {
  return {
    activityId: null,
    retakeOf: null,
    seed: 1,
    difficulty: 2,
    plannedMinutes: 12,
    startedAt: date,
    deadline: later,
    finalizedAt: null,
    score: null,
    xpAwarded: null,
  };
}

function timedQuizItem(
  position: number,
  patch: Partial<Omit<TimedQuizItem, 'runId' | 'position'>> = {},
): Omit<TimedQuizItem, 'runId'> {
  return {
    position,
    conceptId: 'vectors',
    question: { key: exerciseId, seed: 1, exercise: { id: exerciseId } as QuizExercise },
    reserve: null,
    answeredAt: null,
    latencyMs: null,
    submission: null,
    correct: null,
    followUp: false,
    followUpActivityId: null,
    ...patch,
  };
}

function attempt(n: number, overrides: Partial<Attempt> = {}): Attempt {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    sessionId: null,
    activityId: null,
    exerciseId,
    exerciseVersion: '1',
    conceptId: 'vectors',
    dimension: 'math',
    mode: 'practice',
    answer: { seed: 42, answer: [1] },
    correct: 1,
    credit: 1,
    hintsUsed: 0,
    attemptNo: n,
    gradedBy: 'deterministic',
    feedback: { message: 'Correct.' },
    mistakeCategory: null,
    durationMs: null,
    createdAt: new Date(date),
    ...overrides,
  };
}

function xpEvent(sourceKey: string, earnedAt = new Date(date)): NewRow<XpEvent> {
  return { kind: 'quiz', sourceKey, conceptId: null, amount: 5, earnedAt, localDate: '2026-01-17' };
}

function cardFor(conceptId: string, dimension: Dimension = 'math'): NewReviewCard {
  return {
    conceptId,
    dimension,
    fsrs: newReviewCard(date),
    dueAt: date,
    lastReviewAt: null,
    reps: 0,
    lapses: 0,
  };
}

export function sessionRow(startedAt: Date): NewRow<Session> {
  return {
    startedAt,
    kind: 'custom',
    plannedMinutes: 20,
    endedAt: null,
    status: 'active',
    plan: { labels: ['original'] },
    activeSeconds: 0,
  };
}

export function activityRow(
  idx: number,
  overrides: Partial<NewRow<Omit<Activity, 'sessionId'>>> = {},
): NewRow<Omit<Activity, 'sessionId'>> {
  return {
    idx,
    kind: 'learn',
    conceptId: 'vectors',
    projectId: null,
    exerciseIds: ['vectors-q1', 'vectors-q2'],
    plannedMinutes: 5,
    status: 'planned',
    progress: { items: [1] },
    reason: {},
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function lessonRun(conceptId: string): NewRow<LessonRun> {
  return {
    conceptId,
    status: 'in_progress',
    startedAt: date,
    updatedAt: date,
    completedAt: null,
    quizPassedAt: null,
    attempt: 1,
    haltedAt: null,
    retryAfter: null,
    haltedPointIndex: null,
    haltCount: 0,
  };
}

const lessonProblem: NewRow<Omit<LessonProblem, 'runId'>> = {
  knowledgePointId: 'point',
  round: 1,
  position: 1,
  exerciseId,
  seed: null,
  practiceOnly: false,
  assisted: false,
  servedAt: date,
  answeredAt: null,
  correct: null,
  attemptId: null,
};

const quizAttempt = { attemptNo: 1, startedAt: date, submittedAt: null, score: null, passed: null };
const quizItem: NewRow<Omit<LessonQuizItem, 'quizAttemptId'>> = {
  position: 1,
  knowledgePointId: 'point',
  exerciseId,
  seed: null,
  answer: null,
  evidence: null,
  correct: null,
  durationMs: null,
  attemptId: null,
  answeredAt: null,
};

const flag: NewRow<RemediationFlag> = {
  conceptId: 'vectors',
  targetPrereqId: 'scalars',
  status: 'open',
  openedByAttemptId: null,
  createdAt: date,
  resolvedAt: null,
};

export function describeLearnerStoreContract(
  name: string,
  makeStore: (options?: {
    persistHintActivity?: boolean;
    seedCourseProgress?: boolean;
  }) => Promise<StoreFixture>,
) {
  describe(name, () => {
    it('reads due review topics before the cutoff, excluding suspended and foreign cards', async () => {
      const { store, learnerId, otherLearnerId } = await makeStore();
      const card = cardFor('vectors');
      await store.insertReviewCard(learnerId, { ...card, dueAt: date });
      await store.insertReviewCard(learnerId, { ...card, conceptId: 'algebra', dueAt: date });
      await store.insertReviewCard(learnerId, { ...card, conceptId: 'suspended', dueAt: date });
      await store.insertReviewCard(learnerId, { ...card, conceptId: 'not-yet', dueAt: later });
      await store.insertReviewCard(otherLearnerId, { ...card, conceptId: 'foreign', dueAt: date });
      await store.setReviewCardSuspension(learnerId, ['suspended'], date);
      expect(await store.listDueReviewConcepts(learnerId, later)).toEqual(['algebra', 'vectors']);
    });

    it('reads owned project and paper progress in content key order', async () => {
      const { store, learnerId, otherLearnerId } = await makeStore({ seedCourseProgress: true });
      expect(await store.listProjectProgress(learnerId)).toEqual([
        { projectId: 'a', status: 'completed' },
        { projectId: 'z', status: 'in_progress' },
      ]);
      expect(await store.listPaperProgress(learnerId)).toEqual([
        { paperId: 'a', completedAt: date },
        { paperId: 'z', completedAt: null },
      ]);
      expect(await store.listProjectProgress(otherLearnerId)).toEqual([]);
      expect(await store.listPaperProgress(otherLearnerId)).toEqual([]);
    });

    it('orders tied course activity and lesson evidence by semantic keys', async () => {
      const { store, learnerId, otherLearnerId } = await makeStore();
      for (const [owner, topic] of [
        [learnerId, 'vectors'],
        [otherLearnerId, 'foreign'],
        [learnerId, 'algebra'],
      ]) {
        const session = await store.insertSession(owner, sessionRow(date));
        await store.insertActivities(owner, session.id, [
          activityRow(1, { status: 'completed', completedAt: date, conceptId: topic }),
          activityRow(0, { status: 'completed', completedAt: date, conceptId: topic }),
          activityRow(2, { status: 'in_progress', conceptId: topic }),
          activityRow(3, { status: 'completed', completedAt: new Date(date.getTime() - 1) }),
          activityRow(4, { status: 'completed' }),
        ]);
      }
      expect(
        (await store.listCompletedActivities(learnerId, date)).map(({ conceptId, idx }) => [
          conceptId,
          idx,
        ]),
      ).toEqual([
        ['algebra', 0],
        ['vectors', 0],
        ['algebra', 1],
        ['vectors', 1],
      ]);

      const own = await store.insertLessonRunIfAbsent(learnerId, lessonRun('vectors'));
      const foreign = await store.insertLessonRunIfAbsent(otherLearnerId, lessonRun('foreign'));
      if (!own || !foreign) throw new Error('Expected lesson runs');
      await store.insertLessonProblem(otherLearnerId, foreign.id, lessonProblem);
      const last = await store.insertLessonProblem(learnerId, own.id, {
        ...lessonProblem,
        position: 2,
      });
      const first = await store.insertLessonProblem(learnerId, own.id, lessonProblem);
      expect(await store.listCourseLessonProblems(learnerId, [foreign.id, own.id])).toEqual([
        first,
        last,
      ]);
      expect(await store.listCourseLessonProblems(learnerId, [])).toEqual([]);

      for (const [owner, dimension, toState] of [
        [learnerId, 'math', 'independent'],
        [otherLearnerId, 'math', 'assisted'],
        [learnerId, 'math', 'assisted'],
      ] as const) {
        await store.addMasteryEvent(owner, {
          conceptId: 'vectors',
          dimension,
          fromState: 'not_assessed',
          toState,
          createdAt: date,
          rule: 'test',
          attemptId: null,
        });
      }
      expect(
        (await store.listCourseMasteryEvents(learnerId, ['vectors'])).map(({ toState }) => toState),
      ).toEqual(['assisted', 'independent']);
      expect(await store.listCourseMasteryEvents(learnerId, [])).toEqual([]);
    });

    it('filters timed quiz runs by ownership and sorts originals by finalize, start and seed', async () => {
      const { store, learnerId, otherLearnerId, activityId } = await makeStore({
        persistHintActivity: true,
      });
      const row = timedQuizRow();
      const last = await store.insertTimedQuiz(
        learnerId,
        { ...row, activityId, finalizedAt: later },
        [],
      );
      const third = await store.insertTimedQuiz(learnerId, { ...row, finalizedAt: date }, []);
      const second = await store.insertTimedQuiz(
        learnerId,
        {
          ...row,
          startedAt: new Date(0),
          finalizedAt: date,
        },
        [],
      );
      const first = await store.insertTimedQuiz(
        learnerId,
        {
          ...row,
          startedAt: new Date(0),
          finalizedAt: date,
          seed: 0,
        },
        [],
      );
      const active = await store.insertTimedQuiz(
        learnerId,
        { ...row, activityId, retakeOf: last.id },
        [],
      );
      await store.insertTimedQuiz(otherLearnerId, row, []);
      expect(
        await store.listTimedQuizRuns(learnerId, { original: true, finalizedThrough: later }),
      ).toEqual([first, second, third, last]);
      expect(
        await store.listTimedQuizRuns(learnerId, { original: true, finalizedThrough: date }),
      ).toEqual([first, second, third]);
      expect(await store.listTimedQuizRuns(learnerId, { active: true })).toEqual([active]);
      expect(
        await store.listTimedQuizRuns(learnerId, { activityIds: [activityId], original: true }),
      ).toEqual([last]);
      expect(await store.listTimedQuizRuns(learnerId, { activityIds: [] })).toEqual([]);
      expect(await store.listTimedQuizRuns(learnerId, { retakeOf: last.id, activityId })).toEqual([
        active,
      ]);
      expect(await store.listTimedQuizRuns(otherLearnerId, { id: active.id })).toEqual([]);
      await expect(
        store.patchTimedQuizRun(otherLearnerId, active.id, { finalizedAt: later }),
      ).rejects.toThrow();
      await expect(
        store.patchTimedQuizRun(learnerId, active.id, { finalizedAt: later, score: 1 }),
      ).resolves.toEqual({ ...active, finalizedAt: later, score: 1 });
      expect(await store.listTimedQuizRuns(learnerId, { active: true })).toEqual([]);
    });

    it('preserves timed quiz uniqueness on insert and update', async () => {
      const { store, learnerId } = await makeStore();
      const row = timedQuizRow();
      const original = await store.insertTimedQuiz(learnerId, row, []);
      await expect(
        store.transaction((tx) => tx.insertTimedQuiz(learnerId, row, [])),
      ).rejects.toThrow();
      await store.patchTimedQuizRun(learnerId, original.id, { finalizedAt: date });
      const retake = await store.insertTimedQuiz(learnerId, { ...row, retakeOf: original.id }, []);
      await expect(
        store.transaction((tx) =>
          tx.patchTimedQuizRun(learnerId, original.id, { finalizedAt: null }),
        ),
      ).rejects.toThrow();
      await store.patchTimedQuizRun(learnerId, retake.id, { finalizedAt: date });
      await expect(
        store.transaction((tx) =>
          tx.insertTimedQuiz(
            learnerId,
            {
              ...row,
              retakeOf: original.id,
            },
            [],
          ),
        ),
      ).rejects.toThrow();
      await expect(
        store.transaction((tx) =>
          tx.insertTimedQuiz(learnerId, row, [timedQuizItem(0), timedQuizItem(0)]),
        ),
      ).rejects.toThrow();
      expect(await store.listTimedQuizRuns(learnerId, { active: true })).toEqual([]);
    });

    it('patches owned timed quiz items by position and only links pending flagged items of finalized runs', async () => {
      const { store, learnerId, otherLearnerId, activityId } = await makeStore({
        persistHintActivity: true,
      });
      const [first, second] = [timedQuizItem(0), timedQuizItem(1)];
      const completed = await store.insertTimedQuiz(
        learnerId,
        {
          ...timedQuizRow(),
          activityId,
          finalizedAt: date,
        },
        [
          timedQuizItem(3, { conceptId: 'other', followUp: true }),
          { ...second, followUp: true },
          first,
        ],
      );
      const active = await store.insertTimedQuiz(learnerId, timedQuizRow(), [
        timedQuizItem(2, { followUp: true }),
      ]);
      const foreign = await store.insertTimedQuiz(
        otherLearnerId,
        { ...timedQuizRow(), finalizedAt: date },
        [{ ...first, followUp: true }],
      );
      const links = async () =>
        (await store.listTimedQuizItems(learnerId, [completed.id, active.id, foreign.id])).map(
          ({ runId, position, followUpActivityId }) => [runId, position, followUpActivityId],
        );
      expect(await store.listTimedQuizItems(learnerId, [])).toEqual([]);
      await store.patchTimedQuizItem(otherLearnerId, completed.id, 0, { followUp: true });
      await store.linkTimedQuizFollowUps(learnerId, [], activityId);
      expect(await links()).toEqual([
        [completed.id, 0, null],
        [completed.id, 1, null],
        [active.id, 2, null],
        [completed.id, 3, null],
      ]);
      await store.linkTimedQuizFollowUps(learnerId, ['vectors'], activityId);
      expect(await links()).toEqual([
        [completed.id, 0, null],
        [completed.id, 1, activityId],
        [active.id, 2, null],
        [completed.id, 3, null],
      ]);
      const session = await store.insertSession(learnerId, sessionRow(date));
      const [replacement] = await store.insertActivities(learnerId, session.id, [activityRow(0)]);
      await store.patchTimedQuizItem(learnerId, completed.id, 0, {
        followUp: true,
        answeredAt: date,
      });
      await store.linkTimedQuizFollowUps(learnerId, ['vectors'], replacement.id);
      expect(await store.listTimedQuizItems(learnerId, [completed.id])).toMatchObject([
        { position: 0, answeredAt: date, followUpActivityId: replacement.id },
        { position: 1, followUpActivityId: activityId },
        { position: 3, followUpActivityId: null },
      ]);
      await store.deleteActivities(learnerId, { ids: [activityId] });
      expect(await store.listTimedQuizRuns(learnerId, { id: completed.id })).toMatchObject([
        { activityId: null },
      ]);
      expect(await store.listTimedQuizItems(learnerId, [completed.id])).toMatchObject([
        { followUpActivityId: replacement.id },
        { followUpActivityId: null },
        { followUpActivityId: null },
      ]);
    });

    it('reads only owned quiz item keys in semantic order and identifies runs with misses', async () => {
      const { store, learnerId, otherLearnerId } = await makeStore();
      const item = timedQuizItem(0);
      const reserve = { ...item.question, key: 'reserve', seed: 2 };
      const first = await store.insertTimedQuiz(
        learnerId,
        { ...timedQuizRow(), finalizedAt: date },
        [
          { ...item, conceptId: 'vectors', reserve, correct: false },
          { ...item, position: 1, conceptId: 'vectors', correct: true },
        ],
      );
      const second = await store.insertTimedQuiz(learnerId, timedQuizRow(), [
        {
          ...item,
          conceptId: 'angles',
          question: { ...item.question, previousKeys: ['first-prompt'], withdrawn: true },
        },
      ]);
      const foreign = await store.insertTimedQuiz(otherLearnerId, timedQuizRow(), [
        { ...item, conceptId: 'angles', correct: false },
      ]);
      expect(
        await store.listTimedQuizItemKeys(learnerId, [first.id, foreign.id, second.id, first.id]),
      ).toEqual({
        items: [
          {
            runId: second.id,
            conceptId: 'angles',
            questionKey: exerciseId,
            reserveKey: null,
            previousKeys: ['first-prompt'],
            withdrawn: true,
          },
          {
            runId: first.id,
            conceptId: 'vectors',
            questionKey: exerciseId,
            reserveKey: 'reserve',
            previousKeys: [],
            withdrawn: false,
          },
          {
            runId: first.id,
            conceptId: 'vectors',
            questionKey: exerciseId,
            reserveKey: null,
            previousKeys: [],
            withdrawn: false,
          },
        ],
        missedRunIds: new Set([first.id]),
      });
      expect(await store.listTimedQuizItemKeys(learnerId, [])).toEqual({
        items: [],
        missedRunIds: new Set(),
      });
    });

    it('filters and locks diagnostic runs by owner, course, id and status', async () => {
      const { store, learnerId, otherLearnerId } = await makeStore();
      const row: NewRow<DiagnosticRun> = {
        courseId: 'maths',
        kind: 'placement',
        status: 'active',
        state: { courseId: 'maths', answers: [] },
        startedAt: date,
        completedAt: null,
        summary: {},
      };
      const created = await store.insertDiagnosticRun(learnerId, row);
      const newer = await store.insertDiagnosticRun(learnerId, { ...row, startedAt: later });
      await store.insertDiagnosticRun(otherLearnerId, row);
      expect(
        await store.listDiagnosticRuns(learnerId, { courseId: 'maths', status: 'active' }),
      ).toEqual([newer, created]);
      expect(await store.listDiagnosticRuns(learnerId, { courseId: 'other' })).toEqual([]);
      await store.patchDiagnosticRun(otherLearnerId, created.id, { status: 'abandoned' });
      await store.transaction(async (tx) => {
        expect(await tx.listDiagnosticRuns(learnerId, { id: created.id, forUpdate: true })).toEqual(
          [created],
        );
        await tx.patchDiagnosticRun(learnerId, created.id, {
          status: 'completed',
          completedAt: later,
          summary: { known: ['vectors'] },
        });
      });
      expect(await store.listDiagnosticRuns(learnerId, { status: 'completed' })).toEqual([
        { ...created, status: 'completed', completedAt: later, summary: { known: ['vectors'] } },
      ]);
    });

    it('deduplicates grants per run and concept and guards updates by owner and state', async () => {
      const { store, learnerId, otherLearnerId } = await makeStore();
      const { id: runId } = await store.insertDiagnosticRun(learnerId, {
        courseId: 'maths',
        kind: 'placement',
        status: 'completed',
        state: { courseId: 'maths' },
        startedAt: date,
        completedAt: date,
        summary: {},
      });
      const evidence = attempt(1);
      await store.insertAttempt(learnerId, evidence);
      const grant: NewRow<PlacementGrant> = {
        runId,
        conceptId: 'vectors',
        origin: 'direct',
        state: 'conditional',
        reason: 'slow',
        evidenceAttemptIds: [evidence.id],
        createdAt: date,
        updatedAt: date,
        confirmedAt: null,
        confirmedByAttemptId: null,
        withdrawnAt: null,
        withdrawnByAttemptId: null,
      };
      await store.insertPlacementGrantsOnce(learnerId, [
        grant,
        { ...grant, conceptId: 'scalars', reason: 'inferred_only' },
      ]);
      await store.insertPlacementGrantsOnce(learnerId, [{ ...grant, reason: 'on_time' }]);
      const [saved] = await store.listPlacementGrants(learnerId, {
        excludeReasons: ['inferred_only'],
      });
      expect(saved).toEqual({ ...grant, id: expect.any(String) });
      expect(await store.listPlacementGrants(otherLearnerId)).toEqual([]);
      await store.patchPlacementGrants(otherLearnerId, { ids: [saved.id] }, { state: 'withdrawn' });
      await store.patchPlacementGrants(
        learnerId,
        { ids: [saved.id], ifState: 'confirmed' },
        { state: 'withdrawn' },
      );
      expect(
        await store.listPlacementGrants(learnerId, {
          conceptIds: ['vectors'],
          state: 'conditional',
        }),
      ).toEqual([saved]);
      await store.patchPlacementGrants(
        learnerId,
        { conceptId: 'vectors', ifState: 'conditional' },
        {
          state: 'confirmed',
          reason: 'confirmed_by_answer',
          confirmedAt: later,
          confirmedByAttemptId: evidence.id,
        },
      );
      expect(await store.listPlacementGrants(learnerId, { state: 'confirmed' })).toEqual([
        {
          ...saved,
          state: 'confirmed',
          reason: 'confirmed_by_answer',
          confirmedAt: later,
          confirmedByAttemptId: evidence.id,
        },
      ]);
    });

    it('locks, suspends and patches owned cards and reads review logs by attempt lineage', async () => {
      const { store, learnerId, otherLearnerId } = await makeStore();
      const card = await store.insertReviewCard(learnerId, cardFor('vectors'));
      const otherCard = await store.insertReviewCard(otherLearnerId, cardFor('vectors'));
      const session = await store.insertSession(learnerId, sessionRow(date));
      const [{ id: activityId }] = await store.insertActivities(learnerId, session.id, [
        activityRow(0),
      ]);
      const evidence = attempt(1, { activityId, sessionId: session.id });
      await store.insertAttempt(learnerId, evidence);
      const { card: next, log } = scheduleReview(card.fsrs, date, Rating.Good, 'UTC', false);
      const entry = {
        rating: Rating.Good,
        fsrsLog: { ...log, effectiveDueAt: next.due },
        speed: 1.25,
        rawDueAt: next.due,
        createdAt: date,
      };
      await store.transaction(async (tx) => {
        expect(await tx.getReviewCard(learnerId, 'vectors', 'math', { forUpdate: true })).toEqual(
          card,
        );
        await tx.setReviewCardSuspension(learnerId, ['vectors'], date);
        await tx.setReviewCardSuspension(learnerId, ['vectors'], later);
        expect(
          await tx.recordReview(learnerId, 'vectors', 'math', () => {
            throw new Error('Suspended card');
          }),
        ).toBe(false);
        expect(await tx.getReviewCard(learnerId, 'vectors', 'math')).toMatchObject({
          suspendedAt: date,
        });
        await tx.patchReviewCard(learnerId, card.id, {
          dueAt: next.due,
          fsrs: next,
          reps: next.reps,
        });
        await tx.appendReviewLog(learnerId, card.id, { ...entry, attemptId: evidence.id });
      });
      await store.appendReviewLog(learnerId, card.id, { ...entry, createdAt: later });
      await expect(store.appendReviewLog(otherLearnerId, card.id, entry)).rejects.toThrow();
      await store.patchReviewCard(otherLearnerId, card.id, { dueAt: date });
      expect(await store.getReviewCard(otherLearnerId, 'vectors', 'math')).toEqual(otherCard);
      const linkedLog = {
        ...entry,
        id: expect.any(String),
        cardId: card.id,
        conceptId: 'vectors',
        attemptId: evidence.id,
      };
      expect(
        await store.listReviewLogs(learnerId, { activityId, cardIds: [card.id], limit: 1 }),
      ).toEqual([linkedLog]);
      expect(await store.listReviewLogs(learnerId, { cardIds: [card.id], since: date })).toEqual([
        { ...linkedLog, attemptId: null, createdAt: later },
        linkedLog,
      ]);
      expect(await store.listReviewLogs(learnerId, { cardIds: [card.id], limit: 1 })).toEqual([
        { ...linkedLog, attemptId: null, createdAt: later },
      ]);
      expect(
        await store.listReviewLogs(learnerId, { cardIds: [card.id], since: later }),
      ).toHaveLength(1);
      expect(await store.listReviewLogs(otherLearnerId, { cardIds: [card.id] })).toEqual([]);
      await store.setReviewCardSuspension(learnerId, ['vectors'], null);
      expect(await store.getReviewCard(learnerId, 'vectors', 'math')).toMatchObject({
        dueAt: next.due,
        suspendedAt: null,
      });
    });

    it('owns and edits runs and their problems, with conflict and position guards', async () => {
      const { store, learnerId, otherLearnerId } = await makeStore();
      const run = await store.insertLessonRunIfAbsent(learnerId, lessonRun('vectors'));
      if (!run) throw new Error('Missing lesson run');
      expect(await store.insertLessonRunIfAbsent(learnerId, lessonRun('vectors'))).toBeUndefined();
      expect(await store.listLessonRuns(learnerId)).toEqual([run]);
      expect(await store.getLessonRun(otherLearnerId, { runId: run.id })).toBeUndefined();
      await expect(
        store.patchLessonRun(otherLearnerId, run.id, { status: 'quiz' }),
      ).rejects.toThrow();
      const problem = await store.insertLessonProblem(learnerId, run.id, lessonProblem);
      const second = await store.insertLessonProblem(learnerId, run.id, {
        ...lessonProblem,
        position: 2,
      });
      await expect(store.insertLessonProblem(learnerId, run.id, lessonProblem)).rejects.toThrow();
      await expect(
        store.insertLessonProblem(otherLearnerId, run.id, lessonProblem),
      ).rejects.toThrow();
      expect(await store.listLessonProblems(otherLearnerId, run.id)).toEqual([]);
      expect(await store.lockLessonProblem(otherLearnerId, 'vectors', problem.id)).toBeUndefined();
      expect(await store.lockLessonProblem(learnerId, 'scalars', problem.id)).toBeUndefined();
      await store.transaction(async (tx) => {
        expect(
          await tx.getLessonRun(learnerId, { conceptId: 'vectors' }, { forUpdate: true }),
        ).toEqual(run);
        expect(await tx.lockLessonProblem(learnerId, 'vectors', problem.id)).toEqual({
          run,
          problem,
        });
        await tx.patchLessonProblem(learnerId, run.id, problem.id, {
          answeredAt: later,
          correct: 1,
        });
        await tx.patchLessonRun(learnerId, run.id, { status: 'quiz', updatedAt: later });
        await tx.deleteLessonProblems(otherLearnerId, run.id, [problem.id, second.id]);
      });
      expect(await store.listLessonProblems(learnerId, run.id)).toEqual([
        { ...problem, answeredAt: later, correct: 1 },
        second,
      ]);
      expect(await store.getLessonRun(learnerId, { runId: run.id })).toEqual({
        ...run,
        status: 'quiz',
        updatedAt: later,
      });
      await store.deleteLessonProblems(learnerId, run.id, [second.id]);
      expect(await store.listLessonProblems(learnerId, run.id)).toHaveLength(1);
    });

    it('scopes quiz item replacement, persists edits and cascades deleted attempts', async () => {
      const { store, learnerId, otherLearnerId } = await makeStore();
      const run = await store.insertLessonRunIfAbsent(learnerId, lessonRun('vectors'));
      if (!run) throw new Error('Missing lesson run');
      const first = await store.insertLessonQuiz(learnerId, run.id, quizAttempt, [
        { ...quizItem, position: 2 },
        quizItem,
      ]);
      await expect(store.insertLessonQuiz(learnerId, run.id, quizAttempt, [])).rejects.toThrow();
      await expect(
        store.transaction((tx) =>
          tx.insertLessonQuiz(learnerId, run.id, { ...quizAttempt, attemptNo: 2 }, [
            quizItem,
            quizItem,
          ]),
        ),
      ).rejects.toThrow();
      const second = await store.insertLessonQuiz(
        learnerId,
        run.id,
        { ...quizAttempt, attemptNo: 2 },
        [],
      );
      const quiz = await store.readLessonQuiz(learnerId, run.id);
      expect(quiz.quizAttempts).toEqual([first, second]);
      expect(quiz.quizItems.map(({ position }) => position)).toEqual([1, 2]);
      expect(await store.readLessonQuiz(otherLearnerId, run.id)).toEqual({
        quizAttempts: [],
        quizItems: [],
      });
      const [one, two] = quiz.quizItems;
      expect(
        await store.getLessonRun(otherLearnerId, { conceptId: 'vectors', quizItemId: one.id }),
      ).toBeUndefined();
      expect(
        await store.getLessonRun(
          learnerId,
          { conceptId: 'vectors', quizItemId: one.id },
          { forUpdate: true },
        ),
      ).toEqual(run);
      const replacementId = crypto.randomUUID();
      expect(
        await store.patchLessonQuizItem(
          learnerId,
          run.id,
          one.id,
          {
            replacementId,
            exerciseId: 'replacement',
          },
          { unanswered: true },
        ),
      ).toEqual({ ...one, id: replacementId, exerciseId: 'replacement' });
      expect(
        await store.getLessonRun(learnerId, { conceptId: 'vectors', quizItemId: one.id }),
      ).toBeUndefined();
      const answer = { selected: [1] };
      const evidence = {
        exercise: {
          id: 'replacement',
          concept: 'vectors',
          dimension: 'math',
          role: 'core',
          contentVersion: 'v1',
        },
        grade: {
          status: 'graded',
          correct: 1,
          credit: 1,
          feedback: 'Correct',
          graded_by: 'deterministic',
        },
      } as const;
      await store.patchLessonQuizItem(learnerId, run.id, replacementId, {
        answer,
        evidence,
        answeredAt: later,
      });
      answer.selected.push(2);
      expect(
        await store.patchLessonQuizItem(
          learnerId,
          run.id,
          replacementId,
          { exerciseId },
          { unanswered: true },
        ),
      ).toBeUndefined();
      expect(
        await store.patchLessonQuizItem(otherLearnerId, run.id, replacementId, { exerciseId }),
      ).toBeUndefined();
      await store.patchLessonQuizAttempt(learnerId, run.id, first.id, {
        submittedAt: later,
        score: 1,
        passed: true,
      });
      await store.deleteLessonQuizRows(otherLearnerId, run.id, {
        itemIds: [two.id],
        attemptIds: [first.id],
      });
      await store.deleteLessonQuizRows(learnerId, run.id, { itemIds: [two.id] });
      expect(await store.readLessonQuiz(learnerId, run.id)).toEqual({
        quizAttempts: [{ ...first, submittedAt: later, score: 1, passed: true }, second],
        quizItems: [
          {
            ...one,
            id: replacementId,
            exerciseId: 'replacement',
            answeredAt: later,
            answer: { selected: [1] },
            evidence,
          },
        ],
      });
      await store.deleteLessonQuizRows(learnerId, run.id, { attemptIds: [first.id] });
      expect(await store.readLessonQuiz(learnerId, run.id)).toEqual({
        quizAttempts: [second],
        quizItems: [],
      });
    });

    it('resolves only matching open flags and clears topic progress without deleting evidence or XP', async () => {
      const { store, learnerId, otherLearnerId, activityId } = await makeStore();
      const evidence = await store.insertAttempt(learnerId, attempt(1, { activityId }));
      await store.insertXpEventOnce(learnerId, xpEvent('lesson-xp'));
      const run = await store.insertLessonRunIfAbsent(learnerId, lessonRun('vectors'));
      if (!run) throw new Error('Missing lesson run');
      await store.insertLessonProblem(learnerId, run.id, lessonProblem);
      await store.insertLessonQuiz(learnerId, run.id, quizAttempt, [quizItem]);
      await store.insertRemediationFlags(learnerId, [
        flag,
        { ...flag, openedByAttemptId: evidence.id },
        { ...flag, conceptId: 'matrices', targetPrereqId: 'vectors' },
        { ...flag, conceptId: 'other', targetPrereqId: null },
      ]);
      await store.insertRemediationFlags(otherLearnerId, [flag]);
      const query = {
        conceptId: 'vectors',
        targetPrereqIds: ['scalars'],
        excludeOpenedByActivityId: activityId,
      };
      expect(await store.listRemediationFlags(learnerId, query)).toHaveLength(1);
      expect(await store.listRemediationFlags(learnerId, { targetPrereqIds: [] })).toEqual([]);
      await store.resolveRemediationFlags(learnerId, query, later);
      await store.resolveRemediationFlags(learnerId, query, date);
      expect(await store.listRemediationFlags(learnerId, { status: 'resolved' })).toEqual([
        expect.objectContaining({ resolvedAt: later, openedByAttemptId: null }),
      ]);
      expect(await store.listOpenRemediationFlags(learnerId)).toHaveLength(3);
      const facts = await store.readSchedulerFacts(learnerId, {
        now: later,
        recallExerciseIds: [],
      });
      expect(facts.flags).toHaveLength(3);
      expect(facts.flags.every((flag) => flag.status === 'open')).toBe(true);
      await expect(
        store.transaction(async (tx) => {
          await tx.clearTopicProgress(learnerId, 'vectors');
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await store.listLessonRuns(learnerId)).toEqual([run]);
      await store.clearTopicProgress(learnerId, 'vectors');
      expect(await store.listLessonRuns(learnerId)).toEqual([]);
      expect(await store.listLessonProblems(learnerId, run.id)).toEqual([]);
      expect(await store.readLessonQuiz(learnerId, run.id)).toEqual({
        quizAttempts: [],
        quizItems: [],
      });
      expect(await store.listRemediationFlags(learnerId, {})).toEqual([
        expect.objectContaining({ conceptId: 'other' }),
      ]);
      expect(await store.listRemediationFlags(otherLearnerId, {})).toHaveLength(1);
      expect(await store.listAttempts(learnerId, {})).toEqual([evidence]);
      expect(await store.listXpEvents(learnerId, {})).toHaveLength(1);
    });
    it('lists and locks owned sessions, returns copies and only replaces active sessions', async () => {
      const { store, learnerId, otherLearnerId } = await makeStore();
      const row = sessionRow(new Date(date));
      const first = await store.insertSession(learnerId, row);
      const second = await store.insertSession(learnerId, sessionRow(later));
      const foreign = await store.insertSession(otherLearnerId, sessionRow(later));
      expect(
        await activeSessionForDate(
          store,
          learnerId,
          new Date('2026-01-18T01:00Z'),
          'America/Los_Angeles',
        ),
      ).toEqual(first);
      (row.plan as { labels: string[] }).labels[0] = 'changed';
      row.startedAt?.setTime(0);
      const ordered = await store.listSessions(learnerId, { status: 'active' });
      expect(ordered.map(({ id }) => id)).toEqual([second.id, first.id]);
      expect(await store.listSessions(learnerId, { ids: [] })).toEqual([]);
      const locked = await store.transaction(async (tx) => {
        expect(await tx.lockSession(learnerId, foreign.id)).toBeUndefined();
        return tx.lockSession(learnerId, first.id);
      });
      expect(locked).toEqual(first);
      if (locked) (locked.plan as { labels: string[] }).labels[0] = 'changed again';
      await store.patchSessions(
        learnerId,
        { ids: [first.id], status: 'active' },
        { status: 'completed' },
      );
      await store.patchSessions(
        learnerId,
        { status: 'active' },
        { status: 'abandoned', endedAt: later },
      );
      expect(await store.listSessions(learnerId, { ids: [first.id, foreign.id] })).toEqual([
        { ...first, status: 'completed' },
      ]);
      expect(await store.listSessions(learnerId, { status: 'abandoned' })).toEqual([
        { ...second, status: 'abandoned', endedAt: later },
      ]);
      expect(await store.listSessions(otherLearnerId, { ids: [foreign.id] })).toEqual([foreign]);
    });

    it('orders owned activities and compares exercise arrays and status atomically', async () => {
      const { store, learnerId, otherLearnerId } = await makeStore();
      const session = await store.insertSession(learnerId, sessionRow(date));
      const foreign = await store.insertSession(otherLearnerId, sessionRow(later));
      await expect(
        store.insertActivities(learnerId, foreign.id, [activityRow(0)]),
      ).rejects.toThrow();
      const input = activityRow(2, { status: 'completed', completedAt: new Date(date) });
      const [second, first] = await store.insertActivities(learnerId, session.id, [
        input,
        activityRow(1),
      ]);
      expect(await store.insertActivities(learnerId, session.id, [])).toEqual([]);
      await expect(
        store.insertActivities(learnerId, session.id, [activityRow(3), activityRow(1)]),
      ).rejects.toThrow();
      const query = { sessionIds: [session.id], conceptId: 'vectors' };
      expect(await store.listActivities(learnerId, query)).toEqual([first, second]);
      expect(await store.listActivities(otherLearnerId, query)).toEqual([]);
      (input.progress as { items: number[] }).items[0] = 2;
      input.completedAt?.setTime(0);
      first.exerciseIds.reverse();
      expect(
        await store.patchActivities(
          learnerId,
          { ids: [first.id] },
          { status: 'skipped' },
          {
            exerciseIds: first.exerciseIds,
          },
        ),
      ).toEqual([]);
      const expected = {
        statuses: ['planned'] as const,
        exerciseIds: ['vectors-q1', 'vectors-q2'],
        reason: first.reason,
      };
      expect(
        await store.patchActivities(
          learnerId,
          query,
          { status: 'skipped' },
          { reason: { stale: true } },
        ),
      ).toEqual([]);
      const concurrent = await Promise.all([
        store.patchActivities(learnerId, query, { status: 'in_progress' }, expected),
        store.patchActivities(learnerId, query, { status: 'skipped' }, expected),
      ]);
      expect(concurrent.flat()).toHaveLength(1);
      expect(concurrent.flat()[0]?.id).toBe(first.id);
      expect(await store.patchActivities(otherLearnerId, query, { status: 'planned' })).toEqual([]);
      await store.deleteActivities(otherLearnerId, query);
      await store.deleteActivities(learnerId, { ...query, statuses: ['planned'] });
      expect(await store.listActivities(learnerId, query)).toHaveLength(2);
      await store.deleteActivities(learnerId, { ...query, ids: [first.id] });
      expect(await store.listActivities(learnerId, query)).toEqual([second]);
    });

    it('rolls session and activity inserts, updates and deletes back together', async () => {
      const { store, learnerId } = await makeStore();
      const session = await store.insertSession(learnerId, sessionRow(date));
      const [activity] = await store.insertActivities(learnerId, session.id, [activityRow(0)]);
      await expect(
        store.transaction(async (tx) => {
          await tx.lockSession(learnerId, session.id);
          await tx.patchSessions(learnerId, { ids: [session.id] }, { status: 'completed' });
          await tx.patchActivities(learnerId, { ids: [activity.id] }, { status: 'skipped' });
          await tx.deleteActivities(learnerId, { ids: [activity.id] });
          const replacement = await tx.insertSession(learnerId, sessionRow(later));
          await tx.insertActivities(learnerId, replacement.id, [activityRow(0)]);
          throw new Error('rollback session');
        }),
      ).rejects.toThrow('rollback session');
      expect(await store.listSessions(learnerId, { status: 'active' })).toEqual([session]);
      expect(await store.listActivities(learnerId, { conceptId: 'vectors' })).toEqual([activity]);
    });

    it('bounds planner facts, retains historical recall and respects skips and learner isolation', async () => {
      const { store, learnerId, otherLearnerId, addOpenFlag } = await makeStore();
      const session = await store.insertSession(learnerId, sessionRow(date));
      const boundary = new Date(date.getTime() - 7 * 86_400_000);
      await store.insertActivities(learnerId, session.id, [
        activityRow(0, { status: 'completed', completedAt: boundary }),
        activityRow(1, { status: 'completed', completedAt: new Date(boundary.getTime() - 1) }),
        activityRow(2, { status: 'completed', completedAt: new Date(date.getTime() + 1) }),
      ]);
      const [review] = await store.insertActivities(learnerId, session.id, [
        activityRow(3, { kind: 'review', status: 'completed', completedAt: date }),
      ]);
      const reviewAttempt = await store.insertAttempt(
        learnerId,
        attempt(1, { activityId: review.id }),
      );
      for (const [n, createdAt, source] of [
        [1, date, undefined],
        [2, new Date(date.getTime() - 36 * 3_600_000), undefined],
        [3, new Date(date.getTime() - 36 * 3_600_000 - 1), undefined],
        [4, new Date('2026-01-18T00:00:00Z'), undefined],
        [5, date, 'mixed_quiz'],
      ] as const) {
        await store.recordReview(learnerId, `review-${n}`, 'math', () => {
          const { conceptId: _conceptId, dimension: _dimension, ...card } = cardFor(`review-${n}`);
          return {
            card,
            log: {
              rating: Rating.Good,
              attemptId: reviewAttempt.id,
              createdAt,
              fsrsLog: {
                ...scheduleReview(card.fsrs, createdAt, Rating.Good, 'UTC', false).log,
                source,
              },
            },
          };
        });
      }
      await store.insertAttempt(
        learnerId,
        attempt(2, { exerciseId: 'old-recall', createdAt: boundary, correct: 1 }),
      );
      await store.insertAttempt(
        learnerId,
        attempt(3, { exerciseId: 'old-recall', createdAt: boundary, correct: 0 }),
      );
      await store.insertAttempt(
        otherLearnerId,
        attempt(4, { exerciseId: 'old-recall', createdAt: date }),
      );
      await Promise.all(
        Array.from({ length: 101 }, (_, idx) =>
          store.insertAttempt(learnerId, attempt(10 + idx, { exerciseId: 'recent' })),
        ),
      );
      await store.addTopicSpeedAnswer(learnerId, 'vectors', true, date);
      await addOpenFlag('vectors', 'addition');
      const query = { now: date, recallExerciseIds: ['old-recall'] };
      const facts = await store.readSchedulerFacts(learnerId, query);
      expect(facts.learnMinutes).toEqual([{ conceptId: 'vectors', plannedMinutes: 5 }]);
      expect(facts.recentAttempts).toHaveLength(100);
      expect(facts.recentAttempts[0]?.attemptNo).toBe(110);
      expect(facts.recallAttempts).toEqual([
        { exerciseId: 'old-recall', createdAt: boundary, correct: 0 },
      ]);
      expect(facts.reviewLogFacts.map(({ conceptId }) => conceptId).sort()).toEqual([
        'review-1',
        'review-2',
      ]);
      expect(facts.completedReviewLogFacts.map(({ conceptId }) => conceptId).sort()).toEqual([
        'review-1',
        'review-2',
        'review-5',
      ]);
      expect(facts.cards.map(({ conceptId }) => conceptId)).toEqual([
        'review-1',
        'review-2',
        'review-3',
        'review-4',
        'review-5',
      ]);
      expect(facts.flags.map(({ conceptId }) => conceptId)).toEqual(['vectors']);
      expect(facts.topicSpeeds).toEqual(await store.listTopicSpeedEvidence(learnerId));
      facts.recallAttempts[0]?.createdAt.setTime(0);
      facts.recentAttempts[0]?.createdAt.setTime(0);
      facts.reviewLogFacts[0]?.createdAt.setTime(0);
      expect(
        await store.readSchedulerFacts(learnerId, {
          ...query,
          skip: ['mastery', 'lessonRuns', 'projectProgress'],
        }),
      ).toMatchObject({
        mastery: undefined,
        lessonRuns: undefined,
        projectProgress: undefined,
        recallAttempts: [{ exerciseId: 'old-recall', createdAt: boundary, correct: 0 }],
        recentAttempts: expect.arrayContaining([
          expect.objectContaining({ attemptNo: 110, createdAt: date }),
        ]),
      });
      expect(await store.readSchedulerFacts(otherLearnerId, query)).toMatchObject({
        cards: [],
        flags: [],
        topicSpeeds: [],
        learnMinutes: [],
        reviewLogFacts: [],
        completedReviewLogFacts: [],
        recallAttempts: [{ exerciseId: 'old-recall', createdAt: date, correct: 1 }],
      });
    });

    it('round-trips attempts and applies all scoped filters and limits', async () => {
      const { store, learnerId, otherLearnerId, activityId } = await makeStore();
      const original = attempt(1, { activityId });
      const inserted = await store.insertAttempt(learnerId, original);
      expect(inserted).toEqual(original);
      await store.insertAttempt(otherLearnerId, attempt(2, { activityId }));
      await store.insertAttempt(learnerId, attempt(3, { exerciseId: 'vectors-q2' }));
      await expect(store.insertAttempt(otherLearnerId, original)).rejects.toThrow();
      (original.answer as { answer: number[] }).answer[0] = 0;
      (inserted.feedback as { message: string }).message = '';
      original.createdAt.setTime(0);
      const query = {
        ids: [inserted.id],
        activityIds: [activityId],
        exerciseIds: [exerciseId],
        conceptId: 'vectors',
        since: date,
        through: date,
        limit: 1,
      };
      const [row] = await store.listAttempts(learnerId, query);
      expect(row).toEqual(attempt(1, { activityId }));
      row.createdAt.setTime(0);
      expect(await store.listAttempts(learnerId, query)).toEqual([attempt(1, { activityId })]);
      expect(await store.listAttempts(learnerId, { ...query, limit: 0 })).toEqual([]);
      expect(await store.listAttempts(learnerId, { ...query, ids: [] })).toEqual([]);
      expect(
        await store.listAttempts(learnerId, { ...query, since: later, through: undefined }),
      ).toEqual([]);
      expect(await store.listAttempts(learnerId, { ...query, exerciseIds: ['other'] })).toEqual([]);
      expect(await store.listActivityAttemptKeys(learnerId, [activityId])).toEqual([
        { activityId, exerciseId },
      ]);
      expect(await store.listActivityAttemptKeys(learnerId, [])).toEqual([]);
    });

    it('uses each historical attempt order', async () => {
      const { store, learnerId } = await makeStore();
      const rows = [attempt(1, { createdAt: later }), attempt(2), attempt(3, { createdAt: later })];
      for (const row of rows) await store.insertAttempt(learnerId, row);
      const numbers = async (
        order: Parameters<CoreStore['listAttempts']>[1]['order'],
        limit?: number,
      ) => (await store.listAttempts(learnerId, { order, limit })).map((row) => row.attemptNo);
      expect(await numbers('recent', 2)).toEqual(expect.arrayContaining([1, 3]));
      expect(await numbers('activity_attempt_no')).toEqual([1, 2, 3]);
      expect(await numbers('review_chronological')).toEqual([2, 1, 3]);
      expect(await numbers('final_evidence')).toEqual([3, 1, 2]);
    });

    it('preserves the scheduler exercise, number, correctness, mode and ID tie breaks', async () => {
      const { store, learnerId } = await makeStore();
      const rows = [
        attempt(1, { attemptNo: 2, mode: 'assessment' }),
        attempt(2, { attemptNo: 2, mode: 'practice' }),
        attempt(3, { attemptNo: 2, mode: 'practice' }),
        attempt(4, { attemptNo: 2, correct: 0 }),
        attempt(5, { attemptNo: 1 }),
        attempt(6, { exerciseId: 'vectors-q2' }),
        attempt(7, { createdAt: later }),
      ];
      for (const row of rows.reverse()) await store.insertAttempt(learnerId, row);
      const result = await store.listAttempts(learnerId, { order: 'scheduler' });
      expect(result.map(({ id }) => id)).toEqual([7, 2, 3, 1, 4, 5, 6].map((n) => attempt(n).id));
    });

    it('loads historical hint evidence across activities or within one activity', async () => {
      const { store, learnerId, otherLearnerId, activityId } = await makeStore();
      const sameTime = new Date('2026-01-17T12:00:00.000Z');
      await store.insertAttempt(learnerId, attempt(3, { createdAt: later }));
      await store.insertAttempt(learnerId, attempt(2, { activityId }));
      await store.insertAttempt(otherLearnerId, attempt(1, { activityId, createdAt: later }));
      const scoped = await store.readHintEvidence(learnerId, exerciseId, activityId);
      expect(scoped.attempts).toEqual([{ activityId, createdAt: sameTime }]);
      expect(scoped.hints).toEqual(
        expect.arrayContaining([
          { activityId, level: 1, createdAt: sameTime },
          { activityId, level: 5, createdAt: new Date('2026-01-17T12:00:01Z') },
        ]),
      );
      expect(scoped.hints).toHaveLength(2);
      const scope = { userId: learnerId, exerciseId };
      const count = (result: typeof scoped, activityId?: string) =>
        countHintsSincePreviousAttempt({
          ...scope,
          activityId,
          attempts: result.attempts.map((row) => ({ ...row, ...scope })),
          hints: result.hints.map((row) => ({ ...row, ...scope })),
        });
      expect(count(scoped, activityId)).toBe(5);
      expect(count(await store.readHintEvidence(learnerId, exerciseId))).toBe(0);
      expect(await store.readHintEvidence(learnerId, 'missing')).toEqual({
        attempts: [],
        hints: [],
      });
      scoped.hints[0].createdAt.setTime(0);
      expect(
        count(await store.readHintEvidence(learnerId, exerciseId, activityId), activityId),
      ).toBe(5);
    });

    it('clears hint activity links on deletion and preserves them on rollback', async () => {
      const { store, learnerId, otherLearnerId, activityId } = await makeStore({
        persistHintActivity: true,
      });
      const query = { ids: [activityId] };
      const owners = [learnerId, otherLearnerId];
      const original = await Promise.all(
        owners.map((owner) => store.readHintEvidence(owner, exerciseId, activityId)),
      );
      expect(original.map(({ hints }) => hints.length)).toEqual([2, 1]);
      const expectCleared = async (handle: SessionStore) => {
        for (const [i, owner] of owners.entries()) {
          expect((await handle.readHintEvidence(owner, exerciseId, activityId)).hints).toEqual([]);
          const { hints } = await handle.readHintEvidence(owner, exerciseId);
          expect(hints).toEqual(
            expect.arrayContaining(
              original[i].hints.map((hint) => ({ ...hint, activityId: null })),
            ),
          );
          expect(hints).toHaveLength(original[i].hints.length);
        }
      };
      await expect(
        store.transaction(async (tx) => {
          await tx.deleteActivities(learnerId, query);
          await expectCleared(tx);
          throw new Error('rollback hint links');
        }),
      ).rejects.toThrow('rollback hint links');
      expect(
        await Promise.all(
          owners.map((owner) => store.readHintEvidence(owner, exerciseId, activityId)),
        ),
      ).toEqual(original);
      await store.transaction((tx) => tx.deleteActivities(learnerId, query));
      await expectCleared(store);
    });

    it('inserts XP only once per learner and source key and matches literal prefixes', async () => {
      const { store, learnerId, otherLearnerId } = await makeStore();
      const event = xpEvent('kp:x_%\\:first');
      expect(await store.insertXpEventOnce(learnerId, event)).toBe(true);
      expect(await store.insertXpEventOnce(learnerId, { ...event, amount: 999 })).toBe(false);
      expect(await store.insertXpEventOnce(otherLearnerId, { ...event, amount: 999 })).toBe(true);
      await store.insertXpEventOnce(learnerId, xpEvent('kp:xxZZ:first'));
      await store.insertXpEventOnce(learnerId, xpEvent('kp:x_%\\:second', later));
      await store.insertXpEventOnce(learnerId, {
        ...xpEvent('kp:x_%\\:third'),
        localDate: '2026-01-16',
      });
      const query = { sourcePrefix: 'kp:x_%\\:', localDate: event.localDate, through: date };
      const [row] = await store.listXpEvents(learnerId, query);
      expect(row).toEqual({ ...event, id: expect.any(String) });
      event.earnedAt.setTime(0);
      row.earnedAt.setTime(0);
      expect(await store.listXpEvents(learnerId, { sourceKey: event.sourceKey })).toEqual([
        { ...xpEvent(event.sourceKey), id: row.id },
      ]);
      expect(await store.listXpEvents(otherLearnerId, query)).toEqual([
        expect.objectContaining({ amount: 999 }),
      ]);
    });

    it('sums quiz-eligible XP on either side of the last quiz and excludes ineligible events', async () => {
      const { store, learnerId, otherLearnerId } = await makeStore();
      const session = await store.insertSession(learnerId, sessionRow(date));
      const [lesson, review, practice] = await store.insertActivities(learnerId, session.id, [
        activityRow(0),
        activityRow(1, { kind: 'review' }),
        activityRow(2, { kind: 'practice' }),
      ]);
      const foreign = await store.insertSession(otherLearnerId, sessionRow(date));
      const [foreignActivity] = await store.insertActivities(otherLearnerId, foreign.id, [
        activityRow(0),
      ]);
      const add = (kind: XpEvent['kind'], sourceKey: string, amount: number, earnedAt = date) =>
        store.insertXpEventOnce(learnerId, { ...xpEvent(sourceKey, earnedAt), kind, amount });
      await Promise.all([
        add('knowledge_point', 'kp:first', 100),
        add('review', 'review:later', 20, later),
        add('review', 'review:future', 999, new Date(later.getTime() + 1)),
        add('activity', `activity:${lesson.id}`, 10),
        add('activity', `activity:${review.id}`, 5, later),
        add('activity', `activity:${practice.id}`, 999),
        add('activity', `activity:${foreignActivity.id}`, 999),
        add('activity', 'activity:missing', 999),
        add('quiz', 'quiz:first', 999),
        add('mixed_quiz', 'mixed-quiz:first', 999),
        add('project', 'project:first', 999),
        store.insertXpEventOnce(otherLearnerId, xpEvent('kp:foreign')),
      ]);
      expect(await store.sumQuizEligibleXp(learnerId, later, date)).toEqual({
        throughLastQuiz: 110,
        sinceLastQuiz: 25,
      });
      expect(await store.sumQuizEligibleXp(learnerId, later)).toEqual({
        throughLastQuiz: 0,
        sinceLastQuiz: 135,
      });
      expect(await store.sumQuizEligibleXp(otherLearnerId, new Date(date.getTime() - 1))).toEqual({
        throughLastQuiz: 0,
        sinceLastQuiz: 0,
      });
    });

    it('patches settings by learner and replaces prefs without sharing JSON or dates', async () => {
      const { store, learnerId, otherLearnerId } = await makeStore();
      const prefs = { schedule: { monday: 45 } };
      const studySetInitializedAt = new Date(date);
      await store.patchSettings(learnerId, {
        activeCourseId: 'ml',
        studySetInitializedAt,
        prefs,
        startDate: '2026-01-17',
        timeZone: 'Europe/Paris',
      });
      studySetInitializedAt.setTime(0);
      prefs.schedule.monday = 5;
      const settings = await store.getSettings(learnerId);
      expect(settings).toEqual({
        activeCourseId: 'ml',
        studySetInitializedAt: date,
        prefs: { schedule: { monday: 45 } },
        startDate: '2026-01-17',
        timeZone: 'Europe/Paris',
      });
      (settings?.prefs.schedule as typeof prefs.schedule).monday = 60;
      settings?.studySetInitializedAt?.setTime(0);
      expect(await store.getSettings(learnerId)).toMatchObject({
        studySetInitializedAt: date,
        prefs: { schedule: { monday: 45 } },
      });
      await store.patchSettings(learnerId, {
        activeCourseId: null,
        prefs: {},
        studySetInitializedAt: null,
      });
      expect(await store.getSettings(learnerId)).toEqual({
        activeCourseId: null,
        studySetInitializedAt: null,
        prefs: {},
        startDate: '2026-01-17',
        timeZone: 'Europe/Paris',
      });
      expect(await store.getSettings(otherLearnerId)).toMatchObject({ prefs: {} });
    });

    it('uses the enrollment conflict policies and guarded status updates', async () => {
      const { store, learnerId, otherLearnerId } = await makeStore();
      const row: Enrollment = {
        courseId: 'ml',
        status: 'paused',
        startMethod: 'placement',
        startedAt: new Date(date),
        completedAt: null,
      };
      await store.writeEnrollments(learnerId, { kind: 'insert_missing', rows: [row] });
      await store.writeEnrollments(learnerId, {
        kind: 'insert_missing',
        rows: [{ ...row, status: 'active' }],
      });
      expect(await store.listEnrollments(learnerId)).toEqual([row]);
      await store.writeEnrollments(learnerId, {
        kind: 'start',
        row: {
          ...row,
          status: 'active',
          startMethod: 'beginning',
          startedAt: later,
        },
      });
      const [started] = await store.listEnrollments(learnerId);
      expect(started).toEqual({ ...row, status: 'active' });
      started.startedAt.setTime(0);
      await store.writeEnrollments(learnerId, {
        kind: 'complete',
        courseIds: ['ml', 'math'],
        now: later,
      });
      expect(await store.listEnrollments(learnerId)).toEqual(
        expect.arrayContaining([
          { ...row, startedAt: date, status: 'completed', completedAt: later },
          {
            courseId: 'math',
            startedAt: later,
            startMethod: 'beginning',
            status: 'completed',
            completedAt: later,
          },
        ]),
      );
      const reopen = {
        kind: 'set_status',
        courseIds: ['ml', 'absent'],
        status: 'active',
        completedAt: null,
      } as const;
      await store.writeEnrollments(learnerId, { ...reopen, ifStatus: 'paused' });
      expect(
        (await store.listEnrollments(learnerId)).find(({ courseId }) => courseId === 'ml')?.status,
      ).toBe('completed');
      await store.writeEnrollments(learnerId, { ...reopen, ifStatus: 'completed' });
      expect(await store.listEnrollments(learnerId)).toEqual(
        expect.arrayContaining([
          { ...row, status: 'active' },
          expect.objectContaining({ courseId: 'math', status: 'completed' }),
        ]),
      );
      expect(await store.listEnrollments(learnerId)).toHaveLength(2);
      expect(await store.listEnrollments(otherLearnerId)).toEqual([]);
    });

    it('uses one scoped handle for legacy and core writes and rolls back nested and outer work', async () => {
      const { store, learnerId } = await makeStore();
      const error = new Error('rollback');
      await expect(
        store.transaction(async (tx) => {
          await tx.lockLearner(learnerId, 'no_key_update');
          await tx.saveMastery(learnerId, initialMastery('vectors', 'math'));
          await tx.insertXpEventOnce(learnerId, xpEvent('parent'));
          await expect(
            tx.transaction(async (nested) => {
              expect(await nested.insertXpEventOnce(learnerId, xpEvent('parent'))).toBe(false);
              await nested.insertAttempt(learnerId, attempt(1));
              await nested.addTopicSpeedAnswer(learnerId, 'vectors', true, date);
              throw error;
            }),
          ).rejects.toBe(error);
          expect(await tx.listAttempts(learnerId, {})).toEqual([]);
          expect(await tx.listTopicSpeedEvidence(learnerId)).toEqual([]);
          await tx.transaction(async (nested) => {
            await nested.lockLearner(learnerId, 'update');
            await nested.insertXpEventOnce(learnerId, xpEvent('child'));
          });
          expect(await tx.listXpEvents(learnerId, {})).toHaveLength(2);
          throw error;
        }),
      ).rejects.toBe(error);
      expect(await store.listMastery(learnerId)).toEqual([]);
      expect(await store.listXpEvents(learnerId, {})).toEqual([]);
      expect(
        await store.transaction(async (tx) => tx.insertAttempt(learnerId, attempt(1))),
      ).toEqual(attempt(1));
      expect(await store.listAttempts(learnerId, {})).toEqual([attempt(1)]);
    });
    it('returns empty lists and undefined getters for a new learner', async () => {
      const { store, learnerId } = await makeStore();
      expect(await store.listMastery(learnerId)).toEqual([]);
      expect(await store.listTopicSpeedEvidence(learnerId)).toEqual([]);
      expect(await store.getMastery(learnerId, 'vectors', 'math')).toBeUndefined();
      expect(await store.listReviewCards(learnerId)).toEqual([]);
      expect(await store.getReviewCard(learnerId, 'vectors', 'math')).toBeUndefined();
      expect(await store.listOpenRemediationFlags(learnerId)).toEqual([]);
    });

    it('round-trips every mastery field and overwrites on a second save', async () => {
      const { store, learnerId } = await makeStore();
      const record: MasteryRecord = {
        conceptId: 'vectors',
        dimension: 'math',
        state: 'independent',
        provisional: true,
        inferred: true,
        independentItemIds: ['vectors-1'],
        independentDeterministicCount: 1,
        lastIndependentCorrect: true,
        lastAssessedAt: '2026-01-17T12:00:00.000Z',
        lastIndependentAt: '2026-01-14T12:00:00.000Z',
        firstIndependentAt: '2026-01-13T12:00:00.000Z',
        attempts: [
          {
            attemptId: 'attempt-1',
            exerciseId: 'vectors-1',
            correct: 1,
            credit: 1,
            hintsUsed: 0,
            attemptNo: 1,
            mode: 'practice',
            itemRole: 'core',
            gradedBy: 'deterministic',
            independent: true,
            createdAt: '2026-01-13T12:00:00.000Z',
          },
        ],
      };
      await store.saveMastery(learnerId, record);
      expect(await store.getMastery(learnerId, 'vectors', 'math')).toEqual(record);
      const updated = initialMastery('vectors', 'math');
      await store.saveMastery(learnerId, updated);
      expect(await store.getMastery(learnerId, 'vectors', 'math')).toEqual(updated);
      expect(await store.listMastery(learnerId)).toEqual([updated]);
    });

    it('orders mastery by concept then dimension', async () => {
      const { store, learnerId } = await makeStore();
      const algebraMath = initialMastery('algebra', 'math');
      const algebraConceptual = initialMastery('algebra', 'conceptual');
      const vectorsMath = initialMastery('vectors', 'math');
      for (const record of [vectorsMath, algebraMath, algebraConceptual]) {
        await store.saveMastery(learnerId, record);
      }
      expect(await store.listMastery(learnerId)).toEqual([
        algebraConceptual,
        algebraMath,
        vectorsMath,
      ]);
    });

    it('returns an inserted review card and rejects a duplicate', async () => {
      const { store, learnerId } = await makeStore();
      const card = cardFor('vectors');
      const inserted = await store.insertReviewCard(learnerId, card);
      expect(inserted.id).toBeTruthy();
      expect(inserted).toMatchObject({
        ...card,
        fsrs: { state: card.fsrs.state, reps: card.fsrs.reps },
      });
      expect(await store.getReviewCard(learnerId, 'vectors', 'math')).toEqual(inserted);
      await expect(store.insertReviewCard(learnerId, card)).rejects.toThrow();
    });

    it('upserts, sorts, filters and deep copies topic speed evidence', async () => {
      const { store, learnerId } = await makeStore();
      const vectors = {
        conceptId: 'vectors',
        successes: 1.5,
        trials: 2.5,
        answers: 3,
        updatedAt: new Date(date),
        policyVersion: 'speed-v1',
      };
      const algebra = { ...vectors, conceptId: 'algebra', updatedAt: new Date(date) };
      await store.saveTopicSpeedEvidence(learnerId, vectors);
      await store.saveTopicSpeedEvidence(learnerId, algebra);
      vectors.updatedAt.setUTCDate(1);
      const ordered = await store.listTopicSpeedEvidence(learnerId, ['vectors', 'algebra']);
      expect(ordered).toEqual([algebra, { ...vectors, updatedAt: date }]);
      ordered[0].updatedAt.setUTCDate(2);
      ordered[0].successes = 0;
      expect(await store.listTopicSpeedEvidence(learnerId, ['algebra'])).toEqual([algebra]);
      expect(await store.listTopicSpeedEvidence(learnerId, [])).toEqual([]);
      const updated = { ...algebra, conceptId: 'vectors', successes: 2, answers: 4 };
      await store.saveTopicSpeedEvidence(learnerId, updated);
      expect(await store.listTopicSpeedEvidence(learnerId)).toEqual([algebra, updated]);
      await store.addTopicSpeedAnswer(learnerId, 'vectors', true, date);
      expect(await store.listTopicSpeedEvidence(learnerId, ['vectors'])).toEqual([
        { ...updated, successes: expect.closeTo(2.6), trials: 3, answers: 5 },
      ]);
    });

    it('orders all and filtered review cards by concept and dimension', async () => {
      const { store, learnerId } = await makeStore();
      const vectors = await store.insertReviewCard(learnerId, cardFor('vectors'));
      const matrices = await store.insertReviewCard(learnerId, cardFor('matrices'));
      const algebraMath = await store.insertReviewCard(learnerId, cardFor('algebra'));
      const algebraConceptual = await store.insertReviewCard(
        learnerId,
        cardFor('algebra', 'conceptual'),
      );
      expect(await store.listReviewCards(learnerId)).toEqual([
        algebraConceptual,
        algebraMath,
        matrices,
        vectors,
      ]);
      expect(await store.listReviewCards(learnerId, ['vectors', 'algebra'])).toEqual([
        algebraConceptual,
        algebraMath,
        vectors,
      ]);
      expect(await store.listReviewCards(learnerId, [])).toEqual([]);
    });

    it('records a review on a new card and then updates the same card', async () => {
      const { store, learnerId } = await makeStore();
      const firstReview = scheduleReview(newReviewCard(date), date, Rating.Good, 'UTC', false);
      await store.recordReview(learnerId, 'vectors', 'math', (current) => {
        expect(current).toBeUndefined();
        return {
          card: {
            fsrs: firstReview.card,
            dueAt: firstReview.card.due,
            lastReviewAt: date,
            reps: firstReview.card.reps,
            lapses: firstReview.card.lapses,
          },
          log: { rating: Rating.Good, fsrsLog: firstReview.log, createdAt: date },
        };
      });
      const first = await store.getReviewCard(learnerId, 'vectors', 'math');
      expect(first).toMatchObject({
        dueAt: firstReview.card.due,
        lastReviewAt: date,
        reps: firstReview.card.reps,
      });

      const now = firstReview.card.due;
      const secondReview = scheduleReview(firstReview.card, now, Rating.Again, 'UTC', false);
      await store.recordReview(learnerId, 'vectors', 'math', (current) => {
        expect(current).toEqual(first);
        return {
          card: {
            fsrs: { ...secondReview.card, due: now },
            dueAt: now,
            lastReviewAt: now,
            reps: secondReview.card.reps,
            lapses: secondReview.card.lapses,
          },
          log: { rating: Rating.Again, fsrsLog: secondReview.log, createdAt: now },
        };
      });
      const cards = await store.listReviewCards(learnerId);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({
        id: first?.id,
        dueAt: now,
        lastReviewAt: now,
        reps: secondReview.card.reps,
        lapses: secondReview.card.lapses,
      });
      expect(new Date(cards[0].fsrs.due)).toEqual(now);
    });

    it('updates only FSRS and dueAt on a match and leaves a stale card unchanged', async () => {
      const { store, learnerId } = await makeStore();
      const inserted = await store.insertReviewCard(learnerId, cardFor('vectors'));
      const dueAt = new Date('2026-01-18T12:00:00.000Z');
      const fsrs = { ...inserted.fsrs, reps: 2, due: dueAt };
      expect(await store.updateReviewCardIfDue(learnerId, inserted.id, date, { fsrs, dueAt })).toBe(
        true,
      );
      const updated = await store.getReviewCard(learnerId, 'vectors', 'math');
      expect(updated).toEqual({ ...inserted, dueAt, fsrs: { ...fsrs, due: updated?.fsrs.due } });
      expect(new Date(updated?.fsrs.due ?? 0)).toEqual(dueAt);
      expect(await store.updateReviewCardIfDue(learnerId, inserted.id, date, inserted)).toBe(false);
      expect(await store.getReviewCard(learnerId, 'vectors', 'math')).toEqual(updated);
    });

    it('lists open flags but omits the resolved flag', async () => {
      const { store, learnerId, addOpenFlag, resolveOpenFlag } = await makeStore();
      await addOpenFlag('vectors', 'algebra');
      const [flag] = await store.listOpenRemediationFlags(learnerId);
      expect(flag).toEqual({
        id: expect.any(String),
        conceptId: 'vectors',
        targetPrereqId: 'algebra',
      });
      await addOpenFlag('matrices', null);
      await resolveOpenFlag(flag.id);
      expect(await store.listOpenRemediationFlags(learnerId)).toEqual([
        { id: expect.any(String), conceptId: 'matrices', targetPrereqId: null },
      ]);
    });

    it('isolates learners for both reads and compare-and-set', async () => {
      const { store, learnerId, addOpenFlag } = await makeStore();
      const other = '00000000-0000-4000-8000-000000000002';
      await store.saveMastery(learnerId, initialMastery('vectors', 'math'));
      await store.addTopicSpeedAnswer(learnerId, 'vectors', true, date);
      const card = await store.insertReviewCard(learnerId, cardFor('vectors'));
      await addOpenFlag('vectors', null);

      expect(await store.listMastery(other)).toEqual([]);
      expect(await store.listTopicSpeedEvidence(other)).toEqual([]);
      expect(await store.getMastery(other, 'vectors', 'math')).toBeUndefined();
      expect(await store.listReviewCards(other)).toEqual([]);
      expect(await store.getReviewCard(other, 'vectors', 'math')).toBeUndefined();
      expect(await store.listOpenRemediationFlags(other)).toEqual([]);
      expect(await store.updateReviewCardIfDue(other, card.id, card.dueAt, card)).toBe(false);
    });
  });
}
