import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Badge } from '../../components/ui/badge.js';
import { Card, CardContent } from '../../components/ui/card.js';
import { coursesQueryOptions } from './queries.js';

const statusLabels = {
  active: 'In my courses',
  paused: 'Removed',
  completed: 'Complete',
} as const;

export function CoursesPage() {
  const { data } = useSuspenseQuery(coursesQueryOptions());

  return (
    <section className="space-y-8">
      <h1 className="sr-only">Courses</h1>
      {data.subjects.map((subject) => (
        <section key={subject.title} className="space-y-4">
          {data.subjects.length > 1 ? (
            <h2 className="text-lg font-semibold tracking-tight">{subject.title}</h2>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {subject.courses.map((course) => (
              <Link
                key={course.id}
                to="/courses/$courseId"
                params={{ courseId: course.id }}
                className="group block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Card className="h-full transition-colors group-hover:border-primary/50">
                  <CardContent className="space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="font-medium leading-6">{course.title}</h3>
                      {course.status !== 'not_started' ? (
                        <Badge variant="secondary" className="shrink-0">
                          {statusLabels[course.status]}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="line-clamp-2 min-h-10 text-sm text-muted-foreground">
                      {course.description}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {course.topicsDone} of {course.topicsTotal} topics
                    </p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </section>
  );
}
