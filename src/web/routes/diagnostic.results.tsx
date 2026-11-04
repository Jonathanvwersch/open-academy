import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

export const Route = createFileRoute('/diagnostic/results')({
  component: DiagnosticResultsPage,
});

function DiagnosticResultsPage() {
  const [result, setResult] = useState<{
    state?: { domains?: Record<string, { status: string; answers: number }> };
  } | null>(null);
  useEffect(() => {
    const id = window.sessionStorage.getItem('diagnosticRunId');
    if (!id) return;
    void fetch(`/api/diagnostic/${id}/results`)
      .then((response) => response.json())
      .then(setResult);
  }, []);
  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <div>
        <p className="text-sm text-neutral-500">Diagnostic complete</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Your starting point</h1>
      </div>
      <div className="rounded-xl border border-neutral-200 bg-white p-6">
        <p className="text-sm leading-6 text-neutral-700">
          Your results are saved as provisional evidence. Academy will adjust as you work through
          independent practice.
        </p>
        <ul className="mt-4 space-y-2">
          {Object.entries(result?.state?.domains ?? {}).map(([domain, progress]) => (
            <li
              key={domain}
              className="flex justify-between border-t border-neutral-100 pt-2 text-sm"
            >
              <span className="capitalize">{domain}</span>
              <span className="text-neutral-500">
                {progress.status} · {progress.answers} answers
              </span>
            </li>
          ))}
        </ul>
      </div>
      <a
        href="/"
        className="inline-flex rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white"
      >
        View Today
      </a>
    </section>
  );
}
