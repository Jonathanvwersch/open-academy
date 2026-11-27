import type { LoadedSchedulerState } from '../planner/load-scheduler-state.js';
import { loadSchedulerState } from '../planner/load-scheduler-state.js';
import { activeSessionForDate, recoverReviewActivities } from '../planner/session-state.js';
import type { Enrollment, Settings } from '../store/core-store.js';
import type { CourseStore } from '../store/course-store.js';
import type { Session } from '../store/session-store.js';
import type { buildCoursePayload } from './course-payload.js';
import { studyCourseIds } from './study-set.js';
import type { ContentIndex } from './types.js';

export type CourseReadInput = {
  userId: string;
  content: ContentIndex;
  timeZone: string;
  now: () => Date;
  settings?: Settings | null;
  enableFsrsFuzz?: boolean;
};

export class CourseReader {
  private settingsPromise: Promise<Settings | undefined> | undefined;
  private enrollmentPromise: Promise<Enrollment[]> | undefined;
  private studyCourseIdsPromise: Promise<string[]> | undefined;

  constructor(
    readonly store: CourseStore,
    readonly input: CourseReadInput,
  ) {}

  settings() {
    const { settings, userId } = this.input;
    this.settingsPromise ??=
      settings === undefined
        ? this.store.getSettings(userId)
        : Promise.resolve(settings ?? undefined);
    return this.settingsPromise;
  }

  async activeCourseId() {
    return (await this.settings())?.activeCourseId ?? null;
  }

  enrollments() {
    this.enrollmentPromise ??= this.store.listEnrollments(this.input.userId);
    return this.enrollmentPromise;
  }

  studyCourseIds() {
    const { userId, content, now } = this.input;
    this.studyCourseIdsPromise ??= this.settings().then((settings) =>
      studyCourseIds(this.store, userId, content, now, settings, (refresh) => {
        if (refresh) this.enrollmentPromise = undefined;
        return this.enrollments();
      }),
    );
    return this.studyCourseIdsPromise;
  }

  activeSession(now: Date) {
    const { userId, timeZone } = this.input;
    return activeSessionForDate(this.store, userId, now, timeZone);
  }

  async session(id: string, loaded?: Session) {
    const { userId, content } = this.input;
    const session = loaded ?? (await this.store.listSessions(userId, { ids: [id] }))[0];
    if (!session) return;
    const activities = await this.store.listActivities(userId, { sessionIds: [id] });
    if (session.status === 'active') {
      const now = this.input.now();
      await recoverReviewActivities(this.store, userId, activities, content, now, () =>
        this.schedulerState(now),
      );
    }
    return { ...session, activities };
  }

  async schedulerState(now: Date, loaded: LoadedSchedulerState = {}) {
    const { userId, content, enableFsrsFuzz } = this.input;
    const settings = await this.settings();
    return loadSchedulerState(this.store, userId, content, now, {
      ...loaded,
      settings: settings ?? null,
      studyCourseIds: this.studyCourseIds(),
      enableFsrsFuzz,
    });
  }

  async completePayloadCourses(payload: ReturnType<typeof buildCoursePayload>, now: Date) {
    const completedCourseIds = payload.courses
      .filter((course) => course.topicsTotal > 0 && course.topicsDone === course.topicsTotal)
      .map((course) => course.id);
    if (completedCourseIds.length === 0) return;
    const enrollments = await this.enrollments();
    const courseIds = completedCourseIds.filter(
      (courseId) =>
        !enrollments.some(
          (enrollment) => enrollment.courseId === courseId && enrollment.status === 'completed',
        ),
    );
    if (courseIds.length === 0) return;
    await this.store.writeEnrollments(this.input.userId, { kind: 'complete', courseIds, now });
    this.enrollmentPromise = undefined;
    this.studyCourseIdsPromise = undefined;
  }
}
