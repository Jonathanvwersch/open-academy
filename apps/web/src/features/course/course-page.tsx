import type { CourseTopic } from '@academy/contracts/course';
import { useSuspenseQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { ChevronDown, ChevronRight, FileText, Wrench } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import { useEffect, useState } from 'react';
import {
  topicStatusLabels as COURSE_STATUS_LABEL,
  topicStatusClasses,
} from '../../components/topic-status.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Dialog, DialogContent, DialogTitle } from '../../components/ui/dialog.js';
import { paperStatusLabel } from '../papers/queries.js';
import { useTutorSidebar } from '../tutor/tutor-sidebar.js';
import { CourseMetadata } from './course-metadata.js';
import { CourseStartCard } from './course-start-card.js';
import { foundationsHeading } from './foundations-heading.js';
import { useCourseEnrollment, useRestartTopic } from './mutations.js';
import { courseDetailQueryOptions } from './queries.js';
import {
  isUnitOpen,
  readCourseUnitOpenOverrides,
  writeCourseUnitOpenOverrides,
} from './week-open-state.js';

const CourseRoute = getRouteApi('/courses/$courseId');

type RestartTarget = { conceptId: string; title: string };

export function CoursePage() {
  const { courseId } = CourseRoute.useParams();
  const { data } = useSuspenseQuery(courseDetailQueryOptions(courseId));
  const tutorSidebar = useTutorSidebar();
  const [unitOpenOverrides, setUnitOpenOverrides] = useState(readCourseUnitOpenOverrides);
  const [foundationsOpen, setFoundationsOpen] = useState(false);
  const [restartTarget, setRestartTarget] = useState<RestartTarget | null>(null);
  const enrollment = useCourseEnrollment(courseId, data.course.title);
  const restart = useRestartTopic();
  const courseProgress = data.courses.find((course) => course.id === courseId);
  const showStartCard = data.status === 'not_started' || data.courseStart.needed;
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
                <TopicRows topics={data.foundations} onRestart={setRestartTarget} />
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
                                      ) : (
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
                                      )}
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
                                      ) : (
                                        <>{COURSE_STATUS_LABEL[topic.status]} · </>
                                      )}
                                      Lesson coming soon
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                            {topic.status !== 'not_started' && topic.status !== 'locked' ? (
                              <TopicRestartButton topic={topic} onRestart={setRestartTarget} />
                            ) : null}
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
      <Dialog
        open={restartTarget !== null}
        onOpenChange={(open) => {
          if (!open && !restart.isPending) setRestartTarget(null);
        }}
      >
        <DialogContent aria-describedby="restart-topic-description">
          <div className="space-y-2">
            <DialogTitle>Restart {restartTarget?.title}?</DialogTitle>
            <p id="restart-topic-description" className="text-sm text-muted-foreground">
              Your progress and reviews for this topic are cleared and it goes back to not started.
              XP you&apos;ve earned stays.
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setRestartTarget(null)}
              disabled={restart.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={restart.isPending}
              onClick={() => {
                if (!restartTarget) return;
                restart.mutate(
                  { conceptId: restartTarget.conceptId, topicTitle: restartTarget.title },
                  { onSuccess: () => setRestartTarget(null) },
                );
              }}
            >
              Restart topic
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function TopicRows({
  topics,
  onRestart,
}: {
  topics: CourseTopic[];
  onRestart: (target: RestartTarget) => void;
}) {
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
              ) : (
                <Badge variant="secondary" className={topicStatusClasses(topic.status)}>
                  {COURSE_STATUS_LABEL[topic.status]}
                </Badge>
              )}
            </span>
            {topic.status !== 'not_started' && topic.status !== 'locked' ? (
              <TopicRestartButton topic={topic} onRestart={onRestart} />
            ) : null}
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

function TopicRestartButton({
  topic,
  onRestart,
}: {
  topic: Pick<CourseTopic, 'conceptId' | 'title'>;
  onRestart: (target: RestartTarget) => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 shrink-0 px-2 text-xs"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onRestart({ conceptId: topic.conceptId, title: topic.title });
      }}
    >
      Restart
    </Button>
  );
}
