import type { Exercise, KnowledgePoint } from '../content/schemas.js';

export type LessonRunStatus = 'in_progress' | 'quiz' | 'completed';
export type KnowledgePointStatus = 'passed' | 'active' | 'locked';

export interface LessonProblemRow {
  knowledgePointId: string;
  round: number;
  position: number;
  exerciseId: string;
  attemptId?: string | null;
  practiceOnly?: boolean;
  assisted: boolean;
  seed: number | null;
  servedAt: Date;
  answeredAt: Date | null;
  correct: number | null;
}

export interface LessonPointState<Row extends LessonProblemRow = LessonProblemRow> {
  id: string;
  status: KnowledgePointStatus;
  round: number;
  answered: number;
  streak: number;
  passedOn?: Row;
}

export interface DerivedLessonState<Row extends LessonProblemRow = LessonProblemRow> {
  status: LessonRunStatus;
  points: LessonPointState<Row>[];
  currentPointId?: string;
  pending?: Row;
  lastAnswered?: Row;
}

export const XP_BY_PROBLEMS_USED = {
  2: 10,
  3: 9,
  4: 8,
} as const;

export function xpForPassedPoint(problemsUsed: number): number {
  if (problemsUsed >= 5) return 7;
  return XP_BY_PROBLEMS_USED[problemsUsed as keyof typeof XP_BY_PROBLEMS_USED] ?? 0;
}

function nextDifficulty(
  difficulties: readonly number[],
  last: { difficulty: number; correct: number } | undefined,
): number {
  if (!last) return Math.min(...difficulties);
  const higher = difficulties.filter((difficulty) => difficulty > last.difficulty);
  const lower = difficulties.filter((difficulty) => difficulty < last.difficulty);
  if (last.correct === 1) {
    if (higher.length > 0) return Math.min(...higher);
    if (difficulties.includes(last.difficulty)) return last.difficulty;
    return Math.max(...lower);
  }
  if (lower.length > 0) return Math.max(...lower);
  if (difficulties.includes(last.difficulty)) return last.difficulty;
  return Math.min(...higher);
}

function orderedRows<Row extends LessonProblemRow>(rows: readonly Row[]): Row[] {
  return [...rows].sort(
    (left, right) =>
      left.position - right.position || left.servedAt.getTime() - right.servedAt.getTime(),
  );
}

export function deriveLessonState<Row extends LessonProblemRow>(
  lesson: { knowledge_points?: readonly KnowledgePoint[] },
  problems: readonly Row[],
  exercises: ReadonlyMap<string, Pick<Exercise, 'role'>>,
  quizPassedAt?: Date | null,
): DerivedLessonState<Row> {
  const knowledgePoints = lesson.knowledge_points ?? [];
  const currentIds = new Set(knowledgePoints.map((point) => point.id));
  const progressionProblems = problems.filter(
    (problem) => !problem.practiceOnly && exercises.get(problem.exerciseId)?.role !== 'recall',
  );
  const currentProblems = progressionProblems.filter((problem) =>
    currentIds.has(problem.knowledgePointId),
  );
  const pointStates: LessonPointState<Row>[] = [];
  let blocked = false;
  let currentPointId: string | undefined;

  for (const point of knowledgePoints) {
    const rows = currentProblems.filter((problem) => problem.knowledgePointId === point.id);
    const round = Math.max(1, ...rows.map((problem) => problem.round));
    const currentRound = orderedRows(rows.filter((problem) => problem.round === round));
    const answered = currentRound.filter((problem) => problem.answeredAt !== null);
    let streak = 0;
    let passedOn: Row | undefined;
    let answeredCount = 0;
    for (const problem of answered) {
      answeredCount += 1;
      streak = problem.correct === 1 ? streak + 1 : 0;
      if (streak === 2) {
        passedOn = problem;
        break;
      }
    }
    const status: KnowledgePointStatus = blocked ? 'locked' : passedOn ? 'passed' : 'active';
    const effectivePassedOn = status === 'passed' ? passedOn : undefined;
    pointStates.push({
      id: point.id,
      status,
      round,
      answered: status === 'locked' ? 0 : answeredCount,
      streak: status === 'locked' ? 0 : effectivePassedOn ? 2 : streak,
      ...(effectivePassedOn ? { passedOn: effectivePassedOn } : {}),
    });
    if (status !== 'passed' && !blocked) {
      blocked = true;
      currentPointId = point.id;
    }
  }

  const currentState = pointStates.find((point) => point.id === currentPointId);
  const currentRows =
    currentState && currentPointId
      ? orderedRows(
          currentProblems.filter(
            (problem) =>
              problem.knowledgePointId === currentPointId && problem.round === currentState.round,
          ),
        )
      : [];
  const pointOrder = new Map(knowledgePoints.map((point, index) => [point.id, index]));
  const lastAnswered = problems
    .filter((problem) => currentIds.has(problem.knowledgePointId))
    .filter((problem) => problem.answeredAt !== null)
    .sort(
      (left, right) =>
        (right.answeredAt?.getTime() ?? 0) - (left.answeredAt?.getTime() ?? 0) ||
        (pointOrder.get(right.knowledgePointId) ?? -1) -
          (pointOrder.get(left.knowledgePointId) ?? -1) ||
        right.round - left.round ||
        right.position - left.position,
    )[0];
  const pending = currentRows.find((problem) => problem.answeredAt === null);
  const allPassed = pointStates.every((point) => point.status === 'passed');
  return {
    status: allPassed ? (quizPassedAt ? 'completed' : 'quiz') : 'in_progress',
    points: pointStates,
    ...(currentPointId ? { currentPointId } : {}),
    ...(pending ? { pending } : {}),
    ...(lastAnswered ? { lastAnswered } : {}),
  };
}

export interface SelectedLessonProblem {
  exerciseId: string;
  seed: number | null;
  position: number;
}

type RoundProblem = Pick<LessonProblemRow, 'exerciseId' | 'seed' | 'position' | 'correct'> &
  Partial<Pick<LessonProblemRow, 'servedAt'>>;

export function selectNextProblem(
  point: Pick<KnowledgePoint, 'problems'>,
  exercises: ReadonlyMap<string, Exercise>,
  roundProblems: readonly RoundProblem[],
  templateSeed: number,
  usedSeeds: ReadonlySet<number> = new Set(),
): SelectedLessonProblem | undefined {
  const served = new Set(roundProblems.map((problem) => problem.exerciseId));
  const position = roundProblems.length + 1;

  for (const id of point.problems) {
    if (served.has(id)) continue;
    if (exercises.get(id)?.role === 'basics') return { exerciseId: id, seed: null, position };
  }

  const templates = point.problems.flatMap((id) => {
    const exercise = exercises.get(id);
    if (
      exercise?.role !== 'basics' &&
      exercise?.role !== 'recall' &&
      exercise?.type === 'numeric' &&
      'answer_expr' in exercise
    ) {
      return [
        {
          id,
          difficulty: exercise.difficulty,
          served: roundProblems.filter((problem) => problem.exerciseId === id).length,
        },
      ];
    }
    return [];
  });
  const candidates = point.problems.flatMap((id) => {
    if (served.has(id)) return [];
    const exercise = exercises.get(id);
    return exercise && exercise.role !== 'basics' && exercise.role !== 'recall'
      ? [{ id, exercise }]
      : [];
  });

  const countedAnswers = roundProblems
    .filter((problem) => {
      const role = exercises.get(problem.exerciseId)?.role;
      return role !== 'basics' && role !== 'recall';
    })
    .filter((problem) => problem.correct !== null)
    .sort((left, right) => right.position - left.position);
  const last = countedAnswers[0];
  const lastExercise = last ? exercises.get(last.exerciseId) : undefined;
  const lastAttempt =
    last && lastExercise
      ? { difficulty: lastExercise.difficulty, correct: last.correct as number }
      : undefined;

  const newTemplate = (exerciseId: string): SelectedLessonProblem => {
    const seeds = new Set([
      ...usedSeeds,
      ...roundProblems.flatMap((problem) => (problem.seed === null ? [] : [problem.seed])),
    ]);
    let seed = templateSeed;
    while (seeds.has(seed)) seed = (seed + 1) % 0x80000000;
    return { exerciseId, seed, position };
  };

  if (candidates.length > 0) {
    const difficulty = nextDifficulty(
      candidates.map(({ exercise }) => exercise.difficulty),
      lastAttempt,
    );
    const candidate = candidates.find(({ exercise }) => exercise.difficulty === difficulty);
    if (!candidate) return undefined;
    if (candidate.exercise.type === 'numeric' && 'answer_expr' in candidate.exercise) {
      return newTemplate(candidate.id);
    }
    return { exerciseId: candidate.id, seed: null, position };
  }

  if (templates.length === 0) {
    const sortByServedTime = (left: RoundProblem, right: RoundProblem) =>
      (left.servedAt?.getTime() ?? left.position) - (right.servedAt?.getTime() ?? right.position) ||
      left.position - right.position;
    const reusable = roundProblems
      .filter((problem) => {
        const role = exercises.get(problem.exerciseId)?.role;
        return role !== 'basics' && role !== 'recall';
      })
      .sort(sortByServedTime)[0];
    const fallback =
      reusable ??
      roundProblems
        .filter((problem) => exercises.get(problem.exerciseId)?.role === 'basics')
        .sort(sortByServedTime)[0];
    return fallback ? { exerciseId: fallback.exerciseId, seed: null, position } : undefined;
  }
  const difficulty = nextDifficulty(
    templates.map((template) => template.difficulty),
    lastAttempt,
  );
  let nextTemplate: (typeof templates)[number] | undefined;
  for (const id of point.problems) {
    const template = templates.find((item) => item.id === id && item.difficulty === difficulty);
    if (template && (!nextTemplate || template.served < nextTemplate.served)) {
      nextTemplate = template;
    }
  }
  if (!nextTemplate) return undefined;
  return newTemplate(nextTemplate.id);
}
