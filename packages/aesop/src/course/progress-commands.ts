import type { ContentIndex } from '../course/types.js';
import { filterSchedulerStateForContent } from '../graph/content-filters.js';
import { createPrerequisiteChecker, labActivityReady, masteryKey } from '../graph/prerequisites.js';
import { initialLearnProgress } from '../lessons/initial-learn-progress.js';
import {
  effectiveFocusSubjectId,
  type PlannedActivity,
  replan,
  type SchedulerState,
} from '../planner/scheduler.js';
import type { Settings } from '../store/core-store.js';
import type { LessonStore } from '../store/lesson-store.js';
import type { Activity, Session } from '../store/session-store.js';

type CourseCommand = { userId: string; content: ContentIndex; now: Date };
type CourseSession = Session & { activities: Activity[] };

export async function restartTopic(
  store: LessonStore,
  { userId, conceptId, content }: { userId: string; conceptId: string; content: ContentIndex },
) {
  await store.transaction(async (tx) => {
    await tx.clearTopicProgress(userId, conceptId);
    const affectedCourseIds = content.courses
      .filter((course) => course.units.some((unit) => unit.concepts.includes(conceptId)))
      .map((course) => course.id);
    if (affectedCourseIds.length > 0) {
      await tx.writeEnrollments(userId, {
        kind: 'set_status',
        courseIds: affectedCourseIds,
        status: 'active',
        completedAt: null,
        ifStatus: 'completed',
      });
    }
    const sessions = await tx.listSessions(userId, {});
    if (!sessions.length) return;
    const sessionIds = sessions.map(({ id }) => id);
    const statuses = ['planned', 'in_progress'] as const;
    await tx.patchActivities(userId, { conceptId, sessionIds, statuses }, { status: 'skipped' });
    const dependentActivities = await tx.listActivities(userId, { sessionIds, statuses });
    const [masteryRows, runRows] = await Promise.all([
      tx.listMastery(userId),
      tx.listLessonRuns(userId),
    ]);
    const masteryByKey = new Map(
      masteryRows.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
    );
    const prerequisiteChecker = createPrerequisiteChecker(masteryByKey, runRows, content);
    const activitiesToSkip = dependentActivities
      .filter((activity) => {
        if (activity.kind === 'review') {
          return activity.exerciseIds.some(
            (exerciseId) => content.exercisesById.get(exerciseId)?.concept === conceptId,
          );
        }
        if (activity.kind === 'lab') {
          return !labActivityReady(activity, masteryByKey, runRows, content);
        }
        if ((activity.kind !== 'learn' && activity.kind !== 'practice') || !activity.conceptId) {
          return false;
        }
        if (!content.conceptsById.has(activity.conceptId)) return false;
        return !prerequisiteChecker.chainReady(activity.conceptId);
      })
      .map((activity) => activity.id);
    if (activitiesToSkip.length) {
      await tx.patchActivities(userId, { ids: activitiesToSkip, statuses }, { status: 'skipped' });
    }
  });
}

export async function replanSessionActivities(
  store: LessonStore,
  input: CourseCommand & {
    session: CourseSession;
    skipActivityIds?: readonly string[];
    activatePlannedActivityId?: string;
    schedulerState: SchedulerState;
  },
) {
  const state = filterSchedulerStateForContent(input.content, input.schedulerState);
  const skipIds = new Set(input.skipActivityIds ?? []);
  const planningActivities = input.session.activities.map((activity) => ({
    ...activity,
    status: skipIds.has(activity.id)
      ? 'skipped'
      : activity.id === input.activatePlannedActivityId
        ? 'in_progress'
        : activity.status,
  })) as unknown as PlannedActivity[];
  const existingMinutes = planningActivities
    .filter((activity) => activity.status === 'completed' || activity.status === 'in_progress')
    .reduce((total, activity) => total + activity.plannedMinutes, 0);
  const remaining = Math.max(0, input.session.plannedMinutes - existingMinutes);
  const plan = replan(
    state,
    input.content,
    input.now,
    remaining,
    planningActivities,
    input.session.kind,
  );
  const preserved = input.session.activities
    .filter(
      (activity) =>
        activity.status !== 'planned' ||
        skipIds.has(activity.id) ||
        activity.id === input.activatePlannedActivityId,
    )
    .map((activity) => (skipIds.has(activity.id) ? { ...activity, status: 'skipped' } : activity));
  const planned = await Promise.all(
    plan.activities
      .filter((activity) => activity.status !== 'in_progress')
      .map(async (activity) => ({
        activity,
        progress: await initialLearnProgress(
          store,
          input.userId,
          activity,
          activity.conceptId ? input.content.lessonsByConcept.get(activity.conceptId) : undefined,
        ),
      })),
  );
  const nextIndex = Math.max(-1, ...preserved.map((activity) => activity.idx)) + 1;
  await store.transaction(async (store) => {
    if (skipIds.size > 0) {
      await store.patchActivities(
        input.userId,
        {
          sessionIds: [input.session.id],
          ids: [...skipIds],
          statuses: ['planned', 'in_progress'],
        },
        { status: 'skipped' },
      );
    }
    if (input.activatePlannedActivityId) {
      await store.patchActivities(
        input.userId,
        {
          ids: [input.activatePlannedActivityId],
          statuses: ['planned'],
        },
        { status: 'in_progress', startedAt: input.now },
      );
    }
    await store.deleteActivities(input.userId, {
      sessionIds: [input.session.id],
      statuses: ['planned'],
    });
    for (const [idx, { activity, progress }] of planned.entries()) {
      await store.insertActivities(input.userId, input.session.id, [
        {
          idx: nextIndex + idx,
          kind: activity.kind,
          conceptId: activity.conceptId ?? null,
          projectId: activity.projectId ?? null,
          exerciseIds: activity.exerciseIds,
          plannedMinutes: activity.plannedMinutes,
          status: 'planned',
          reason: activity.reason,
          progress: progress || {},
          startedAt: null,
          completedAt: null,
        },
      ]);
    }
  });
}

export async function updateLearningFocus(
  store: LessonStore,
  input: CourseCommand & {
    subjectId: string | null;
  },
  reads: {
    settings(): Promise<Settings | undefined>;
    activeSession(now: Date): Promise<Pick<Session, 'id'> | undefined>;
    session(id: string): Promise<CourseSession | undefined>;
    schedulerState(now: Date, content: ContentIndex): Promise<SchedulerState>;
  },
) {
  const settings = await reads.settings();
  const prefs = { ...settings?.prefs };
  if (input.subjectId === null) delete prefs.focusSubjectId;
  else prefs.focusSubjectId = input.subjectId;
  await store.patchSettings(input.userId, { prefs });

  const active = await reads.activeSession(input.now);
  const session = active ? await reads.session(active.id) : undefined;
  if (!session) return;
  const schedulerState = await reads.schedulerState(input.now, input.content);
  const focusSubjectId = effectiveFocusSubjectId(
    { focusSubjectId: input.subjectId },
    schedulerState.studyCourseIds,
    input.content,
  );
  const state = filterSchedulerStateForContent(input.content, {
    ...schedulerState,
    focusSubjectId: focusSubjectId ?? undefined,
  });
  await replanSessionActivities(store, {
    userId: input.userId,
    content: input.content,
    now: input.now,
    session,
    schedulerState: state,
  });
}
