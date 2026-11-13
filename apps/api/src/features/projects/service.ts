import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { serializeExercise } from '../../content/serialize.js';
import { masteryEvents, projectProgress, projectSubmissions } from '../../db/schema.js';
import { initialMastery, masteryRank } from '../../learning/types.js';
import { type FeatureRequest, type FeatureServices, serviceResult } from '../../service-context.js';

type ProjectVerifierResults = {
  tests: Array<{ id: string; passed: boolean; message: string }>;
  metrics: Record<string, number>;
};
function projectEvidenceSummary(
  project: {
    tests: Array<{ id: string }>;
    metrics: Array<{ id: string; label: string; threshold: number; direction: 'below' | 'above' }>;
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
      metric.direction === 'below' ? value < metric.threshold : value > metric.threshold;
    if (!passes) {
      failures.push(`${metric.label} (${value}) must be ${metric.direction} ${metric.threshold}.`);
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
export async function getProjects(deps: FeatureServices, _request: FeatureRequest) {
  const { content } = deps;
  const index = await content();
  return serviceResult(index.projects.map((project) => ({ id: project.id, title: project.title })));
}

export async function getProjectsById(deps: FeatureServices, request: FeatureRequest) {
  const { db, content } = deps;
  const index = await content();
  const project = index.projectsById.get(request.params.id);
  if (!project) return serviceResult({ error: 'Project not found' }, 404);
  const submissions = await db
    .select()
    .from(projectSubmissions)
    .where(
      and(
        eq(projectSubmissions.userId, request.userId),
        eq(projectSubmissions.projectId, project.id),
      ),
    )
    .orderBy(desc(projectSubmissions.createdAt))
    .limit(1);
  const progress = await db
    .select()
    .from(projectProgress)
    .where(
      and(eq(projectProgress.userId, request.userId), eq(projectProgress.projectId, project.id)),
    )
    .limit(1);
  const latestSubmission = submissions[0] ?? null;
  const evidence = latestSubmission
    ? projectEvidenceSummary(project, latestSubmission.results as ProjectVerifierResults).evidence
    : null;
  return serviceResult({
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
    submitted: Boolean(submissions[0]),
    latestSubmission,
    evidence,
    reflection: project.reflection
      .map((id) => {
        const exercise = index.exercisesById.get(id);
        return exercise ? serializeExercise(exercise, request.userId) : null;
      })
      .filter(Boolean),
    status: progress[0]?.status ?? 'not_started',
  });
}

export async function postProjectsByIdResults(deps: FeatureServices, request: FeatureRequest) {
  const { db, content } = deps;
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
    .safeParse(request.body);
  if (!body.success) return serviceResult({ error: 'Invalid results JSON' }, 400);
  const index = await content();
  const project = index.projectsById.get(request.params.id);
  if (!project || body.data.project !== project.id)
    return serviceResult({ error: 'Project mismatch' }, 400);
  const allowedTests = new Map(project.tests.map((test) => [test.id, test]));
  if (
    new Set(body.data.tests.map((test) => test.id)).size !== body.data.tests.length ||
    body.data.tests.some((test) => !allowedTests.has(test.id)) ||
    Object.keys(body.data.metrics).some(
      (metricId) => !project.metrics.some((metric) => metric.id === metricId),
    )
  ) {
    return serviceResult({ error: 'Unknown verifier test or metric' }, 422);
  }
  const verification = projectEvidenceSummary(project, body.data);
  const passed = body.data.tests.filter((test) => test.passed).length;
  const [submission] = await db
    .insert(projectSubmissions)
    .values({
      userId: request.userId,
      projectId: project.id,
      results: body.data,
      passed,
      total: body.data.tests.length,
      metrics: body.data.metrics,
    })
    .returning();
  await db
    .insert(projectProgress)
    .values({
      userId: request.userId,
      projectId: project.id,
      status: verification.complete ? 'completed' : 'in_progress',
      completedAt: verification.complete ? request.now() : null,
    })
    .onConflictDoUpdate({
      target: [projectProgress.userId, projectProgress.projectId],
      set: {
        status: verification.complete ? 'completed' : 'in_progress',
        completedAt: verification.complete ? request.now() : null,
      },
    });
  for (const check of body.data.tests.filter((test) => test.passed)) {
    const spec = allowedTests.get(check.id);
    if (!spec) continue;
    for (const conceptId of spec.concepts) {
      const existing = await request.repo.masteryRecord(conceptId, spec.dimension);
      const next = existing ?? initialMastery(conceptId, spec.dimension);
      if (masteryRank(next.state) < masteryRank('assisted')) {
        await request.repo.saveMastery({
          ...next,
          state: 'assisted',
          inferred: false,
          lastAssessedAt: request.now().toISOString(),
        });
        await db.insert(masteryEvents).values({
          userId: request.userId,
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
  return serviceResult(
    {
      submission,
      status: verification.complete ? 'completed' : 'in_progress',
      evidence: verification.evidence,
      reflection: project.reflection
        .map((id) => {
          const exercise = index.exercisesById.get(id);
          return exercise ? serializeExercise(exercise, request.userId) : null;
        })
        .filter(Boolean),
    },
    201,
  );
}
