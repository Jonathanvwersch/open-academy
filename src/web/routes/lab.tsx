import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { Markdown } from '../components.js';
import { projectQueryOptions } from '../queries.js';
import { RouteLoadError } from '../route-error.js';

export const Route = createFileRoute('/lab')({
  loader: ({ context }) => context.queryClient.ensureQueryData(projectQueryOptions('linreg-numpy')),
  errorComponent: () => <RouteLoadError message="Lab is unavailable." role="alert" />,
  component: LabPage,
});

function LabPage() {
  const [error, setError] = useState('');
  const [evidence, setEvidence] = useState('');
  const [reflection, setReflection] = useState<Array<{ id: string; prompt: string }>>([]);
  const { data } = useSuspenseQuery(projectQueryOptions('linreg-numpy'));
  async function upload(file?: File) {
    if (!file) return;
    try {
      const response = await fetch('/api/projects/linreg-numpy/results', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: await file.text(),
      });
      const result = (await response.json()) as {
        error?: string;
        evidence?: string;
        reflection?: Array<{ id: string; prompt: string }>;
      };
      if (!response.ok) throw new Error(result.error ?? 'Upload failed');
      setEvidence(result.evidence ?? 'Results recorded');
      setReflection(result.reflection ?? []);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Invalid results file');
    }
  }
  const project = data.project;
  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <div>
        <p className="text-sm text-neutral-500">Saturday lab</p>
        <h1 className="mt-1 text-3xl font-semibold">{project.title}</h1>
      </div>
      <div className="space-y-4 rounded-xl border border-neutral-200 bg-white p-6">
        <p>{project.objective}</p>
        <Markdown>{project.background}</Markdown>
        <h2 className="text-lg font-semibold">Milestones</h2>
        <ol className="list-decimal space-y-3 pl-5">
          {project.tasks.map((task) => (
            <li key={task.id}>
              <strong>{task.title}</strong>
              <Markdown>{task.md}</Markdown>
            </li>
          ))}
        </ol>
        <h2 className="text-lg font-semibold">Acceptance checks</h2>
        <ul className="list-disc pl-5">
          {project.acceptance.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="text-sm text-neutral-600">
          Run `python labs/linreg-numpy/verify.py` locally, then upload results.json. The server
          validates data only and never runs uploaded code.
        </p>
        <label className="block text-sm font-medium">
          Upload results.json
          <input
            className="mt-2 block text-sm"
            type="file"
            accept=".json,application/json"
            onChange={(event) => void upload(event.target.files?.[0])}
          />
        </label>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {evidence ? (
        <section className="rounded-xl border border-neutral-200 bg-white p-5">
          <h2 className="font-semibold">Project evidence</h2>
          <p>{evidence}</p>
          <h3 className="mt-4 font-medium">Reflection questions</h3>
          <div className="mt-3 space-y-4">
            {reflection.map((exercise) => (
              <div key={exercise.id}>
                <Markdown>{exercise.prompt}</Markdown>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </section>
  );
}
