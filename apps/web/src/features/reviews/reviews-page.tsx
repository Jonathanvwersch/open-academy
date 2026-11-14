import type { ReviewTopic } from '@academy/contracts/reviews';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Collapsible } from 'radix-ui';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { todayQueryOptions } from '../sessions/queries.js';
import { useStartSession } from '../sessions/start-session.js';
import { reviewsQueryOptions } from './queries.js';

const dimensionLabels: Record<string, string> = {
  conceptual: 'Concept',
  math: 'Maths',
  implementation: 'Code',
  transfer: 'Apply it',
};

function dateLabel(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(
    new Date(`${date}T12:00:00.000Z`),
  );
}

function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

export function ReviewsPage() {
  const { data } = useSuspenseQuery(reviewsQueryOptions());
  const { data: today } = useSuspenseQuery(todayQueryOptions());
  const startSession = useStartSession(today.sessionKind);
  const [openDates, setOpenDates] = useState<Set<string>>(() => new Set());
  const [scrollDate, setScrollDate] = useState<string>();
  const todayDate = shiftDate(data.upcoming[0]?.date ?? new Date().toISOString().slice(0, 10), -1);
  const topicsByDate = useMemo(() => {
    const grouped = new Map<string, typeof data.topics>();
    for (const topic of data.topics) {
      if (topic.due) continue;
      const date = shiftDate(todayDate, topic.dueInDays);
      const topics = grouped.get(date) ?? [];
      topics.push(topic);
      grouped.set(date, topics);
    }
    return grouped;
  }, [data.topics, todayDate]);
  const dueTopics = data.topics.filter((topic) => topic.due);
  const upcomingDates = new Set(data.upcoming.map((day) => day.date));
  const upcomingTopics = [...topicsByDate].filter(([date]) => upcomingDates.has(date));
  const todayTopics = topicsByDate.get(todayDate) ?? [];
  const laterTopics = [...topicsByDate]
    .filter(([date]) => !upcomingDates.has(date) && date !== todayDate)
    .flatMap(([, topics]) => topics);
  const dueDateGroups = groupByCourse(dueTopics);
  useEffect(() => {
    if (!scrollDate || !openDates.has(scrollDate)) return;
    document.getElementById(`reviews-${scrollDate}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
    setScrollDate(undefined);
  }, [openDates, scrollDate]);

  const toggleDate = (date: string) => {
    setOpenDates((current) => {
      const next = new Set(current);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  return (
    <section className="space-y-6">
      <h1 className="sr-only">Reviews</h1>
      <Card>
        <CardHeader>
          <CardTitle>Due now · {data.dueNow}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {dueTopics.length > 0 ? (
            <>
              <TopicGroups groups={dueDateGroups} />
              {today.activeSessionId ? (
                <Button asChild>
                  <Link to="/session/$id" params={{ id: today.activeSessionId }}>
                    Continue reviews
                  </Link>
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={() => startSession.mutate()}
                  loading={startSession.isPending}
                >
                  Start reviews
                </Button>
              )}
              {startSession.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  {startSession.error.message}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing due right now.</p>
          )}
        </CardContent>
      </Card>
      <fieldset className="grid grid-cols-7 gap-2">
        <legend className="sr-only">Upcoming reviews for the next seven days</legend>
        {data.upcoming.map((day) => (
          <Button
            key={day.date}
            type="button"
            variant="outline"
            disabled={day.count === 0}
            aria-pressed={openDates.has(day.date)}
            className="h-auto min-h-20 flex-col gap-1 px-1 py-3"
            onClick={() => {
              setOpenDates((current) => new Set(current).add(day.date));
              setScrollDate(day.date);
            }}
          >
            <span className="text-xs">{dateLabel(day.date, { weekday: 'short' })}</span>
            <span className="text-xl font-semibold tabular-nums">{day.count}</span>
          </Button>
        ))}
      </fieldset>
      <Card>
        <CardHeader>
          <CardTitle>Coming up</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {upcomingTopics.map(([date, topics]) => (
            <ReviewDay
              key={date}
              id={`reviews-${date}`}
              title={`${date === data.upcoming[0]?.date ? 'Tomorrow' : dateLabel(date, { weekday: 'short', day: 'numeric', month: 'short' })} · ${topics.length}`}
              groups={groupByCourse(topics)}
              open={openDates.has(date)}
              onOpenChange={() => toggleDate(date)}
            />
          ))}
          {todayTopics.length > 0 ? (
            <ReviewDay
              id={`reviews-${todayDate}`}
              title={`Later today · ${todayTopics.length}`}
              groups={groupByCourse(todayTopics)}
              open={openDates.has(todayDate)}
              onOpenChange={() => toggleDate(todayDate)}
            />
          ) : null}
          {laterTopics.length > 0 ? (
            <ReviewDay
              id="reviews-later"
              title={`Later · ${laterTopics.length}`}
              groups={groupByCourse(laterTopics)}
              open={openDates.has('later')}
              onOpenChange={() => toggleDate('later')}
            />
          ) : null}
          {data.topics.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No reviews yet. Topics you finish come back here.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}

function groupByCourse(topics: ReviewTopic[]) {
  const groups = new Map<string, { title: string; topics: typeof topics }>();
  for (const topic of topics) {
    const key = topic.courseId ?? '';
    const group = groups.get(key) ?? { title: topic.courseTitle ?? 'Other topics', topics: [] };
    group.topics.push(topic);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function TopicGroups({ groups }: { groups: ReturnType<typeof groupByCourse> }) {
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group.title} className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            {group.title} · {group.topics.length}
          </h2>
          <ul className="divide-y">
            {group.topics.map((topic) => (
              <li
                key={topic.conceptId}
                className="flex flex-wrap items-center gap-2 py-3 first:pt-0"
              >
                <span className="font-medium">{topic.title}</span>
                {topic.kinds.map((kind) => (
                  <Badge key={kind} variant="outline">
                    {dimensionLabels[kind] ?? kind}
                  </Badge>
                ))}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function ReviewDay({
  id,
  title,
  groups,
  open,
  onOpenChange,
}: {
  id: string;
  title: string;
  groups: ReturnType<typeof groupByCourse>;
  open: boolean;
  onOpenChange: () => void;
}) {
  return (
    <Collapsible.Root open={open} onOpenChange={onOpenChange}>
      <div id={id} className="scroll-mt-4 rounded-lg border px-4">
        <Collapsible.Trigger className="flex w-full items-center justify-between py-3 text-left font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {title}
          <span aria-hidden="true">{open ? '−' : '+'}</span>
        </Collapsible.Trigger>
        <Collapsible.Content className="pb-4">
          <TopicGroups groups={groups} />
        </Collapsible.Content>
      </div>
    </Collapsible.Root>
  );
}
