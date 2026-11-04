import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Badge } from '@/ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card.js';
import { courseQueryOptions } from '../queries.js';
import { RouteLoadError } from '../route-error.js';

export const Route = createFileRoute('/course')({
  loader: ({ context }) => context.queryClient.ensureQueryData(courseQueryOptions()),
  errorComponent: () => (
    <RouteLoadError message="Your course is unavailable." className="text-sm text-destructive" />
  ),
  component: CoursePage,
});

function CoursePage() {
  const { data } = useSuspenseQuery(courseQueryOptions());
  return (
    <section className="space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">Your curriculum</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Course</h1>
      </div>
      <div className="space-y-4">
        {data.weeks.map((week) => (
          <Card key={week.week}>
            <CardHeader>
              <CardTitle>
                Week {week.week} · {week.title}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <ol className="divide-y">
                {week.topics.map((topic) => (
                  <li
                    key={topic.conceptId}
                    className={`flex items-center justify-between gap-3 px-4 py-3 ${
                      topic.status === 'locked' ? 'text-muted-foreground opacity-60' : ''
                    }`}
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="w-9 shrink-0 pt-0.5 text-sm tabular-nums text-muted-foreground">
                        {topic.number}
                      </span>
                      <div className="min-w-0 space-y-1">
                        <p className="font-medium">{topic.title}</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="secondary">{topic.mastery}</Badge>
                          {topic.status !== 'not_started' ? (
                            <span className="text-xs text-muted-foreground">
                              {COURSE_STATUS_LABEL[topic.status]}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    {topic.hasLesson ? (
                      <Link
                        to="/lessons/$conceptId"
                        params={{ conceptId: topic.conceptId }}
                        search={{ from: undefined }}
                        className="shrink-0 text-sm font-medium underline-offset-4 hover:underline"
                      >
                        View lesson
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

const COURSE_STATUS_LABEL = {
  locked: 'Locked',
  not_started: 'Not started',
  in_progress: 'In progress',
  complete: 'Complete',
} as const;
