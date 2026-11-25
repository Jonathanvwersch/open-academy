import { type Card, Rating } from 'ts-fsrs';
import type { Dimension } from '../course/schemas.js';
import type { ContentIndex, IndexedExercise } from '../course/types.js';
import { buildEncompassingIndex } from '../graph/encompassing.js';
import type { LearnerStore } from '../store/learner-store.js';
import { mapReviewRating, newReviewCard, scheduleInitialReview } from './fsrs.js';
import { implicitRepetition, positiveCreditBlocked } from './implicit-repetition.js';
import { DefaultMasteryModel } from './mastery.js';
import { topicSpeed } from './speed.js';
import { type LearningMode, masteryRank } from './types.js';

export type ImplicitRepetitionTraceEvent = {
  sourceConceptId: string;
  rating: Rating;
  targetCardId: string;
  targetConceptId?: string;
  reason?: 'target-speed-below-one';
  weight: number;
  before: { dueAt: Date; fsrs: Card; stability: number; difficulty: number };
  after: { dueAt: Date; fsrs: Card; stability: number; difficulty: number };
  applied: boolean;
};

let implicitRepetitionTrace: ((event: ImplicitRepetitionTraceEvent) => void) | undefined;

export async function getTopicSpeed(store: LearnerStore, learnerId: string, conceptId: string) {
  return topicSpeed((await store.listTopicSpeedEvidence(learnerId, [conceptId]))[0]);
}

export function setImplicitRepetitionTrace(
  trace: ((event: ImplicitRepetitionTraceEvent) => void) | undefined,
) {
  implicitRepetitionTrace = trace;
}

export async function applyImplicitRepetitions(
  store: LearnerStore,
  input: {
    learnerId: string;
    conceptId: string;
    rating: Rating;
    index: ContentIndex;
    now: Date;
    timeZone: string;
    enableFuzz: boolean;
  },
) {
  const encompassing = buildEncompassingIndex(input.index);
  const targets =
    input.rating === Rating.Again
      ? encompassing.descendants(input.conceptId)
      : encompassing.ancestors(input.conceptId);
  if (targets.size === 0) return;

  const cards = await store.listReviewCards(input.learnerId, [...targets.keys()]);
  const speeds =
    input.rating === Rating.Again || cards.length === 0
      ? new Map<string, number>()
      : new Map(
          (await store.listTopicSpeedEvidence(input.learnerId, [...targets.keys()])).map(
            (evidence) => [evidence.conceptId, topicSpeed(evidence)],
          ),
        );
  for (const card of cards) {
    const before = { fsrs: card.fsrs, dueAt: card.dueAt };
    const weight = targets.get(card.conceptId) ?? 0;
    const speed = speeds.get(card.conceptId) ?? 1;
    const result = implicitRepetition(before, {
      weight,
      rating: input.rating,
      now: input.now,
      timeZone: input.timeZone,
      enableFuzz: input.enableFuzz,
      speed,
    });
    const after = result ?? before;
    const applied =
      !!result && (await store.updateReviewCardIfDue(input.learnerId, card.id, card.dueAt, result));
    implicitRepetitionTrace?.({
      sourceConceptId: input.conceptId,
      rating: input.rating,
      targetCardId: card.id,
      targetConceptId: card.conceptId,
      ...(positiveCreditBlocked(input.rating, speed)
        ? { reason: 'target-speed-below-one' as const }
        : {}),
      weight,
      before: {
        ...before,
        fsrs: { ...before.fsrs },
        stability: before.fsrs.stability,
        difficulty: before.fsrs.difficulty,
      },
      after: {
        ...after,
        fsrs: { ...after.fsrs },
        stability: after.fsrs.stability,
        difficulty: after.fsrs.difficulty,
      },
      applied,
    });
  }
}

export async function applyMastery(
  store: LearnerStore,
  input: {
    learnerId: string;
    exercise: IndexedExercise;
    attemptId: string;
    correct: number;
    credit: number;
    hintsUsed: number;
    attemptNo: number;
    submitted: boolean;
    mode: LearningMode;
    gradedBy: 'deterministic' | 'llm' | 'self';
    followUp?: boolean;
    createReviewCard?: boolean;
    now: Date;
    timeZone: string;
    enableFuzz: boolean;
  },
) {
  if (
    input.submitted &&
    input.gradedBy === 'deterministic' &&
    input.hintsUsed === 0 &&
    input.attemptNo === 1
  ) {
    await store.addTopicSpeedAnswer(
      input.learnerId,
      input.exercise.concept,
      input.correct >= 1,
      input.now,
    );
  }
  const previous = await store.getMastery(
    input.learnerId,
    input.exercise.concept,
    input.exercise.dimension,
  );
  const open = await store.listOpenRemediationFlags(input.learnerId);
  const model = new DefaultMasteryModel();
  const result = model.applyAttempt(
    previous,
    {
      conceptId: input.exercise.concept,
      dimension: input.exercise.dimension,
      attemptId: input.attemptId,
      exerciseId: input.exercise.id,
      correct: input.correct,
      hintsUsed: input.hintsUsed,
      attemptNo: input.attemptNo,
      mode: input.mode,
      itemRole: input.exercise.role,
      gradedBy: input.gradedBy,
      followUp: input.followUp,
    },
    input.now,
    { remediationOpen: open.some((flag) => flag.conceptId === input.exercise.concept) },
  );
  await store.saveMastery(input.learnerId, result.mastery);
  if (result.event) {
    await store.addMasteryEvent(input.learnerId, {
      conceptId: result.event.conceptId,
      dimension: result.event.dimension,
      fromState: result.event.fromState,
      toState: result.event.toState,
      rule: result.event.rule,
      attemptId: result.event.attemptId ?? null,
      createdAt: input.now,
    });
  }
  if (
    input.createReviewCard !== false &&
    masteryRank(result.mastery.state) >= masteryRank('assisted')
  ) {
    await ensureReviewCard(store, {
      learnerId: input.learnerId,
      conceptId: input.exercise.concept,
      dimension: input.exercise.dimension,
      correct: input.correct,
      hintsUsed: input.hintsUsed,
      attemptNo: input.attemptNo,
      now: input.now,
      timeZone: input.timeZone,
      enableFuzz: input.enableFuzz,
    });
  }
  return { mastery: result.mastery, event: result.event, credit: result.credit };
}

export async function ensureReviewCard(
  store: LearnerStore,
  input: {
    learnerId: string;
    conceptId: string;
    dimension: Dimension;
    correct: number;
    hintsUsed: number;
    attemptNo: number;
    now: Date;
    timeZone: string;
    enableFuzz: boolean;
  },
) {
  const existingCard = await store.getReviewCard(input.learnerId, input.conceptId, input.dimension);
  if (existingCard) return;

  const card = newReviewCard(input.now);
  const rating = mapReviewRating({
    correct: input.correct,
    hintsUsed: input.hintsUsed,
    attemptNo: input.attemptNo,
  });
  const scheduled = scheduleInitialReview(
    card,
    input.now,
    rating,
    input.timeZone,
    input.enableFuzz,
    await getTopicSpeed(store, input.learnerId, input.conceptId),
  );
  await store.insertReviewCard(input.learnerId, {
    conceptId: input.conceptId,
    dimension: input.dimension,
    fsrs: scheduled.card,
    dueAt: scheduled.card.due,
    lastReviewAt: input.now,
    reps: scheduled.card.reps,
    lapses: scheduled.card.lapses,
  });
}
