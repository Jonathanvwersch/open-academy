import { useSuspenseQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { masteryStateLabels } from './mastery-labels.js';
import { progressQueryOptions } from './queries.js';
import { StreakCard } from './streak-card.js';

const masteryStateOrder = ['retained', 'independent', 'assisted', 'introduced', 'not_assessed'];

const masteryStateColors: Record<string, string> = {
  not_assessed: 'bg-muted',
  introduced: 'bg-neutral-300',
  assisted: 'bg-amber-300',
  independent: 'bg-sky-400',
  retained: 'bg-emerald-500',
};

export function ProgressPage() {
  const { data } = useSuspenseQuery(progressQueryOptions());
  return (
    <section className="space-y-6">
      <h1 className="sr-only">Progress</h1>
      <StreakCard streak={data.streak} />
      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <p className="text-sm">
            Topics done:{' '}
            <span className="font-semibold tabular-nums">
              {data.topicsDone} of {data.topicsTotal}
            </span>
          </p>
          <p className="text-sm">
            Study time:{' '}
            <span className="font-semibold tabular-nums">{data.studyTimeHours.toFixed(1)} h</span>
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>By course</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {data.subjects.length ? (
            data.subjects.map((subject) => (
              <section className="space-y-4" key={subject.id}>
                <h3 className="font-semibold">{subject.title}</h3>
                {subject.courses.map((course) => {
                  const counts = masteryStateOrder
                    .map(
                      (state) =>
                        [
                          state,
                          course.masteryCounts[state as keyof typeof course.masteryCounts],
                        ] as const,
                    )
                    .filter(([, count]) => count > 0);
                  const total = counts.reduce((sum, [, count]) => sum + count, 0);
                  const legend = counts
                    .map(([state, count]) => `${count} ${masteryStateLabels[state]}`)
                    .join(' · ');
                  return (
                    <div className="space-y-2" key={course.id}>
                      <div className="flex items-baseline justify-between gap-4">
                        <h4 className="min-w-0 truncate font-medium">{course.title}</h4>
                        <span className="shrink-0 text-sm font-medium">
                          {course.topicsDone} of {course.topicsTotal} topics
                        </span>
                      </div>
                      {legend ? (
                        <>
                          <div
                            aria-label={legend}
                            className="flex h-2 overflow-hidden rounded-full"
                            role="img"
                          >
                            {counts.map(([state, count]) => (
                              <span
                                key={state}
                                className={masteryStateColors[state]}
                                style={{ width: `${(count / total) * 100}%` }}
                              />
                            ))}
                          </div>
                          <p className="text-xs text-muted-foreground">{legend}</p>
                        </>
                      ) : null}
                      {course.lessonsComingSoon ? (
                        <p className="text-sm text-muted-foreground">
                          {course.lessonsComingSoon}{' '}
                          {course.lessonsComingSoon === 1 ? 'lesson' : 'lessons'} coming soon
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </section>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No active courses yet.</p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
