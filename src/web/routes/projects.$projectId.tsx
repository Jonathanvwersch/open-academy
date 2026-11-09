import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card.js';
import { Input } from '@/ui/input.js';
import { Label } from '@/ui/label.js';
import { apiFetch } from '../authenticated-fetch.js';
import { Markdown } from '../components.js';
import { projectQueryOptions } from '../queries.js';
import { RouteLoadError } from '../route-error.js';
import { PageSkeleton } from '../skeletons.js';

export const Route = createFileRoute('/projects/$projectId')({
  pendingComponent: PageSkeleton,
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(projectQueryOptions(params.projectId)),
  errorComponent: () => <RouteLoadError message="Project unavailable." role="alert" />,
  component: ProjectPage,
});

function ProjectPage() {
  const { projectId } = Route.useParams();
  const [error, setError] = useState('');
  const [evidence, setEvidence] = useState('');
  const [reflection, setReflection] = useState<Array<{ id: string; prompt: string }>>([]);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const { data } = useSuspenseQuery(projectQueryOptions(projectId));

  async function upload(file?: File) {
    if (!file || uploading) return;
    setUploading(true);
    try {
      const response = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/results`, {
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
    } finally {
      setUploading(false);
    }
  }

  const project = data.project;
  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{project.title}</h1>
        <p className="text-muted-foreground">{project.objective}</p>
      </div>
      <Card>
        <CardContent className="space-y-4">
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
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Submit results</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="results-file">Upload results.json</Label>
            <Input
              id="results-file"
              type="file"
              accept=".json,application/json"
              disabled={uploading}
              onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
            />
          </div>
          <Button
            type="button"
            loading={uploading}
            disabled={!selectedFile}
            onClick={() => void upload(selectedFile ?? undefined)}
          >
            Upload results
          </Button>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>
      {evidence ? (
        <Card>
          <CardHeader>
            <CardTitle>Project evidence</CardTitle>
          </CardHeader>
          <CardContent>
            <p>{evidence}</p>
            <h3 className="mt-4 font-medium">Reflection questions</h3>
            <div className="mt-3 space-y-4">
              {reflection.map((exercise) => (
                <div key={exercise.id}>
                  <Markdown>{exercise.prompt}</Markdown>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}
