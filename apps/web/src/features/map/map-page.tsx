import type { UpNextPayload } from '@academy/contracts/course';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent } from '../../components/ui/card.js';
import { studyMapQueryOptions } from './queries.js';

function weekStart(date: string): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() - ((value.getUTCDay() + 6) % 7));
  return value.toISOString().slice(0, 10);
}

function weekTitle(date: string): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  return `Week of ${new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(value)}`;
}

function dateLabel(date: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00.000Z`));
}

function groupByWeek(topics: UpNextPayload['upcoming']) {
  const weeks = new Map<string, typeof topics>();
  for (const topic of topics) {
    const key = weekStart(topic.date);
    weeks.set(key, [...(weeks.get(key) ?? []), topic]);
  }
  return [...weeks].map(([week, items]) => ({ week, items }));
}

function TopicList({ topics }: { topics: UpNextPayload['upcoming'] }) {
  return (
    <Card className="py-0">
      <CardContent className="p-0">
        <ol className="divide-y">
          {topics.map((topic) => (
            <li key={`${topic.courseId}:${topic.conceptId}`}>
              <Link
                to="/courses/$courseId"
                params={{ courseId: topic.courseId }}
                className="flex items-start justify-between gap-4 px-5 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="min-w-0 space-y-1">
                  <span className="block font-medium">{topic.title}</span>
                  <span className="block text-sm text-muted-foreground">
                    {topic.courseTitle} · {topic.unitTitle}
                  </span>
                </span>
                <span className="shrink-0 pt-0.5 text-sm text-muted-foreground">
                  {topic.dayLabel}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

export function MapPage() {
  const { data } = useSuspenseQuery(studyMapQueryOptions());
  const [showAllSubjects, setShowAllSubjects] = useState(false);
  const allSubjects = data.allSubjects ?? null;
  const focused = Boolean(data.focusSubjectTitle && allSubjects);
  const weeks = groupByWeek(
    focused && showAllSubjects && allSubjects ? allSubjects : data.upcoming,
  );

  return (
    <section className="mx-auto w-full max-w-3xl space-y-6 px-4 pb-10 sm:px-6">
      <header className="space-y-3">
        <h1 className="sr-only">Up next</h1>
        <p className="text-sm text-muted-foreground">
          {focused && !showAllSubjects
            ? `Your next ${data.focusSubjectTitle} topics, in projected study order. Other subjects are paused while you focus on ${data.focusSubjectTitle}.`
            : 'Your next topics across active courses, in projected study order.'}
        </p>
        {focused ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-pressed={showAllSubjects}
            onClick={() => setShowAllSubjects((value) => !value)}
          >
            {showAllSubjects ? `Show ${data.focusSubjectTitle} only` : 'Show all subjects'}
          </Button>
        ) : null}
      </header>
      {weeks.length ? (
        weeks.map(({ week, items }) => (
          <section key={week} aria-label={weekTitle(week)} className="space-y-3">
            <h2 className="text-sm font-semibold text-muted-foreground">{weekTitle(week)}</h2>
            <TopicList topics={items} />
          </section>
        ))
      ) : (
        <Card>
          <CardContent className="text-sm text-muted-foreground">
            No topics are currently projected. Add an active course or complete a prerequisite to
            see what is next.
          </CardContent>
        </Card>
      )}
      <Collapsible.Root className="space-y-3">
        <Collapsible.Trigger className="group flex w-full items-center justify-between rounded-sm text-sm font-semibold text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span>Finished ({data.finished.length})</span>
          <ChevronDown
            aria-hidden="true"
            className="size-4 transition-transform group-data-[state=open]:rotate-180"
          />
        </Collapsible.Trigger>
        <Collapsible.Content>
          <Card className="py-0">
            <CardContent className="p-0">
              {data.finished.length ? (
                <ol className="divide-y">
                  {data.finished.map((topic) => (
                    <li
                      key={`${topic.courseId}:${topic.conceptId}`}
                      className="flex items-start justify-between gap-4 px-5 py-3"
                    >
                      <span className="min-w-0 space-y-1">
                        <span className="block font-medium">{topic.title}</span>
                        <span className="block text-sm text-muted-foreground">
                          {topic.courseTitle} · {topic.unitTitle}
                        </span>
                      </span>
                      {topic.date ? (
                        <span className="shrink-0 pt-0.5 text-sm text-muted-foreground">
                          {dateLabel(topic.date)}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="px-5 py-3 text-sm text-muted-foreground">No finished topics yet.</p>
              )}
            </CardContent>
          </Card>
        </Collapsible.Content>
      </Collapsible.Root>
    </section>
  );
}
