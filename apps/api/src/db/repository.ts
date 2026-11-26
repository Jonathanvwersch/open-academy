import type { Dimension } from '@academy/aesop/course/schemas';
import { activeStudyCourseIds, studySetBackfill } from '@academy/aesop/course/study-set';
import type { ContentIndex } from '@academy/aesop/course/types';
import { startOfNextCalendarDay } from '@academy/aesop/memory/fsrs';
import type { MasteryRecord } from '@academy/aesop/memory/types';
import { activePlacementRuns } from '@academy/aesop/placement/diagnostic-commands';
import { loadSchedulerState } from '@academy/aesop/planner/load-scheduler-state';
import { attemptedExerciseIdsByActivity as groupAttemptedExerciseIdsByActivity } from '@academy/aesop/planner/review-topics';
import type { SchedulerState } from '@academy/aesop/planner/scheduler';
import {
  activeSessionForDate,
  recoverReviewActivities,
} from '@academy/aesop/planner/session-state';
import type { Enrollment } from '@academy/aesop/store/core-store';
import type { Session } from '@academy/aesop/store/session-store';
import { and, asc, desc, eq, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from './client.js';
import { drizzleLearnerStore } from './learner-store.js';
import {
  attempts,
  hintEvents,
  lessonRuns,
  mastery,
  masteryEvents,
  remediationFlags,
  reviewCards,
  reviewLogs,
  users,
} from './schema.js';

export class LearnerRepository {
  private userPromise: Promise<typeof users.$inferSelect | undefined> | undefined;
  private courseEnrollmentsPromise: Promise<Enrollment[]> | undefined;
  private studyCourseIdsPromise: Promise<string[]> | undefined;
  private studySetInitialized = false;

  constructor(
    readonly db: Database,
    readonly userId: string,
    private readonly requestUser?: typeof users.$inferSelect,
    private readonly sessionContent?: { load: () => Promise<ContentIndex>; now: () => Date },
  ) {}

  user() {
    // HTTP middleware has already read this row. Reuse it only within that request.
    if (this.requestUser) return Promise.resolve(this.requestUser);
    this.userPromise ??= this.loadUser();
    return this.userPromise;
  }

  private async loadUser() {
    const [user] = await this.db.select().from(users).where(eq(users.id, this.userId)).limit(1);
    return user;
  }

  async settings() {
    if (!this.requestUser && !this.userPromise) {
      return drizzleLearnerStore(this.db).getSettings(this.userId);
    }
    const user = await this.user();
    if (!user) return undefined;
    const { activeCourseId, studySetInitializedAt, startDate, timezone, prefs } = user;
    return {
      activeCourseId,
      studySetInitializedAt,
      startDate,
      timeZone: timezone,
      prefs: prefs as Record<string, unknown>,
    };
  }

  async activeCourseId(): Promise<string | null> {
    return (await this.settings())?.activeCourseId ?? null;
  }

  studyCourseIds(
    content: ContentIndex,
    now = this.sessionContent?.now ?? (() => new Date()),
  ): Promise<string[]> {
    this.studyCourseIdsPromise ??= this.loadStudyCourseIds(content, now).catch((error: unknown) => {
      this.invalidateEnrollmentCaches();
      throw error;
    });
    return this.studyCourseIdsPromise;
  }

  private async loadStudyCourseIds(content: ContentIndex, now: () => Date): Promise<string[]> {
    const settings = await this.settings();
    if (!settings) return [];
    if (settings.studySetInitializedAt) this.studySetInitialized = true;

    if (!this.studySetInitialized) {
      const [enrollments, masteryRows, lessonRunRows] = await Promise.all([
        this.courseEnrollments(),
        this.db
          .select({ conceptId: mastery.conceptId, state: mastery.state })
          .from(mastery)
          .where(eq(mastery.userId, this.userId)),
        this.db
          .select({ conceptId: lessonRuns.conceptId })
          .from(lessonRuns)
          .where(eq(lessonRuns.userId, this.userId)),
      ]);
      const backfill = studySetBackfill(content, enrollments, masteryRows, lessonRunRows);
      const store = drizzleLearnerStore(this.db);
      if (backfill.length > 0) {
        const startedAt = now();
        await store.writeEnrollments(this.userId, {
          kind: 'insert_missing',
          rows: backfill.map((courseId) => ({
            courseId,
            status: 'active',
            startMethod: 'beginning',
            startedAt,
            completedAt: null,
          })),
        });
        this.courseEnrollmentsPromise = undefined;
      }
      await store.patchSettings(this.userId, { studySetInitializedAt: now() });
      this.studySetInitialized = true;
    }

    return this.activeStudyCourseIds(content);
  }

  async activeStudyCourseIds(content: ContentIndex): Promise<string[]> {
    return activeStudyCourseIds(content, await this.courseEnrollments());
  }

  async masteryRecords(): Promise<MasteryRecord[]> {
    return drizzleLearnerStore(this.db).listMastery(this.userId);
  }

  async masteryRecord(conceptId: string, dimension: Dimension): Promise<MasteryRecord | undefined> {
    return drizzleLearnerStore(this.db).getMastery(this.userId, conceptId, dimension);
  }

  async saveMastery(record: MasteryRecord): Promise<void> {
    await drizzleLearnerStore(this.db).saveMastery(this.userId, record);
  }

  async schedulerState(
    now: Date,
    content: ContentIndex,
    loaded: Pick<Partial<SchedulerState>, 'mastery' | 'lessonRuns' | 'projectProgress'> = {},
  ): Promise<SchedulerState> {
    await this.user();
    const settings = await this.settings();
    const store = drizzleLearnerStore(this.db, { schedulerTimezone: settings?.timeZone ?? 'UTC' });
    return loadSchedulerState(store, this.userId, content, now, {
      ...loaded,
      settings: settings ?? null,
      studyCourseIds: this.studyCourseIds(content, this.sessionContent?.now ?? (() => now)),
      enableFsrsFuzz: process.env.NODE_ENV !== 'test',
    });
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

  async attemptedExerciseIdsByActivity(activityIds: readonly string[]) {
    const rows = await drizzleLearnerStore(this.db).listActivityAttemptKeys(this.userId, activityIds);
    return groupAttemptedExerciseIdsByActivity(rows);
  }

  async activeSession(now: Date) {
    const user = await this.user();
    const session = await activeSessionForDate(
      drizzleLearnerStore(this.db),
      this.userId,
      now,
      user?.timezone ?? 'UTC',
    );
    return session && { ...session, userId: this.userId };
  }

  async session(sessionId: string, loaded?: Session & { userId: string }) {
    if (!z.string().uuid().safeParse(sessionId).success) return undefined;
    const store = drizzleLearnerStore(this.db);
    const session =
      loaded?.id === sessionId && loaded.userId === this.userId
        ? loaded
        : (await store.listSessions(this.userId, { ids: [sessionId] }))[0];
    if (!session) return undefined;
    const activities = await store.listActivities(this.userId, { sessionIds: [sessionId] });
    if (this.sessionContent && session.status === 'active') {
      const content = await this.sessionContent.load();
      const now = this.sessionContent.now();
      await recoverReviewActivities(store, this.userId, activities, content, now, () =>
        this.schedulerState(now, content),
      );
    }
    return { ...session, userId: this.userId, activities };
  }

  async dueCards(now: Date, timezone: string) {
    return this.db
      .select()
      .from(reviewCards)
      .where(
        and(
          eq(reviewCards.userId, this.userId),
          isNull(reviewCards.suspendedAt),
          lt(reviewCards.dueAt, startOfNextCalendarDay(now, timezone)),
        ),
      )
      .orderBy(asc(reviewCards.dueAt));
  }

  async saveHintEvent(input: {
    activityId?: string;
    exerciseId: string;
    level: number;
    text: string;
    source?: 'authored' | 'llm';
    createdAt: Date;
  }) {
    return this.db
      .insert(hintEvents)
      .values({
        userId: this.userId,
        activityId: input.activityId,
        exerciseId: input.exerciseId,
        level: input.level,
        source: input.source ?? 'authored',
        text: input.text,
        createdAt: input.createdAt,
      })
      .returning();
  }

  activePlacementRuns() {
    return activePlacementRuns(drizzleLearnerStore(this.db), this.userId);
  }

  courseEnrollments() {
    this.courseEnrollmentsPromise ??= drizzleLearnerStore(this.db).listEnrollments(this.userId);
    return this.courseEnrollmentsPromise;
  }

  private invalidateEnrollmentCaches() {
    this.courseEnrollmentsPromise = undefined;
    this.studyCourseIdsPromise = undefined;
  }

  async courseEnrollment(courseId: string) {
    return (await this.courseEnrollments()).find((row) => row.courseId === courseId);
  }

  async startCourse(courseId: string, startMethod: 'placement' | 'beginning', startedAt: Date) {
    await drizzleLearnerStore(this.db).writeEnrollments(this.userId, {
      kind: 'start',
      row: { courseId, startMethod, startedAt, status: 'active', completedAt: null },
    });
    this.invalidateEnrollmentCaches();
  }

  async setCourseEnrollmentStatus(
    courseId: string,
    status: 'active' | 'paused' | 'completed',
    completedAt: Date | null = null,
  ) {
    await drizzleLearnerStore(this.db).writeEnrollments(this.userId, {
      kind: 'set_status',
      courseIds: [courseId],
      status,
      completedAt,
    });
    this.invalidateEnrollmentCaches();
  }

  async completeCourses(courseIds: readonly string[], completedAt: Date) {
    if (courseIds.length === 0) return;
    await drizzleLearnerStore(this.db).writeEnrollments(this.userId, {
      kind: 'complete',
      courseIds,
      now: completedAt,
    });
    this.invalidateEnrollmentCaches();
  }

  async logs(cardId: string) {
    return this.db.select().from(reviewLogs).where(eq(reviewLogs.cardId, cardId));
  }
}
