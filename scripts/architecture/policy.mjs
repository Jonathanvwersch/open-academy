export const publicFeatureModules = {
  web: new Set([
    'features/exercises/exercise-form.tsx',
    'features/exercises/feedback-panel.tsx',
    'features/exercises/hint-ladder.tsx',
    'features/lessons/lesson-block.tsx',
    'features/lessons/lesson-runner.tsx',
    'features/quizzes/quiz-start.tsx',
    'features/sessions/session-activity-header.tsx',
    'features/sessions/start-session.ts',
    'features/progress/streak-card.tsx',
    'features/tutor/tutor-sidebar.tsx',
    'features/course/use-switch-course.ts',
    'features/course/queries.ts',
    'features/auth/queries.ts',
    'features/landing/host-routing.ts',
    'features/landing/public-paths.ts',
    'features/map/queries.ts',
    'features/reviews/queries.ts',
  ]),
  api: new Set([
    'features/course/service.ts',
    'features/papers/service.ts',
    'features/tutor/provider.ts',
    'features/tutor/schemas.ts',
    'features/tutor/feedback-context.ts',
    'features/tutor/scoring.ts',
    'features/tutor/service.ts',
  ]),
};

export const sourceLayers = {
  web: new Set(['app', 'routes', 'features', 'components', 'api', 'lib', 'hooks']),
  api: new Set(['features', 'learning', 'content', 'db', 'http']),
};

export const sourceEntries = {
  web: new Set(['main.tsx', 'routeTree.gen.ts', 'katex-contrib.d.ts', 'vite-env.d.ts']),
  api: new Set([
    'app.ts',
    'index.ts',
    'prod.ts',
    'vercel.ts',
    'config.ts',
    'paths.ts',
    'service-context.ts',
  ]),
};

// The Vercel entry point is a deployment adapter, not a second application.
export const deploymentImports = new Set(['apps/api/dist-vercel/server.mjs']);

export const browserForbiddenPackages = new Set(['@academy/aesop']);

export const sharedPackageDependencies = new Set(['zod', '@academy/shared']);

export const aesopDependencies = new Set([
  '@academy/aesop',
  '@academy/shared',
  'mathjs',
  'ts-fsrs',
  'yaml',
  'zod',
]);

export const aesopBuiltins = new Set(['node:crypto', 'node:fs/promises', 'node:path']);

export const cliDependencies = new Set(['@academy/api', '@academy/aesop', 'tsx', 'yaml']);
// Only the simulator CLI writes reports; keep filesystem access out of simulator drivers.
export const simulatorBuiltins = new Set(['node:fs/promises', 'node:path']);
