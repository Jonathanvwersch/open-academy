import { z } from 'zod';
import { serializeExercise } from '../course/serialize.js';
import type { EngineRequest, EngineResult } from '../engine/types.js';
import { respond } from '../engine/types.js';
import { initialMastery, masteryRank } from '../memory/types.js';

type ProjectVerifierResults = {
  tests: Array<{ id: string; passed: boolean; message: string }>;
  metrics: Record<string, number>;
};

function projectEvidenceSummary(
  project: {
    tests: Array<{ id: string }>;
    metrics: Array<{
      id: string;
      label: string;
      threshold: number;
      direction: 'below' | 'above';
      inclusive?: boolean;
    }>;
  },
  results: ProjectVerifierResults,
) {
  const reportedTests = new Map(results.tests.map((test) => [test.id, test]));
  const missingTests = project.tests.filter((test) => !reportedTests.has(test.id));
  const failures = results.tests
    .filter((test) => !test.passed)
    .map((test) => `Test ${test.id} failed: ${test.message}`);
  if (results.tests.length === 0) failures.unshift('No verifier tests were reported.');
  if (missingTests.length > 0) {
    failures.push(`Missing: ${missingTests.map((test) => test.id).join(', ')}`);
  }

  const passingMetrics = project.metrics.filter((metric) => {
    const value = results.metrics[metric.id];
    if (typeof value !== 'number') {
      failures.push(`${metric.label} was not reported.`);
      return false;
    }
    const passes =
      metric.direction === 'below'
        ? metric.inclusive
          ? value <= metric.threshold
          : value < metric.threshold
        : metric.inclusive
          ? value >= metric.threshold
          : value > metric.threshold;
    if (!passes) {
      const requirement = metric.inclusive
        ? metric.direction === 'below'
          ? 'at most'
          : 'at least'
        : metric.direction;
      failures.push(`${metric.label} (${value}) must be ${requirement} ${metric.threshold}.`);
    }
    return passes;
  });
  const passed = project.tests.filter((test) => reportedTests.get(test.id)?.passed).length;
  const allTestsPassed =
    project.tests.length > 0 &&
    results.tests.length === project.tests.length &&
    missingTests.length === 0 &&
    results.tests.every((test) => test.passed) &&
    passed === project.tests.length;
  return {
    complete: allTestsPassed && passingMetrics.length === project.metrics.length,
    evidence: `${passed}/${project.tests.length} checks passed${failures.length ? ` · ${failures.join(' ')}` : ''}`,
  };
}

export function projectsOperation(request: EngineRequest): EngineResult {
  return respond(
    request.content.projects.map((project) => ({ id: project.id, title: project.title })),
  );
}

export async function projectOperation(request: EngineRequest, id: string): Promise<EngineResult> {
  const project = request.content.projectsById.get(id);
  if (!project) return respond({ error: 'Project not found' }, 404);
  const latestSubmission =
    (await request.store.listProjectSubmissions(request.userId)).find(
      (submission) => submission.projectId === project.id,
    ) ?? null;
  const progress = (await request.store.listProjectProgress(request.userId)).find(
    (row) => row.projectId === project.id,
  );
  const evidence = latestSubmission
    ? projectEvidenceSummary(project, latestSubmission.results as ProjectVerifierResults).evidence
    : null;
  return respond({
    project: {
      id: project.id,
      title: project.title,
      objective: project.objective,
      background: project.background,
      tasks: project.tasks,
      acceptance: project.acceptance,
      reflection: project.reflection,
      status: project.status,
    },
    checksTotal: project.tests.length,
    submitted: Boolean(latestSubmission),
    latestSubmission,
    evidence,
    reflection: project.reflection
      .map((exerciseId) => {
        const exercise = request.content.exercisesById.get(exerciseId);
        return exercise ? serializeExercise(exercise, request.userId) : null;
      })
      .filter(Boolean),
    status: progress?.status ?? 'not_started',
  });
}

export async function submitProjectResults(
  request: EngineRequest,
  id: string,
  input: unknown,
): Promise<EngineResult> {
  const body = z
    .object({
      project: z.string(),
      version: z.number().int(),
      tests: z.array(
        z.object({ id: z.string(), passed: z.boolean(), message: z.string() }).strict(),
      ),
      metrics: z.record(z.string(), z.number()),
      generated_at: z.string(),
    })
    .strict()
    .safeParse(input);
  if (!body.success) return respond({ error: 'Invalid results JSON' }, 400);
  const project = request.content.projectsById.get(id);
  if (!project || body.data.project !== project.id) {
    return respond({ error: 'Project mismatch' }, 400);
  }
  const allowedTests = new Map(project.tests.map((test) => [test.id, test]));
  if (
    new Set(body.data.tests.map((test) => test.id)).size !== body.data.tests.length ||
    body.data.tests.some((test) => !allowedTests.has(test.id)) ||
    Object.keys(body.data.metrics).some(
      (metricId) => !project.metrics.some((metric) => metric.id === metricId),
    )
  ) {
    return respond({ error: 'Unknown verifier test or metric' }, 422);
  }
  const verification = projectEvidenceSummary(project, body.data);
  const passed = body.data.tests.filter((test) => test.passed).length;
  const submission = await request.store.addProjectSubmission(request.userId, {
    projectId: project.id,
    results: body.data,
    passed,
    total: body.data.tests.length,
    metrics: body.data.metrics,
    createdAt: request.now(),
  });
  await request.store.setProjectProgress(request.userId, {
    projectId: project.id,
    status: verification.complete ? 'completed' : 'in_progress',
    completedAt: verification.complete ? request.now() : null,
  });
  for (const check of body.data.tests.filter((test) => test.passed)) {
    const spec = allowedTests.get(check.id);
    if (!spec) continue;
    for (const conceptId of spec.concepts) {
      const existing = await request.store.getMastery(request.userId, conceptId, spec.dimension);
      const next = existing ?? initialMastery(conceptId, spec.dimension);
      if (masteryRank(next.state) < masteryRank('assisted')) {
        await request.store.saveMastery(request.userId, {
          ...next,
          state: 'assisted',
          inferred: false,
          lastAssessedAt: request.now().toISOString(),
        });
        await request.store.addMasteryEvent(request.userId, {
          conceptId,
          dimension: spec.dimension,
          fromState: next.state,
          toState: 'assisted',
          rule: 'lab_project_check_passed',
          attemptId: null,
          createdAt: request.now(),
        });
      }
    }
  }
  return respond(
    {
      submission,
      status: verification.complete ? 'completed' : 'in_progress',
      evidence: verification.evidence,
      reflection: project.reflection
        .map((exerciseId) => {
          const exercise = request.content.exercisesById.get(exerciseId);
          return exercise ? serializeExercise(exercise, request.userId) : null;
        })
        .filter(Boolean),
    },
    201,
  );
}
