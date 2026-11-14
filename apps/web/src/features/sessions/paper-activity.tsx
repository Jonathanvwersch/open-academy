import { useSuspenseQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Markdown } from '../../components/markdown.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { paperStatusLabel, papersQueryOptions } from '../papers/queries.js';
import { todayQueryOptions } from './queries.js';
export function PaperActivity({
  sessionId,
  activityId,
  completed,
  tutorEnabled,
  onSkip,
}: {
  sessionId: string;
  activityId: string;
  completed: boolean;
  tutorEnabled: boolean;
  onSkip: () => Promise<void>;
}) {
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState('');
  const { data: papersData } = useSuspenseQuery(papersQueryOptions());
  const { data: today } = useSuspenseQuery(todayQueryOptions());
  const papers = papersData.units.find((unit) => unit.unit === today.unit)?.papers ?? [];
  const skip = async () => {
    setSkipping(true);
    setError('');
    try {
      await onSkip();
    } catch {
      setError('Could not skip this paper. Please try again.');
    } finally {
      setSkipping(false);
    }
  };
  if (completed) {
    return <p role="status">Paper reading complete.</p>;
  }
  return (
    <div className="space-y-4">
      <p>Pick one of this unit&apos;s papers to read.</p>
      <ul className="divide-y rounded-md border">
        {papers.map((paper) => (
          <li key={paper.id}>
            <Link
              to="/papers/$paperId"
              params={{ paperId: paper.id }}
              search={{ from: sessionId, activity: activityId }}
              className="block cursor-pointer px-4 py-3 hover:bg-muted/60"
            >
              <span className="font-medium">
                <Markdown inline>{paper.title}</Markdown>
              </span>
              <span className="mt-1 block text-sm text-muted-foreground">
                <Markdown inline>{paper.authors}</Markdown> · {paper.year} · ~{paper.est_minutes}{' '}
                min
              </span>
              <Badge
                variant="secondary"
                className={
                  paper.status === 'completed'
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                    : ''
                }
              >
                {paperStatusLabel(paper.status)}
              </Badge>
            </Link>
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="button" variant="outline" loading={skipping} onClick={() => void skip()}>
        Skip for today
      </Button>
      {!tutorEnabled ? (
        <p className="text-sm text-muted-foreground">Tutor grading is unavailable.</p>
      ) : null}
    </div>
  );
}
