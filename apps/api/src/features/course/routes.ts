import { and, eq, inArray } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import type { ContentIndex } from '../../content/types.js';
import type { Database } from '../../db/client.js';
import type { LearnerRepository } from '../../db/repository.js';
import {
  lessonProblems,
  lessonRuns,
  paperProgress,
  projectProgress,
  sessionActivities,
  studySessions,
  xpEvents,
} from '../../db/schema.js';
import type { ApiEnv } from '../../http/context.js';
import { topicIsComplete } from '../../learning/course-status.js';
import { deriveLessonState } from '../../learning/lesson-runner.js';
import { masteryKey, prerequisiteMet } from '../../learning/prerequisites.js';
import type { PlannedActivity, SessionPreferences } from '../../learning/scheduler.js';
import {
  currentLearnerWeek,
  planSession,
  type SessionKind,
  sessionBudget,
} from '../../learning/scheduler.js';
import {
  averageDailyXp,
  coursePercent,
  estimatedFinishDate,
  estimateTaskXp,
  localDateKey,
  sessionKindForDate,
  weekXp,
  xpGoalFor,
} from '../../learning/xp.js';
import { buildCourseWeeks } from './service.js';

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
    const [mastery, user, events, active, diagnostic] = await Promise.all([
      repo.masteryRecords(),
      repo.user(),
      deps.db.select().from(xpEvents).where(eq(xpEvents.userId, userId)),
      repo.activeSession(now),
      repo.latestDiagnosticRun(),
    ]);
    const prefs = (user?.prefs ?? {}) as SessionPreferences;
    const todayLocal = localDateKey(now, timeZone);
    const totalXp = events.reduce((total, event) => total + event.amount, 0);
    const todayXp = events
      .filter((event) => event.localDate === todayLocal)
      .reduce((total, event) => total + event.amount, 0);
    const projectStatuses = new Map(projectRows.map((row) => [row.projectId, row.status]));
    const runsByConcept = new Map(runRows.map((run) => [run.conceptId, run]));
    const problemsByRun = await getProblemsByRun(
      deps.db,
      runRows.map((run) => run.id),
    );
    const masteryByConcept = new Map<string, typeof mastery>();
    for (const record of mastery) {
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
      : plannedActivities(
          await repo.schedulerState(now, {
            mastery,
            lessonRuns: runRows,
            projectProgress: projectRows,
          }),
          index,
          prefs,
          timeZone,
          now,
        );

    const tasks = activities.map((activity, taskIndex) => {
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
        id: 'id' in activity ? activity.id : `planned-${taskIndex}`,
        activityKind: activity.kind,
        label: activityLabel(activity.kind),
        ...(conceptId ? { conceptId } : {}),
        title: concept?.title ?? project?.title ?? titleForKind(activity.kind),
        xp: estimateTaskXp(activity, lessonState),
        prerequisites,
      };
    });

    const recommendedConceptId = tasks.find((task) => task.activityKind === 'learn')?.conceptId;
    const masteryByKey = new Map(
      mastery.map((record) => [masteryKey(record.conceptId, record.dimension), record]),
    );
    const lessonRunState = runRows.map(({ conceptId, status }) => ({ conceptId, status }));
    const outlineConceptIds = Array.from(
      new Set(
        (index.curriculum?.weeks ?? [])
          .slice()
          .sort((left, right) => left.week - right.week)
          .flatMap((week) => week.concepts),
      ),
    );
    const eligibleChoices = active
      ? []
      : outlineConceptIds.flatMap((conceptId) => {
          const concept = index.conceptsById.get(conceptId);
          const lesson = index.lessonsByConcept.get(conceptId);
          if (
            !concept ||
            !lesson ||
            concept.status === 'stub' ||
            completedConcept(conceptId) ||
            !concept.prereqs
              .filter((prerequisite) => prerequisite.strength === 'hard')
              .every((prerequisite) =>
                prerequisiteMet(prerequisite.id, masteryByKey, lessonRunState, index),
              )
          ) {
            return [];
          }
          const run = runsByConcept.get(conceptId);
          const lessonState = lesson.knowledge_points?.length
            ? run
              ? deriveLessonState(lesson, problemsByRun.get(run.id) ?? [], index.exercisesById)
              : { points: lesson.knowledge_points.map(() => ({ status: 'active' })) }
            : undefined;
          return [
            {
              conceptId,
              title: concept.title,
              xp: estimateTaskXp(
                { kind: 'learn', plannedMinutes: concept.est_minutes },
                lessonState,
              ),
              recommended: conceptId === recommendedConceptId,
            },
          ];
        });
    const choices = eligibleChoices.slice(0, 5);
    const recommendedChoice = eligibleChoices.find((choice) => choice.recommended);
    if (
      recommendedChoice &&
      !choices.some((choice) => choice.conceptId === recommendedChoice.conceptId)
    ) {
      choices.push(recommendedChoice);
    }

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
      const run =
        activity.kind === 'learn' && activity.conceptId
          ? runsByConcept.get(activity.conceptId)
          : undefined;
      const activityXp = events
        .filter(
          (event) =>
            event.sourceKey === `activity:${activity.id}` && event.localDate === todayLocal,
        )
        .reduce((total, event) => total + event.amount, 0);
      const lessonXp =
        run?.completedAt &&
        activity.completedAt &&
        run.completedAt.getTime() === activity.completedAt.getTime()
          ? events
              .filter(
                (event) =>
                  event.localDate === todayLocal &&
                  (event.sourceKey.startsWith(`kp:${run.id}:`) ||
                    event.sourceKey === `quiz:${run.id}`),
              )
              .reduce((total, event) => total + event.amount, 0)
          : 0;
      return {
        activityId: activity.id,
        label: activityLabel(activity.kind),
        title:
          (activity.conceptId && index.conceptsById.get(activity.conceptId)?.title) ??
          (activity.projectId && index.projectsById.get(activity.projectId)?.title) ??
          titleForKind(activity.kind),
        xp: activityXp + lessonXp,
        completedAt: activity.completedAt?.toISOString(),
      };
    });

    const weeks = buildCourseWeeks(index, mastery, runRows, new Map(), projectStatuses);
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
      today: {
        needsDiagnostic:
          (!diagnostic || diagnostic.status === 'active') && Boolean(index.diagnostic),
        diagnosticActive: diagnostic?.status === 'active',
        diagnosticRunId: diagnostic?.status === 'active' ? diagnostic.id : null,
        sessionKind: sessionKindForDate(todayLocal),
      },
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
      choices,
      doneToday,
      activeSessionId: active?.id ?? null,
    });
  });

  api.get('/course', async (context) => {
    const index = await deps.content();
    const [mastery, runs, paperRows, projectRows] = await Promise.all([
      deps.withRepo(context).masteryRecords(),
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
      currentWeek: currentLearnerWeek({ mastery, lessonRuns: runs }, index),
      weeks: buildCourseWeeks(index, mastery, runs, paperStatuses, projectStatuses),
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
