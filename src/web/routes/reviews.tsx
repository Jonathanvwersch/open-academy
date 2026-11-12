import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Badge } from '@/ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card.js';
import { reviewsQueryOptions } from '../queries.js';
import { RouteLoadError } from '../route-error.js';
import { ReviewsSkeleton } from '../skeletons.js';

export const Route = createFileRoute('/reviews')({
  pendingComponent: ReviewsSkeleton,
  loader: ({ context }) => context.queryClient.ensureQueryData(reviewsQueryOptions()),
  errorComponent: () => <RouteLoadError message="Reviews are unavailable." role="alert" />,
  component: ReviewsPage,
});

const dimensionLabels: Record<string, string> = {
  conceptual: 'Concept',
  math: 'Maths',
  implementation: 'Code',
  transfer: 'Concept',
};

function localDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dueLabel(dueAt: string): string {
  const today = localDateKey(new Date());
  const due = localDateKey(new Date(dueAt));
  const days = Math.round(
    (Date.parse(`${due}T00:00:00.000Z`) - Date.parse(`${today}T00:00:00.000Z`)) / 86_400_000,
  );
  if (days < 0) return 'Overdue';
  if (days === 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  return `Due in ${days} days`;
}

function dayLabel(date: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
  }).format(new Date(`${date}T12:00:00.000Z`));
}

function ReviewsPage() {
  const { data } = useSuspenseQuery(reviewsQueryOptions());
  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Reviews</h1>
        <p className="mt-1 text-muted-foreground">
          {data.dueNow > 0 ? `${data.dueNow} due now` : 'Nothing due'}
        </p>
      </div>
      <fieldset
        className="grid grid-cols-7 gap-2"
        aria-label="Upcoming reviews for the next seven days"
      >
        {data.upcoming.map((day) => (
          <div
            key={day.date}
            className="flex min-h-20 flex-col items-center justify-center gap-1 rounded-lg border bg-card px-1 py-3 text-center"
          >
            <span className="text-xs text-muted-foreground">{dayLabel(day.date)}</span>
            <span className="text-sm font-medium">{day.count}</span>
          </div>
        ))}
      </fieldset>
      <Card>
        <CardHeader>
          <CardTitle>Topics</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {data.topics.length > 0 ? (
            <ul className="divide-y">
              {data.topics.map((topic) => (
                <li key={`${topic.conceptId}:${topic.dimension}`} className="px-4 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-medium">{topic.title}</h2>
                    <Badge variant="outline">
                      {dimensionLabels[topic.dimension] ?? topic.dimension}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {dueLabel(topic.dueAt)} · ~{Math.round(topic.recall * 100)}% recall · Reviewed{' '}
                    {topic.reps} times
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 pb-4 text-sm text-muted-foreground">No review topics yet.</p>
          )}
        </CardContent>
      </Card>
      <p className="text-sm text-muted-foreground">Due reviews come up in your next session.</p>
    </section>
  );
}
