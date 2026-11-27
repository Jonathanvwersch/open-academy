import type { LessonRunPayload } from '@academy/aesop/api/lessons';

type Point = NonNullable<LessonRunPayload['run']>['points'][number];

export function StepProgress({ point }: { point: Pick<Point, 'status' | 'streak'> | undefined }) {
  const streak = point?.streak ?? 0;
  const label =
    point?.status === 'passed'
      ? 'Step complete'
      : streak === 1
        ? '1 more correct to finish'
        : '2 correct in a row';
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <div role="img" aria-label={`${streak} of 2 correct in a row`} className="flex gap-2">
        {[0, 1].map((index) => (
          <span
            key={index}
            className={`h-3 w-3 rounded-full border ${index < streak ? 'border-green-600 bg-green-500' : 'border-border bg-background'}`}
          />
        ))}
      </div>
      <span className="inline-grid">
        <span aria-hidden="true" className="invisible col-start-1 row-start-1">
          1 more correct to finish
        </span>
        <span className="col-start-1 row-start-1">{label}</span>
      </span>
    </div>
  );
}
