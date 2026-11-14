import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { apiFetch } from '../../api/authenticated-fetch.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { papersQueryOptions } from '../papers/queries.js';
import { todayQueryOptions } from '../sessions/queries.js';
import { courseQueryKeyRoot, learnQueryOptions } from './queries.js';

export function CourseStartCard({
  courseId,
  courseTitle,
  placementRunId,
}: {
  courseId: string;
  courseTitle: string;
  placementRunId: string | null;
}) {
  const queryClient = useQueryClient();
  const startFromBeginning = useMutation({
    mutationFn: async () => {
      const response = await apiFetch('/api/course/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'beginning', courseId }),
      });
      if (!response.ok) throw new Error('Could not start this course');
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: courseQueryKeyRoot }),
        queryClient.invalidateQueries({ queryKey: learnQueryOptions().queryKey }),
        queryClient.invalidateQueries({ queryKey: todayQueryOptions().queryKey }),
        queryClient.invalidateQueries({ queryKey: papersQueryOptions().queryKey }),
      ]);
    },
  });

  return (
    <Card>
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
            onClick={() => startFromBeginning.mutate()}
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
