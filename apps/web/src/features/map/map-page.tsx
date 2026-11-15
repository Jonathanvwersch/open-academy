import type { UpNextPayload } from '@academy/contracts/course';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { Collapsible } from 'radix-ui';
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

export function MapPage() {
  const { data } = useSuspenseQuery(studyMapQueryOptions());
  const weeks = groupByWeek(data.upcoming);

  return (
    <section className="mx-auto w-full max-w-3xl space-y-6 px-4 pb-10 sm:px-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Up next</h1>
        <p className="text-sm text-muted-foreground">
          Your next topics across active courses, in projected study order.
        </p>
      </header>
      {weeks.length ? (
        weeks.map(({ week, items }) => (
          <section key={week} aria-label={weekTitle(week)} className="space-y-3">
            <h2 className="text-sm font-semibold text-muted-foreground">{weekTitle(week)}</h2>
            <ol className="divide-y rounded-lg border">
              {items.map((topic) => (
                <li key={`${topic.courseId}:${topic.conceptId}`} className="px-4 py-3">
                  <Link
                    to="/courses/$courseId"
                    params={{ courseId: topic.courseId }}
                    className="flex items-start justify-between gap-4 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
          </section>
        ))
      ) : (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            No topics are currently projected. Add an active course or complete a prerequisite to
            see what is next.
          </CardContent>
        </Card>
      )}
      <Collapsible.Root>
        <Card>
          <CardContent className="p-0">
            <Collapsible.Trigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="h-auto w-full justify-between px-4 py-3"
              >
                <span className="font-medium">Finished ({data.finished.length})</span>
                <ChevronDown aria-hidden="true" className="size-4" />
              </Button>
            </Collapsible.Trigger>
            <Collapsible.Content>
              {data.finished.length ? (
                <ol className="divide-y border-t">
                  {data.finished.map((topic) => (
                    <li
                      key={`${topic.courseId}:${topic.conceptId}`}
                      className="flex items-start justify-between gap-4 px-4 py-3"
                    >
                      <span className="min-w-0">
                        <span className="block font-medium">{topic.title}</span>
                        <span className="block text-sm text-muted-foreground">
                          {topic.courseTitle} · {topic.unitTitle}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm text-muted-foreground">
                        {dateLabel(topic.date)}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="border-t px-4 py-3 text-sm text-muted-foreground">
                  No finished topics yet.
                </p>
              )}
            </Collapsible.Content>
          </CardContent>
        </Card>
      </Collapsible.Root>
    </section>
  );
}
