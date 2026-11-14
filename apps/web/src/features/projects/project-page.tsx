import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { useState } from 'react';
import { apiFetch } from '../../api/authenticated-fetch.js';
import { Markdown } from '../../components/markdown.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { courseQueryOptions } from '../course/queries.js';
import { projectQueryOptions } from './queries.js';

const Route = getRouteApi('/projects/$projectId');
export function ProjectPage() {
  const { projectId } = Route.useParams();
  const [error, setError] = useState('');
  const [evidence, setEvidence] = useState<string | null>(null);
  const [reflection, setReflection] = useState<Array<{ id: string; prompt: string }> | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(projectQueryOptions(projectId));
  const visibleEvidence = evidence ?? data.evidence;
  const visibleReflection = reflection ?? data.reflection;

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
        status?: 'in_progress' | 'completed';
        submission?: {
          results: { tests: Array<{ id: string; passed: boolean; message: string }> };
        };
        evidence?: string;
        reflection?: Array<{ id: string; prompt: string }>;
      };
      if (!response.ok) throw new Error(result.error ?? 'Upload failed');
      if (!result.status || !result.submission) throw new Error('Upload status unavailable');
      const status = result.status;
      const submission = result.submission;
      const evidenceText = result.evidence ?? 'Results recorded';
      const reflectionQuestions = result.reflection ?? [];
      setEvidence(evidenceText);
      setReflection(reflectionQuestions);
      queryClient.setQueryData(projectQueryOptions(projectId).queryKey, (current) =>
        current
          ? {
              ...current,
              status,
              latestSubmission: { results: { tests: submission.results.tests } },
              evidence: evidenceText,
              reflection: reflectionQuestions,
            }
          : current,
      );
      queryClient.setQueryData(courseQueryOptions().queryKey, (current) =>
        current
          ? {
              ...current,
              units: current.units.map((unit) =>
                unit.project?.id === projectId
                  ? { ...unit, project: { ...unit.project, status } }
                  : unit,
              ),
            }
          : current,
      );
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Invalid results file');
    } finally {
      setUploading(false);
    }
  }

  const project = data.project;
  if (project.status === 'stub' || data.checksTotal === 0) {
    return (
      <section className="space-y-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{project.title}</h1>
          <p className="text-muted-foreground">{project.objective}</p>
        </div>
        <p className="text-sm text-muted-foreground">Coming soon</p>
      </section>
    );
  }

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
      {visibleEvidence ? (
        <Card>
          <CardHeader>
            <CardTitle>Project evidence</CardTitle>
          </CardHeader>
          <CardContent>
            <p>{visibleEvidence}</p>
            <h3 className="mt-4 font-medium">Reflection questions</h3>
            <div className="mt-3 space-y-4">
              {visibleReflection.map((exercise) => (
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
