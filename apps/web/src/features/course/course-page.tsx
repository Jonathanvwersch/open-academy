import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronDown, ChevronRight, FileText, Wrench } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import { useEffect, useState } from 'react';
import { Markdown } from '../../components/markdown.js';
import { Badge } from '../../components/ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { paperStatusLabel } from '../papers/queries.js';
import { useTutorSidebar } from '../tutor/tutor-sidebar.js';
import { CourseMetadata } from './course-metadata.js';
import { courseQueryOptions } from './queries.js';
import {
  isWeekOpen,
  readCourseWeekOpenOverrides,
  writeCourseWeekOpenOverrides,
} from './week-open-state.js';

export function CoursePage() {
  const { data } = useSuspenseQuery(courseQueryOptions());
  const tutorSidebar = useTutorSidebar();
  const [weekOpenOverrides, setWeekOpenOverrides] = useState(readCourseWeekOpenOverrides);
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
        {data.weeks.map((week) => {
          const open = isWeekOpen(week.week, data.currentWeek, weekOpenOverrides);
          return (
            <Collapsible.Root
              key={week.week}
              open={open}
              onOpenChange={(nextOpen) => {
                const next = { ...weekOpenOverrides, [week.week]: nextOpen };
                setWeekOpenOverrides(next);
                writeCourseWeekOpenOverrides(next);
              }}
            >
              <Card>
                <CardHeader className="p-0">
                  <CardTitle aria-label={`Week ${week.week} · ${week.title}`} className="w-full">
                    <Collapsible.Trigger
                      aria-label={`${open ? 'Collapse' : 'Expand'} week ${week.week}`}
                      className="flex w-full items-center justify-between gap-3 rounded-t-xl px-(--card-spacing) pt-(--card-spacing) text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    >
                      <span>
                        Week {week.week} · {week.title}
                      </span>
                      <ChevronDown
                        aria-hidden="true"
                        className={`size-4 shrink-0 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
                      />
                    </Collapsible.Trigger>
                  </CardTitle>
                </CardHeader>
                <Collapsible.Content>
                  <CardContent className="p-0 last:pb-0">
                    <ol className="divide-y">
                      {week.topics.map((topic) => {
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
                                <div className="flex flex-wrap items-center gap-2">
                                  {topic.hasLesson ? (
                                    <>
                                      {topic.status === 'locked' ? (
                                        <span className="text-xs text-muted-foreground">
                                          {topic.needs?.some(
                                            (prerequisite) => prerequisite.quiz,
                                          ) ? (
                                            <>
                                              Pass the{' '}
                                              {
                                                topic.needs.find(
                                                  (prerequisite) => prerequisite.quiz,
                                                )?.title
                                              }{' '}
                                              quiz first
                                            </>
                                          ) : (
                                            <>
                                              Needs{' '}
                                              {topic.needs
                                                ?.map((prerequisite) => prerequisite.title)
                                                .join(', ')}
                                            </>
                                          )}
                                        </span>
                                      ) : topic.status !== 'not_started' ? (
                                        <Badge
                                          variant="secondary"
                                          className={
                                            topic.status === 'complete'
                                              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                                              : topic.status === 'quiz'
                                                ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200'
                                                : ''
                                          }
                                        >
                                          {COURSE_STATUS_LABEL[topic.status]}
                                        </Badge>
                                      ) : null}
                                      {topic.status !== 'locked' &&
                                      topic.mastery !== 'Not started' ? (
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
                                          {topic.needs?.some(
                                            (prerequisite) => prerequisite.quiz,
                                          ) ? (
                                            <>
                                              Pass the{' '}
                                              {
                                                topic.needs.find(
                                                  (prerequisite) => prerequisite.quiz,
                                                )?.title
                                              }{' '}
                                              quiz first
                                            </>
                                          ) : (
                                            <>
                                              Needs{' '}
                                              {topic.needs
                                                ?.map((prerequisite) => prerequisite.title)
                                                .join(', ')}
                                            </>
                                          )}{' '}
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
                        const rowClassName = `flex items-center justify-between gap-3 px-(--card-spacing) py-3 ${
                          topic.status === 'locked' && topic.hasLesson
                            ? 'text-muted-foreground opacity-60'
                            : topic.status === 'complete'
                              ? 'bg-emerald-50/70 text-emerald-800 dark:bg-emerald-950/20 dark:text-emerald-200'
                              : topic.status === 'quiz'
                                ? 'bg-amber-50/70 dark:bg-amber-950/20'
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
                        <h3 className="px-(--card-spacing) pt-4 pb-1 text-sm font-medium text-muted-foreground">
                          Papers
                        </h3>
                        <ul className="divide-y">
                          {week.papers.map((paper) => (
                            <li key={paper.id}>
                              <Link
                                to="/papers/$paperId"
                                params={{ paperId: paper.id }}
                                className="flex items-center justify-between gap-3 px-(--card-spacing) py-3 hover:bg-muted/60"
                              >
                                <span className="flex w-9 shrink-0 items-center">
                                  <FileText
                                    aria-hidden="true"
                                    className="size-4 text-muted-foreground"
                                  />
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
                    {week.project ? (
                      <section className="border-t" aria-label="Project">
                        <h3 className="px-(--card-spacing) pt-4 pb-1 text-sm font-medium text-muted-foreground">
                          Project
                        </h3>
                        <ul className="divide-y">
                          <li>
                            {week.project.available ? (
                              <Link
                                to="/projects/$projectId"
                                params={{ projectId: week.project.id }}
                                className="flex items-center justify-between gap-3 px-(--card-spacing) py-3 hover:bg-muted/60"
                              >
                                <span className="flex w-9 shrink-0 items-center">
                                  <Wrench
                                    aria-hidden="true"
                                    className="size-4 text-muted-foreground"
                                  />
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block font-medium">
                                    <Markdown inline>{week.project.title}</Markdown>
                                  </span>
                                </span>
                                {week.project.status !== 'not_started' ? (
                                  <Badge
                                    variant="secondary"
                                    className={
                                      week.project.status === 'completed'
                                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                                        : ''
                                    }
                                  >
                                    {week.project.status === 'completed'
                                      ? 'Complete'
                                      : 'In progress'}
                                  </Badge>
                                ) : null}
                                <ChevronRight
                                  aria-hidden="true"
                                  className="size-4 shrink-0 text-muted-foreground"
                                />
                              </Link>
                            ) : (
                              <div className="flex items-center justify-between gap-3 px-(--card-spacing) py-3">
                                <span className="flex w-9 shrink-0 items-center">
                                  <Wrench
                                    aria-hidden="true"
                                    className="size-4 text-muted-foreground"
                                  />
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block font-medium text-muted-foreground">
                                    <Markdown inline>{week.project.title}</Markdown>
                                  </span>
                                  <span className="block text-xs text-muted-foreground">
                                    Project coming soon
                                  </span>
                                </span>
                              </div>
                            )}
                          </li>
                        </ul>
                      </section>
                    ) : null}
                  </CardContent>
                </Collapsible.Content>
              </Card>
            </Collapsible.Root>
          );
        })}
      </div>
    </section>
  );
}

const COURSE_STATUS_LABEL = {
  not_started: 'Not started',
  in_progress: 'In progress',
  quiz: 'Quiz not passed',
  complete: 'Complete',
} as const;
