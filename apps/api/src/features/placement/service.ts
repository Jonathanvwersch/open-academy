import { serializeExercise } from '@academy/aesop/course/serialize';
import { activeCourseFor, courseFoundations, masteryKey } from '@academy/aesop/graph/prerequisites';
import { gradeExercise } from '@academy/aesop/lessons/grading/index';
import { applyMastery, ensureReviewCard } from '@academy/aesop/memory/mastery-service';
import { initialMastery, masteryRank } from '@academy/aesop/memory/types';
import {
  createPlacementState,
  nextPlacementExercise,
  PLACEMENT_MAX_QUESTIONS,
  type PlacementState,
  placementComplete,
  recordPlacementAnswer,
} from '@academy/aesop/placement/placement';
import { planSession, sessionBudget } from '@academy/aesop/planner/scheduler';
import type { SessionPreferences } from '@academy/aesop/planner/session-budget';
import { localDateKey, sessionKindForDate } from '@academy/aesop/progress/xp';
import { emptyAnswerMessage } from '@academy/shared/answer-validation';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { drizzleLearnerStore } from '../../db/learner-store.js';
import { LearnerRepository } from '../../db/repository.js';
import { attempts, diagnosticRuns, lessonRuns, masteryEvents, users } from '../../db/schema.js';
import { fsrsFuzzEnabled } from '../../learning/fsrs-fuzz.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';
import { buildCoursePayload } from '../course/service.js';

const answerBody = z.union([
  z.object({ exerciseId: z.string(), dontKnow: z.literal(true) }),
  z.object({ exerciseId: z.string(), answer: z.unknown() }),
]);

async function placementProgress(request: FeatureRequest) {
  const [mastery, lessonRunRows] = await Promise.all([
    request.repo.masteryRecords(),
    request.repo.db.select().from(lessonRuns).where(eq(lessonRuns.userId, request.userId)),
  ]);
  return { mastery, lessonRuns: lessonRunRows };
}

function stateFor(run: { state: unknown }): PlacementState {
  return run.state as PlacementState;
}

async function creditPlacedOut(
  request: FeatureRequest,
  state: PlacementState,
  content: Awaited<ReturnType<FeatureServices['content']>>,
) {
  const { mastery } = await placementProgress(request);
  const now = request.now();
  const masteryByKey = new Map(
    mastery.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
  );
  for (const conceptId of state.known) {
    const concept = content.conceptsById.get(conceptId);
    if (!concept) continue;
    for (const dimension of concept.dimensions) {
      const key = masteryKey(conceptId, dimension);
      const record = masteryByKey.get(key) ?? initialMastery(conceptId, dimension);
      const fromState = record.state;
      if (masteryRank(record.state) < masteryRank('independent')) {
        record.state = 'independent';
        record.provisional = true;
        record.lastAssessedAt = now.toISOString();
        await request.repo.saveMastery(record);
        masteryByKey.set(key, record);
        await request.repo.db.insert(masteryEvents).values({
          userId: request.userId,
          conceptId,
          dimension,
          fromState,
          toState: record.state,
          rule: 'placement_placed_out',
          createdAt: now,
        });
      }
      await ensureReviewCard(drizzleLearnerStore(request.repo.db), {
        learnerId: request.userId,
        conceptId,
        dimension,
        correct: 1,
        hintsUsed: 0,
        attemptNo: 1,
        now,
        timeZone: request.timeZone,
        enableFuzz: fsrsFuzzEnabled(),
      });
    }
  }
}

async function completeRun(
  request: FeatureRequest,
  runId: string,
  state: PlacementState,
  content: Awaited<ReturnType<FeatureServices['content']>>,
) {
  const now = request.now();
  await creditPlacedOut(request, state, content);
  await request.repo.db
    .update(diagnosticRuns)
    .set({ state, status: 'completed', completedAt: now, summary: state })
    .where(eq(diagnosticRuns.id, runId));
  await request.repo.startCourse(state.courseId, 'placement', now);
}

export async function postPlacement(deps: FeatureServices, request: FeatureRequest) {
  return deps.db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, request.userId)).for('update');
    const db = tx as unknown as Database;
    return startPlacement(
      { ...deps, db },
      { ...request, repo: new LearnerRepository(db, request.userId) },
    );
  });
}

async function startPlacement(deps: FeatureServices, request: FeatureRequest) {
  const content = await deps.content();
  const body = request.body as { courseId?: unknown } | null;
  const storedCourseId = await request.repo.activeCourseId();
  const studyCourseIds = await request.repo.studyCourseIds(content);
  const courseId =
    typeof body?.courseId === 'string' && content.coursesById.has(body.courseId)
      ? body.courseId
      : (studyCourseIds[0] ?? storedCourseId);
  const course = activeCourseFor(content, courseId);
  if (!course) return serviceResult({ error: 'No active course' }, 404);
  const activeRun = await request.repo.activePlacementRun(course.id);
  if (activeRun) {
    const state = stateFor(activeRun);
    const progress = await placementProgress(request);
    if (placementComplete(state, content, progress.mastery, progress.lessonRuns)) {
      await completeRun(request, activeRun.id, state, content);
    }
    return serviceResult({ id: activeRun.id }, 200);
  }

  const state = createPlacementState(course.id);
  const progress = await placementProgress(request);
  const complete = placementComplete(state, content, progress.mastery, progress.lessonRuns);
  const [run] = await deps.db
    .insert(diagnosticRuns)
    .values({
      userId: request.userId,
      kind: 'placement',
      status: complete ? 'completed' : 'active',
      state,
      startedAt: request.now(),
      completedAt: complete ? request.now() : null,
      summary: complete ? state : {},
    })
    .returning();
  if (complete) await request.repo.startCourse(course.id, 'placement', request.now());
  return serviceResult({ id: run.id }, 201);
}

export async function getPlacementNext(deps: FeatureServices, request: FeatureRequest) {
  const run = await request.repo.placementRun(request.params.id);
  if (!run) return serviceResult({ error: 'Placement not found' }, 404);
  const state = stateFor(run);
  const content = await deps.content();
  const progress = await placementProgress(request);
  const exercise = nextPlacementExercise(state, content, progress.mastery, progress.lessonRuns);
  if (!exercise) return serviceResult({ complete: true });
  const course = content.coursesById.get(state.courseId);
  return serviceResult({
    complete: false,
    courseTitle: course?.title ?? '',
    questionNumber: state.answers.length + 1,
    maxQuestions: PLACEMENT_MAX_QUESTIONS,
    exercise: serializeExercise(exercise, request.userId),
  });
}

export async function postPlacementAnswer(deps: FeatureServices, request: FeatureRequest) {
  if (!z.string().uuid().safeParse(request.params.id).success)
    return serviceResult({ error: 'Placement not found' }, 404);
  return deps.db.transaction(async (tx) => {
    await tx
      .select({ id: diagnosticRuns.id })
      .from(diagnosticRuns)
      .where(
        and(eq(diagnosticRuns.id, request.params.id), eq(diagnosticRuns.userId, request.userId)),
      )
      .for('update');
    const db = tx as unknown as Database;
    return answerPlacement(
      { ...deps, db },
      { ...request, repo: new LearnerRepository(db, request.userId) },
    );
  });
}

async function answerPlacement(deps: FeatureServices, request: FeatureRequest) {
  const body = answerBody.safeParse(request.body);
  if (!body.success) return serviceResult({ error: 'Invalid placement answer' }, 400);
  const run = await request.repo.placementRun(request.params.id);
  if (!run) return serviceResult({ error: 'Placement not found' }, 404);
  if (run.status !== 'active') return serviceResult({ error: 'Placement is not active' }, 409);
  const content = await deps.content();
  const state = stateFor(run);
  const progress = await placementProgress(request);
  const exercise = nextPlacementExercise(state, content, progress.mastery, progress.lessonRuns);
  if (!exercise || exercise.id !== body.data.exerciseId) {
    return serviceResult({ error: 'This is not the current placement item.' }, 409);
  }
  let answer: unknown;
  let result: Awaited<ReturnType<typeof gradeExercise>>;
  if ('answer' in body.data) {
    answer = body.data.answer;
    const emptyMessage = emptyAnswerMessage(exercise.type, answer);
    if (emptyMessage) return serviceResult({ error: emptyMessage }, 422);
    result = await gradeExercise(exercise, answer);
  } else {
    answer = { dontKnow: true };
    result = { status: 'graded', correct: 0, credit: 0, feedback: '', graded_by: 'self' };
  }
  if (result.status !== 'graded') {
    return serviceResult({ error: 'Answer could not be graded' }, 422);
  }
  const now = request.now();
  const [attempt] = await deps.db
    .insert(attempts)
    .values({
      userId: request.userId,
      exerciseId: exercise.id,
      exerciseVersion: exercise.contentVersion,
      conceptId: exercise.concept,
      dimension: exercise.dimension,
      mode: 'diagnostic',
      answer,
      correct: result.correct,
      credit: result.credit,
      hintsUsed: 0,
      attemptNo: 1,
      gradedBy: result.graded_by ?? 'deterministic',
      feedback: { message: result.feedback },
      createdAt: now,
    })
    .returning();
  await applyMastery(drizzleLearnerStore(request.repo.db), {
    learnerId: request.userId,
    exercise,
    attemptId: attempt.id,
    correct: result.correct,
    credit: result.credit,
    hintsUsed: 0,
    attemptNo: 1,
    mode: 'diagnostic',
    gradedBy: result.graded_by ?? 'deterministic',
    now,
    timeZone: request.timeZone,
    enableFuzz: fsrsFuzzEnabled(),
  });
  const nextState = recordPlacementAnswer(
    state,
    {
      conceptId: exercise.concept,
      exerciseId: exercise.id,
      correct: result.correct >= 1,
    },
    content,
    progress.mastery,
    progress.lessonRuns,
  );
  const updatedProgress = await placementProgress(request);
  const complete = placementComplete(
    nextState,
    content,
    updatedProgress.mastery,
    updatedProgress.lessonRuns,
  );
  if (complete) {
    await completeRun(request, run.id, nextState, content);
  } else {
    await deps.db
      .update(diagnosticRuns)
      .set({ state: nextState })
      .where(eq(diagnosticRuns.id, run.id));
  }
  return serviceResult({ complete });
}

export async function getPlacementResults(deps: FeatureServices, request: FeatureRequest) {
  const run = await request.repo.placementRun(request.params.id);
  if (!run) return serviceResult({ error: 'Placement not found' }, 404);
  if (run.status !== 'completed') {
    return serviceResult({ error: 'Placement is not complete' }, 409);
  }
  const content = await deps.content();
  const state = stateFor(run);
  const course = content.coursesById.get(state.courseId);
  if (!course) return serviceResult({ error: 'Placement course not found' }, 404);
  const progress = await placementProgress(request);
  const known = new Set(state.known);
  const unitConcepts = [...new Set(course.units.flatMap((unit) => unit.concepts))];
  const courseProgress = buildCoursePayload(
    content,
    course.id,
    progress.mastery,
    progress.lessonRuns,
  ).courses.find((entry) => entry.id === course.id);
  if (!courseProgress) return serviceResult({ error: 'Placement course not found' }, 404);
  const user = await request.repo.user();
  const schedulerState = await request.repo.schedulerState(request.now(), content);
  const prefs = (user?.prefs ?? {}) as SessionPreferences;
  const localDate = localDateKey(request.now(), request.timeZone);
  const sessionKind = sessionKindForDate(localDate);
  const firstTopic =
    planSession(
      {
        ...schedulerState,
        activeCourseId: state.courseId,
        studyCourseIds: [
          state.courseId,
          ...schedulerState.studyCourseIds.filter((courseId) => courseId !== state.courseId),
        ],
      },
      content,
      request.now(),
      sessionBudget(sessionKind, prefs, localDate),
      sessionKind,
    ).activities.find((activity) => activity.kind === 'learn')?.conceptId ?? null;
  return serviceResult({
    courseId: course.id,
    courseTitle: course.title,
    placedOut: unitConcepts.flatMap((conceptId) => {
      if (!known.has(conceptId)) return [];
      const concept = content.conceptsById.get(conceptId);
      return concept ? [concept.title] : [];
    }),
    foundationsPlacedOut: courseFoundations(content, course.id)
      .filter((concept) => known.has(concept.id))
      .map((concept) => concept.title),
    topicsTotal: courseProgress.topicsTotal,
    topicsDone: courseProgress.topicsDone,
    firstTopic: firstTopic ? (content.conceptsById.get(firstTopic)?.title ?? firstTopic) : null,
  });
}
