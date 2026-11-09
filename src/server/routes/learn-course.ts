import { and, eq, inArray } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import type { ContentIndex } from '../content/types.js';
import type { Database } from '../db/client.js';
import type { LearnerRepository } from '../db/repository.js';
import {
  lessonProblems,
  lessonRuns,
  paperProgress,
  projectProgress,
  sessionActivities,
  studySessions,
  xpEvents,
} from '../db/schema.js';
import {
  lowestMasteryState,
  masteryLabel,
  topicIsComplete,
  topicStatus,
} from '../learning/course-status.js';
import { deriveLessonState } from '../learning/lesson-runner.js';
import { compareOutlinePosition, masteryKey, prerequisiteMet } from '../learning/prerequisites.js';
import type { PlannedActivity, SessionPreferences } from '../learning/scheduler.js';
import { planSession, type SessionKind, sessionBudget } from '../learning/scheduler.js';
import {
  averageDailyXp,
  coursePercent,
  estimatedFinishDate,
  estimateTaskXp,
  localDateKey,
  weekXp,
  xpGoalFor,
} from '../learning/xp.js';
import type { ApiEnv } from './api.js';

type RouteContext = Context<ApiEnv>;
type ActivityRecord = typeof sessionActivities.$inferSelect;

export function registerLearnCourseRoutes(
  api: Hono<ApiEnv>,
  deps: {
    db: Database;
    content: () => Promise<ContentIndex>;
    withRepo: (context: RouteContext) => LearnerRepository;
    requestNow: (context: RouteContext) => Date;
  },
) {
  api.get('/learn', async (context) => {
    const index = await deps.content();
    const repo = deps.withRepo(context);
    const userId = context.get('userId');
    const timeZone = context.get('timeZone');
    const now = deps.requestNow(context);
    const [state, user, events, active] = await Promise.all([
      repo.schedulerState(now),
      repo.user(),
      deps.db.select().from(xpEvents).where(eq(xpEvents.userId, userId)),
      repo.activeSession(now),
    ]);
    const prefs = (user?.prefs ?? {}) as SessionPreferences;
    const todayLocal = localDateKey(now, timeZone);
    const totalXp = events.reduce((total, event) => total + event.amount, 0);
    const todayXp = events
      .filter((event) => event.localDate === todayLocal)
      .reduce((total, event) => total + event.amount, 0);

    const [runRows, completedRows, projectRows] = await Promise.all([
      deps.db.select().from(lessonRuns).where(eq(lessonRuns.userId, userId)),
      deps.db
        .select({ activity: sessionActivities })
        .from(sessionActivities)
        .innerJoin(studySessions, eq(sessionActivities.sessionId, studySessions.id))
        .where(and(eq(studySessions.userId, userId), eq(sessionActivities.status, 'completed'))),
      deps.db
        .select({ projectId: projectProgress.projectId, status: projectProgress.status })
        .from(projectProgress)
        .where(eq(projectProgress.userId, userId)),
    ]);
    const projectStatuses = new Map(projectRows.map((row) => [row.projectId, row.status]));
    const runsByConcept = new Map(runRows.map((run) => [run.conceptId, run]));
    const problemsByRun = await getProblemsByRun(
      deps.db,
      runRows.map((run) => run.id),
    );
    const masteryByConcept = new Map<string, typeof state.mastery>();
    for (const record of state.mastery) {
      const conceptRecords = masteryByConcept.get(record.conceptId) ?? [];
      conceptRecords.push(record);
      masteryByConcept.set(record.conceptId, conceptRecords);
    }
    const completedConcept = (conceptId: string | null | undefined) => {
      if (!conceptId) return false;
      const concept = index.conceptsById.get(conceptId);
      if (!concept) return false;
      const states = concept.dimensions.map(
        (dimension) =>
          masteryByConcept.get(conceptId)?.find((record) => record.dimension === dimension)
            ?.state ?? 'not_assessed',
      );
      return topicIsComplete(runsByConcept.get(conceptId)?.status, states);
    };

    const activeSession = active ? await repo.session(active.id) : undefined;
    const activities: Array<ActivityRecord | PlannedActivity> = activeSession
      ? activeSession.activities.filter(
          (activity) => activity.status === 'planned' || activity.status === 'in_progress',
        )
      : plannedActivities(state, index, prefs, timeZone, now);

    const tasks = activities.map((activity) => {
      const conceptId = activity.conceptId;
      const concept = conceptId ? index.conceptsById.get(conceptId) : undefined;
      const lesson = conceptId ? index.lessonsByConcept.get(conceptId) : undefined;
      const run = conceptId ? runsByConcept.get(conceptId) : undefined;
      const lessonState =
        activity.kind === 'learn' && lesson?.knowledge_points?.length
          ? run
            ? deriveLessonState(lesson, problemsByRun.get(run.id) ?? [], index.exercisesById)
            : {
                points: lesson.knowledge_points.map(() => ({ status: 'active' })),
              }
          : undefined;
      const prerequisites = (concept?.prereqs ?? []).map((prerequisite) => ({
        id: prerequisite.id,
        title: index.conceptsById.get(prerequisite.id)?.title ?? prerequisite.id,
        done: completedConcept(prerequisite.id),
      }));
      const projectId = 'projectId' in activity ? activity.projectId : undefined;
      const project = projectId ? index.projectsById.get(projectId) : undefined;
      return {
        activityKind: activity.kind,
        label: activityLabel(activity.kind),
        ...(conceptId ? { conceptId } : {}),
        title: concept?.title ?? project?.title ?? titleForKind(activity.kind),
        xp: estimateTaskXp(activity, lessonState),
        prerequisites,
      };
    });

    const todayDone = completedRows
      .filter(
        ({ activity }) =>
          activity.completedAt && localDateKey(activity.completedAt, timeZone) === todayLocal,
      )
      .sort(
        (left, right) =>
          (left.activity.completedAt?.getTime() ?? 0) -
          (right.activity.completedAt?.getTime() ?? 0),
      );
    const doneToday = todayDone.map(({ activity }) => {
      const run = activity.conceptId ? runsByConcept.get(activity.conceptId) : undefined;
      const activityEvent = events.find((event) => event.sourceKey === `activity:${activity.id}`);
      const lessonXp = run
        ? events
            .filter(
              (event) =>
                event.sourceKey.startsWith(`kp:${run.id}:`) && event.localDate === todayLocal,
            )
            .reduce((total, event) => total + event.amount, 0)
        : 0;
      return {
        label: activityLabel(activity.kind),
        title:
          (activity.conceptId && index.conceptsById.get(activity.conceptId)?.title) ??
          (activity.projectId && index.projectsById.get(activity.projectId)?.title) ??
          titleForKind(activity.kind),
        xp: activityEvent?.amount ?? lessonXp,
        completedAt: activity.completedAt?.toISOString(),
      };
    });

    const weeks = buildCourseWeeks(index, state.mastery, runRows, new Map(), projectStatuses);
    const topics = weeks.flatMap((week) => week.topics);
    const topicsDone = topics.filter((topic) => topic.status === 'complete').length;
    const estimatedFinish =
      topicsDone < topics.length
        ? estimatedFinishDate(
            topics.length - topicsDone,
            averageDailyXp(events, todayLocal),
            todayLocal,
            prefs,
          )
        : null;
    const estimatedFinishAtGoal =
      topicsDone < topics.length
        ? estimatedFinishDate(topics.length - topicsDone, 0, todayLocal, prefs)
        : null;
    return context.json({
      xp: {
        total: totalXp,
        today: todayXp,
        goal: xpGoalFor(todayLocal, prefs),
        week: weekXp(events, todayLocal, prefs),
      },
      course: {
        percentComplete: coursePercent(topicsDone, topics.length),
        topicsDone,
        topicsTotal: topics.length,
        estimatedFinish,
        estimatedFinishAtGoal,
      },
      tasks,
      doneToday,
      activeSessionId: active?.id ?? null,
    });
  });

  api.get('/course', async (context) => {
    const index = await deps.content();
    const state = await deps.withRepo(context).schedulerState(deps.requestNow(context));
    const [runs, paperRows, projectRows] = await Promise.all([
      deps.db
        .select()
        .from(lessonRuns)
        .where(eq(lessonRuns.userId, context.get('userId'))),
      deps.db
        .select()
        .from(paperProgress)
        .where(eq(paperProgress.userId, context.get('userId'))),
      deps.db
        .select({ projectId: projectProgress.projectId, status: projectProgress.status })
        .from(projectProgress)
        .where(eq(projectProgress.userId, context.get('userId'))),
    ]);
    const paperStatuses = new Map<string, 'not_started' | 'reading' | 'completed'>(
      paperRows.map((row) => [row.paperId, row.completedAt ? 'completed' : 'reading'] as const),
    );
    const projectStatuses = new Map(projectRows.map((row) => [row.projectId, row.status]));
    return context.json({
      weeks: buildCourseWeeks(index, state.mastery, runs, paperStatuses, projectStatuses),
    });
  });
}

function plannedActivities(
  state: Awaited<ReturnType<LearnerRepository['schedulerState']>>,
  index: ContentIndex,
  preferences: unknown,
  timeZone: string,
  now: Date,
): PlannedActivity[] {
  const prefs = (preferences ?? {}) as {
    scheduleMinutes?: number;
    saturdayMinutes?: number;
    sundayMinutes?: number;
  };
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone }).format(now);
  const kind: SessionKind =
    weekday === 'Sat' ? 'saturday' : weekday === 'Sun' ? 'sunday' : 'weekday';
  return planSession(state, index, now, sessionBudget(kind, prefs), kind).activities;
}

async function getProblemsByRun(db: Database, runIds: string[]) {
  if (runIds.length === 0) return new Map<string, Array<typeof lessonProblems.$inferSelect>>();
  const rows = await db.select().from(lessonProblems).where(inArray(lessonProblems.runId, runIds));
  const byRun = new Map<string, Array<typeof lessonProblems.$inferSelect>>();
  for (const row of rows) {
    const runRows = byRun.get(row.runId) ?? [];
    runRows.push(row);
    byRun.set(row.runId, runRows);
  }
  return byRun;
}

export function buildCourseWeeks(
  index: ContentIndex,
  masteryRecords: Awaited<ReturnType<LearnerRepository['masteryRecords']>>,
  runs: Array<typeof lessonRuns.$inferSelect>,
  paperStatuses: Map<string, 'not_started' | 'reading' | 'completed'> = new Map(),
  projectStatuses: Map<string, 'not_started' | 'in_progress' | 'completed'> = new Map(),
) {
  const masteryByConcept = new Map<string, typeof masteryRecords>();
  for (const record of masteryRecords) {
    const records = masteryByConcept.get(record.conceptId) ?? [];
    records.push(record);
    masteryByConcept.set(record.conceptId, records);
  }
  const runsByConcept = new Map(runs.map((run) => [run.conceptId, run]));
  const masteryByKey = new Map(
    masteryRecords.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
  );
  const lessonRunState = runs.map(({ conceptId, status }) => ({ conceptId, status }));
  const outlineConceptIds = Array.from(
    new Set((index.curriculum?.weeks ?? []).flatMap((week) => week.concepts)),
  );
  const outlineConcepts = outlineConceptIds.flatMap((conceptId) => {
    const concept = index.conceptsById.get(conceptId);
    return concept ? [concept] : [];
  });
  return (index.curriculum?.weeks ?? [])
    .slice()
    .sort((left, right) => left.week - right.week)
    .map((week) => {
      const project = week.project ? index.projectsById.get(week.project) : undefined;
      return {
        week: week.week,
        title: week.title,
        intro: week.intro ?? '',
        project: project
          ? {
              id: project.id,
              title: project.title,
              available: project.status === 'authored',
              status: projectStatuses.get(project.id) ?? 'not_started',
            }
          : null,
        papers: (index.papersByWeek.get(week.week) ?? []).map((paper) => ({
          id: paper.id,
          title: paper.title,
          authors: paper.authors,
          year: paper.year,
          estMinutes: paper.est_minutes,
          status: paperStatuses.get(paper.id) ?? 'not_started',
        })),
        topics: week.concepts.map((conceptId, indexInWeek) => {
          const concept = index.conceptsById.get(conceptId);
          if (!concept) {
            return {
              number: `${week.week}.${indexInWeek + 1}`,
              conceptId,
              title: conceptId,
              hasLesson: false,
              status: 'not_started' as const,
              mastery: 'Not started',
              buildsOn: [],
              leadsTo: [],
              leadsToMore: 0,
            };
          }
          const records = masteryByConcept.get(concept.id) ?? [];
          const dimensionStates = concept.dimensions.map(
            (dimension) =>
              records.find((record) => record.dimension === dimension)?.state ?? 'not_assessed',
          );
          const runStatus = runsByConcept.get(concept.id)?.status;
          const status = topicStatus({
            lessonRunStatus: runStatus,
            dimensionStates,
            prerequisites: concept.prereqs.map((prerequisite) => ({
              strength: prerequisite.strength,
              done: prerequisiteMet(prerequisite.id, masteryByKey, lessonRunState, index),
            })),
          });
          const needs = concept.prereqs
            .filter(
              (prerequisite) =>
                prerequisite.strength === 'hard' &&
                !prerequisiteMet(prerequisite.id, masteryByKey, lessonRunState, index),
            )
            .sort((left, right) => compareOutlinePosition(left.id, right.id, index))
            .map((prerequisite) => ({
              id: prerequisite.id,
              title: index.conceptsById.get(prerequisite.id)?.title ?? prerequisite.id,
            }));
          const buildsOn = [...concept.prereqs]
            .sort((left, right) => compareOutlinePosition(left.id, right.id, index))
            .map((prerequisite) => ({
              id: prerequisite.id,
              title: index.conceptsById.get(prerequisite.id)?.title ?? prerequisite.id,
            }));
          const nextConcepts = outlineConcepts.filter((candidate) =>
            candidate.prereqs.some((prerequisite) => prerequisite.id === concept.id),
          );
          return {
            number: `${week.week}.${indexInWeek + 1}`,
            conceptId,
            title: concept.title,
            hasLesson: index.lessonsByConcept.has(concept.id),
            status,
            mastery: masteryLabel(lowestMasteryState(dimensionStates)),
            buildsOn,
            leadsTo: nextConcepts.slice(0, 3).map((candidate) => ({
              id: candidate.id,
              title: candidate.title,
            })),
            leadsToMore: Math.max(0, nextConcepts.length - 3),
            ...(status === 'locked' ? { needs } : {}),
          };
        }),
      };
    });
}

function activityLabel(
  kind: string,
): 'Lesson' | 'Review' | 'Practice' | 'Project' | 'Quiz' | 'Paper' {
  if (kind === 'learn') return 'Lesson';
  if (kind === 'review') return 'Review';
  if (kind === 'lab') return 'Project';
  if (kind === 'paper') return 'Paper';
  if (kind === 'quick_check' || kind === 'diagnostic') return 'Quiz';
  return 'Practice';
}

function titleForKind(kind: string): string {
  if (kind === 'paper') return 'Paper reading';
  if (kind === 'quick_check') return 'Quick check';
  if (kind === 'reflect') return 'Reflection';
  if (kind === 'teachback') return 'Teach-back';
  if (kind === 'diagnostic') return 'Diagnostic';
  if (kind === 'practice') return 'Mixed practice';
  return activityLabel(kind);
}
