import type { CourseTopic } from '@academy/contracts/course';
import { useSuspenseQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { ChevronDown, ChevronRight, FileText, Wrench } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import { useEffect, useState } from 'react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Dialog, DialogContent, DialogTitle } from '../../components/ui/dialog.js';
import { paperStatusLabel } from '../papers/queries.js';
import { useTutorSidebar } from '../tutor/tutor-sidebar.js';
import { CourseMetadata } from './course-metadata.js';
import { CourseStartCard } from './course-start-card.js';
import { foundationsHeading } from './foundations-heading.js';
import { courseQueryOptions } from './queries.js';
import { useSwitchCourse } from './use-switch-course.js';
import {
  isUnitOpen,
  readCourseUnitOpenOverrides,
  writeCourseUnitOpenOverrides,
} from './week-open-state.js';

const CourseRoute = getRouteApi('/course');

export function CoursePage() {
  const { course: courseId } = CourseRoute.useSearch();
  const { data } = useSuspenseQuery(courseQueryOptions(courseId));
  const tutorSidebar = useTutorSidebar();
  const [unitOpenOverrides, setUnitOpenOverrides] = useState(readCourseUnitOpenOverrides);
  const [coursesOpen, setCoursesOpen] = useState(false);
  const [foundationsOpen, setFoundationsOpen] = useState(false);
  const activeCourse = data.courses.find((course) => course.id === data.course.id);
  const changeCourse = useSwitchCourse(() => setCoursesOpen(false));
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
            {activeCourse?.topicsDone ?? 0} of {activeCourse?.topicsTotal ?? 0} topics done
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => setCoursesOpen(true)}>
          Change course
        </Button>
      </header>
      <Dialog open={coursesOpen} onOpenChange={setCoursesOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Courses</DialogTitle>
          <div className="mt-4 space-y-3">
            {data.courses.map((course) => (
              <Card key={course.id} size="sm">
                <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <h3 className="font-medium">{course.title}</h3>
                    <p className="line-clamp-2 text-sm text-muted-foreground">
                      {course.description}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {course.topicsDone} of {course.topicsTotal} topics
                    </p>
                  </div>
                  {course.active ? (
                    <Badge variant="secondary">Current</Badge>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={changeCourse.isPending}
                      loading={changeCourse.isPending && changeCourse.variables === course.id}
                      onClick={() => changeCourse.mutate(course.id)}
                    >
                      {course.started ? 'Switch' : 'Start'}
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
          {changeCourse.isError ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {changeCourse.error.message}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
      {data.courseStart.needed ? (
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
              {topic.status === 'locked' ? (
                <span className="text-xs text-muted-foreground">
                  Needs {topic.needs?.map((prerequisite) => prerequisite.title).join(', ')}
                </span>
              ) : topic.status !== 'not_started' ? (
                <Badge
                  variant="secondary"
                  className={
                    topic.status === 'complete'
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                      : topic.status === 'quiz'
                        ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                        : ''
                  }
                >
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
                search={{ from: undefined }}
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
