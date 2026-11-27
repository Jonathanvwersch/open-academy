import { studyCourseIds } from '../course/study-set.js';
import type { ContentIndex } from '../course/types.js';
import { topicIsComplete } from '../graph/course-status.js';
import { activeCourseFor, courseFoundations, masteryKey } from '../graph/prerequisites.js';
import type { GradeResult } from '../lessons/grading/types.js';
import { applyMastery, ensureReviewCard } from '../memory/mastery-service.js';
import { initialMastery, masteryRank } from '../memory/types.js';
import { loadSchedulerState } from '../planner/load-scheduler-state.js';
import { planSession, sessionBudget } from '../planner/scheduler.js';
import type { SessionPreferences } from '../planner/session-budget.js';
import { localDateKey, sessionKindForDate } from '../progress/xp.js';
import type { DiagnosticRun, PlacementReviewStore } from '../store/placement-review-store.js';
import { placementGrantStates, recordPlacementGrants } from './grant-commands.js';
import {
  createPlacementState,
  nextPlacementExercise,
  PLACEMENT_MAX_QUESTIONS,
  type PlacementState,
  placementComplete,
  recordPlacementAnswer,
} from './placement.js';

type PlacementCommand = {
  userId: string;
  timeZone: string;
  now: () => Date;
  newId: () => string;
  enableFsrsFuzz: boolean;
};
type PlacementAnswer = {
  exerciseId: string;
  durationMs?: number;
} & ({ answer: unknown } | { dontKnow: true });

async function placementProgress(store: PlacementReviewStore, learnerId: string) {
  const [mastery, lessonRuns] = await Promise.all([
    store.listMastery(learnerId),
    store.listLessonRuns(learnerId),
  ]);
  return { mastery, lessonRuns };
}

export async function activePlacementRuns(store: PlacementReviewStore, learnerId: string) {
  return (await store.listDiagnosticRuns(learnerId, { status: 'active' })).filter(
    ({ kind }) => kind === 'placement',
  );
}

export async function getPlacementRun(store: PlacementReviewStore, learnerId: string, id: string) {
  const [run] = await store.listDiagnosticRuns(learnerId, { id });
  return run?.kind === 'placement' ? run : undefined;
}

function startCourse(store: PlacementReviewStore, userId: string, courseId: string, now: Date) {
  return store.writeEnrollments(userId, {
    kind: 'start',
    row: {
      courseId,
      status: 'active',
      startMethod: 'placement',
      startedAt: now,
      completedAt: null,
    },
  });
}

async function completeRun(
  store: PlacementReviewStore,
  command: PlacementCommand,
  runId: string,
  state: PlacementState,
  content: ContentIndex,
) {
  const { userId, timeZone, enableFsrsFuzz } = command;
  const now = command.now();
  const { mastery } = await placementProgress(store, userId);
  const assessedAt = command.now();
  const grants = await recordPlacementGrants({
    store,
    userId,
    runId,
    state,
    content,
    now: assessedAt,
  });
  const masteryByKey = new Map(
    mastery.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
  );
  for (const conceptId of state.known) {
    const concept = content.conceptsById.get(conceptId);
    const grant = grants.get(conceptId);
    if (!concept || !grant) continue;
    for (const dimension of concept.dimensions) {
      const key = masteryKey(conceptId, dimension);
      const record = masteryByKey.get(key) ?? initialMastery(conceptId, dimension);
      const fromState = record.state;
      if (grant === 'confirmed' && record.provisional) {
        record.provisional = false;
        await store.saveMastery(userId, record);
      }
      if (masteryRank(record.state) < masteryRank('independent')) {
        record.state = 'independent';
        record.provisional = grant === 'conditional';
        record.lastAssessedAt = assessedAt.toISOString();
        await store.saveMastery(userId, record);
        masteryByKey.set(key, record);
        await store.addMasteryEvent(userId, {
          conceptId,
          dimension,
          fromState,
          toState: record.state,
          rule: 'placement_placed_out',
          attemptId: null,
          createdAt: assessedAt,
        });
      }
      await ensureReviewCard(store, {
        learnerId: userId,
        conceptId,
        dimension,
        correct: 1,
        hintsUsed: 0,
        attemptNo: 1,
        now: assessedAt,
        timeZone,
        enableFuzz: enableFsrsFuzz,
      });
    }
  }
  await store.patchDiagnosticRun(userId, runId, {
    state,
    status: 'completed',
    completedAt: now,
    summary: state,
  });
  await startCourse(store, userId, state.courseId, now);
}

export async function startPlacement(
  store: PlacementReviewStore,
  command: PlacementCommand,
  requestedCourseId: string | undefined,
  loadContent: () => Promise<ContentIndex>,
) {
  const { userId, now } = command;
  return store.transaction(async (tx) => {
    await tx.lockLearner(userId, 'update');
    const content = await loadContent();
    const settings = await tx.getSettings(userId);
    const studyIds = await studyCourseIds(tx, userId, content, now, settings);
    const course = activeCourseFor(
      content,
      requestedCourseId !== undefined && content.coursesById.has(requestedCourseId)
        ? requestedCourseId
        : (studyIds[0] ?? settings?.activeCourseId),
    );
    if (!course) return { kind: 'no_course' as const };
    const activeRun = (
      await tx.listDiagnosticRuns(userId, { courseId: course.id, status: 'active' })
    ).find(({ kind }) => kind === 'placement');
    const state = activeRun ? (activeRun.state as PlacementState) : createPlacementState(course.id);
    const progress = await placementProgress(tx, userId);
    const complete = placementComplete(state, content, progress.mastery, progress.lessonRuns);
    if (activeRun) {
      if (complete) await completeRun(tx, command, activeRun.id, state, content);
      return { kind: 'existing' as const, id: activeRun.id };
    }
    const run = await tx.insertDiagnosticRun(userId, {
      courseId: course.id,
      kind: 'placement',
      status: complete ? 'completed' : 'active',
      state,
      startedAt: now(),
      completedAt: complete ? now() : null,
      summary: complete ? state : {},
    });
    if (complete) await startCourse(tx, userId, course.id, now());
    return { kind: 'created' as const, id: run.id };
  });
}

export async function placementNext(
  store: PlacementReviewStore,
  learnerId: string,
  run: DiagnosticRun,
  content: ContentIndex,
) {
  const state = run.state as PlacementState;
  const progress = await placementProgress(store, learnerId);
  const exercise = nextPlacementExercise(state, content, progress.mastery, progress.lessonRuns);
  if (!exercise) return { complete: true as const };
  return {
    complete: false as const,
    courseTitle: content.coursesById.get(state.courseId)?.title ?? '',
    questionNumber: state.answers.length + 1,
    maxQuestions: PLACEMENT_MAX_QUESTIONS,
    exercise,
  };
}

/** The caller keeps this transaction open through grading and the answer write. */
export async function preparePlacementAnswer(
  store: PlacementReviewStore,
  learnerId: string,
  id: string,
  answer: PlacementAnswer | undefined,
  loadContent: () => Promise<ContentIndex>,
) {
  const [run] = await store.listDiagnosticRuns(learnerId, { id, forUpdate: true });
  if (!answer) return { kind: 'invalid' as const };
  if (run?.kind !== 'placement') return { kind: 'not_found' as const };
  if (run.status !== 'active') return { kind: 'inactive' as const };
  const content = await loadContent();
  const state = run.state as PlacementState;
  const progress = await placementProgress(store, learnerId);
  const exercise = nextPlacementExercise(state, content, progress.mastery, progress.lessonRuns);
  if (!exercise || exercise.id !== answer.exerciseId) return { kind: 'stale' as const };
  return { kind: 'ready' as const, runId: run.id, state, progress, exercise, answer, content };
}

type PreparedAnswer = Extract<
  Awaited<ReturnType<typeof preparePlacementAnswer>>,
  { kind: 'ready' }
>;

export async function answerPlacement(
  store: PlacementReviewStore,
  command: PlacementCommand,
  prepared: PreparedAnswer,
  grade: Extract<GradeResult, { status: 'graded' }>,
) {
  const { userId, timeZone, enableFsrsFuzz } = command;
  const { exercise, state, content, runId, progress, answer } = prepared;
  const submitted = 'answer' in answer;
  const now = command.now();
  const gradedBy = grade.graded_by ?? 'deterministic';
  const attempt = await store.insertAttempt(userId, {
    id: command.newId(),
    sessionId: null,
    activityId: null,
    exerciseId: exercise.id,
    exerciseVersion: exercise.contentVersion,
    conceptId: exercise.concept,
    dimension: exercise.dimension,
    mode: 'diagnostic',
    answer: submitted ? answer.answer : { dontKnow: true },
    correct: grade.correct,
    credit: grade.credit,
    hintsUsed: 0,
    attemptNo: 1,
    gradedBy,
    feedback: { message: grade.feedback },
    mistakeCategory: null,
    durationMs: answer.durationMs ?? null,
    createdAt: now,
  });
  await applyMastery(store, {
    learnerId: userId,
    exercise,
    attemptId: attempt.id,
    correct: grade.correct,
    credit: grade.credit,
    hintsUsed: 0,
    attemptNo: 1,
    submitted,
    mode: 'diagnostic',
    gradedBy,
    now,
    timeZone,
    enableFuzz: enableFsrsFuzz,
  });
  const nextState = recordPlacementAnswer(
    state,
    {
      conceptId: exercise.concept,
      exerciseId: exercise.id,
      correct: grade.correct >= 1,
      attemptId: attempt.id,
    },
    content,
    progress.mastery,
    progress.lessonRuns,
  );
  const updated = await placementProgress(store, userId);
  const complete = placementComplete(nextState, content, updated.mastery, updated.lessonRuns);
  if (complete) await completeRun(store, command, runId, nextState, content);
  else await store.patchDiagnosticRun(userId, runId, { state: nextState });
  return { complete };
}

export async function placementResults(
  store: PlacementReviewStore,
  command: PlacementCommand,
  run: DiagnosticRun,
  content: ContentIndex,
) {
  const { userId, timeZone, now, enableFsrsFuzz } = command;
  const state = run.state as PlacementState;
  const course = content.coursesById.get(state.courseId);
  if (!course) return undefined;
  const { mastery, lessonRuns } = await placementProgress(store, userId);
  const grants = await placementGrantStates(store, userId);
  const known = new Set(
    state.known.filter((id) => grants.has(id) && grants.get(id) !== 'withdrawn'),
  );
  const movedBack = state.known.filter((id) => grants.get(id) === 'withdrawn');
  const topicIds = course.units.flatMap(({ concepts }) => concepts);
  const masteryByKey = new Map(
    mastery.map((row) => [masteryKey(row.conceptId, row.dimension), row.state]),
  );
  const runByConcept = new Map(lessonRuns.map(({ conceptId, status }) => [conceptId, status]));
  const topicsDone = topicIds.filter((id) => {
    const concept = content.conceptsById.get(id);
    return (
      concept &&
      topicIsComplete(
        runByConcept.get(id),
        concept.dimensions.map(
          (dimension) => masteryByKey.get(masteryKey(id, dimension)) ?? 'not_assessed',
        ),
      )
    );
  }).length;
  const settings = await store.getSettings(userId);
  const date = now();
  const schedulerState = await loadSchedulerState(store, userId, content, date, {
    settings: settings ?? null,
    studyCourseIds: studyCourseIds(store, userId, content, now, settings),
    enableFsrsFuzz,
  });
  const prefs = (settings?.prefs ?? {}) as SessionPreferences;
  const localDate = localDateKey(now(), timeZone);
  const sessionKind = sessionKindForDate(localDate);
  const firstTopic = planSession(
    {
      ...schedulerState,
      activeCourseId: state.courseId,
      studyCourseIds: [
        state.courseId,
        ...schedulerState.studyCourseIds.filter((id) => id !== state.courseId),
      ],
    },
    content,
    now(),
    sessionBudget(sessionKind, prefs, localDate),
    sessionKind,
  ).activities.find((activity) => activity.kind === 'learn')?.conceptId;
  return {
    courseId: course.id,
    courseTitle: course.title,
    placedOut: [...new Set(topicIds)].flatMap((id) => {
      const concept = content.conceptsById.get(id);
      return known.has(id) && concept ? [concept.title] : [];
    }),
    foundationsPlacedOut: courseFoundations(content, course.id)
      .filter(({ id }) => known.has(id))
      .map(({ title }) => title),
    movedBack: movedBack.map((id) => content.conceptsById.get(id)?.title ?? id),
    topicsTotal: topicIds.length,
    topicsDone,
    firstTopic: firstTopic ? (content.conceptsById.get(firstTopic)?.title ?? firstTopic) : null,
  };
}
