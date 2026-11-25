import type { ContentIndex, IndexedLesson } from '@academy/aesop/course/types';
import { selectQuizItems } from '@academy/aesop/lessons/lesson-quiz';
import { type deriveLessonState, selectNextProblem } from '@academy/aesop/lessons/lesson-runner';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  lessonProblems,
  lessonQuizAttempts,
  lessonQuizItems,
  type lessonRuns,
} from '../../db/schema.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Run = typeof lessonRuns.$inferSelect;
type Problem = typeof lessonProblems.$inferSelect;

export async function loadRunProblems(tx: Tx, runId: string, index: ContentIndex) {
  const rows = await tx
    .select()
    .from(lessonProblems)
    .where(eq(lessonProblems.runId, runId))
    .orderBy(lessonProblems.servedAt, lessonProblems.position, lessonProblems.id);
  const staleIds = rows
    .filter((row) => row.answeredAt === null && !index.exercisesById.has(row.exerciseId))
    .map((row) => row.id);
  if (staleIds.length === 0) return { rows, removed: false };
  await tx.delete(lessonProblems).where(inArray(lessonProblems.id, staleIds));
  const stale = new Set(staleIds);
  return { rows: rows.filter((row) => !stale.has(row.id)), removed: true };
}

export async function serveNextRunProblem(
  tx: Tx,
  run: Run,
  lesson: IndexedLesson,
  index: ContentIndex,
  rows: Problem[],
  state: ReturnType<typeof deriveLessonState<Problem>>,
  now: Date,
) {
  if (state.status !== 'in_progress' || state.halted || state.pending) return;
  const point = lesson.knowledge_points?.find((item) => item.id === state.currentPointId);
  if (!point) return;
  const pointRows = rows.filter(
    (row) => row.knowledgePointId === point.id && row.round === run.attempt && !row.practiceOnly,
  );
  const selection = selectNextProblem(
    point,
    index.exercisesById,
    pointRows,
    Math.floor(Math.random() * 0x80000000),
    new Set(rows.flatMap(({ seed }) => (seed === null ? [] : [seed]))),
  );
  if (!selection) return;
  const [problem] = await tx
    .insert(lessonProblems)
    .values({
      runId: run.id,
      knowledgePointId: point.id,
      round: run.attempt,
      position: Math.max(0, ...pointRows.map((row) => row.position)) + 1,
      exerciseId: selection.exerciseId,
      seed: selection.seed,
      servedAt: now,
    })
    .returning();
  return problem;
}

export async function loadRunQuiz(
  tx: Tx,
  runId: string,
  lesson: IndexedLesson,
  index: ContentIndex,
) {
  const quizAttempts = await tx
    .select()
    .from(lessonQuizAttempts)
    .where(eq(lessonQuizAttempts.runId, runId))
    .orderBy(lessonQuizAttempts.attemptNo);
  const attemptIds = quizAttempts.map((attempt) => attempt.id);
  const quizItems = attemptIds.length
    ? await tx
        .select()
        .from(lessonQuizItems)
        .where(inArray(lessonQuizItems.quizAttemptId, attemptIds))
        .orderBy(lessonQuizItems.quizAttemptId, lessonQuizItems.position, lessonQuizItems.id)
    : [];
  const open = new Set(quizAttempts.filter((attempt) => !attempt.submittedAt).map(({ id }) => id));
  const stale = quizItems.filter(
    (item) =>
      open.has(item.quizAttemptId) && !item.answeredAt && !index.exercisesById.has(item.exerciseId),
  );
  if (stale.length === 0) return { quizAttempts, quizItems };

  const servedProblems = await tx
    .select({ exerciseId: lessonProblems.exerciseId, seed: lessonProblems.seed })
    .from(lessonProblems)
    .where(eq(lessonProblems.runId, runId));
  const usedSeeds = new Set(
    [...servedProblems, ...quizItems].flatMap(({ seed }) => (seed === null ? [] : [seed])),
  );
  const excluded = new Map<string, Set<string>>();
  const dropped = new Set<string>();
  for (const item of stale) {
    let excludeFixedExerciseIds = excluded.get(item.quizAttemptId);
    if (!excludeFixedExerciseIds) {
      excludeFixedExerciseIds = new Set(
        quizItems
          .filter((row) => row.quizAttemptId === item.quizAttemptId)
          .map((row) => row.exerciseId),
      );
      excluded.set(item.quizAttemptId, excludeFixedExerciseIds);
    }
    const candidates = selectQuizItems({
      lesson,
      exercises: index.exercisesById,
      servedProblems,
      previousAttemptItems: quizItems.filter((row) => row.quizAttemptId !== item.quizAttemptId),
      usedSeeds,
      seed: Math.floor(Math.random() * 0x80000000),
      excludeFixedExerciseIds,
    });
    const replacement = candidates.find((row) => row.pointId === item.knowledgePointId);
    if (!replacement) {
      await tx.delete(lessonQuizItems).where(eq(lessonQuizItems.id, item.id));
      dropped.add(item.id);
      continue;
    }
    const [updated] = await tx
      .update(lessonQuizItems)
      .set({
        id: crypto.randomUUID(),
        exerciseId: replacement.exerciseId,
        seed: replacement.seed,
      })
      .where(and(eq(lessonQuizItems.id, item.id), isNull(lessonQuizItems.answeredAt)))
      .returning();
    Object.assign(item, updated);
    if (replacement.seed === null) excludeFixedExerciseIds.add(replacement.exerciseId);
    if (replacement.seed !== null) usedSeeds.add(replacement.seed);
  }
  return { quizAttempts, quizItems: quizItems.filter(({ id }) => !dropped.has(id)) };
}
