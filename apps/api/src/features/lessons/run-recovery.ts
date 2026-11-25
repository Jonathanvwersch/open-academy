import type { ContentIndex, IndexedLesson } from '@academy/aesop/course/types';
import { selectQuizItems } from '@academy/aesop/lessons/lesson-quiz';
import { deriveLessonState, selectNextProblem } from '@academy/aesop/lessons/lesson-runner';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  lessonProblems,
  lessonQuizAttempts,
  lessonQuizItems,
  lessonRuns,
} from '../../db/schema.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Run = typeof lessonRuns.$inferSelect;
type Problem = typeof lessonProblems.$inferSelect;

function readRunProblems(db: Database | Tx, runId: string) {
  return db
    .select()
    .from(lessonProblems)
    .where(eq(lessonProblems.runId, runId))
    .orderBy(lessonProblems.servedAt, lessonProblems.position, lessonProblems.id);
}

function isStalePending(row: Problem, index: ContentIndex) {
  return row.answeredAt === null && !index.exercisesById.has(row.exerciseId);
}

export async function loadRunProblems(tx: Tx, runId: string, index: ContentIndex) {
  const rows = await readRunProblems(tx, runId);
  const staleIds = rows.filter((row) => isStalePending(row, index)).map((row) => row.id);
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

async function readRunQuiz(db: Database | Tx, runId: string) {
  const rows = await db
    .select({ attempt: lessonQuizAttempts, item: lessonQuizItems })
    .from(lessonQuizAttempts)
    .leftJoin(lessonQuizItems, eq(lessonQuizItems.quizAttemptId, lessonQuizAttempts.id))
    .where(eq(lessonQuizAttempts.runId, runId))
    .orderBy(lessonQuizAttempts.attemptNo, lessonQuizItems.position, lessonQuizItems.id);
  return {
    quizAttempts: [...new Map(rows.map(({ attempt }) => [attempt.id, attempt])).values()],
    quizItems: rows.flatMap(({ item }) => (item ? [item] : [])),
  };
}

function staleQuizItems(
  { quizAttempts, quizItems }: Awaited<ReturnType<typeof readRunQuiz>>,
  index: ContentIndex,
) {
  const open = new Set(quizAttempts.filter((attempt) => !attempt.submittedAt).map(({ id }) => id));
  return quizItems.filter(
    (item) =>
      open.has(item.quizAttemptId) && !item.answeredAt && !index.exercisesById.has(item.exerciseId),
  );
}

export async function loadRunQuiz(
  tx: Tx,
  runId: string,
  lesson: IndexedLesson,
  index: ContentIndex,
) {
  const quiz = await readRunQuiz(tx, runId);
  const { quizAttempts, quizItems } = quiz;
  const stale = staleQuizItems(quiz, index);
  if (stale.length === 0) return { quizAttempts, quizItems };

  const servedProblems = await tx
    .select({ exerciseId: lessonProblems.exerciseId, seed: lessonProblems.seed })
    .from(lessonProblems)
    .where(eq(lessonProblems.runId, runId));
  const usedSeeds = new Set(
    [...servedProblems, ...quizItems].flatMap(({ seed }) => (seed === null ? [] : [seed])),
  );
  const dropped = new Set<string>();
  for (const item of stale) {
    const candidates = selectQuizItems({
      lesson,
      exercises: index.exercisesById,
      servedProblems,
      previousAttemptItems: quizItems.filter((row) => row.quizAttemptId !== item.quizAttemptId),
      usedSeeds,
      seed: Math.floor(Math.random() * 0x80000000),
      recoveryItems: quizItems.filter((row) => row.quizAttemptId === item.quizAttemptId),
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
    if (replacement.seed !== null) usedSeeds.add(replacement.seed);
  }
  const remaining = quizItems.filter(({ id }) => !dropped.has(id));
  const remainingAttemptIds = new Set(remaining.map((item) => item.quizAttemptId));
  const emptied = [...new Set(stale.map((item) => item.quizAttemptId))].filter(
    (id) => !remainingAttemptIds.has(id),
  );
  if (emptied.length > 0) {
    await tx.delete(lessonQuizAttempts).where(inArray(lessonQuizAttempts.id, emptied));
  }
  return {
    quizAttempts: quizAttempts.filter(({ id }) => !emptied.includes(id)),
    quizItems: remaining,
  };
}

export async function loadRunSnapshot(
  db: Database,
  run: Run,
  lesson: IndexedLesson,
  index: ContentIndex,
  now: Date,
) {
  const derive = (current: Run, rows: Problem[]) =>
    deriveLessonState(lesson, rows, index.exercisesById, current.quizPassedAt, current.attempt);
  const missingLastAnswer = (current: Run, state: ReturnType<typeof derive>) =>
    current.status !== 'needs_retry' &&
    state.status === 'in_progress' &&
    !state.halted &&
    !state.pending &&
    state.lastAnswered &&
    !index.exercisesById.has(state.lastAnswered.exerciseId);
  const rows = await readRunProblems(db, run.id);
  const quiz = await readRunQuiz(db, run.id);
  const derived = derive(run, rows);
  if (
    !rows.some((row) => isStalePending(row, index)) &&
    !missingLastAnswer(run, derived) &&
    staleQuizItems(quiz, index).length === 0
  ) {
    return { current: run, rows, derived, ...quiz };
  }
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(lessonRuns)
      .where(eq(lessonRuns.id, run.id))
      .for('update');
    if (!current) return null;
    const { rows, removed } = await loadRunProblems(tx, current.id, index);
    let derived = derive(current, rows);
    if (current.status !== 'needs_retry' && (removed || missingLastAnswer(current, derived))) {
      const next = await serveNextRunProblem(tx, current, lesson, index, rows, derived, now);
      if (next) {
        rows.push(next);
        derived = derive(current, rows);
      }
    }
    return { current, rows, derived, ...(await loadRunQuiz(tx, current.id, lesson, index)) };
  });
}
