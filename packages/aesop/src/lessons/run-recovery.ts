import type { ContentIndex, IndexedLesson } from '../course/types.js';
import type { LessonProblem, LessonQuiz, LessonRun, LessonStore } from '../store/lesson-store.js';
import { selectQuizItems } from './lesson-quiz.js';
import { deriveLessonState, selectNextProblem } from './lesson-runner.js';

export type LessonRuntime = {
  now: () => Date;
  random: () => number;
  newId: () => string;
  enableFsrsFuzz: boolean;
};

function isStalePending(row: LessonProblem, index: ContentIndex) {
  return row.answeredAt === null && !index.exercisesById.has(row.exerciseId);
}

export async function loadRunProblems(
  store: LessonStore,
  learnerId: string,
  runId: string,
  index: ContentIndex,
) {
  const rows = await store.listLessonProblems(learnerId, runId);
  const staleIds = rows.filter((row) => isStalePending(row, index)).map((row) => row.id);
  if (staleIds.length === 0) return { rows, removed: false };
  await store.deleteLessonProblems(learnerId, runId, staleIds);
  const stale = new Set(staleIds);
  return { rows: rows.filter((row) => !stale.has(row.id)), removed: true };
}

export async function serveNextRunProblem(
  store: LessonStore,
  learnerId: string,
  run: LessonRun,
  lesson: IndexedLesson,
  index: ContentIndex,
  rows: LessonProblem[],
  state: ReturnType<typeof deriveLessonState<LessonProblem>>,
  now: Date,
  random: () => number,
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
    Math.floor(random() * 0x80000000),
    new Set(rows.flatMap(({ seed }) => (seed === null ? [] : [seed]))),
  );
  if (!selection) return;
  return store.insertLessonProblem(learnerId, run.id, {
    knowledgePointId: point.id,
    round: run.attempt,
    position: Math.max(0, ...pointRows.map((row) => row.position)) + 1,
    exerciseId: selection.exerciseId,
    seed: selection.seed,
    servedAt: now,
    practiceOnly: false,
    assisted: false,
    answeredAt: null,
    correct: null,
    attemptId: null,
  });
}

function staleQuizItems({ quizAttempts, quizItems }: LessonQuiz, index: ContentIndex) {
  const open = new Set(quizAttempts.filter((attempt) => !attempt.submittedAt).map(({ id }) => id));
  return quizItems.filter(
    (item) =>
      open.has(item.quizAttemptId) && !item.answeredAt && !index.exercisesById.has(item.exerciseId),
  );
}

export async function loadRunQuiz(
  store: LessonStore,
  learnerId: string,
  runId: string,
  lesson: IndexedLesson,
  index: ContentIndex,
  { random, newId }: Pick<LessonRuntime, 'random' | 'newId'>,
) {
  const quiz = await store.readLessonQuiz(learnerId, runId);
  const { quizAttempts, quizItems } = quiz;
  const stale = staleQuizItems(quiz, index);
  if (stale.length === 0) return quiz;

  const servedProblems = await store.listLessonProblems(learnerId, runId);
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
      seed: Math.floor(random() * 0x80000000),
      recoveryItems: quizItems.filter((row) => row.quizAttemptId === item.quizAttemptId),
    });
    const replacement = candidates.find((row) => row.pointId === item.knowledgePointId);
    if (!replacement) {
      await store.deleteLessonQuizRows(learnerId, runId, { itemIds: [item.id] });
      dropped.add(item.id);
      continue;
    }
    const updated = await store.patchLessonQuizItem(
      learnerId,
      runId,
      item.id,
      {
        replacementId: newId(),
        exerciseId: replacement.exerciseId,
        seed: replacement.seed,
      },
      { unanswered: true },
    );
    Object.assign(item, updated);
    if (replacement.seed !== null) usedSeeds.add(replacement.seed);
  }
  const remaining = quizItems.filter(({ id }) => !dropped.has(id));
  const remainingAttemptIds = new Set(remaining.map((item) => item.quizAttemptId));
  const emptied = [...new Set(stale.map((item) => item.quizAttemptId))].filter(
    (id) => !remainingAttemptIds.has(id),
  );
  if (emptied.length > 0) {
    await store.deleteLessonQuizRows(learnerId, runId, { attemptIds: emptied });
  }
  return {
    quizAttempts: quizAttempts.filter(({ id }) => !emptied.includes(id)),
    quizItems: remaining,
  };
}

export async function loadRunSnapshot(
  store: LessonStore,
  learnerId: string,
  run: LessonRun,
  lesson: IndexedLesson,
  index: ContentIndex,
  now: Date,
  runtime: Pick<LessonRuntime, 'random' | 'newId'>,
) {
  const derive = (current: LessonRun, rows: LessonProblem[]) =>
    deriveLessonState(lesson, rows, index.exercisesById, current.quizPassedAt, current.attempt);
  const missingLastAnswer = (current: LessonRun, state: ReturnType<typeof derive>) =>
    current.status !== 'needs_retry' &&
    state.status === 'in_progress' &&
    !state.halted &&
    !state.pending &&
    state.lastAnswered &&
    !index.exercisesById.has(state.lastAnswered.exerciseId);
  const rows = await store.listLessonProblems(learnerId, run.id);
  const quiz = await store.readLessonQuiz(learnerId, run.id);
  const derived = derive(run, rows);
  if (
    !rows.some((row) => isStalePending(row, index)) &&
    !missingLastAnswer(run, derived) &&
    staleQuizItems(quiz, index).length === 0
  ) {
    return { current: run, rows, derived, ...quiz };
  }
  return store.transaction(async (tx) => {
    const current = await tx.getLessonRun(learnerId, { runId: run.id }, { forUpdate: true });
    if (!current) return null;
    const { rows, removed } = await loadRunProblems(tx, learnerId, current.id, index);
    let derived = derive(current, rows);
    if (current.status !== 'needs_retry' && (removed || missingLastAnswer(current, derived))) {
      const next = await serveNextRunProblem(
        tx,
        learnerId,
        current,
        lesson,
        index,
        rows,
        derived,
        now,
        runtime.random,
      );
      if (next) {
        rows.push(next);
        derived = derive(current, rows);
      }
    }
    return {
      current,
      rows,
      derived,
      ...(await loadRunQuiz(tx, learnerId, current.id, lesson, index, runtime)),
    };
  });
}
