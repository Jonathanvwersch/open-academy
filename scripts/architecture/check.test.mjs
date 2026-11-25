import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkArchitecture } from './check.mjs';

function fixture(files, run) {
  const root = mkdtempSync(path.join(tmpdir(), 'academy-architecture-'));
  const defaults = {
    'package.json': JSON.stringify({ name: 'academy' }),
    'apps/web/package.json': JSON.stringify({
      name: '@academy/web',
      dependencies: { '@academy/contracts': 'workspace:*' },
    }),
    'apps/api/package.json': JSON.stringify({
      name: '@academy/api',
      dependencies: { '@academy/aesop': 'workspace:*' },
    }),
    'packages/aesop/package.json': JSON.stringify({
      name: '@academy/aesop',
      exports: {
        './course/*': './src/course/*.ts',
        './graph/*': './src/graph/*.ts',
        './memory/*': './src/memory/*.ts',
        './planner/*': './src/planner/*.ts',
        './lessons/*': './src/lessons/*.ts',
        './lessons/grading/*': './src/lessons/grading/*.ts',
        './placement/*': './src/placement/*.ts',
        './progress/*': './src/progress/*.ts',
      },
      dependencies: {
        '@academy/contracts': 'workspace:*',
        mathjs: '15.2.0',
        'ts-fsrs': '6.0.0',
        yaml: '2.9.1',
        zod: '4.6.7',
      },
    }),
    'packages/aesop/src/planner/scheduler.ts': 'export const schedule = 1;',
    'packages/contracts/package.json': JSON.stringify({
      name: '@academy/contracts',
      exports: { './lessons': './src/lessons.ts' },
    }),
    'packages/contracts/src/lessons.ts': 'export interface Lesson {id:string}',
  };
  try {
    for (const [file, source] of Object.entries({ ...defaults, ...files })) {
      const target = path.join(root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
    run(checkArchitecture(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('permits feature-owned code, query entry points, aliases, and explicit package exports', () => {
  fixture(
    {
      'apps/web/src/features/lessons/queries.ts':
        "import type {Lesson} from '@academy/contracts/lessons'; export const lesson:Lesson={id:'a'};",
      'apps/web/src/features/sessions/session-page.tsx':
        "import {lesson} from '@/features/lessons/queries.js'; export const value=lesson;",
    },
    (errors) => assert.deepEqual(errors, []),
  );
});

test('permits the API Vercel entry point and generated deployment adapter', () => {
  fixture(
    {
      'apps/api/src/vercel.ts': 'export default 1;',
      'api/index.ts': "export {default} from '../apps/api/dist-vercel/server.mjs';",
    },
    (errors) => assert.deepEqual(errors, []),
  );
});

test('permits API and CLI imports through Aesop folder exports', () => {
  fixture(
    {
      'apps/api/src/learning/scheduler.ts':
        "import {schedule} from '@academy/aesop/planner/scheduler'; export {schedule};",
      'packages/aesop/src/course/load.ts':
        "import {createHash} from 'node:crypto'; import {readFile} from 'node:fs/promises'; import {resolve} from 'node:path'; export {createHash,readFile,resolve};",
      'packages/cli/package.json': JSON.stringify({
        name: '@academy/cli',
        dependencies: { '@academy/aesop': 'workspace:*' },
      }),
      'packages/cli/src/scheduler.ts':
        "import {schedule} from '@academy/aesop/planner/scheduler'; export {schedule};",
    },
    (errors) => assert.deepEqual(errors, []),
  );
});

test('forbids browser imports of Aesop', () => {
  fixture(
    {
      'apps/web/package.json': JSON.stringify({
        name: '@academy/web',
        dependencies: {
          '@academy/aesop': 'workspace:*',
          '@academy/contracts': 'workspace:*',
        },
      }),
      'apps/web/src/features/lessons/page.ts':
        "import {schedule} from '@academy/aesop/planner/scheduler'; export {schedule};",
    },
    (errors) =>
      assert.ok(
        errors.some((error) => error.includes('apps/web cannot import @academy/aesop')),
        errors.join('\n'),
      ),
  );
});

test('forbids Aesop imports of database and application code', () => {
  fixture(
    {
      'apps/api/src/config.ts': 'export const value=1;',
      'packages/aesop/src/planner/database.ts':
        "import {sql} from 'drizzle-orm'; import {Hono} from 'hono'; export {sql,Hono};",
      'packages/aesop/src/planner/api.ts':
        "import {value} from '../../../../apps/api/src/config.js'; export {value};",
    },
    (errors) => {
      assert.ok(
        errors.some((error) => error.includes('drizzle-orm does not belong')),
        errors.join('\n'),
      );
      assert.ok(
        errors.some((error) => error.includes('hono does not belong')),
        errors.join('\n'),
      );
      assert.ok(
        errors.some((error) => error.includes('shared packages cannot depend on applications')),
        errors.join('\n'),
      );
    },
  );
});

for (const [label, source] of [
  ['type-only import', "import type {Secret} from '../../../../../apps/api/src/config.js';"],
  ['dynamic import', "export const value=import('../../../../../apps/api/src/config.js');"],
  [
    'type import expression',
    "export type Value=import('../../../../../apps/api/src/config.js').Secret;",
  ],
  ['re-export', "export {value} from '../../../../../apps/api/src/config.js';"],
]) {
  test(`rejects cross-application access through a ${label}`, () => {
    fixture(
      {
        'apps/api/src/config.ts': 'export interface Secret {value:string};export const value=1;',
        'apps/web/src/features/lessons/page.ts': source,
      },
      (errors) =>
        assert.ok(
          errors.some((error) => error.includes('web cannot import API')),
          errors.join('\n'),
        ),
    );
  });
}

test('rejects private cross-feature imports through aliases', () => {
  fixture(
    {
      'apps/web/src/features/lessons/internal.ts': 'export const value=1;',
      'apps/web/src/features/sessions/session-page.tsx':
        "export {value} from '@/features/lessons/internal.js';",
    },
    (errors) => assert.ok(errors.some((error) => error.includes('private to lessons'))),
  );
});

test('keeps shared UI below product features', () => {
  fixture(
    {
      'apps/web/src/components/button.ts': "import {value} from '../features/lessons/queries.js';",
      'apps/web/src/features/lessons/queries.ts': 'export const value=1;',
    },
    (errors) =>
      assert.ok(errors.some((error) => error.includes('shared frontend code cannot import'))),
  );
});

test('rejects private package paths and relative paths that bypass exports', () => {
  fixture(
    {
      'apps/web/src/features/lessons/page.ts':
        "import type {Lesson} from '@academy/contracts/src/lessons'; import type {Lesson as Other} from '../../../../../packages/contracts/src/lessons.js';",
    },
    (errors) => {
      assert.ok(errors.some((error) => error.includes('is private')));
      assert.ok(errors.some((error) => error.includes('explicit workspace package export')));
    },
  );
});

test('keeps contracts browser-safe and independent from applications', () => {
  fixture(
    {
      'apps/api/src/config.ts': 'export const value=1;',
      'packages/contracts/src/lessons.ts':
        "import {readFileSync} from 'node:fs'; export {value} from '../../../apps/api/src/config.js';",
    },
    (errors) => {
      assert.ok(errors.some((error) => error.includes('browser-safe code')));
      assert.ok(errors.some((error) => error.includes('shared packages cannot depend')));
    },
  );
});

test('detects dependency cycles without rejecting a diamond-shaped graph', () => {
  const files = {
    'apps/web/src/features/lessons/a.ts': "import './b.js';import './c.js';",
    'apps/web/src/features/lessons/b.ts': "import './d.js';",
    'apps/web/src/features/lessons/c.ts': "import './d.js';",
    'apps/web/src/features/lessons/d.ts': 'export const value=1;',
  };
  fixture(files, (errors) => assert.deepEqual(errors, []));
  fixture({ ...files, 'apps/web/src/features/lessons/d.ts': "import './a.js';" }, (errors) =>
    assert.ok(errors.some((error) => error.includes('dependency cycle'))),
  );
});

test('validates source placement, naming, resolution, and suppression reasons', () => {
  fixture(
    {
      'apps/web/src/MixedComponents.tsx':
        "// biome-ignore lint/suspicious/noExplicitAny\nimport './missing.js';",
    },
    (errors) => {
      for (const message of [
        'kebab-case',
        'owning feature',
        'cannot resolve',
        'suppression must include a reason',
      ])
        assert.ok(
          errors.some((error) => error.includes(message)),
          message,
        );
    },
  );
});

test('permits generated routing files and required framework names', () => {
  fixture(
    {
      'apps/web/src/routeTree.gen.ts': "// biome-ignore lint\nimport './generated.js';",
      'apps/web/src/routes/__root.tsx': 'export const Route={};',
      'apps/web/src/routes/lessons.$conceptId.tsx': 'export const Route={};',
    },
    (errors) => assert.deepEqual(errors, []),
  );
});

test('requires direct dependency declarations and transport-free services', () => {
  fixture(
    {
      'apps/api/src/features/lessons/service.ts': "import {Hono} from 'hono';",
    },
    (errors) => {
      assert.ok(errors.some((error) => error.includes('declare hono')));
      assert.ok(errors.some((error) => error.includes('keep Hono in routes')));
    },
  );
});
