import { Button } from '../ui/button.js';

export function SessionActivityHeader({
  title,
  label,
  position,
  total,
  lessonHref,
}: {
  title: string;
  label: string;
  position: number;
  total: number;
  lessonHref?: string;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {label} · Activity {position} of {total} today
        </p>
      </div>
      <div className="flex items-center gap-2">
        {lessonHref ? (
          <Button asChild variant="outline" size="sm">
            <a href={lessonHref}>View lesson</a>
          </Button>
        ) : null}
      </div>
    </header>
  );
}
