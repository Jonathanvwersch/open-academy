import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ChevronRight, FileText } from 'lucide-react';
import { useEffect } from 'react';
import { Badge } from '@/ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card.js';
import { Markdown } from '../components.js';
import { courseQueryOptions, paperStatusLabel } from '../queries.js';
import { RouteLoadError } from '../route-error.js';
import { CourseSkeleton } from '../skeletons.js';
import { useTutorSidebar } from '../tutor/TutorSidebar.js';

export const Route = createFileRoute('/course')({
  pendingComponent: CourseSkeleton,
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
      <h1 className="sr-only">Course</h1>
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
            <CardContent className="p-0 last:pb-0">
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
                          <p
                            className={`font-medium ${topic.hasLesson ? '' : 'text-muted-foreground'}`}
                          >
                            {topic.title}
                          </p>
                          {contextLine ? (
                            <p className="text-xs text-muted-foreground">{contextLine}</p>
                          ) : null}
                          <div className="flex flex-wrap items-center gap-2">
                            {topic.hasLesson ? (
                              <>
                                {topic.status === 'locked' ? (
                                  <span className="text-xs text-muted-foreground">
                                    Needs{' '}
                                    {topic.needs
                                      ?.map((prerequisite) => prerequisite.title)
                                      .join(', ')}
                                  </span>
                                ) : topic.status !== 'not_started' ? (
                                  <Badge
                                    variant="secondary"
                                    className={
                                      topic.status === 'complete'
                                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                                        : ''
                                    }
                                  >
                                    {COURSE_STATUS_LABEL[topic.status]}
                                  </Badge>
                                ) : null}
                                {topic.status !== 'locked' && topic.mastery !== 'Not started' ? (
                                  <span
                                    className={`text-xs ${
                                      topic.status === 'complete'
                                        ? 'text-emerald-700 dark:text-emerald-300'
                                        : 'text-muted-foreground'
                                    }`}
                                  >
                                    Mastery: {topic.mastery}
                                  </span>
                                ) : null}
                              </>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                {topic.status === 'locked' ? (
                                  <>
                                    Needs{' '}
                                    {topic.needs
                                      ?.map((prerequisite) => prerequisite.title)
                                      .join(', ')}{' '}
                                    ·{' '}
                                  </>
                                ) : null}
                                Lesson coming soon
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      {topic.hasLesson ? (
                        <ChevronRight
                          aria-hidden="true"
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                      ) : null}
                    </>
                  );
                  const rowClassName = `flex items-center justify-between gap-3 px-4 py-3 ${
                    topic.status === 'locked' && topic.hasLesson
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
              {week.papers.length > 0 ? (
                <section className="border-t" aria-label="Papers">
                  <h3 className="px-4 pt-4 pb-1 text-sm font-medium text-muted-foreground">
                    Papers
                  </h3>
                  <ul className="divide-y">
                    {week.papers.map((paper) => (
                      <li key={paper.id}>
                        <Link
                          to="/papers/$paperId"
                          params={{ paperId: paper.id }}
                          className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/60"
                        >
                          <span className="flex w-9 shrink-0 items-center">
                            <FileText aria-hidden="true" className="size-4 text-muted-foreground" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block font-medium">
                              <Markdown inline>{paper.title}</Markdown>
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              <Markdown inline>{paper.authors}</Markdown> · {paper.year} · ~
                              {paper.estMinutes} min
                            </span>
                          </span>
                          {paper.status === 'reading' || paper.status === 'completed' ? (
                            <Badge
                              variant="secondary"
                              className={
                                paper.status === 'completed'
                                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                                  : ''
                              }
                            >
                              {paperStatusLabel(paper.status)}
                            </Badge>
                          ) : null}
                          <ChevronRight
                            aria-hidden="true"
                            className="size-4 shrink-0 text-muted-foreground"
                          />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
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
