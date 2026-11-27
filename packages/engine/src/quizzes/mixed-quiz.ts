import { Rating } from 'ts-fsrs';
import { instantiateExercise, isTemplate } from '../course/templates.js';
import type { ContentIndex, IndexedExercise } from '../course/types.js';
import { buildEncompassingIndex } from '../graph/encompassing.js';
import { courseConceptIds } from '../graph/prerequisites.js';

export const QUIZ_XP_INTERVAL = 150;
export const QUIZ_XP_WINDOW = 30;
export const QUIZ_SIZE = 8;
const DEFAULT_TARGET_SECONDS = 90;

export type QuizExercise = IndexedExercise & { type: 'mc' | 'numeric' | 'expression' };
export interface QuizQuestion {
  withdrawn?: true;
  previousKeys?: string[];
  exercise: QuizExercise;
  seed: number;
  key: string;
}
export interface QuizQuestionPair {
  question: QuizQuestion;
  reserve: QuizQuestion;
}

export function quizXpBalance(eligibleXp: number, completedOriginals: number): number {
  return Math.max(0, eligibleXp - completedOriginals * QUIZ_XP_INTERVAL);
}

export function quizSeed(...values: Array<string | number>): number {
  return (
    [...values.join('\u0000')].reduce(
      (hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619),
      2166136261,
    ) >>> 0
  );
}

export function nextQuizDifficulty(previous?: { difficulty: number; score: number }): number {
  return previous
    ? Math.min(5, Math.max(1, previous.difficulty + Math.sign(previous.score - 0.8)))
    : 2;
}

export function quizTargetSeconds(exercise: Pick<QuizExercise, 'target_seconds'>): number {
  return exercise.target_seconds ?? DEFAULT_TARGET_SECONDS;
}

export function quizDurationMs(items: readonly QuizQuestion[], accommodation = 1): number {
  return Math.ceil(
    items.reduce((sum, item) => sum + quizTargetSeconds(item.exercise), 0) * accommodation * 1000,
  );
}

export function quizPlannedMinutes(items: readonly QuizQuestion[], accommodation = 1): number {
  return Math.ceil(quizDurationMs(items, accommodation) / 60_000);
}

export function quizAnswerIsLate(receivedAt: Date, deadline: Date): boolean {
  return receivedAt >= deadline;
}

export function quizItemOutcome(correct: boolean, latencyMs: number | null, targetSeconds: number) {
  const slow = correct && latencyMs !== null && latencyMs > targetSeconds * 1000;
  return {
    correct,
    rating: !correct ? Rating.Again : slow ? Rating.Hard : Rating.Good,
    followUp: !correct || slow,
  };
}

export function quizScore(items: readonly { correct: boolean }[]): number {
  return items.length ? items.filter((item) => item.correct).length / items.length : 0;
}

export function quizXp(minutes: number, score: number, retake: boolean): number {
  return retake ? 0 : Math.round(minutes * score);
}

export function quizRetakeEligible(
  items: readonly { correct: boolean; followUp: boolean; reviewed: boolean }[],
  hasRetake: boolean,
): boolean {
  return (
    !hasRetake &&
    items.some((item) => !item.correct) &&
    items.every((item) => !item.followUp || item.reviewed)
  );
}

function quizExercise(exercise: IndexedExercise): exercise is QuizExercise {
  return (
    !exercise.lesson_only &&
    (exercise.type === 'mc' || exercise.type === 'numeric' || exercise.type === 'expression')
  );
}

export function topicQuestions(input: {
  content: ContentIndex;
  topic: string;
  seed: number;
  difficulty: number;
  usedKeys: ReadonlySet<string>;
  count: number;
}): QuizQuestion[] {
  if (input.content.conceptsById.get(input.topic)?.status !== 'authored') return [];
  const authored = (input.content.exercisesByConcept.get(input.topic) ?? [])
    .filter(quizExercise)
    .sort(
      (a, b) =>
        Math.abs(a.difficulty - input.difficulty) - Math.abs(b.difficulty - input.difficulty) ||
        quizSeed(input.seed, a.id) - quizSeed(input.seed, b.id),
    );
  const keys = new Set<string>();
  const result: QuizQuestion[] = [];
  for (const original of authored) {
    const template = isTemplate(original);
    for (let variant = 0; variant < (template ? 8 : 1); variant++) {
      const seed = quizSeed(input.seed, original.id, variant) & 0x7fffffff;
      const exercise = template
        ? ({
            ...instantiateExercise(original, seed).exercise,
            concept: original.concept,
            contentVersion: original.contentVersion,
          } as QuizExercise)
        : original;
      const key = exercise.prompt.trim().replace(/\s+/g, ' ');
      if (input.usedKeys.has(key) || keys.has(key)) continue;
      keys.add(key);
      result.push({ exercise, seed, key });
      if (result.length === input.count) return result;
    }
  }
  return result;
}

export function selectQuizQuestions(input: {
  content: ContentIndex;
  completedTopics: ReadonlySet<string>;
  confirmedPlacementTopics: ReadonlySet<string>;
  courseId: string | null;
  seed: number;
  difficulty: number;
  exposure: ReadonlyMap<string, number>;
  usedKeys: ReadonlySet<string>;
}): QuizQuestionPair[] | undefined {
  const course = courseConceptIds(input.content.coursesById.get(input.courseId ?? ''));
  const encompassing = buildEncompassingIndex(input.content);
  const candidates = [...new Set([...input.completedTopics, ...input.confirmedPlacementTopics])]
    .filter((topic) => input.content.conceptsById.get(topic)?.status === 'authored')
    .map((topic) => {
      const weight = (course.has(topic) ? 4 : 1) / (1 + (input.exposure.get(topic) ?? 0));
      return {
        topic,
        rank: -Math.log((quizSeed(input.seed, topic) + 1) / 0x1_0000_0000) / weight,
        questions: topicQuestions({ ...input, topic, count: 2 }),
      };
    })
    .filter(({ questions }) => questions.length >= 2)
    .sort((a, b) => a.rank - b.rank || a.topic.localeCompare(b.topic));

  function choose(
    available: typeof candidates,
    selected: QuizQuestionPair[],
    seen: ReadonlySet<string>,
  ): QuizQuestionPair[] | undefined {
    if (selected.length === QUIZ_SIZE) return selected;
    for (let i = 0; i <= available.length - (QUIZ_SIZE - selected.length); i++) {
      const { topic, questions } = available[i];
      const [question, reserve] = questions;
      if (seen.has(question.key) || seen.has(reserve.key)) continue;
      const eligible = available
        .slice(i + 1)
        .filter(
          ({ topic: other }) =>
            !encompassing.ancestors(topic).has(other) &&
            !encompassing.descendants(topic).has(other),
        );
      const selection = choose(
        eligible,
        [...selected, { question, reserve }],
        new Set([...seen, question.key, reserve.key]),
      );
      if (selection) return selection;
    }
    return undefined;
  }
  return choose(candidates, [], new Set());
}
