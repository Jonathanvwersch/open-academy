import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import { apiFetch } from '../../api/authenticated-fetch.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Progress } from '../../components/ui/progress.js';
import { studyMapQueryOptions } from '../map/queries.js';
import { StreakCard } from '../progress/streak-card.js';
import { todayQueryOptions } from '../sessions/queries.js';
import { useStartSession } from '../sessions/start-session.js';
import { CourseStartCard } from './course-start-card.js';
import { coursesQueryOptions, learnQueryOptions } from './queries.js';

export function LearnPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(learnQueryOptions());
  const { data: catalog } = useSuspenseQuery(coursesQueryOptions());
  const today = data.today;
  const focusSubjectTitle = data.focusSubjectId
    ? (data.activeSubjects.find((subject) => subject.id === data.focusSubjectId)?.title ??
      data.focusSubjectId)
    : null;
  const finishLineLabel = focusSubjectTitle
    ? `All current ${focusSubjectTitle} lessons done by`
    : 'All current lessons done by';
  const enterSession = async ({ id }: { id: string }) => {
    queryClient.setQueryData(learnQueryOptions().queryKey, (current) =>
      current ? { ...current, activeSessionId: id } : current,
    );
    queryClient.setQueryData(todayQueryOptions().queryKey, (current) =>
      current ? { ...current, activeSessionId: id } : current,
    );
    await navigate({ to: '/session/$id', params: { id } });
    await queryClient.invalidateQueries({
      queryKey: learnQueryOptions().queryKey,
      refetchType: 'none',
    });
  };
  const startSession = useStartSession(today.sessionKind, enterSession);
  const startChoice = useMutation({
    mutationFn: async (focusConceptId: string) => {
      const response = await apiFetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ focusConceptId, kind: today.sessionKind }),
      });
      if (!response.ok) throw new Error('Could not start the selected lesson');
      return response.json() as Promise<{ id: string }>;
    },
    onSuccess: enterSession,
  });
  const focusSubject = useMutation({
    mutationFn: async (subjectId: string | null) => {
      const response = await apiFetch('/api/focus', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subjectId }),
      });
      if (!response.ok) throw new Error('Could not update learning focus');
      return response.json() as Promise<{ focusSubjectId: string | null }>;
    },
    onMutate: async (subjectId) => {
      const queryKey = learnQueryOptions().queryKey;
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (current) =>
        current ? { ...current, focusSubjectId: subjectId } : current,
      );
      return { previous };
    },
    onError: (_error, _subjectId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(learnQueryOptions().queryKey, context.previous);
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: studyMapQueryOptions().queryKey });
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: learnQueryOptions().queryKey }),
        queryClient.invalidateQueries({ queryKey: todayQueryOptions().queryKey }),
        queryClient.invalidateQueries({ queryKey: ['session'] }),
      ]);
    },
  });
  const maxXp = Math.max(1, ...data.xp.week.flatMap((day) => [day.xp, day.goal]));
  const dayTotal = data.xp.week.reduce((total, day) => total + day.xp, 0);

  if (today.needsCourseChoice) {
    return (
      <section className="space-y-6">
        <h1 className="sr-only">Home</h1>
        <Card>
          <CardHeader>
            <CardTitle>Choose a course</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {catalog.subjects.flatMap((subject) =>
              subject.courses.map((course) => (
                <Link
                  key={course.id}
                  to="/courses/$courseId"
                  params={{ courseId: course.id }}
                  className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Card size="sm" className="transition-colors hover:border-primary/50">
                    <CardContent className="flex items-center justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <h2 className="font-medium">{course.title}</h2>
                        <p className="line-clamp-2 text-sm text-muted-foreground">
                          {course.description}
                        </p>
                      </div>
                      <span className="shrink-0 text-sm font-medium">View course</span>
                    </CardContent>
                  </Card>
                </Link>
              )),
            )}
          </CardContent>
        </Card>
      </section>
    );
  }
  const courseToStart =
    catalog.subjects
      .flatMap((subject) => subject.courses)
      .find((course) => course.id === today.courseStart.courseId) ?? today.studyCourses[0];
  if (today.courseStart.needed && courseToStart) {
    return (
      <section className="space-y-6">
        <h1 className="sr-only">Home</h1>
        <CourseStartCard
          courseId={courseToStart.id}
          courseTitle={courseToStart.title}
          placementRunId={today.courseStart.placementRunId}
        />
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <h1 className="sr-only">Home</h1>
      <StreakCard streak={data.streak} />
      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Next up</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {data.activeSubjects.length > 1 ? (
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Study today</legend>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant={data.focusSubjectId ? 'outline' : 'secondary'}
                      aria-pressed={!data.focusSubjectId}
                      disabled={focusSubject.isPending}
                      onClick={() => focusSubject.mutate(null)}
                    >
                      All
                    </Button>
                    {data.activeSubjects.map((subject) => (
                      <Button
                        key={subject.id}
                        type="button"
                        size="sm"
                        variant={data.focusSubjectId === subject.id ? 'secondary' : 'outline'}
                        aria-pressed={data.focusSubjectId === subject.id}
                        disabled={focusSubject.isPending || subject.hasLessons === false}
                        title={subject.hasLessons === false ? 'Lessons coming soon' : undefined}
                        onClick={() => focusSubject.mutate(subject.id)}
                      >
                        {subject.title}
                        {subject.hasLessons === false ? (
                          <span className="text-muted-foreground"> · soon</span>
                        ) : null}
                      </Button>
                    ))}
                  </div>
                  {focusSubject.isError ? (
                    <p role="alert" className="text-sm text-destructive">
                      {focusSubject.error.message}
                    </p>
                  ) : null}
                  {focusSubjectTitle ? (
                    <p className="text-sm text-muted-foreground">
                      Studying {focusSubjectTitle} only. Other subjects are paused until you pick
                      All.
                    </p>
                  ) : null}
                  {data.focusSubjectId && data.dueReviewsOutsideFocus > 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {data.dueReviewsOutsideFocus}{' '}
                      {data.dueReviewsOutsideFocus === 1
                        ? 'review from another subject is'
                        : 'reviews from other subjects are'}{' '}
                      waiting.{' '}
                      <Link to="/reviews" className="underline underline-offset-4">
                        Review them
                      </Link>
                    </p>
                  ) : null}
                </fieldset>
              ) : null}
              {data.activeSessionId ? (
                <Button asChild className="h-10 w-full justify-between px-4">
                  <Link to="/session/$id" params={{ id: data.activeSessionId }}>
                    {focusSubjectTitle ? `Resume ${focusSubjectTitle}` : 'Resume session'}
                    <ArrowRight className="size-4" aria-hidden="true" />
                  </Link>
                </Button>
              ) : (
                <Button
                  type="button"
                  className="h-10 w-full justify-between px-4"
                  onClick={() => startSession.mutate()}
                  loading={startSession.isPending}
                >
                  {focusSubjectTitle ? `Start ${focusSubjectTitle}` : 'Start learning'}
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Button>
              )}
              {startSession.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  {startSession.error.message}
                </p>
              ) : null}
              {data.tasks.length ? (
                <ul className="divide-y">
                  {data.tasks.map((task) => (
                    <li key={task.id} className="space-y-2 py-4 first:pt-0 last:pb-0">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <Badge variant="secondary">{task.label}</Badge>
                          <h2 className="font-medium leading-6">{task.title}</h2>
                          {task.reviewTopics && task.reviewTopics.length > 1 ? (
                            <p className="text-sm text-muted-foreground">
                              {task.reviewTopics.map((topic) => topic.title).join(', ')}
                            </p>
                          ) : null}
                          {task.reason ? (
                            <p className="text-sm text-muted-foreground">{task.reason}</p>
                          ) : null}
                        </div>
                        {task.activityKind !== 'paper' ? (
                          <span className="shrink-0 text-sm font-medium text-muted-foreground">
                            +{task.xp} XP
                          </span>
                        ) : null}
                      </div>
                      {task.prerequisites.some((prerequisite) => !prerequisite.done) ? (
                        <p className="text-sm text-muted-foreground">
                          Needs{' '}
                          {task.prerequisites
                            .filter((prerequisite) => !prerequisite.done)
                            .map((prerequisite) => prerequisite.title)
                            .join(', ')}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No tasks planned for today.</p>
              )}
              {!data.activeSessionId && data.choices.length > 1 ? (
                <div className="space-y-3 border-t pt-4">
                  <h3 className="text-sm font-medium">Or pick a lesson</h3>
                  <ul className="divide-y">
                    {data.choices.map((choice) => (
                      <li
                        key={choice.conceptId}
                        className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                      >
                        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="min-w-0 font-medium leading-5">{choice.title}</span>
                          {choice.recommended ? (
                            <Badge variant="secondary">Recommended</Badge>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                          <span className="text-sm text-muted-foreground">+{choice.xp} XP</span>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => startChoice.mutate(choice.conceptId)}
                            loading={
                              startChoice.isPending && startChoice.variables === choice.conceptId
                            }
                          >
                            Start
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                  {startChoice.isError ? (
                    <p role="alert" className="text-sm text-destructive">
                      {startChoice.error.message}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Done today</CardTitle>
            </CardHeader>
            <CardContent>
              {data.doneToday.length ? (
                <ul className="space-y-3">
                  {data.doneToday.map((item) => (
                    <li
                      key={item.activityId}
                      className="flex items-start justify-between gap-3 text-sm"
                    >
                      <div className="min-w-0">
                        <p className="font-medium">{item.title}</p>
                        <p className="text-muted-foreground">{item.label}</p>
                      </div>
                      <span className="shrink-0 text-muted-foreground">+{item.xp} XP</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Nothing completed yet.</p>
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Your progress</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">XP today</p>
                  <p className="text-xl font-semibold">
                    {data.xp.today}{' '}
                    <span className="text-sm font-normal text-muted-foreground">
                      / {data.xp.goal} XP
                    </span>
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm text-muted-foreground">Total XP</p>
                  <p className="text-xl font-semibold">{data.xp.total}</p>
                </div>
              </div>
              <Progress
                value={Math.min(100, (data.xp.today / data.xp.goal) * 100)}
                aria-label="Today's XP goal"
                className="h-2"
              />
            </div>

            <div className="space-y-3 border-t pt-5">
              <div className="flex items-baseline justify-between">
                <h2 className="text-sm font-medium">This week</h2>
                <span className="text-sm text-muted-foreground">{dayTotal} XP</span>
              </div>
              <div
                aria-label="XP earned each day this week"
                role="img"
                className="grid h-24 grid-cols-7 items-end gap-2"
              >
                {data.xp.week.map((day) => {
                  const goalHeight = (day.goal / maxXp) * 100;
                  const xpHeight = Math.min(100, (day.xp / maxXp) * 100);
                  return (
                    <div key={day.date} className="flex h-full min-w-0 flex-col justify-end gap-1">
                      <div
                        className="relative h-16 overflow-hidden rounded-sm bg-muted"
                        title={`${day.xp} XP earned; goal ${day.goal} XP`}
                      >
                        <div
                          aria-hidden="true"
                          className="absolute z-10 w-full border-t border-dashed border-muted-foreground/70"
                          style={{ bottom: `${goalHeight}%` }}
                        />
                        <div
                          aria-hidden="true"
                          className="absolute inset-x-0 bottom-0 rounded-sm bg-emerald-600"
                          style={{ height: `${xpHeight}%` }}
                        />
                      </div>
                      <span className="text-center text-xs text-muted-foreground">
                        {weekdayLabel(day.date)}
                      </span>
                      <span className="sr-only">
                        {day.date}: {day.xp} of {day.goal} XP
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="space-y-3 border-t pt-5">
              <div className="flex items-baseline gap-3 text-xs text-muted-foreground">
                <span className="flex-1">Course</span>
                <span className="shrink-0">Topics</span>
                <span className="w-14 shrink-0 text-right">Finish</span>
              </div>
              <ul className="space-y-3">
                {data.studyCourses.map((course) => {
                  const percentComplete =
                    course.topicsTotal > 0
                      ? Math.round((course.topicsDone / course.topicsTotal) * 100)
                      : 0;
                  const paused = Boolean(
                    focusSubjectTitle && course.subjectId !== data.focusSubjectId,
                  );
                  const finished =
                    course.topicsTotal > 0 && course.topicsDone >= course.topicsTotal;
                  const [status, statusLabel] = paused
                    ? ['Paused', `Paused while you focus on ${focusSubjectTitle}`]
                    : course.estimatedFinish
                      ? [
                          formatShortDate(course.estimatedFinish),
                          `Finishes around ${formatDate(course.estimatedFinish)} at your pace`,
                        ]
                      : finished
                        ? ['Done', 'Finished']
                        : ['Soon', 'Lessons coming soon'];
                  return (
                    <li key={course.id} className="space-y-1.5">
                      <div className="flex items-baseline gap-3 text-sm">
                        <Link
                          to="/courses/$courseId"
                          params={{ courseId: course.id }}
                          className="min-w-0 flex-1 break-words font-medium underline-offset-4 hover:underline"
                        >
                          {course.title}
                        </Link>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {course.topicsDone}/{course.topicsTotal}
                        </span>
                        <span
                          className="w-14 shrink-0 text-right tabular-nums text-muted-foreground"
                          title={statusLabel}
                        >
                          <span aria-hidden="true">{status}</span>
                          <span className="sr-only">{statusLabel}</span>
                        </span>
                      </div>
                      <Progress
                        value={percentComplete}
                        aria-label={`${course.title} progress`}
                        className="h-1.5"
                      />
                    </li>
                  );
                })}
              </ul>
              {data.today.studyFinish.atPace && data.today.studyFinish.atGoal ? (
                <p className="pt-1 text-sm text-muted-foreground">
                  {data.today.studyFinish.atPace === data.today.studyFinish.atGoal
                    ? `${finishLineLabel} ${formatDate(data.today.studyFinish.atPace)}`
                    : `${finishLineLabel} ${formatDate(data.today.studyFinish.atPace)} at your pace, or ${formatDate(data.today.studyFinish.atGoal)} at your daily goal`}
                </p>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function weekdayLabel(date: string): string {
  return new Date(`${date}T12:00:00.000Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    timeZone: 'UTC',
  });
}

function formatShortDate(date: string): string {
  return new Date(`${date}T12:00:00.000Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function formatDate(date: string): string {
  return new Date(`${date}T12:00:00.000Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
