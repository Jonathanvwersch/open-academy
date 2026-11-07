import type { Exercise, KnowledgePoint } from '../content/schemas.js';

export type LessonRunStatus = 'in_progress' | 'needs_retry' | 'completed';
export type KnowledgePointStatus = 'passed' | 'failed' | 'active' | 'locked';

export interface LessonProblemRow {
  knowledgePointId: string;
  round: number;
  position: number;
  exerciseId: string;
  attemptId?: string | null;
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
  5: 7,
} as const; // Hypothesis: faster knowledge-point passes should earn slightly more XP.

export function xpForPassedPoint(problemsUsed: number): number {
  return XP_BY_PROBLEMS_USED[problemsUsed as keyof typeof XP_BY_PROBLEMS_USED] ?? 0;
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
): DerivedLessonState<Row> {
  const knowledgePoints = lesson.knowledge_points ?? [];
  const currentIds = new Set(knowledgePoints.map((point) => point.id));
  const currentProblems = problems.filter((problem) => currentIds.has(problem.knowledgePointId));
  const pointStates: LessonPointState<Row>[] = [];
  let blocked = false;
  let currentPointId: string | undefined;
  let failed = false;

  for (const point of knowledgePoints) {
    const rows = currentProblems.filter((problem) => problem.knowledgePointId === point.id);
    const round = Math.max(1, ...rows.map((problem) => problem.round));
    const currentRound = orderedRows(rows.filter((problem) => problem.round === round));
    const answered = currentRound.filter((problem) => problem.answeredAt !== null);
    let streak = 0;
    let passedOn: Row | undefined;
    let answeredCount = 0;
    let roundFailed = false;
    const countedAnswers = answered.filter(
      (problem) => exercises.get(problem.exerciseId)?.role !== 'basics',
    );
    for (const [index, problem] of countedAnswers.entries()) {
      answeredCount = index + 1;
      streak = problem.correct === 1 ? streak + 1 : 0;
      if (streak === 2) {
        passedOn = problem;
        break;
      }
      if (answeredCount === 5 || (answeredCount === 4 && problem.correct !== 1)) {
        roundFailed = true;
        break;
      }
    }
    const status: KnowledgePointStatus = blocked
      ? 'locked'
      : passedOn
        ? 'passed'
        : roundFailed
          ? 'failed'
          : 'active';
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
      failed = roundFailed;
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
  const lastAnswered = [...currentProblems]
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
    status: allPassed ? 'completed' : failed ? 'needs_retry' : 'in_progress',
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

export function selectNextProblem(
  point: Pick<KnowledgePoint, 'problems'>,
  exercises: ReadonlyMap<string, Exercise>,
  roundProblems: readonly Pick<LessonProblemRow, 'exerciseId' | 'seed' | 'position'>[],
  templateSeed: number,
  usedSeeds: ReadonlySet<number> = new Set(),
): SelectedLessonProblem | undefined {
  const countedProblems = roundProblems.filter(
    (problem) => exercises.get(problem.exerciseId)?.role !== 'basics',
  );
  if (countedProblems.length >= 5) return undefined;
  const served = new Set(roundProblems.map((problem) => problem.exerciseId));
  const templates: string[] = [];
  for (const id of point.problems) {
    const exercise = exercises.get(id);
    if (exercise?.type === 'numeric' && 'answer_expr' in exercise) templates.push(id);
  }

  const position = roundProblems.length + 1;
  const newTemplate = (exerciseId: string): SelectedLessonProblem => {
    const seeds = new Set([
      ...usedSeeds,
      ...roundProblems.flatMap((problem) => (problem.seed === null ? [] : [problem.seed])),
    ]);
    let seed = templateSeed;
    while (seeds.has(seed)) seed = (seed + 1) % 0x80000000;
    return { exerciseId, seed, position };
  };

  for (const id of point.problems) {
    if (served.has(id)) continue;
    const exercise = exercises.get(id);
    if (!exercise) continue;
    if (exercise.type === 'numeric' && 'answer_expr' in exercise) return newTemplate(id);
    return { exerciseId: id, seed: null, position };
  }

  if (templates.length === 0) return undefined;
  const templateCount = roundProblems.filter((problem) =>
    templates.includes(problem.exerciseId),
  ).length;
  const nextTemplate = templates[templateCount % templates.length];
  if (!nextTemplate) return undefined;
  return newTemplate(nextTemplate);
}
