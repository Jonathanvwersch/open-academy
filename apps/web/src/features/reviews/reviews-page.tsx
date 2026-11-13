import { useSuspenseQuery } from '@tanstack/react-query';
import { Badge } from '../../components/ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { reviewsQueryOptions } from './queries.js';

const dimensionLabels: Record<string, string> = {
  conceptual: 'Concept',
  math: 'Maths',
  implementation: 'Code',
  transfer: 'Transfer',
};

function dueLabel(topic: { due: boolean; dueInDays: number }): string {
  if (topic.due) return 'Due now';
  if (topic.dueInDays === 0) return 'Due later today';
  if (topic.dueInDays === 1) return 'Due tomorrow';
  return `Due in ${topic.dueInDays} days`;
}

function dayLabel(date: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
  }).format(new Date(`${date}T12:00:00.000Z`));
}

export function ReviewsPage() {
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
            <span
              className={`text-sm font-medium ${day.count === 0 ? 'text-muted-foreground' : ''}`}
            >
              {day.count}
            </span>
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
                    {dueLabel(topic)} · ~{Math.round(topic.recall * 100)}% recall ·{' '}
                    {topic.reps === 0
                      ? 'Not reviewed yet'
                      : topic.reps === 1
                        ? 'Reviewed once'
                        : `Reviewed ${topic.reps} times`}
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
