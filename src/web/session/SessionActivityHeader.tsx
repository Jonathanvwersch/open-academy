import { ModeBadge } from '../components.js';
import { Button } from '../ui/button.js';

export function SessionActivityHeader({
  title,
  label,
  position,
  total,
  mode,
  lessonHref,
}: {
  title: string;
  label: string;
  position: number;
  total: number;
  mode: 'practice' | 'assessment' | 'review';
  lessonHref?: string;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {label} · {position} of {total} today
        </p>
      </div>
      <div className="flex items-center gap-2">
        {lessonHref ? (
          <Button asChild variant="outline" size="sm">
            <a href={lessonHref}>View lesson</a>
          </Button>
        ) : null}
        {mode !== 'practice' ? <ModeBadge mode={mode} /> : null}
      </div>
    </header>
  );
}
