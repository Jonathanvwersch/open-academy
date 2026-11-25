import type { Card, Rating, ReviewLog } from 'ts-fsrs';
import type { Dimension } from '../course/schemas.js';
import type { MasteryRecord, MasteryState } from '../memory/types.js';

export interface StoredReviewCard {
  id: string;
  conceptId: string;
  dimension: Dimension;
  fsrs: Card;
  dueAt: Date;
  lastReviewAt: Date | null;
  reps: number;
  lapses: number;
}

export interface NewReviewCard {
  conceptId: string;
  dimension: Dimension;
  fsrs: Card;
  dueAt: Date;
  lastReviewAt: Date | null;
  reps: number;
  lapses: number;
}

export interface ReviewLogRecord {
  rating: Rating;
  fsrsLog: ReviewLog & { source?: string };
  createdAt: Date;
}

export interface MasteryEventRecord {
  conceptId: string;
  dimension: Dimension;
  fromState: MasteryState;
  toState: MasteryState;
  rule: string;
  attemptId: string | null;
  createdAt: Date;
}

export interface OpenRemediationFlag {
  id: string;
  conceptId: string;
  targetPrereqId: string | null;
}

export interface LearnerStore {
  /** Sorted by conceptId, then dimension. */
  listMastery(learnerId: string): Promise<MasteryRecord[]>;
  getMastery(
    learnerId: string,
    conceptId: string,
    dimension: Dimension,
  ): Promise<MasteryRecord | undefined>;
  /** Upsert on (learnerId, conceptId, dimension). */
  saveMastery(learnerId: string, record: MasteryRecord): Promise<void>;
  addMasteryEvent(learnerId: string, event: MasteryEventRecord): Promise<void>;
  /** Active cards, optionally filtered by conceptId. Sorted by conceptId, dimension, id. */
  listReviewCards(learnerId: string, conceptIds?: readonly string[]): Promise<StoredReviewCard[]>;
  getReviewCard(
    learnerId: string,
    conceptId: string,
    dimension: Dimension,
  ): Promise<StoredReviewCard | undefined>;
  insertReviewCard(learnerId: string, card: NewReviewCard): Promise<StoredReviewCard>;
  /** Save a review and its log together. Returns false when the card is suspended. */
  recordReview(
    learnerId: string,
    conceptId: string,
    dimension: Dimension,
    compute: (card: StoredReviewCard | undefined) => {
      card: Omit<NewReviewCard, 'conceptId' | 'dimension'>;
      log: ReviewLogRecord;
    },
  ): Promise<boolean>;
  /** Compare-and-set: update an active card whose dueAt still equals expectedDueAt. */
  updateReviewCardIfDue(
    learnerId: string,
    cardId: string,
    expectedDueAt: Date,
    next: { fsrs: Card; dueAt: Date },
  ): Promise<boolean>;
  listOpenRemediationFlags(learnerId: string): Promise<OpenRemediationFlag[]>;
}
