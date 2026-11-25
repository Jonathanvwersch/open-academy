import type { Dimension } from '@academy/aesop/course/schemas';
import type { ContentIndex } from '@academy/aesop/course/types';
import { filterSchedulerStateForContent } from '@academy/aesop/graph/content-filters';
import { courseHasEvidence } from '@academy/aesop/graph/course-start';
import { retrievability, startOfNextCalendarDay } from '@academy/aesop/memory/fsrs';
import type { MasteryRecord } from '@academy/aesop/memory/types';
import { attemptedExerciseIdsByActivity as groupAttemptedExerciseIdsByActivity } from '@academy/aesop/planner/review-topics';
import {
  buildRemedialReviewActivityForConcept,
  buildReviewActivityForConcept,
  effectiveFocusSubjectId,
  type SchedulerState,
} from '@academy/aesop/planner/scheduler';
import { localDateKey } from '@academy/aesop/progress/xp';
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import type { Card } from 'ts-fsrs';
import { z } from 'zod';
import type { Database } from './client.js';
import { drizzleLearnerStore } from './learner-store.js';
import {
  attempts,
  courseEnrollments,
  diagnosticRuns,
  hintEvents,
  lessonRuns,
  mastery,
  masteryEvents,
  paperProgress,
  projectProgress,
  remediationFlags,
  reviewCards,
  reviewLogs,
  sessionActivities,
  studySessions,
  users,
} from './schema.js';

export class LearnerRepository {
  private userPromise: Promise<typeof users.$inferSelect | undefined> | undefined;
  private courseEnrollmentsPromise: Promise<(typeof courseEnrollments.$inferSelect)[]> | undefined;
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

  async activeCourseId(): Promise<string | null> {
    return (await this.user())?.activeCourseId ?? null;
  }

  async setActiveCourseId(courseId: string): Promise<void> {
    await this.db.update(users).set({ activeCourseId: courseId }).where(eq(users.id, this.userId));
  }

  studyCourseIds(content: ContentIndex): Promise<string[]> {
    this.studyCourseIdsPromise ??= this.loadStudyCourseIds(content).catch((error: unknown) => {
      this.invalidateEnrollmentCaches();
      throw error;
    });
    return this.studyCourseIdsPromise;
  }

  private async loadStudyCourseIds(content: ContentIndex): Promise<string[]> {
    const user = await this.user();
    if (!user) return [];
    if (user.studySetInitializedAt) this.studySetInitialized = true;

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
      const startedCourseIds = new Set(enrollments.map((enrollment) => enrollment.courseId));
      const started = content.courses
        .filter((course) =>
          courseHasEvidence(
            course.units.flatMap((unit) => unit.concepts),
            masteryRows,
            lessonRunRows,
          ),
        )
        .map((course) => course.id);
      for (const courseId of started) startedCourseIds.add(courseId);
      const courseOrder = content.curriculum?.courses ?? content.courses.map((course) => course.id);
      const backfill = courseOrder.filter((courseId) => startedCourseIds.has(courseId));
      if (backfill.length > 0) {
        await this.db
          .insert(courseEnrollments)
          .values(
            backfill.map((courseId) => ({
              userId: this.userId,
              courseId,
              startMethod: 'beginning' as const,
            })),
          )
          .onConflictDoNothing();
        this.courseEnrollmentsPromise = undefined;
      }
      await this.db
        .update(users)
        .set({ studySetInitializedAt: new Date() })
        .where(eq(users.id, this.userId));
      this.studySetInitialized = true;
    }

    return this.activeStudyCourseIds(content);
  }

  async activeStudyCourseIds(content: ContentIndex): Promise<string[]> {
    const activeCourseIds = new Set(
      (await this.courseEnrollments())
        .filter((enrollment) => enrollment.status === 'active')
        .map((enrollment) => enrollment.courseId),
    );
    const courseOrder = content.curriculum?.courses ?? content.courses.map((course) => course.id);
    return courseOrder.filter((courseId) => activeCourseIds.has(courseId));
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
    const user = await this.user();
    const recallExerciseIds = (content.exercisesByRole.get('recall') ?? []).map(
      (exercise) => exercise.id,
    );
    const [
      masteryRows,
      cards,
      recentAttempts,
      flags,
      projects,
      lessonRunRows,
      paperRows,
      studyCourseIds,
      recentLearnActivities,
      todayReviewLogs,
      completedReviewLogsToday,
      recallAttemptRows,
    ] = await Promise.all([
      loaded.mastery ?? this.masteryRecords(),
      this.db
        .select()
        .from(reviewCards)
        .where(and(eq(reviewCards.userId, this.userId), isNull(reviewCards.suspendedAt)))
        .orderBy(asc(reviewCards.conceptId), asc(reviewCards.dimension), asc(reviewCards.id)),
      this.db
        .select()
        .from(attempts)
        .where(eq(attempts.userId, this.userId))
        .orderBy(
          desc(attempts.createdAt),
          asc(attempts.exerciseId),
          desc(attempts.attemptNo),
          desc(attempts.correct),
          asc(attempts.mode),
          asc(attempts.id),
        )
        .limit(100),
      this.db
        .select()
        .from(remediationFlags)
        .where(and(eq(remediationFlags.userId, this.userId), eq(remediationFlags.status, 'open')))
        .orderBy(
          asc(remediationFlags.conceptId),
          asc(remediationFlags.targetPrereqId),
          asc(remediationFlags.id),
        ),
      loaded.projectProgress ??
        this.db
          .select({ projectId: projectProgress.projectId, status: projectProgress.status })
          .from(projectProgress)
          .where(eq(projectProgress.userId, this.userId))
          .orderBy(asc(projectProgress.projectId)),
      loaded.lessonRuns ??
        this.db
          .select({
            conceptId: lessonRuns.conceptId,
            status: lessonRuns.status,
            startedAt: lessonRuns.startedAt,
            retryAfter: lessonRuns.retryAfter,
          })
          .from(lessonRuns)
          .where(eq(lessonRuns.userId, this.userId))
          .orderBy(asc(lessonRuns.conceptId), desc(lessonRuns.startedAt), desc(lessonRuns.id)),
      this.db
        .select()
        .from(paperProgress)
        .where(eq(paperProgress.userId, this.userId))
        .orderBy(asc(paperProgress.paperId)),
      this.studyCourseIds(content),
      this.db
        .select({
          conceptId: sessionActivities.conceptId,
          plannedMinutes: sql<number>`coalesce(sum(${sessionActivities.plannedMinutes}), 0)::int`,
        })
        .from(sessionActivities)
        .innerJoin(studySessions, eq(sessionActivities.sessionId, studySessions.id))
        .where(
          and(
            eq(studySessions.userId, this.userId),
            eq(sessionActivities.kind, 'learn'),
            eq(sessionActivities.status, 'completed'),
            gte(sessionActivities.completedAt, new Date(now.getTime() - 7 * 86_400_000)),
            lte(sessionActivities.completedAt, now),
          ),
        )
        .groupBy(sessionActivities.conceptId),
      this.db
        .select({ conceptId: reviewCards.conceptId, createdAt: reviewLogs.createdAt })
        .from(reviewLogs)
        .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
        .where(
          and(
            eq(reviewCards.userId, this.userId),
            sql`coalesce(${reviewLogs.fsrsLog}->>'source', '') <> 'mixed_quiz'`,
            gte(reviewLogs.createdAt, new Date(now.getTime() - 36 * 60 * 60 * 1000)),
            lt(reviewLogs.createdAt, startOfNextCalendarDay(now, user?.timezone ?? 'UTC')),
          ),
        ),
      this.db
        .select({
          activityId: attempts.activityId,
          conceptId: reviewCards.conceptId,
          rating: reviewLogs.rating,
          createdAt: reviewLogs.createdAt,
        })
        .from(reviewLogs)
        .innerJoin(reviewCards, eq(reviewLogs.cardId, reviewCards.id))
        .innerJoin(attempts, eq(reviewLogs.attemptId, attempts.id))
        .innerJoin(sessionActivities, eq(attempts.activityId, sessionActivities.id))
        .where(
          and(
            eq(reviewCards.userId, this.userId),
            eq(sessionActivities.kind, 'review'),
            eq(sessionActivities.status, 'completed'),
            gte(reviewLogs.createdAt, new Date(now.getTime() - 36 * 60 * 60 * 1000)),
            lt(reviewLogs.createdAt, startOfNextCalendarDay(now, user?.timezone ?? 'UTC')),
          ),
        ),
      recallExerciseIds.length > 0
        ? this.db
            .selectDistinctOn([attempts.exerciseId], {
              exerciseId: attempts.exerciseId,
              correct: attempts.correct,
              createdAt: attempts.createdAt,
            })
            .from(attempts)
            .where(
              and(
                eq(attempts.userId, this.userId),
                sql`${attempts.exerciseId} = any(array[${sql.join(
                  recallExerciseIds.map((exerciseId) => sql`${exerciseId}`),
                  sql`, `,
                )}]::text[])`,
              ),
            )
            .orderBy(
              asc(attempts.exerciseId),
              desc(attempts.createdAt),
              desc(attempts.attemptNo),
              desc(attempts.correct),
              desc(attempts.id),
            )
        : Promise.resolve(
            [] as Array<{
              exerciseId: string;
              correct: number;
              createdAt: Date;
            }>,
          ),
    ]);
    const recentLearnMinutesByConcept: Record<string, number> = {};
    for (const activity of recentLearnActivities) {
      if (!activity.conceptId) continue;
      recentLearnMinutesByConcept[activity.conceptId] =
        (recentLearnMinutesByConcept[activity.conceptId] ?? 0) + activity.plannedMinutes;
    }
    const completedReviewRatingsByActivityConcept = new Map<
      string,
      { conceptId: string; rating: number }
    >();
    for (const log of completedReviewLogsToday) {
      if (
        !log.activityId ||
        localDateKey(log.createdAt, user?.timezone ?? 'UTC') !==
          localDateKey(now, user?.timezone ?? 'UTC')
      ) {
        continue;
      }
      const key = `${log.activityId}\u0000${log.conceptId}`;
      const rating = Number(log.rating);
      const previous = completedReviewRatingsByActivityConcept.get(key);
      if (previous) previous.rating = Math.min(previous.rating, rating);
      else completedReviewRatingsByActivityConcept.set(key, { conceptId: log.conceptId, rating });
    }
    const focusSubjectId = effectiveFocusSubjectId(
      user?.prefs as { focusSubjectId?: unknown } | undefined,
      studyCourseIds,
      content,
    );
    return {
      timezone: user?.timezone ?? 'UTC',
      activeCourseId: user?.activeCourseId ?? null,
      studyCourseIds,
      focusSubjectId: focusSubjectId ?? undefined,
      recentLearnMinutesByConcept,
      mastery: masteryRows,
      cards: cards.map((card) => ({
        conceptId: card.conceptId,
        dimension: card.dimension as Dimension,
        dueAt: card.dueAt.toISOString(),
        fsrs: card.fsrs as Card,
        retrievability: retrievability(card.fsrs as Card, now, process.env.NODE_ENV !== 'test'),
      })),
      reviewedTodayConceptIds: [
        ...new Set(
          todayReviewLogs
            .filter(
              (log) =>
                localDateKey(log.createdAt, user?.timezone ?? 'UTC') ===
                localDateKey(now, user?.timezone ?? 'UTC'),
            )
            .map((log) => log.conceptId),
        ),
      ],
      completedReviewRatingsToday: [...completedReviewRatingsByActivityConcept.values()],
      recentAttempts: recentAttempts.map((attempt) => ({
        conceptId: attempt.conceptId,
        exerciseId: attempt.exerciseId,
        dimension: attempt.dimension as Dimension,
        correct: attempt.correct,
        itemRole: 'core',
        createdAt: attempt.createdAt.toISOString(),
      })),
      recallAttempts: recallAttemptRows.map((attempt) => ({
        exerciseId: attempt.exerciseId,
        correct: attempt.correct,
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
      completedPaperIds: paperRows
        .filter((row) => row.completedAt !== null)
        .map((row) => row.paperId),
      lessonRuns: lessonRunRows.map((run) => ({
        conceptId: run.conceptId,
        status: run.status,
        startedAt: run.startedAt,
        retryAfter: run.retryAfter ?? undefined,
      })),
      startDate: user?.startDate || localDateKey(now, user?.timezone ?? 'UTC'),
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

  async attemptedExerciseIdsByActivity(activityIds: readonly string[]) {
    if (activityIds.length === 0) return new Map<string, Set<string>>();
    const rows = await this.db
      .select({ activityId: attempts.activityId, exerciseId: attempts.exerciseId })
      .from(attempts)
      .where(and(eq(attempts.userId, this.userId), inArray(attempts.activityId, activityIds)));
    return groupAttemptedExerciseIdsByActivity(rows);
  }

  async activeSession(now: Date) {
    const user = await this.user();
    const timezone = user?.timezone ?? 'UTC';
    const today = localDateKey(now, timezone);
    const sessions = await this.db
      .select()
      .from(studySessions)
      .where(and(eq(studySessions.userId, this.userId), eq(studySessions.status, 'active')))
      .orderBy(desc(studySessions.startedAt));
    return sessions.find(
      (session) => session.startedAt && localDateKey(session.startedAt, timezone) === today,
    );
  }

  async session(sessionId: string, loaded?: typeof studySessions.$inferSelect) {
    if (!z.string().uuid().safeParse(sessionId).success) return undefined;
    const session =
      loaded?.id === sessionId && loaded.userId === this.userId
        ? loaded
        : (
            await this.db
              .select()
              .from(studySessions)
              .where(and(eq(studySessions.id, sessionId), eq(studySessions.userId, this.userId)))
              .limit(1)
          )[0];
    if (!session) {
      return undefined;
    }
    const activities = await this.db
      .select()
      .from(sessionActivities)
      .where(eq(sessionActivities.sessionId, sessionId))
      .orderBy(asc(sessionActivities.idx));
    if (this.sessionContent && session.status === 'active') {
      await this.recoverReviewActivities(
        activities,
        await this.sessionContent.load(),
        this.sessionContent.now(),
      );
    }
    return { ...session, activities };
  }

  private async recoverReviewActivities(
    activities: (typeof sessionActivities.$inferSelect)[],
    content: ContentIndex,
    now: Date,
  ) {
    let state: SchedulerState | undefined;
    for (const activity of activities) {
      if (
        activity.kind !== 'review' ||
        (activity.status !== 'planned' && activity.status !== 'in_progress')
      )
        continue;
      const survivors = activity.exerciseIds.filter((id) => content.exercisesById.has(id));
      if (survivors.length === activity.exerciseIds.length) continue;
      const exerciseIds = survivors;
      if (exerciseIds.length === 0) {
        state ??= filterSchedulerStateForContent(content, await this.schedulerState(now, content));
        const usedExerciseIds = activities
          .filter((other) => other.id !== activity.id)
          .flatMap((other) => other.exerciseIds);
        const reservedTopics = new Set(
          usedExerciseIds.map((id) => content.exercisesById.get(id)?.concept),
        );
        const topics = activity.conceptId
          ? [activity.conceptId]
          : [...new Set(state.cards.map((card) => card.conceptId))].filter(
              (id) => !reservedTopics.has(id),
            );
        for (const topic of topics) {
          const reselect = state.remediationFlags.some(
            (flag) => flag.status !== 'resolved' && flag.targetPrereqId === topic,
          )
            ? buildRemedialReviewActivityForConcept
            : buildReviewActivityForConcept;
          const replacement = reselect(
            { ...state, usedExerciseIds: [...usedExerciseIds, ...exerciseIds] },
            content,
            now,
            topic,
          );
          if (replacement) exerciseIds.push(...replacement.exerciseIds);
          if (exerciseIds.length >= activity.exerciseIds.length) break;
        }
      }
      const [updated] = await this.db
        .update(sessionActivities)
        .set({
          exerciseIds,
          reason: { ...(activity.reason as object), removedQuestions: true },
        })
        .where(
          and(
            eq(sessionActivities.id, activity.id),
            eq(sessionActivities.exerciseIds, activity.exerciseIds),
          ),
        )
        .returning();
      if (updated) Object.assign(activity, updated);
      else {
        const [current] = await this.db
          .select()
          .from(sessionActivities)
          .where(eq(sessionActivities.id, activity.id));
        if (current) Object.assign(activity, current);
      }
    }
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

  async placementRun(runId: string) {
    if (!z.string().uuid().safeParse(runId).success) return undefined;
    const [run] = await this.db
      .select()
      .from(diagnosticRuns)
      .where(and(eq(diagnosticRuns.id, runId), eq(diagnosticRuns.userId, this.userId)))
      .limit(1);
    return run?.kind === 'placement' ? run : undefined;
  }

  async activePlacementRun(courseId: string) {
    const runs = await this.activePlacementRuns();
    return runs.find((run) => (run.state as { courseId?: unknown }).courseId === courseId);
  }

  async activePlacementRuns() {
    return this.db
      .select()
      .from(diagnosticRuns)
      .where(
        and(
          eq(diagnosticRuns.userId, this.userId),
          eq(diagnosticRuns.kind, 'placement'),
          eq(diagnosticRuns.status, 'active'),
        ),
      )
      .orderBy(desc(diagnosticRuns.startedAt));
  }

  courseEnrollments() {
    this.courseEnrollmentsPromise ??= this.loadCourseEnrollments();
    return this.courseEnrollmentsPromise;
  }

  private async loadCourseEnrollments() {
    return this.db
      .select()
      .from(courseEnrollments)
      .where(eq(courseEnrollments.userId, this.userId));
  }

  private invalidateEnrollmentCaches() {
    this.courseEnrollmentsPromise = undefined;
    this.studyCourseIdsPromise = undefined;
  }

  async courseEnrollment(courseId: string) {
    const [enrollment] = await this.db
      .select()
      .from(courseEnrollments)
      .where(
        and(eq(courseEnrollments.userId, this.userId), eq(courseEnrollments.courseId, courseId)),
      )
      .limit(1);
    return enrollment;
  }

  async startCourse(courseId: string, startMethod: 'placement' | 'beginning', startedAt: Date) {
    await this.db
      .insert(courseEnrollments)
      .values({
        userId: this.userId,
        courseId,
        startMethod,
        startedAt,
      })
      .onConflictDoUpdate({
        target: [courseEnrollments.userId, courseEnrollments.courseId],
        set: { status: 'active' },
      });
    this.invalidateEnrollmentCaches();
  }

  async setCourseEnrollmentStatus(
    courseId: string,
    status: 'active' | 'paused' | 'completed',
    completedAt: Date | null = null,
  ) {
    await this.db
      .update(courseEnrollments)
      .set({ status, completedAt })
      .where(
        and(eq(courseEnrollments.userId, this.userId), eq(courseEnrollments.courseId, courseId)),
      );
    this.invalidateEnrollmentCaches();
  }

  async completeCourses(courseIds: readonly string[], completedAt: Date) {
    if (courseIds.length === 0) return;
    await this.db
      .insert(courseEnrollments)
      .values(
        courseIds.map((courseId) => ({
          userId: this.userId,
          courseId,
          status: 'completed' as const,
          startMethod: 'beginning' as const,
          completedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [courseEnrollments.userId, courseEnrollments.courseId],
        set: { status: 'completed', completedAt },
      });
    this.invalidateEnrollmentCaches();
  }

  async logs(cardId: string) {
    return this.db.select().from(reviewLogs).where(eq(reviewLogs.cardId, cardId));
  }
}
