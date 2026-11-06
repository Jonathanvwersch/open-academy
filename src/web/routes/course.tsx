import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Badge } from '@/ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card.js';
import { courseQueryOptions } from '../queries.js';
import { RouteLoadError } from '../route-error.js';
import { useTutorSidebar } from '../tutor/TutorSidebar.js';

export const Route = createFileRoute('/course')({
  loader: ({ context }) => context.queryClient.ensureQueryData(courseQueryOptions()),
  errorComponent: () => (
    <RouteLoadError message="Your course is unavailable." className="text-sm text-destructive" />
  ),
  component: CoursePage,
});

function CoursePage() {
  const { data } = useSuspenseQuery(courseQueryOptions());
  const tutorSidebar = useTutorSidebar();
  useEffect(() => {
    tutorSidebar.setContext({
      page: 'course',
      pageLabel: 'Course outline',
      allowed: true,
      enabled: false,
    });
    return () => tutorSidebar.clearContext();
  }, [tutorSidebar]);
  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">Your curriculum</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Course</h1>
      </div>
      <div className="space-y-4">
        {data.weeks.map((week) => (
          <Card key={week.week}>
            <CardHeader className="space-y-2">
              <CardTitle>
                Week {week.week} · {week.title}
              </CardTitle>
              {week.intro ? <p className="text-sm text-muted-foreground">{week.intro}</p> : null}
              {week.project ? (
                <p className="text-sm text-muted-foreground">Project: {week.project.title}</p>
              ) : null}
            </CardHeader>
            <CardContent className="p-0">
              <ol className="divide-y">
                {week.topics.map((topic) => {
                  const contextLine = [
                    topic.status !== 'locked' && topic.buildsOn.length > 0
                      ? `Builds on: ${topic.buildsOn.map((item) => item.title).join(', ')}`
                      : null,
                    topic.leadsTo.length > 0
                      ? `Leads to: ${topic.leadsTo.map((item) => item.title).join(', ')}${
                          topic.leadsToMore > 0 ? ` +${topic.leadsToMore} more` : ''
                        }`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ');
                  const row = (
                    <>
                      <div className="flex min-w-0 items-start gap-3">
                        <span className="w-9 shrink-0 pt-0.5 text-sm tabular-nums text-muted-foreground">
                          {topic.number}
                        </span>
                        <div className="min-w-0 space-y-1">
                          <p className="font-medium">{topic.title}</p>
                          {contextLine ? (
                            <p className="text-xs text-muted-foreground">{contextLine}</p>
                          ) : null}
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge
                              variant="secondary"
                              className={
                                topic.status === 'complete'
                                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                                  : ''
                              }
                            >
                              {topic.mastery}
                            </Badge>
                            {topic.status !== 'not_started' ? (
                              <span
                                className={`text-xs ${
                                  topic.status === 'complete'
                                    ? 'text-emerald-700 dark:text-emerald-300'
                                    : 'text-muted-foreground'
                                }`}
                              >
                                {topic.status === 'locked'
                                  ? `Needs ${topic.needs?.map((prerequisite) => prerequisite.title).join(', ')}`
                                  : COURSE_STATUS_LABEL[topic.status]}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                      {topic.hasLesson ? (
                        <span className="shrink-0 text-sm font-medium underline-offset-4 group-hover:underline">
                          View lesson
                        </span>
                      ) : null}
                    </>
                  );
                  const rowClassName = `flex items-center justify-between gap-3 px-4 py-3 ${
                    topic.status === 'locked'
                      ? 'text-muted-foreground opacity-60'
                      : topic.status === 'complete'
                        ? 'bg-emerald-50/70 text-emerald-800 dark:bg-emerald-950/20 dark:text-emerald-200'
                        : ''
                  }`;
                  return (
                    <li key={topic.conceptId}>
                      {topic.hasLesson ? (
                        <Link
                          to="/lessons/$conceptId"
                          params={{ conceptId: topic.conceptId }}
                          search={{ from: undefined }}
                          className={`group ${rowClassName} hover:bg-muted/60`}
                        >
                          {row}
                        </Link>
                      ) : (
                        <div className={rowClassName}>{row}</div>
                      )}
                    </li>
                  );
                })}
              </ol>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

const COURSE_STATUS_LABEL = {
  not_started: 'Not started',
  in_progress: 'In progress',
  complete: 'Complete',
} as const;
