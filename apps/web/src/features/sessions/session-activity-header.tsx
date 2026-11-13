import { Button } from '../../components/ui/button.js';
import { Skeleton } from '../../components/ui/skeleton.js';

export function SessionActivityHeader({
  title,
  label,
  lessonHref,
  subtitle,
  subtitleSkeleton = false,
}: {
  title: string;
  label: string;
  lessonHref?: string;
  subtitle?: string;
  subtitleSkeleton?: boolean;
}) {
  const headerSubtitle =
    subtitle ?? (label.toLowerCase() !== title.toLowerCase() ? label : undefined);
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        {subtitleSkeleton ? (
          <Skeleton
            aria-hidden="true"
            data-testid="lesson-subtitle-skeleton"
            className="mt-1 h-6 w-48"
          />
        ) : headerSubtitle !== undefined ? (
          <h2 className="mt-1 text-base text-muted-foreground">{headerSubtitle}</h2>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        {lessonHref ? (
          <Button asChild variant="outline" size="sm">
            <a href={lessonHref}>View full lesson</a>
          </Button>
        ) : null}
      </div>
    </header>
  );
}
