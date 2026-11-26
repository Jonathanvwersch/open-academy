import { activeStudyCourseIds, studySetBackfill } from '../course/study-set.js';
import type { ContentIndex } from '../course/types.js';
import { activePlacementRuns } from '../placement/diagnostic-commands.js';
import { loadSchedulerState } from '../planner/load-scheduler-state.js';
import { attemptedExerciseIdsByActivity as groupAttemptedExerciseIdsByActivity } from '../planner/review-topics.js';
import type { SchedulerState } from '../planner/scheduler.js';
import { activeSessionForDate, recoverReviewActivities } from '../planner/session-state.js';
import type { Enrollment, Settings } from '../store/core-store.js';
import type { CourseStore } from '../store/course-store.js';
import type { Session } from '../store/session-store.js';

export type EngineUser = {
  id: string;
  timezone: string;
  startDate: string;
  prefs: Record<string, unknown>;
  activeCourseId: string | null;
  studySetInitializedAt: Date | null;
};

export function engineUser(userId: string, settings: Settings | undefined): EngineUser | undefined {
  return settings
    ? {
        id: userId,
        timezone: settings.timeZone,
        startDate: settings.startDate,
        prefs: settings.prefs,
        activeCourseId: settings.activeCourseId,
        studySetInitializedAt: settings.studySetInitializedAt,
      }
    : undefined;
}

export class EngineLearnerRepository {
  private userPromise: Promise<EngineUser | undefined> | undefined;
  private courseEnrollmentsPromise: Promise<Enrollment[]> | undefined;
  private studyCourseIdsPromise: Promise<string[]> | undefined;
  private studySetInitialized = false;

  constructor(
    readonly store: CourseStore,
    readonly userId: string,
    private readonly requestUser?: EngineUser,
    private readonly sessionContent?: { load: () => Promise<ContentIndex>; now: () => Date },
    private readonly enableFsrsFuzz = true,
  ) {}

  user() {
    if (this.requestUser) return Promise.resolve(this.requestUser);
    this.userPromise ??= this.store
      .getSettings(this.userId)
      .then((settings) => engineUser(this.userId, settings));
    return this.userPromise;
  }

  async settings(): Promise<Settings | undefined> {
    if (!this.requestUser && !this.userPromise) return this.store.getSettings(this.userId);
    const user = await this.user();
    if (!user) return undefined;
    const { activeCourseId, studySetInitializedAt, startDate, timezone, prefs } = user;
    return { activeCourseId, studySetInitializedAt, startDate, timeZone: timezone, prefs };
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
        this.store.listMastery(this.userId),
        this.store.listLessonRuns(this.userId),
      ]);
      const backfill = studySetBackfill(
        content,
        enrollments,
        masteryRows.map(({ conceptId, state }) => ({ conceptId, state })),
        lessonRunRows.map(({ conceptId }) => ({ conceptId })),
      );
      if (backfill.length > 0) {
        const startedAt = now();
        await this.store.writeEnrollments(this.userId, {
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
      await this.store.patchSettings(this.userId, { studySetInitializedAt: now() });
      this.studySetInitialized = true;
    }
    return this.activeStudyCourseIds(content);
  }

  async activeStudyCourseIds(content: ContentIndex): Promise<string[]> {
    return activeStudyCourseIds(content, await this.courseEnrollments());
  }

  async schedulerState(
    now: Date,
    content: ContentIndex,
    loaded: Pick<Partial<SchedulerState>, 'mastery' | 'lessonRuns' | 'projectProgress'> = {},
  ): Promise<SchedulerState> {
    await this.user();
    const settings = await this.settings();
    return loadSchedulerState(this.store, this.userId, content, now, {
      ...loaded,
      settings: settings ?? null,
      studyCourseIds: this.studyCourseIds(content, this.sessionContent?.now ?? (() => now)),
      enableFsrsFuzz: this.enableFsrsFuzz,
    });
  }

  async attemptedExerciseIdsByActivity(activityIds: readonly string[]) {
    const rows = await this.store.listActivityAttemptKeys(this.userId, activityIds);
    return groupAttemptedExerciseIdsByActivity(rows);
  }

  async activeSession(now: Date) {
    const user = await this.user();
    const session = await activeSessionForDate(
      this.store,
      this.userId,
      now,
      user?.timezone ?? 'UTC',
    );
    return session && { ...session, userId: this.userId };
  }

  async session(sessionId: string, loaded?: Session & { userId: string }) {
    const session =
      loaded?.id === sessionId && loaded.userId === this.userId
        ? loaded
        : (await this.store.listSessions(this.userId, { ids: [sessionId] }))[0];
    if (!session) return undefined;
    const activities = await this.store.listActivities(this.userId, { sessionIds: [sessionId] });
    if (this.sessionContent && session.status === 'active') {
      const content = await this.sessionContent.load();
      const now = this.sessionContent.now();
      await recoverReviewActivities(this.store, this.userId, activities, content, now, () =>
        this.schedulerState(now, content),
      );
    }
    return { ...session, userId: this.userId, activities };
  }

  activePlacementRuns() {
    return activePlacementRuns(this.store, this.userId);
  }

  courseEnrollments() {
    this.courseEnrollmentsPromise ??= this.store.listEnrollments(this.userId);
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
    await this.store.writeEnrollments(this.userId, {
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
    await this.store.writeEnrollments(this.userId, {
      kind: 'set_status',
      courseIds: [courseId],
      status,
      completedAt,
    });
    this.invalidateEnrollmentCaches();
  }

  async completeCourses(courseIds: readonly string[], completedAt: Date) {
    if (courseIds.length === 0) return;
    await this.store.writeEnrollments(this.userId, {
      kind: 'complete',
      courseIds,
      now: completedAt,
    });
    this.invalidateEnrollmentCaches();
  }
}
