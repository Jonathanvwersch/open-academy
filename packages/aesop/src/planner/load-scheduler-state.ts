import type { Dimension } from '../course/schemas.js';
import type { ContentIndex } from '../course/types.js';
import { retrievability } from '../memory/fsrs.js';
import { topicSpeed } from '../memory/speed.js';
import { localDateKey } from '../progress/xp.js';
import type { Id, Settings } from '../store/core-store.js';
import type { SessionStore } from '../store/session-store.js';
import { effectiveFocusSubjectId, type SchedulerState } from './scheduler.js';

export type LoadedSchedulerState = Pick<
  Partial<SchedulerState>,
  'mastery' | 'lessonRuns' | 'projectProgress'
> & {
  settings?: Settings | null;
  studyCourseIds?: string[] | Promise<string[]>;
  enableFsrsFuzz?: boolean;
};

export async function loadSchedulerState(
  store: SessionStore,
  learnerId: Id,
  content: ContentIndex,
  now: Date,
  loaded: LoadedSchedulerState = {},
): Promise<SchedulerState> {
  const [settings, studyCourseIds, facts] = await Promise.all([
    loaded.settings === undefined ? store.getSettings(learnerId) : loaded.settings,
    loaded.studyCourseIds ?? activeStudyCourseIds(store, learnerId, content),
    store.readSchedulerFacts(learnerId, {
      now,
      recallExerciseIds: (content.exercisesByRole.get('recall') ?? []).map(({ id }) => id),
      skip: (['mastery', 'lessonRuns', 'projectProgress'] as const).filter(
        (key) => loaded[key] !== undefined,
      ),
    }),
  ]);
  const timezone = settings?.timeZone ?? 'UTC';
  const {
    cards,
    recentAttempts,
    flags,
    paperProgress: paperRows,
    learnMinutes: recentLearnActivities,
    reviewLogFacts: todayReviewLogs,
    completedReviewLogFacts: completedReviewLogsToday,
    recallAttempts: recallAttemptRows,
    topicSpeeds: speedEvidence,
  } = facts;
  const masteryRows = loaded.mastery ?? facts.mastery ?? [];
  const projects = loaded.projectProgress ?? facts.projectProgress ?? [];
  const lessonRunRows = loaded.lessonRuns ?? facts.lessonRuns ?? [];
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
    if (!log.activityId || localDateKey(log.createdAt, timezone) !== localDateKey(now, timezone)) {
      continue;
    }
    const key = `${log.activityId}\u0000${log.conceptId}`;
    const rating = Number(log.rating);
    const previous = completedReviewRatingsByActivityConcept.get(key);
    if (previous) previous.rating = Math.min(previous.rating, rating);
    else completedReviewRatingsByActivityConcept.set(key, { conceptId: log.conceptId, rating });
  }
  const focusSubjectId = effectiveFocusSubjectId(settings?.prefs, studyCourseIds, content);
  return {
    timezone,
    topicSpeeds: Object.fromEntries(
      speedEvidence.map((record) => [record.conceptId, topicSpeed(record)]),
    ),
    activeCourseId: settings?.activeCourseId ?? null,
    studyCourseIds,
    focusSubjectId: focusSubjectId ?? undefined,
    recentLearnMinutesByConcept,
    mastery: masteryRows,
    cards: cards.map((card) => ({
      conceptId: card.conceptId,
      dimension: card.dimension,
      dueAt: card.dueAt.toISOString(),
      fsrs: card.fsrs,
      retrievability: retrievability(card.fsrs, now, loaded.enableFsrsFuzz ?? false),
    })),
    reviewedTodayConceptIds: [
      ...new Set(
        todayReviewLogs
          .filter((log) => localDateKey(log.createdAt, timezone) === localDateKey(now, timezone))
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
    startDate: settings?.startDate || localDateKey(now, timezone),
  };
}

async function activeStudyCourseIds(store: SessionStore, learnerId: Id, content: ContentIndex) {
  const active = new Set(
    (await store.listEnrollments(learnerId))
      .filter((enrollment) => enrollment.status === 'active')
      .map((enrollment) => enrollment.courseId),
  );
  const courseOrder = content.curriculum?.courses ?? content.courses.map((course) => course.id);
  return courseOrder.filter((courseId) => active.has(courseId));
}
