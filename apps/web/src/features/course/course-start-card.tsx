import { Link } from '@tanstack/react-router';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { useStartCourse } from './mutations.js';

export function CourseStartCard({
  courseId,
  courseTitle,
  placementRunId,
}: {
  courseId: string;
  courseTitle: string;
  placementRunId: string | null;
}) {
  const startFromBeginning = useStartCourse(courseId, courseTitle);

  return (
    <Card id="course-start-card">
      <CardHeader>
        <CardTitle>Start {courseTitle}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm leading-6 text-muted-foreground">
          Take a short placement check to skip topics you already know, or start from the beginning.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button asChild>
            <Link to="/placement" search={{ id: placementRunId ?? undefined, course: courseId }}>
              {placementRunId ? 'Continue placement check' : 'Take the placement check'}
            </Link>
          </Button>
          <Button
            type="button"
            variant="outline"
            loading={startFromBeginning.isPending}
            onClick={() => startFromBeginning.mutate('active')}
          >
            I&apos;m new to this — start from the beginning
          </Button>
        </div>
        {startFromBeginning.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {startFromBeginning.error.message}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
