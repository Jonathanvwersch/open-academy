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
    'features/papers/service.ts',
    'features/tutor/provider.ts',
    'features/tutor/judge-explanation.ts',
    'features/tutor/schemas.ts',
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

export const enginePublicEntries = new Set([
  '@open-academy/engine',
  '@open-academy/engine/api',
  '@open-academy/engine/node',
  '@open-academy/engine/simulator',
  '@open-academy/engine/testing',
]);
export const browserForbiddenPackages = new Set(['@open-academy/engine']);
export const browserSafeEngineImports = new Set(['@open-academy/engine/api']);

export const sharedPackageDependencies = new Set(['zod', '@academy/shared']);

// The root Academy script launches the CLI with tsx.
export const engineDependencies = new Set(['mathjs', 'ts-fsrs', 'yaml', 'zod']);

export const engineBuiltins = new Set(['node:crypto', 'node:fs/promises', 'node:path']);

export const engineBuildBuiltins = new Set(['node:fs', 'node:path']);

// The authoring CLI uses Node process and filesystem APIs; engine modules remain browser-safe.
export const cliBuiltins = new Set([
  'node:child_process',
  'node:fs',
  'node:path',
  'node:url',
  'node:util',
]);

// Only the simulator CLI writes reports; keep filesystem access out of simulator drivers.
export const simulatorBuiltins = new Set(['node:fs/promises', 'node:path', 'node:url']);
