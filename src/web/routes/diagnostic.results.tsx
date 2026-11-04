import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

export const Route = createFileRoute('/diagnostic/results')({
  component: DiagnosticResultsPage,
});

interface DiagnosticResults {
  domains: Array<{
    id: string;
    title: string;
    outcome: string;
    answers: number;
    knownConcepts: string[];
    gaps: string[];
  }>;
  plan: {
    firstWeek: { title: string } | null;
    firstWeekConcepts: string[];
    firstSession: Array<{
      kind: string;
      conceptTitle?: string;
      plannedMinutes: number;
      reason: { summary: string };
    }>;
    ninetyDayPath: Array<{ week: number; title: string }>;
  };
}

function DiagnosticResultsPage() {
  const [result, setResult] = useState<DiagnosticResults | null>(null);
  useEffect(() => {
    let active = true;
    void (async () => {
      let id: string | null =
        new URLSearchParams(window.location.search).get('id') ??
        window.sessionStorage.getItem('diagnosticRunId');
      if (!id) {
        const latest = await fetch('/api/diagnostic/latest');
        if (!latest.ok) return;
        id = ((await latest.json()) as { id?: string }).id ?? null;
      }
      if (!id) return;
      const response = await fetch(`/api/diagnostic/${encodeURIComponent(id)}/results`);
      if (response.ok && active) setResult(await response.json());
    })();
    return () => {
      active = false;
    };
  }, []);
  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <div>
        <p className="text-sm text-neutral-500">Diagnostic complete</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Your starting point</h1>
      </div>
      <div className="space-y-5 rounded-xl border border-neutral-200 bg-white p-6">
        <p className="text-sm leading-6 text-neutral-700">
          Results are provisional; independent practice will refine your mastery.
        </p>
        {(result?.domains ?? []).map((domain) => (
          <article key={domain.id} className="border-t border-neutral-100 pt-4">
            <div className="flex justify-between gap-4">
              <h2 className="font-semibold">{domain.title}</h2>
              <span className="text-sm text-neutral-500">
                {domain.outcome} · {domain.answers} answers
              </span>
            </div>
            <p className="mt-2 text-sm">
              <strong>Known provisionally:</strong>{' '}
              {domain.knownConcepts.length ? domain.knownConcepts.join(', ') : 'None identified'}
            </p>
            <p className="mt-1 text-sm">
              <strong>Gaps:</strong>{' '}
              {domain.gaps.length ? domain.gaps.join(', ') : 'None identified'}
            </p>
          </article>
        ))}
      </div>
      <section className="space-y-4 rounded-xl border border-neutral-200 bg-white p-6">
        <h2 className="text-xl font-semibold">Your plan</h2>
        <div>
          <h3 className="font-medium">First week: {result?.plan.firstWeek?.title ?? 'Loading…'}</h3>
          <p className="mt-1 text-sm text-neutral-600">
            Focus: {result?.plan.firstWeekConcepts.join(', ') ?? ''}
          </p>
        </div>
        <div>
          <h3 className="font-medium">First session</h3>
          <ul className="mt-2 space-y-2 text-sm">
            {(result?.plan.firstSession ?? []).map((activity) => (
              <li key={`${activity.kind}-${activity.conceptTitle ?? activity.reason.summary}`}>
                <strong>{activity.kind.replace('_', ' ')}</strong>
                {activity.conceptTitle ? ` · ${activity.conceptTitle}` : ''} ·{' '}
                {activity.plannedMinutes} min
                <span className="block text-neutral-600">{activity.reason.summary}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="font-medium">90-day path</h3>
          <ol className="mt-2 list-inside list-decimal space-y-1 text-sm text-neutral-600">
            {(result?.plan.ninetyDayPath ?? []).map((week) => (
              <li key={week.week}>
                Week {week.week}: {week.title}
              </li>
            ))}
          </ol>
        </div>
      </section>
      <a
        href="/"
        className="inline-flex rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white"
      >
        View Today
      </a>
    </section>
  );
}
