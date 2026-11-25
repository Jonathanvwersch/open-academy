import type { Exercise, KnowledgePoint } from '../course/schemas.js';
import { instantiateExercise, isTemplate } from '../course/templates.js';
import type { LessonProblemRow } from './lesson-runner.js';

export const QUIZ_PASS_MARK = 0.8;

export type QuizItemHistory = Pick<LessonProblemRow, 'exerciseId' | 'seed'>;

export interface SelectedQuizItem {
  pointId: string;
  exerciseId: string;
  seed: number | null;
  difficulty: number;
  position: number;
}

export function quizQuestionsPerStep(stepCount: number): number {
  if (stepCount === 1) return 6;
  if (stepCount === 2) return 3;
  if (stepCount === 3 || stepCount === 4) return 2;
  return 0;
}

export function scoreLessonQuiz(correctScores: readonly number[]): {
  score: number;
  passed: boolean;
} {
  const score =
    correctScores.length === 0
      ? 0
      : correctScores.reduce((total, correct) => total + correct, 0) / correctScores.length;
  return { score, passed: score + Number.EPSILON >= QUIZ_PASS_MARK };
}

export function selectQuizItems(input: {
  lesson: { knowledge_points?: readonly KnowledgePoint[] };
  exercises: ReadonlyMap<string, Exercise>;
  servedProblems: readonly QuizItemHistory[];
  previousAttemptItems: readonly QuizItemHistory[];
  usedSeeds: ReadonlySet<number>;
  seed: number;
  recoveryItems?: readonly QuizItemHistory[];
}): SelectedQuizItem[] {
  const points = input.lesson.knowledge_points ?? [];
  const quota = quizQuestionsPerStep(points.length);
  if (quota === 0) return [];

  let randomState = input.seed >>> 0 || 1;
  const random = () => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    return (randomState >>> 0) / 0x1_0000_0000;
  };
  const shuffle = <T>(items: T[]): T[] => {
    for (let index = items.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [items[index], items[swapIndex]] = [items[swapIndex] as T, items[index] as T];
    }
    return items;
  };

  const runServed = new Set(input.servedProblems.map((item) => item.exerciseId));
  const previousAttempt = new Set(
    input.previousAttemptItems.map((item) => `${item.exerciseId}:${item.seed ?? 'fixed'}`),
  );
  const usedSeeds = new Set(input.usedSeeds);
  const promptKey = (prompt: string) => prompt.trim().replace(/\s+/g, ' ');
  const existingFixedIds = new Set<string>();
  const existingPrompts = new Set<string>();
  for (const item of input.recoveryItems ?? []) {
    const exercise = input.exercises.get(item.exerciseId);
    if (!exercise) continue;
    if (isTemplate(exercise)) {
      if (item.seed !== null) {
        existingPrompts.add(promptKey(instantiateExercise(exercise, item.seed).exercise.prompt));
        usedSeeds.add(item.seed);
      }
    } else {
      existingFixedIds.add(item.exerciseId);
      existingPrompts.add(promptKey(exercise.prompt));
    }
  }
  const selected: SelectedQuizItem[] = [];
  type Candidate = {
    exerciseId: string;
    seed: number | null;
    difficulty: number;
    preference: number;
    key: string;
  };

  for (const point of points) {
    const candidates: Candidate[] = point.problems.flatMap((exerciseId): Candidate[] => {
      const exercise = input.exercises.get(exerciseId);
      if (
        !exercise ||
        exercise.role === 'recall' ||
        exercise.type === 'explain' ||
        exercise.lesson_only
      ) {
        return [];
      }
      if (!isTemplate(exercise)) {
        if (existingFixedIds.has(exerciseId)) return [];
        const wasInPreviousAttempt = previousAttempt.has(`${exerciseId}:fixed`);
        const served = runServed.has(exerciseId);
        return [
          {
            exerciseId,
            seed: null,
            difficulty: exercise.difficulty,
            preference: !served && !wasInPreviousAttempt ? 0 : wasInPreviousAttempt ? 2 : 1,
            key: `${exerciseId}:fixed`,
          },
        ];
      }

      const generated: Candidate[] = [];
      const sampleLimit = existingPrompts.size > 0 ? quota * 3 : quota;
      for (let sample = 0; sample < sampleLimit && generated.length < quota; sample += 1) {
        let templateSeed = Math.floor(random() * 0x7fffffff);
        while (usedSeeds.has(templateSeed)) {
          templateSeed = (templateSeed + 1) % 0x7fffffff;
        }
        usedSeeds.add(templateSeed);
        if (
          existingPrompts.size > 0 &&
          existingPrompts.has(
            promptKey(instantiateExercise(exercise, templateSeed).exercise.prompt),
          )
        )
          continue;
        generated.push({
          exerciseId,
          seed: templateSeed,
          difficulty: exercise.difficulty,
          preference: 0,
          key: `${exerciseId}:${templateSeed}`,
        });
      }
      return generated;
    });
    const chosen: typeof candidates = [];
    const available = () => candidates.filter((candidate) => !chosen.includes(candidate));
    const pickDifficulty = (difficulty: number) => {
      const matches = available().filter((candidate) => candidate.difficulty === difficulty);
      if (matches.length === 0) return false;
      const bestPreference = Math.min(...matches.map((candidate) => candidate.preference));
      const best = shuffle(matches.filter((candidate) => candidate.preference === bestPreference));
      chosen.push(best[0] as (typeof candidates)[number]);
      return true;
    };

    if (quota === 2) {
      const difficulties = [...new Set(candidates.map((candidate) => candidate.difficulty))].sort(
        (left, right) => left - right,
      );
      if (difficulties.length > 0) pickDifficulty(difficulties[0] as number);
      if (difficulties.length > 1) pickDifficulty(difficulties.at(-1) as number);
    }
    while (chosen.length < quota) {
      let added = false;
      for (const difficulty of [1, 2, 3]) {
        if (chosen.length >= quota) break;
        added = pickDifficulty(difficulty) || added;
      }
      if (!added) break;
    }

    const ordered = chosen.sort((left, right) => left.difficulty - right.difficulty);
    for (const candidate of ordered) {
      selected.push({
        pointId: point.id,
        exerciseId: candidate.exerciseId,
        seed: candidate.seed,
        difficulty: candidate.difficulty,
        position: selected.length + 1,
      });
    }
  }
  return selected;
}
