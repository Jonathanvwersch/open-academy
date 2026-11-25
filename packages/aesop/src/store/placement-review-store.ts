import type { Dimension } from '../course/schemas.js';
import type {
  PlacementGrantOrigin,
  PlacementGrantReason,
  PlacementGrantState,
} from '../placement/grants.js';
import type { Id, NewRow } from './core-store.js';
import type { NewReviewCard, ReviewLogRecord, StoredReviewCard } from './learner-store.js';
import type { LessonStore, ReviewLogEntry } from './lesson-store.js';
import type { RowEdit } from './session-store.js';

export type DiagnosticRun = {
  id: Id;
  /** Derived from state, including for rows written before this store was introduced. */
  courseId: Id | null;
  kind: 'baseline' | 'day30' | 'day60' | 'day90' | 'placement';
  status: 'active' | 'completed' | 'abandoned';
  state: unknown;
  startedAt: Date;
  completedAt: Date | null;
  summary: unknown;
};

export type PlacementGrant = {
  id: Id;
  runId: Id;
  conceptId: Id;
  origin: PlacementGrantOrigin;
  state: PlacementGrantState;
  reason: PlacementGrantReason;
  evidenceAttemptIds: Id[];
  createdAt: Date;
  updatedAt: Date;
  confirmedAt: Date | null;
  confirmedByAttemptId: Id | null;
  withdrawnAt: Date | null;
  withdrawnByAttemptId: Id | null;
};

export interface PlacementReviewStore extends LessonStore {
  getReviewCard(
    learnerId: Id,
    conceptId: Id,
    dimension: Dimension,
    options?: { forUpdate?: boolean },
  ): Promise<StoredReviewCard | undefined>;
  listDiagnosticRuns(
    learnerId: Id,
    query: { id?: Id; courseId?: Id; status?: DiagnosticRun['status']; forUpdate?: boolean },
  ): Promise<DiagnosticRun[]>;
  insertDiagnosticRun(learnerId: Id, run: NewRow<DiagnosticRun>): Promise<DiagnosticRun>;
  patchDiagnosticRun(
    learnerId: Id,
    runId: Id,
    patch: RowEdit<DiagnosticRun, 'courseId'>,
  ): Promise<void>;
  listPlacementGrants(
    learnerId: Id,
    query?: {
      conceptIds?: readonly Id[];
      state?: PlacementGrant['state'];
      excludeReasons?: readonly PlacementGrant['reason'][];
    },
  ): Promise<PlacementGrant[]>;
  insertPlacementGrantsOnce(
    learnerId: Id,
    grants: readonly NewRow<PlacementGrant>[],
  ): Promise<void>;
  patchPlacementGrants(
    learnerId: Id,
    query: { ids?: readonly Id[]; conceptId?: Id; ifState?: PlacementGrant['state'] },
    patch: RowEdit<PlacementGrant, 'conceptId' | 'runId'>,
  ): Promise<void>;
  setReviewCardSuspension(
    learnerId: Id,
    conceptIds: readonly Id[],
    suspendedAt: Date | null,
  ): Promise<void>;
  /** Newest first. Activity lineage comes from the attempt linked to each log. */
  listReviewLogs(
    learnerId: Id,
    query: { cardIds?: readonly Id[]; activityId?: Id; since?: Date },
  ): Promise<ReviewLogEntry[]>;
  patchReviewCard(
    learnerId: Id,
    cardId: Id,
    patch: Partial<Omit<NewReviewCard, 'conceptId' | 'dimension'>>,
  ): Promise<void>;
  appendReviewLog(
    learnerId: Id,
    cardId: Id,
    log: ReviewLogRecord & { attemptId?: Id },
  ): Promise<void>;
}
