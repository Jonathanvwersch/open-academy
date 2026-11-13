import { emptyAnswerMessage } from '@academy/shared/answer-validation';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { serializeExercise } from '../../content/serialize.js';
import { attempts, diagnosticRuns, masteryEvents } from '../../db/schema.js';
import {
  createDiagnosticState,
  diagnosticComplete,
  markDiagnosticUnassessed,
  nextDiagnosticExercise,
  recordDiagnosticAnswer,
} from '../../learning/diagnostic.js';
import { gradeExercise } from '../../learning/grading/index.js';
import { inferPrerequisite } from '../../learning/mastery.js';
import { applyMastery } from '../../learning/mastery-service.js';
import { planSession, sessionBudget } from '../../learning/scheduler.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';

export async function postDiagnostic(deps: FeatureServices, request: FeatureRequest) {
  const { db, content } = deps;
  const active = await db
    .select()
    .from(diagnosticRuns)
    .where(and(eq(diagnosticRuns.userId, request.userId), eq(diagnosticRuns.status, 'active')))
    .orderBy(desc(diagnosticRuns.startedAt))
    .limit(1);
  if (active[0]) {
    return serviceResult(active[0]);
  }
  const state = createDiagnosticState(await content());
  const [run] = await db
    .insert(diagnosticRuns)
    .values({
      userId: request.userId,
      kind: 'baseline',
      state,
      startedAt: request.now(),
    })
    .returning();
  return serviceResult(run, 201);
}

export async function getDiagnosticByIdNext(deps: FeatureServices, request: FeatureRequest) {
  const { content } = deps;
  const repo = request.repo;
  const run = await repo.diagnosticRun(request.params.id);
  if (!run) {
    return serviceResult({ error: 'Diagnostic not found' }, 404);
  }
  const exercise = nextDiagnosticExercise(run.state as never, await content());
  if (!exercise) {
    return serviceResult({ complete: true });
  }
  const concept = (await content()).conceptsById.get(exercise.concept);
  return serviceResult({
    complete: false,
    domain: concept?.domain,
    domainId: concept?.domain,
    domainTitle:
      (await content()).curriculum?.domains.find((entry) => entry.id === concept?.domain)?.title ??
      concept?.domain,
    exercise: serializeExercise(exercise, request.userId),
  });
}

export async function postDiagnosticByIdSkip(deps: FeatureServices, request: FeatureRequest) {
  const { db, content } = deps;
  const body = z.object({ domain: z.string() }).safeParse(request.body);
  if (!body.success) {
    return serviceResult({ error: 'Invalid domain' }, 400);
  }
  const repo = request.repo;
  const run = await repo.diagnosticRun(request.params.id);
  if (!run) {
    return serviceResult({ error: 'Diagnostic not found' }, 404);
  }
  const index = await content();
  const state = markDiagnosticUnassessed(
    run.state as never,
    body.data.domain,
    request.now(),
    index,
  );
  const complete = diagnosticComplete(state as never);
  await db
    .update(diagnosticRuns)
    .set({
      state,
      status: complete ? 'completed' : 'active',
      completedAt: complete ? request.now() : null,
      summary: complete ? state : {},
    })
    .where(eq(diagnosticRuns.id, run.id));
  return serviceResult({ complete, state });
}

export async function postDiagnosticByIdAnswer(deps: FeatureServices, request: FeatureRequest) {
  const { db, content } = deps;
  const body = z.object({ exerciseId: z.string(), answer: z.unknown() }).safeParse(request.body);
  if (!body.success) {
    return serviceResult({ error: 'Invalid diagnostic answer' }, 400);
  }
  const repo = request.repo;
  const run = await repo.diagnosticRun(request.params.id);
  const index = await content();
  const exercise = index.exercisesById.get(body.data.exerciseId);
  if (!run || !exercise) {
    return serviceResult({ error: 'Diagnostic or exercise not found' }, 404);
  }
  const emptyMessage = emptyAnswerMessage(exercise.type, body.data.answer);
  if (emptyMessage) return serviceResult({ error: emptyMessage }, 422);
  const nextExercise = nextDiagnosticExercise(run.state as never, index);
  if (nextExercise?.id !== exercise.id) {
    return serviceResult({ error: 'This is not the current diagnostic item.' }, 409);
  }
  const result = await gradeExercise(exercise, body.data.answer);
  if (result.status !== 'graded') {
    return serviceResult(result, result.status === 'invalid' ? 422 : 200);
  }
  const now = request.now();
  const currentState = run.state as never;
  const answer = recordDiagnosticAnswer(currentState, exercise, result.correct >= 1, index, now);
  const attemptId = crypto.randomUUID();
  const [attempt] = await db
    .insert(attempts)
    .values({
      id: attemptId,
      userId: request.userId,
      exerciseId: exercise.id,
      exerciseVersion: exercise.contentVersion,
      conceptId: exercise.concept,
      dimension: exercise.dimension,
      mode: 'diagnostic',
      answer: body.data.answer,
      correct: result.correct,
      credit: result.correct,
      hintsUsed: 0,
      attemptNo: 1,
      gradedBy: result.graded_by ?? 'deterministic',
      feedback: { message: result.feedback },
      createdAt: now,
    })
    .returning();
  await applyMastery({
    repo,
    userId: request.userId,
    exercise,
    attemptId,
    correct: result.correct,
    credit: result.correct,
    hintsUsed: 0,
    attemptNo: 1,
    mode: 'diagnostic',
    gradedBy: result.graded_by ?? 'deterministic',
    now,
    timeZone: request.timeZone,
  });
  const nextState = answer.state;
  for (const prerequisiteId of answer.inferredPrerequisiteIds) {
    const prerequisite = index.conceptsById.get(prerequisiteId);
    for (const dimension of prerequisite?.dimensions ?? []) {
      const inferred = inferPrerequisite(
        await repo.masteryRecord(prerequisiteId, dimension),
        prerequisiteId,
        dimension,
        now,
      );
      await repo.saveMastery(inferred.mastery);
      if (inferred.event) {
        await db.insert(masteryEvents).values({
          userId: request.userId,
          conceptId: inferred.event.conceptId,
          dimension: inferred.event.dimension,
          fromState: inferred.event.fromState,
          toState: inferred.event.toState,
          rule: inferred.event.rule,
          createdAt: now,
        });
      }
    }
  }
  if (diagnosticComplete(nextState)) {
    await db
      .update(diagnosticRuns)
      .set({ state: nextState, status: 'completed', completedAt: now, summary: nextState })
      .where(eq(diagnosticRuns.id, run.id));
  } else {
    await db.update(diagnosticRuns).set({ state: nextState }).where(eq(diagnosticRuns.id, run.id));
  }
  return serviceResult({
    ...result,
    ...(exercise.solution ? { solution: exercise.solution } : {}),
    evidence: answer.evidence,
    complete: diagnosticComplete(nextState),
    attemptId: attempt.id,
  });
}

export async function getDiagnosticLatest(_deps: FeatureServices, request: FeatureRequest) {
  const run = await request.repo.latestCompletedDiagnosticRun();
  return run
    ? serviceResult({ id: run.id })
    : serviceResult({ error: 'No completed diagnostic' }, 404);
}

export async function getDiagnosticByIdResults(deps: FeatureServices, request: FeatureRequest) {
  const { content } = deps;
  const repo = request.repo;
  const index = await content();
  const run =
    (await repo.diagnosticRun(request.params.id)) ?? (await repo.latestCompletedDiagnosticRun());
  const now = request.now();
  const state = await repo.schedulerState(now);
  const user = await repo.user();
  const prefs = (user?.prefs ?? {}) as { scheduleMinutes?: number };
  const firstSession = planSession(state, index, now, sessionBudget('weekday', prefs));
  const runState = run?.state as
    | {
        domains?: Record<
          string,
          {
            status: string;
            answers: number;
            correctConceptIds: string[];
            gapConceptIds: string[];
          }
        >;
      }
    | undefined;
  const curriculum = index.curriculum;
  const diagnosticDomains = new Set(index.diagnostic?.domains.map((domain) => domain.domain) ?? []);
  return run
    ? serviceResult({
        ...run,
        state: run.state,
        mastery: await repo.masteryRecords(),
        domains: (curriculum?.domains ?? []).map((domain) => {
          const progress = runState?.domains?.[domain.id];
          const concepts = index.concepts.filter((concept) => concept.domain === domain.id);
          const titleFor = (id: string) => index.conceptsById.get(id)?.title ?? id;
          return {
            id: domain.id,
            title: domain.title,
            outcome: !diagnosticDomains.has(domain.id)
              ? 'not in diagnostic'
              : progress?.status === 'unassessed'
                ? 'unassessed'
                : progress?.status === 'partially_assessed'
                  ? 'partially assessed'
                  : 'assessed',
            answers: progress?.answers ?? 0,
            knownConcepts: [...new Set(progress?.correctConceptIds ?? [])].map(titleFor),
            gaps: [...new Set(progress?.gapConceptIds ?? [])].map(titleFor),
            conceptCount: concepts.length,
          };
        }),
        plan: {
          firstWeek: curriculum?.weeks.find((entry) => entry.week === 1) ?? null,
          firstWeekConcepts:
            curriculum?.weeks
              .find((entry) => entry.week === 1)
              ?.concepts.map((id) => index.conceptsById.get(id)?.title ?? id) ?? [],
          firstSession: firstSession.activities.map((activity) => ({
            ...activity,
            conceptTitle: activity.conceptId
              ? index.conceptsById.get(activity.conceptId)?.title
              : undefined,
          })),
          ninetyDayPath: (curriculum?.weeks ?? [])
            .slice(0, 13)
            .map((entry) => ({ week: entry.week, title: entry.title })),
        },
      })
    : serviceResult({ error: 'Diagnostic not found' }, 404);
}
