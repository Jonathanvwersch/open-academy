import type { CourseQueueStatus, CourseTopic } from '@academy/aesop/api/course';
import { useSuspenseQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { ChevronDown, ChevronRight, FileText, Wrench } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import { Fragment, useEffect, useState } from 'react';
import {
  topicStatusLabels as COURSE_STATUS_LABEL,
  topicStatusClasses,
} from '../../components/topic-status.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { paperStatusLabel } from '../papers/queries.js';
import { useTutorSidebar } from '../tutor/tutor-sidebar.js';
import { buildsOnLineItems, buildsOnLineText } from './builds-on-line.js';
import { CourseMetadata } from './course-metadata.js';
import { CourseStartCard } from './course-start-card.js';
import { foundationsHeading } from './foundations-heading.js';
import { useCourseEnrollment } from './mutations.js';
import { courseDetailQueryOptions } from './queries.js';
import {
  isUnitOpen,
  readCourseUnitOpenOverrides,
  writeCourseUnitOpenOverrides,
} from './week-open-state.js';

const CourseRoute = getRouteApi('/courses/$courseId');

function foundationSourceLabel(courseTitles: string[], hasMore: boolean): string {
  const titles = [...courseTitles, ...(hasMore ? ['others'] : [])];
  if (titles.length < 2) return titles[0] ?? 'other courses';
  if (titles.length === 2) return `${titles[0]} and ${titles[1]}`;
  return `${titles.slice(0, -1).join(', ')}, and ${titles.at(-1)}`;
}

function retryStatusLine(retry: NonNullable<CourseTopic['retry']>) {
  const retryAfter = retry.after ? Date.parse(retry.after) : Number.NaN;
  const titles = retryAfter > Date.now() ? [] : retry.reviewFirst.map(({ title }) => title);
  return `This lesson is paused. ${titles.length ? `It comes back after a review of ${titles.join(' and ')}.` : 'It comes back tomorrow.'}`;
}

function QueueStatusLine({
  queue,
  hasStartableTopics,
}: {
  queue: CourseQueueStatus;
  hasStartableTopics: boolean;
}) {
  switch (queue.kind) {
    case 'studying':
      return <p className="text-sm text-muted-foreground">Studying now</p>;
    case 'after':
      return (
        <p className="text-sm text-muted-foreground">
          Next in line after{' '}
          <Link
            to="/courses/$courseId"
            params={{ courseId: queue.courseId }}
            className="underline underline-offset-2"
          >
            {queue.courseTitle}
          </Link>
          .{hasStartableTopics ? ' You can start its unlocked topics now.' : null}
        </p>
      );
    case 'waiting':
      return (
        <p className="text-sm text-muted-foreground">
          {queue.topicCount === 0
            ? 'Waiting on prerequisites'
            : `Waiting on ${queue.topicCount} ${queue.topicCount === 1 ? 'topic' : 'topics'} from ${foundationSourceLabel(queue.courseTitles, false)}`}
        </p>
      );
    case 'paused':
      return (
        <p className="text-sm text-muted-foreground">Paused while you study {queue.subjectTitle}</p>
      );
    case 'soon':
      return <p className="text-sm text-muted-foreground">Lessons coming soon</p>;
    case 'done':
      return <p className="text-sm text-muted-foreground">Finished</p>;
  }
}

export function CoursePage() {
  const { courseId } = CourseRoute.useParams();
  const { data } = useSuspenseQuery(courseDetailQueryOptions(courseId));
  const tutorSidebar = useTutorSidebar();
  const [unitOpenOverrides, setUnitOpenOverrides] = useState(readCourseUnitOpenOverrides);
  const [foundationsOpen, setFoundationsOpen] = useState(false);
  const enrollment = useCourseEnrollment(courseId, data.course.title);
  const courseProgress = data.courses.find((course) => course.id === courseId);
  const showStartCard = data.status === 'not_started' || data.courseStart.needed;
  const buildsOnItems = buildsOnLineItems(data.buildsOn);
  const hasStartableTopics = data.units.some((unit) =>
    unit.topics.some(
      (topic) =>
        topic.hasLesson &&
        ['not_started', 'in_progress', 'quiz'].some((status) => status === topic.status),
    ),
  );
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
      <header className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{data.course.title}</h1>
          <p className="max-w-[70ch] text-sm text-muted-foreground">{data.course.description}</p>
          <p className="text-sm font-medium">
            {courseProgress?.topicsDone ?? 0} of {courseProgress?.topicsTotal ?? 0} topics done
          </p>
          <p className="text-sm text-muted-foreground">
            {buildsOnItems.length > 0 ? (
              <>
                Builds on{' '}
                {buildsOnItems.map(({ courseId: sourceCourseId, title, separator, suffix }) => (
                  <Fragment key={sourceCourseId}>
                    {separator}
                    <Link
                      to="/courses/$courseId"
                      params={{ courseId: sourceCourseId }}
                      className="underline underline-offset-2"
                    >
                      {title}
                    </Link>{' '}
                    ({suffix})
                  </Fragment>
                ))}
                .
              </>
            ) : (
              buildsOnLineText(data.buildsOn)
            )}
          </p>
          {data.queue ? (
            <QueueStatusLine queue={data.queue} hasStartableTopics={hasStartableTopics} />
          ) : null}
        </div>
        {!showStartCard && data.status === 'active' ? (
          <Button
            type="button"
            variant="outline"
            loading={enrollment.isPending}
            onClick={() => enrollment.mutate('paused')}
          >
            Remove
          </Button>
        ) : !showStartCard && data.status === 'paused' ? (
          <Button
            type="button"
            variant="outline"
            loading={enrollment.isPending}
            onClick={() => enrollment.mutate('active')}
          >
            Add to my courses
          </Button>
        ) : null}
      </header>
      {enrollment.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {enrollment.error.message}
        </p>
      ) : null}
      {data.status === 'completed' && data.suggestedNext.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Up next</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {data.suggestedNext.map((course) => (
              <Link
                key={course.id}
                to="/courses/$courseId"
                params={{ courseId: course.id }}
                className="flex items-center justify-between gap-3 rounded-md border px-4 py-3 hover:bg-muted/60"
              >
                <span className="min-w-0">
                  <span className="block font-medium">{course.title}</span>
                  <span className="block text-sm text-muted-foreground">{course.reason}</span>
                </span>
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
              </Link>
            ))}
          </CardContent>
        </Card>
      ) : null}
      {showStartCard ? (
        <CourseStartCard
          courseId={data.course.id}
          courseTitle={data.course.title}
          placementRunId={data.courseStart.placementRunId}
        />
      ) : null}
      {data.foundations.length > 0 ? (
        <Collapsible.Root open={foundationsOpen} onOpenChange={setFoundationsOpen}>
          <Card className="gap-0">
            <CardHeader className="p-0">
              <CardTitle className="w-full">
                <Collapsible.Trigger
                  aria-label={`${foundationsOpen ? 'Collapse' : 'Expand'} foundations`}
                  className="flex w-full items-center justify-between gap-3 rounded-t-xl px-(--card-spacing) pt-(--card-spacing) text-left data-[state=open]:pb-3 data-[state=closed]:pb-(--card-spacing) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  <span>{foundationsHeading(data.foundations.length)}</span>
                  <ChevronDown
                    aria-hidden="true"
                    className={`size-4 shrink-0 text-muted-foreground transition-transform duration-200 ${foundationsOpen ? 'rotate-180' : ''}`}
                  />
                </Collapsible.Trigger>
              </CardTitle>
            </CardHeader>
            <Collapsible.Content>
              <CardContent className="first:pt-0 p-0 last:pb-0">
                <p className="px-(--card-spacing) pb-4 text-sm text-muted-foreground">
                  Topics from other courses that this course needs. They&apos;re scheduled when a
                  unit needs them.
                </p>
                <TopicRows topics={data.foundations} />
              </CardContent>
            </Collapsible.Content>
          </Card>
        </Collapsible.Root>
      ) : null}
      <div className="space-y-4">
        {data.units.map((unit) => {
          const open = isUnitOpen(data.course.id, unit.unit, data.currentUnit, unitOpenOverrides);
          return (
            <Collapsible.Root
              key={unit.unit}
              open={open}
              onOpenChange={(nextOpen) => {
                const next = {
                  ...unitOpenOverrides,
                  [`${data.course.id}:${unit.unit}`]: nextOpen,
                };
                setUnitOpenOverrides(next);
                writeCourseUnitOpenOverrides(next);
              }}
            >
              <Card className="gap-0">
                <CardHeader className="p-0">
                  <CardTitle aria-label={`Unit ${unit.unit} · ${unit.title}`} className="w-full">
                    <Collapsible.Trigger
                      aria-label={`${open ? 'Collapse' : 'Expand'} unit ${unit.unit}`}
                      className="flex w-full items-center justify-between gap-3 rounded-t-xl px-(--card-spacing) pt-(--card-spacing) text-left data-[state=open]:pb-3 data-[state=closed]:pb-(--card-spacing) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    >
                      <span>
                        Unit {unit.unit} · {unit.title}
                      </span>
                      <ChevronDown
                        aria-hidden="true"
                        className={`size-4 shrink-0 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
                      />
                    </Collapsible.Trigger>
                  </CardTitle>
                </CardHeader>
                <Collapsible.Content>
                  <CardContent className="first:pt-0 p-0 last:pb-0">
                    {unit.intro ? (
                      <p className="px-(--card-spacing) pb-4 text-sm text-muted-foreground">
                        {unit.intro}
                      </p>
                    ) : null}
                    <ol className="divide-y">
                      {unit.topics.map((topic) => {
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
                                      {topic.retry ? (
                                        <span className="text-xs text-muted-foreground">
                                          {retryStatusLine(topic.retry)}
                                        </span>
                                      ) : topic.status === 'locked' ? (
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
                                          {topic.placedOut
                                            ? 'Placed out'
                                            : COURSE_STATUS_LABEL[topic.status]}
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
                                {topic.movedBack ? (
                                  <p className="text-xs text-muted-foreground">
                                    Moved back into your plan: you missed a question that depends on
                                    it.
                                  </p>
                                ) : null}
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
                                search={{ from: undefined, step: undefined }}
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
                    {unit.papers.length > 0 ? (
                      <section className="border-t" aria-label="Optional reading">
                        <h3 className="px-(--card-spacing) pt-4 pb-1 text-sm font-medium text-muted-foreground">
                          Optional reading
                        </h3>
                        <ul className="divide-y">
                          {unit.papers.map((paper) => (
                            <li key={paper.id}>
                              <Link
                                to="/papers/$paperId"
                                params={{ paperId: paper.id }}
                                search={{ courseId: data.course.id }}
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
                                    <CourseMetadata>{paper.title}</CourseMetadata>
                                  </span>
                                  <span className="block text-xs text-muted-foreground">
                                    <CourseMetadata>{paper.authors}</CourseMetadata> · {paper.year}
                                    {' · ~'}
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
                    {unit.project ? (
                      <section className="border-t" aria-label="Project">
                        <h3 className="px-(--card-spacing) pt-4 pb-1 text-sm font-medium text-muted-foreground">
                          Project
                        </h3>
                        <ul className="divide-y">
                          <li>
                            {unit.project.available ? (
                              <Link
                                to="/projects/$projectId"
                                params={{ projectId: unit.project.id }}
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
                                    <CourseMetadata>{unit.project.title}</CourseMetadata>
                                  </span>
                                </span>
                                {unit.project.status !== 'not_started' ? (
                                  <Badge
                                    variant="secondary"
                                    className={
                                      unit.project.status === 'completed'
                                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                                        : ''
                                    }
                                  >
                                    {unit.project.status === 'completed'
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
                                    <CourseMetadata>{unit.project.title}</CourseMetadata>
                                  </span>
                                  <span className="block text-xs text-muted-foreground">
                                    {unit.project.authored
                                      ? 'Waiting on prerequisites'
                                      : 'Project coming soon'}
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

function TopicRows({ topics }: { topics: CourseTopic[] }) {
  return (
    <ol className="divide-y">
      {topics.map((topic) => {
        const row = (
          <>
            <span className="w-9 shrink-0 pt-0.5 text-sm tabular-nums text-muted-foreground">
              {topic.number}
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={`block font-medium ${topic.hasLesson ? '' : 'text-muted-foreground'}`}
              >
                {topic.title}
              </span>
              {topic.retry ? (
                <span className="text-xs text-muted-foreground">
                  {retryStatusLine(topic.retry)}
                </span>
              ) : topic.status === 'locked' ? (
                <span className="text-xs text-muted-foreground">
                  Needs {topic.needs?.map((prerequisite) => prerequisite.title).join(', ')}
                </span>
              ) : topic.status !== 'not_started' ? (
                <Badge variant="secondary" className={topicStatusClasses(topic.status)}>
                  {COURSE_STATUS_LABEL[topic.status]}
                </Badge>
              ) : null}
            </span>
            {topic.hasLesson ? (
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            ) : null}
          </>
        );
        const className = `flex items-center justify-between gap-3 px-(--card-spacing) py-3 ${
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
                search={{ from: undefined, step: undefined }}
                className={`group ${className} hover:bg-muted/60`}
              >
                {row}
              </Link>
            ) : (
              <div className={className}>{row}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
