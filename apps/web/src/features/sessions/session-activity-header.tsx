import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Button } from '../../components/ui/button.js';

export interface LessonLink {
  conceptId: string;
  from: string;
}

export function SessionActivityHeader({
  title,
  label,
  lessonLink,
  subtitle,
  context,
}: {
  title: string;
  label: string;
  lessonLink?: LessonLink;
  subtitle?: string;
  context?: ReactNode;
}) {
  const headerSubtitle =
    subtitle ?? (label.toLowerCase() !== title.toLowerCase() ? label : undefined);
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        {context}
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        {headerSubtitle !== undefined ? (
          <h2 className="mt-1 text-base text-muted-foreground">{headerSubtitle}</h2>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        {lessonLink ? (
          <Button asChild variant="outline" size="sm">
            <Link
              to="/lessons/$conceptId"
              params={{ conceptId: lessonLink.conceptId }}
              search={{ from: lessonLink.from }}
            >
              View full lesson
            </Link>
          </Button>
        ) : null}
      </div>
    </header>
  );
}
