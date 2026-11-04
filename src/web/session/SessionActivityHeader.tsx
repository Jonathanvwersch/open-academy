import { ModeBadge } from '../components.js';

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
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-neutral-600">
          {label} · {position} of {total} today
        </p>
      </div>
      <div className="flex items-center gap-2">
        {lessonHref ? (
          <a
            href={lessonHref}
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100"
          >
            View lesson
          </a>
        ) : null}
        {mode !== 'practice' ? <ModeBadge mode={mode} /> : null}
      </div>
    </header>
  );
}
