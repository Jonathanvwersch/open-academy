import { and, asc, desc, eq, lte } from 'drizzle-orm';
import type { Card } from 'ts-fsrs';
import type { Dimension } from '../content/schemas.js';
import { retrievability } from '../learning/fsrs.js';
import type { SchedulerState } from '../learning/scheduler.js';
import type { MasteryRecord, MasteryState } from '../learning/types.js';
import { initialMastery } from '../learning/types.js';
import type { Database } from './client.js';
import {
  attempts,
  diagnosticRuns,
  hintEvents,
  mastery,
  masteryEvents,
  projectProgress,
  remediationFlags,
  reviewCards,
  reviewLogs,
  sessionActivities,
  studySessions,
  users,
} from './schema.js';

export class LearnerRepository {
  constructor(
    readonly db: Database,
    readonly userId: string,
  ) {}

  async user() {
    const [user] = await this.db.select().from(users).where(eq(users.id, this.userId)).limit(1);
    return user;
  }

  async masteryRecords(): Promise<MasteryRecord[]> {
    const rows = await this.db.select().from(mastery).where(eq(mastery.userId, this.userId));
    return rows.map((row) => {
      const evidence = row.evidence as Partial<MasteryRecord>;
      return {
        ...initialMastery(row.conceptId, row.dimension as Dimension),
        state: row.state as MasteryState,
        provisional: row.provisional,
        inferred: row.inferred,
        independentItemIds: evidence.independentItemIds ?? [],
        independentDeterministicCount: evidence.independentDeterministicCount ?? 0,
        lastIndependentCorrect: evidence.lastIndependentCorrect ?? false,
        attempts: evidence.attempts ?? [],
        lastAssessedAt: row.lastAssessedAt?.toISOString() ?? null,
        lastIndependentAt: row.lastIndependentAt?.toISOString() ?? null,
        firstIndependentAt: row.firstIndependentAt?.toISOString() ?? null,
      };
    });
  }

  async masteryRecord(conceptId: string, dimension: Dimension): Promise<MasteryRecord | undefined> {
    return (await this.masteryRecords()).find(
      (record) => record.conceptId === conceptId && record.dimension === dimension,
    );
  }

  async saveMastery(record: MasteryRecord): Promise<void> {
    await this.db
      .insert(mastery)
      .values({
        userId: this.userId,
        conceptId: record.conceptId,
        dimension: record.dimension,
        state: record.state,
        provisional: record.provisional,
        inferred: record.inferred,
        evidence: {
          independentItemIds: record.independentItemIds,
          independentDeterministicCount: record.independentDeterministicCount,
          lastIndependentCorrect: record.lastIndependentCorrect,
          attempts: record.attempts,
        },
        lastAssessedAt: record.lastAssessedAt ? new Date(record.lastAssessedAt) : null,
        lastIndependentAt: record.lastIndependentAt ? new Date(record.lastIndependentAt) : null,
        firstIndependentAt: record.firstIndependentAt ? new Date(record.firstIndependentAt) : null,
      })
      .onConflictDoUpdate({
        target: [mastery.userId, mastery.conceptId, mastery.dimension],
        set: {
          state: record.state,
          provisional: record.provisional,
          inferred: record.inferred,
          evidence: {
            independentItemIds: record.independentItemIds,
            independentDeterministicCount: record.independentDeterministicCount,
            lastIndependentCorrect: record.lastIndependentCorrect,
            attempts: record.attempts,
          },
          lastAssessedAt: record.lastAssessedAt ? new Date(record.lastAssessedAt) : null,
          lastIndependentAt: record.lastIndependentAt ? new Date(record.lastIndependentAt) : null,
          firstIndependentAt: record.firstIndependentAt
            ? new Date(record.firstIndependentAt)
            : null,
        },
      });
  }

  async schedulerState(now: Date): Promise<SchedulerState> {
    const [user] = await this.db.select().from(users).where(eq(users.id, this.userId)).limit(1);
    const [masteryRows, cards, recentAttempts, flags, projects] = await Promise.all([
      this.masteryRecords(),
      this.db.select().from(reviewCards).where(eq(reviewCards.userId, this.userId)),
      this.db
        .select()
        .from(attempts)
        .where(eq(attempts.userId, this.userId))
        .orderBy(desc(attempts.createdAt))
        .limit(100),
      this.db
        .select()
        .from(remediationFlags)
        .where(and(eq(remediationFlags.userId, this.userId), eq(remediationFlags.status, 'open'))),
      this.db.select().from(projectProgress).where(eq(projectProgress.userId, this.userId)),
    ]);
    return {
      mastery: masteryRows,
      cards: cards.map((card) => ({
        conceptId: card.conceptId,
        dimension: card.dimension as Dimension,
        dueAt: card.dueAt.toISOString(),
        retrievability: retrievability(card.fsrs as Card, now, process.env.NODE_ENV !== 'test'),
      })),
      recentAttempts: recentAttempts.map((attempt) => ({
        conceptId: attempt.conceptId,
        exerciseId: attempt.exerciseId,
        dimension: attempt.dimension as Dimension,
        correct: attempt.correct,
        itemRole: 'core',
        createdAt: attempt.createdAt.toISOString(),
      })),
      remediationFlags: flags.map((flag) => ({
        conceptId: flag.conceptId,
        targetPrereqId: flag.targetPrereqId ?? undefined,
        status: flag.status,
      })),
      projectProgress: projects.map((project) => ({
        projectId: project.projectId,
        status: project.status,
      })),
      startDate: user?.startDate || now.toISOString(),
    };
  }

  async recentAttempts(limit = 100) {
    return this.db
      .select()
      .from(attempts)
      .where(eq(attempts.userId, this.userId))
      .orderBy(desc(attempts.createdAt))
      .limit(limit);
  }

  async events(conceptId?: string) {
    const where = conceptId
      ? and(eq(masteryEvents.userId, this.userId), eq(masteryEvents.conceptId, conceptId))
      : eq(masteryEvents.userId, this.userId);
    return this.db.select().from(masteryEvents).where(where).orderBy(desc(masteryEvents.createdAt));
  }

  async openFlags() {
    return this.db
      .select()
      .from(remediationFlags)
      .where(and(eq(remediationFlags.userId, this.userId), eq(remediationFlags.status, 'open')));
  }

  async attemptsForActivity(activityId: string, exerciseId: string) {
    return this.db
      .select()
      .from(attempts)
      .where(and(eq(attempts.activityId, activityId), eq(attempts.exerciseId, exerciseId)))
      .orderBy(asc(attempts.attemptNo));
  }

  async activeSession() {
    const [session] = await this.db
      .select()
      .from(studySessions)
      .where(and(eq(studySessions.userId, this.userId), eq(studySessions.status, 'active')))
      .orderBy(desc(studySessions.startedAt))
      .limit(1);
    return session;
  }

  async session(sessionId: string) {
    const [session] = await this.db
      .select()
      .from(studySessions)
      .where(and(eq(studySessions.id, sessionId), eq(studySessions.userId, this.userId)))
      .limit(1);
    if (!session) {
      return undefined;
    }
    const activities = await this.db
      .select()
      .from(sessionActivities)
      .where(eq(sessionActivities.sessionId, sessionId))
      .orderBy(asc(sessionActivities.idx));
    return { ...session, activities };
  }

  async dueCards(now: Date) {
    return this.db
      .select()
      .from(reviewCards)
      .where(and(eq(reviewCards.userId, this.userId), lte(reviewCards.dueAt, now)))
      .orderBy(asc(reviewCards.dueAt));
  }

  async saveHintEvent(input: {
    activityId?: string;
    exerciseId: string;
    level: number;
    text: string;
  }) {
    return this.db
      .insert(hintEvents)
      .values({
        userId: this.userId,
        activityId: input.activityId,
        exerciseId: input.exerciseId,
        level: input.level,
        source: 'authored',
        text: input.text,
      })
      .returning();
  }

  async diagnosticRun(runId: string) {
    const [run] = await this.db
      .select()
      .from(diagnosticRuns)
      .where(and(eq(diagnosticRuns.id, runId), eq(diagnosticRuns.userId, this.userId)))
      .limit(1);
    return run;
  }

  async latestDiagnosticRun() {
    const [run] = await this.db
      .select()
      .from(diagnosticRuns)
      .where(eq(diagnosticRuns.userId, this.userId))
      .orderBy(desc(diagnosticRuns.startedAt))
      .limit(1);
    return run;
  }

  async logs(cardId: string) {
    return this.db.select().from(reviewLogs).where(eq(reviewLogs.cardId, cardId));
  }
}
