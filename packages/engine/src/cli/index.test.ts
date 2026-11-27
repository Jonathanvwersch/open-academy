import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const cli = join(root, 'packages/engine/src/cli/index.ts');

vi.setConfig({ testTimeout: 60_000 });

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), 'academy-cli-'));
}

function run(args: string[], cwd = root, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync('pnpm', ['academy', ...args], { cwd, env, encoding: 'utf8' });
}

function runWithInitCwd(args: string[], initCwd: string, environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(join(root, 'node_modules/.bin/tsx'), [cli, ...args], {
    cwd: root,
    env: { ...process.env, ...environment, INIT_CWD: initCwd },
    encoding: 'utf8',
  });
}

function runFromPack(args: string[], pack: string) {
  const environment: NodeJS.ProcessEnv = { ...process.env, CONTENT_DIR: '.' };
  delete environment.INIT_CWD;
  return spawnSync('pnpm', ['--dir', root, 'academy', ...args], {
    cwd: pack,
    env: environment,
    encoding: 'utf8',
  });
}

describe('academy CLI', () => {
  it('keeps added source files private in an existing pack without ignore rules', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      expect(run(['init', pack, '--title', 'Applied Science']).status).toBe(0);
      rmSync(join(pack, 'sources/.gitignore'));
      expect(spawnSync('git', ['init', '--quiet', pack]).status).toBe(0);
      const source = join(parent, 'private-notes.txt');
      writeFileSync(source, 'Private lecture notes.');
      expect(run(['sources', 'add', source, '--pack', pack]).status).toBe(0);
      expect(
        spawnSync('git', ['check-ignore', 'sources/private-notes.txt'], { cwd: pack }).status,
      ).toBe(0);
      expect(spawnSync('git', ['check-ignore', 'sources/index.yaml'], { cwd: pack }).status).toBe(
        1,
      );
      expect(readFileSync(join(pack, 'sources/private-notes.txt'), 'utf8')).toBe(
        'Private lecture notes.',
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('prints root and per-command help', () => {
    const noArguments = run([]);
    const rootHelp = run(['--help']);
    expect(noArguments.status).toBe(0);
    expect(rootHelp.status).toBe(0);
    expect(noArguments.stdout).toBe(rootHelp.stdout);
    const helpLines = rootHelp.stdout.trim().split('\n');
    expect(helpLines[0]).toBe('Usage:');
    expect(helpLines.slice(1)).toHaveLength(11);
    expect(helpLines.slice(1).every((line) => line.startsWith('  '))).toBe(true);
    expect(rootHelp.stdout).toContain('--pack');
    expect(rootHelp.stdout).toContain('--requires');
    expect(rootHelp.stdout).toContain('--course <id> --unit <n>');
    expect(rootHelp.stdout).toContain('sources add');
    expect(rootHelp.stdout).toContain('academy prereqs <topic-id>');
    expect(run(['new', 'topic', '--help']).stdout).toContain('academy new topic');
    expect(run(['prereqs', '--help']).stdout).toContain('academy prereqs <topic-id>');
    expect(run(['sources', 'add', '--help']).stdout).toContain('academy sources add');
    expect(run(['weights', 'verify', '--help']).stdout.trim()).toBe(
      'academy weights verify <uses.yaml> [--pack <dir>]',
    );
  });

  it('runs simulations with the memory driver', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      const out = join(parent, 'simulation-output');
      cpSync(join(root, 'tests/fixtures/content'), pack, { recursive: true });
      const result = runWithInitCwd(
        [
          'simulate',
          pack,
          '--days',
          '1',
          '--profiles',
          'average,scenario-p14-fallback',
          '--courses',
          'fixture-course',
          '--out',
          out,
        ],
        parent,
      );
      expect(result.status).toBe(0);
      expect(existsSync(join(out, 'report.json'))).toBe(true);
      expect(existsSync(join(out, 'report.md'))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('prints simulate help without starting a run', () => {
    const parent = temporaryDirectory();
    const out = join(parent, 'simulation-output');
    const help =
      'academy simulate [dir] [--pack <dir>] [--days <n>] [--profiles <list|all>] [--out <dir>] [--courses <list>]';
    try {
      const shortHelp = run([
        'simulate',
        '-h',
        '--days',
        '1',
        '--profiles',
        'average',
        '--out',
        out,
      ]);
      const longHelp = run(['simulate', '--help']);
      expect(shortHelp.status).toBe(0);
      expect(longHelp.status).toBe(0);
      expect(shortHelp.stdout.trim()).toBe(help);
      expect(longHelp.stdout.trim()).toBe(help);
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('verifies encompassing weights against every eligible question and prerequisite step', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      cpSync(join(root, 'tests/fixtures/content'), pack, { recursive: true });

      const gradientLessonPath = join(pack, 'lessons/gradient-descent.yaml');
      const gradientLesson = parse(readFileSync(gradientLessonPath, 'utf8')) as {
        knowledge_points: Array<{ id: string; key_prereqs?: string[] }>;
      };
      gradientLesson.knowledge_points[0].key_prereqs = ['derivatives', 'gradients'];
      gradientLesson.knowledge_points[1].key_prereqs = ['derivatives'];
      writeFileSync(gradientLessonPath, stringify(gradientLesson));

      const gradientExercises = parse(
        readFileSync(join(pack, 'exercises/gradient-descent.yaml'), 'utf8'),
      ) as { exercises: Array<{ id: string }> };
      const review = gradientExercises.exercises.find(
        ({ id }) => id === 'gradient-descent-fixture-review',
      );
      writeFileSync(
        join(pack, 'exercises/additional-questions.yaml'),
        stringify({
          concept: 'gradient-descent',
          exercises: [
            { ...review, id: 'additional-review' },
            {
              ...review,
              id: 'additional-recall',
              role: 'recall',
              knowledge_point: gradientLesson.knowledge_points[0].id,
            },
          ],
        }),
      );

      const exerciseIds = new Map<string, string[]>();
      for (const file of readdirSync(join(pack, 'exercises'))) {
        const { concept, exercises } = parse(
          readFileSync(join(pack, 'exercises', file), 'utf8'),
        ) as { concept: string; exercises: Array<{ id: string; role: string }> };
        exerciseIds.set(concept, [
          ...(exerciseIds.get(concept) ?? []),
          ...exercises.filter(({ role }) => role !== 'recall').map(({ id }) => id),
        ]);
      }

      type Entry = {
        weight: number;
        exercises: number;
        steps: number;
        uses: Record<string, string[]>;
      };
      const uses: Record<string, Record<string, Entry>> = {};
      for (const [concept, prerequisite] of [
        ['derivatives', 'vectors'],
        ['gradients', 'derivatives'],
        ['linear-algebra', 'vectors'],
        ['linear-models', 'vectors'],
        ['loss-functions', 'linear-models'],
        ['gradient-descent', 'gradients'],
        ['gradient-descent', 'loss-functions'],
        ['gradient-descent', 'derivatives'],
      ]) {
        const ids = exerciseIds.get(concept) ?? [];
        uses[concept] ??= {};
        uses[concept][prerequisite] = {
          weight: 0,
          exercises: ids.length,
          steps: 2,
          uses: Object.fromEntries(ids.map((id) => [id, []])),
        };
      }
      const edge = uses['gradient-descent'].derivatives;
      expect(edge.exercises).toBe(26);
      edge.uses['additional-review'] = ['derivatives-fixture-1', 'derivatives-fixture-2'];
      edge.uses['dx-gradient-descent'] = ['derivatives-fixture-1', 'derivatives-fixture-2'];
      edge.weight = 0.08;

      for (const domain of ['math', 'ml']) {
        const file = join(pack, 'concepts', `${domain}.yaml`);
        const data = parse(readFileSync(file, 'utf8')) as {
          concepts: Array<{
            id: string;
            encompassings?: Array<{ id: string; weight: number }>;
          }>;
        };
        for (const concept of data.concepts) {
          concept.encompassings = Object.entries(uses[concept.id] ?? {}).map(
            ([id, { weight }]) => ({
              id,
              weight,
            }),
          );
        }
        writeFileSync(file, stringify(data));
      }

      function verify(data: typeof uses) {
        writeFileSync(join(parent, 'uses.yaml'), stringify(data));
        return runWithInitCwd(['weights', 'verify', 'uses.yaml', '--pack', 'pack'], parent);
      }

      const verified = verify(uses);
      expect(verified.status, verified.stderr).toBe(0);
      expect(verified.stdout).toContain('Verified 8 encompassing weights.');

      function expectInvalid(change: (data: typeof uses, entry: Entry) => void, message: string) {
        const data = structuredClone(uses);
        change(data, data['gradient-descent'].derivatives);
        const result = verify(data);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(message);
      }
      expectInvalid((data) => {
        delete data['gradient-descent'].derivatives;
      }, 'gradient-descent -> derivatives: missing edge in uses');
      expectInvalid((_, entry) => {
        entry.uses['additional-recall'] = [];
      }, 'unexpected exercise id "additional-recall"');
      expectInvalid((_, entry) => {
        delete entry.uses['dx-gradient-descent'];
      }, 'missing uses for dx-gradient-descent');
      expectInvalid((_, entry) => {
        entry.uses['additional-review'] = ['gradients-fixture-1'];
      }, 'unknown prerequisite step "gradients-fixture-1"');
      expectInvalid((_, entry) => {
        entry.uses['additional-review'] = ['derivatives-fixture-1', 'derivatives-fixture-1'];
      }, 'duplicate step "derivatives-fixture-1"');
      expectInvalid((_, entry) => {
        entry.steps = 1;
      }, 'expected 26 exercises and 2 steps');
      expectInvalid((_, entry) => {
        entry.weight = 0.12;
      }, 'expected weight 0.08 from uses');
      expectInvalid((_, entry) => {
        entry.uses['additional-review'] = [];
        entry.weight = 0.04;
      }, 'expected encompassing weight 0.04 in concept file');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('makes uses optional for planned topics but verifies any supplied entries', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      const initialized = run(['init', pack, '--title', 'Applied Science']);
      expect(initialized.status, initialized.stderr).toBe(0);
      const planned = run([
        'new',
        'topic',
        'second-topic',
        '--title',
        'Second topic',
        '--requires',
        'applied-science-first-topic',
        '--pack',
        pack,
      ]);
      expect(planned.status, planned.stderr).toBe(0);

      function verify(data: unknown) {
        writeFileSync(join(parent, 'uses.yaml'), stringify(data));
        return runWithInitCwd(['weights', 'verify', 'uses.yaml', '--pack', 'pack'], parent);
      }

      const prerequisite = 'applied-science-first-topic';
      const entry = { weight: 0, exercises: 0, steps: 0, uses: {} };
      const omitted = verify({});
      expect(omitted.status, omitted.stderr).toBe(0);
      expect(omitted.stdout).toContain('Verified 0 encompassing weights.');
      const supplied = { 'second-topic': { [prerequisite]: entry } };
      const missing = verify(supplied);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('missing encompassing in concept file');

      for (const [data, message] of [
        [{ 'missing-topic': { [prerequisite]: entry } }, 'Unknown concept "missing-topic"'],
        [{ 'second-topic': { 'missing-prereq': entry } }, 'unexpected edge in uses'],
        [{ [prerequisite]: { 'second-topic': entry } }, 'unexpected edge in uses'],
        [
          { 'second-topic': { [prerequisite]: { ...entry, uses: { 'missing-exercise': [] } } } },
          'unexpected exercise id "missing-exercise"',
        ],
        [
          { 'second-topic': { [prerequisite]: { ...entry, weight: 0.5 } } },
          'expected weight 0.00 from uses',
        ],
      ] as const) {
        const result = verify(data);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(message);
      }

      const file = join(pack, 'concepts/main.yaml');
      const data = parse(readFileSync(file, 'utf8')) as {
        concepts: Array<{ id: string; encompassings?: Array<{ id: string; weight: number }> }>;
      };
      const topic = data.concepts.find(({ id }) => id === 'second-topic');
      if (!topic) throw new Error('Missing planned topic');
      topic.encompassings = [{ id: prerequisite, weight: 0.5 }];
      writeFileSync(file, stringify(data));
      const mismatch = verify(supplied);
      expect(mismatch.status).toBe(1);
      expect(mismatch.stderr).toContain('expected encompassing weight 0.00 in concept file');

      topic.encompassings = [{ id: prerequisite, weight: 0 }];
      writeFileSync(file, stringify(data));
      const match = verify(supplied);
      expect(match.status, match.stderr).toBe(0);
      expect(match.stdout).toContain('Verified 1 encompassing weight.');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('prints hard prerequisite lessons first and keeps soft links untaught', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      cpSync(join(root, 'tests/fixtures/content'), pack, { recursive: true });

      const conceptFile = join(pack, 'concepts/ml.yaml');
      const conceptData = parse(readFileSync(conceptFile, 'utf8')) as {
        concepts: Array<{
          id: string;
          prereqs: Array<{ id: string; strength?: 'hard' | 'soft' }>;
        }>;
      };
      const topic = conceptData.concepts.find(({ id }) => id === 'gradient-descent');
      if (!topic) throw new Error('Missing gradient-descent fixture topic');
      topic.prereqs.push({ id: 'matrix-products', strength: 'hard' });
      writeFileSync(conceptFile, stringify(conceptData));

      const courseFile = join(pack, 'courses/fixture-course.yaml');
      const courseData = parse(readFileSync(courseFile, 'utf8')) as {
        units: Array<{ concepts: string[] }>;
      };
      const optimizationUnit = courseData.units.find(({ concepts }) =>
        concepts.includes('gradient-descent'),
      );
      if (!optimizationUnit) throw new Error('Missing optimization fixture unit');
      const matrixProductsIndex = optimizationUnit.concepts.indexOf('matrix-products');
      if (matrixProductsIndex < 0) throw new Error('Missing matrix-products fixture topic');
      optimizationUnit.concepts.splice(matrixProductsIndex, 1);
      const gradientDescentIndex = optimizationUnit.concepts.indexOf('gradient-descent');
      optimizationUnit.concepts.splice(gradientDescentIndex, 0, 'matrix-products');
      writeFileSync(courseFile, stringify(courseData));

      const supervisedLessonFile = join(pack, 'lessons/supervised-learning.yaml');
      const supervisedLesson = parse(readFileSync(supervisedLessonFile, 'utf8')) as {
        knowledge_points: Array<{ id: string; explain: string }>;
      };
      const supervisedStep = supervisedLesson.knowledge_points.find(
        ({ id }) => id === 'sl-inputs-targets',
      );
      if (!supervisedStep) throw new Error('Missing supervised-learning fixture step');
      supervisedStep.explain +=
        '\n\nA known-answer example pairs an input with its correct target.';
      writeFileSync(supervisedLessonFile, stringify(supervisedLesson));

      const notationFile = join(pack, 'notation.yaml');
      const notation = parse(readFileSync(notationFile, 'utf8')) as {
        terms: Array<{
          id: string;
          label: string;
          match: string[];
          introduced_by: string[];
        }>;
      };
      notation.terms.push(
        {
          id: 'vector-coordinate-list',
          label: 'ordered coordinate list',
          match: ['A vector is an ordered list of coordinates'],
          introduced_by: ['vectors'],
        },
        {
          id: 'known-answer-examples',
          label: 'known-answer examples',
          match: ['A known-answer example pairs an input with its correct target'],
          introduced_by: ['supervised-learning'],
        },
      );
      writeFileSync(notationFile, stringify(notation));

      const result = runFromPack(['prereqs', 'gradient-descent'], pack);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        '# What a learner starting Gradient descent (gradient-descent) has been taught',
      );
      const requiredSection = result.stdout.slice(
        result.stdout.indexOf('## Required topics'),
        result.stdout.indexOf('## Notation and ideas already taught'),
      );
      const prerequisiteOrder = [
        '### Vectors (vectors)',
        '### Derivatives (derivatives)',
        '### Linear algebra for ML (linear-algebra)',
        '### Linear models (linear-models)',
        '### Gradients (gradients)',
        '### Loss functions (loss-functions)',
        '### Matrix products (matrix-products)',
      ];
      expect(prerequisiteOrder.every((title) => requiredSection.includes(title))).toBe(true);
      expect(prerequisiteOrder.map((title) => requiredSection.indexOf(title))).toEqual(
        [...prerequisiteOrder.map((title) => requiredSection.indexOf(title))].sort(
          (left, right) => left - right,
        ),
      );
      expect(requiredSection).toContain(
        '- **Vector magnitude**: A vector is an ordered list of coordinates, and its magnitude is its length.',
      );
      expect(requiredSection).toContain('A graph node reserved for a later lesson.');
      expect(requiredSection).toContain('(no lesson yet)');
      expect(requiredSection).not.toContain('Supervised learning');
      expect(result.stdout).toContain('- ordered coordinate list (introduced by vectors)');

      const softSection = result.stdout.slice(
        result.stdout.indexOf('## Soft links'),
        result.stdout.indexOf('## Not yet taught at this point'),
      );
      expect(softSection).toContain('- Supervised learning (supervised-learning)');
      expect(result.stdout).toContain(
        '- known-answer examples (introduced by supervised-learning)',
      );

      const unknown = runFromPack(['prereqs', 'unknown-topic'], pack);
      expect(unknown.status).toBe(1);
      expect(unknown.stderr).toContain('unknown-topic');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 30_000);

  it('prints help and exits unsuccessfully for unknown commands and subcommands', () => {
    for (const args of [
      ['unknown'],
      ['new', 'unknown'],
      ['sources', 'unknown'],
      ['unknown', '--help'],
    ]) {
      const result = run(args);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('academy');
    }
  }, 15_000);

  it('initializes a template pack that passes check and refuses non-empty directories', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'my-pack');
      expect(run(['init', pack, '--title', 'Applied Science']).status).toBe(0);
      expect(readFileSync(join(pack, 'concepts/main.yaml'), 'utf8')).toContain(
        'id: applied-science-first-topic',
      );
      const notation = parse(readFileSync(join(pack, 'notation.yaml'), 'utf8')) as {
        avoid: unknown[];
        terms: { id: string; match: string[]; introduced_by: string[] }[];
      };
      expect(notation.terms.map(({ id }) => id)).toEqual([
        'real-space',
        'sum',
        'transpose',
        'matrix',
        'limit',
        'exp',
        'ln',
        'partial',
        'nabla',
        'composition',
        'argmin',
        'hadamard',
        'indicator',
      ]);
      expect(notation.terms.every(({ introduced_by }) => introduced_by.length === 0)).toBe(true);
      expect(notation.avoid).toEqual([]);
      for (const [id, pattern] of [
        ['real-space', 'ℝ'],
        ['sum', '∑'],
        ['transpose', '⊤'],
        ['partial', '∂'],
        ['nabla', '∇'],
        ['composition', '∘'],
        ['hadamard', '⊙'],
        ['indicator', '𝟙'],
      ]) {
        expect(notation.terms.find((term) => term.id === id)?.match).toContain(pattern);
      }
      expect(notation.terms.find((term) => term.id === 'sum')?.match).not.toContain('Σ');
      const result = run(['check', pack]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('1 topics, 0 lessons, 0 questions, 1 courses');
      expect(result.stdout).toContain('0 warnings');
      expect(runWithInitCwd(['check', 'my-pack'], parent).status).toBe(0);
      expect(runWithInitCwd(['check'], parent, { CONTENT_DIR: 'my-pack' }).status).toBe(0);
      const fromPack = runFromPack(['check'], pack);
      expect(fromPack.status, fromPack.stderr).toBe(0);
      expect(fromPack.stdout).toContain('1 topics, 0 lessons, 0 questions, 1 courses');
      expect(run(['check'], root, { ...process.env, CONTENT_DIR: pack }).status).toBe(0);
      const defaultPackEnvironment = { ...process.env };
      delete defaultPackEnvironment.CONTENT_DIR;
      expect(run(['check'], root, defaultPackEnvironment).status).toBe(0);
      const templateFiles = [
        '.agents/skills/plan-course/SKILL.md',
        '.agents/skills/write-from-sources/SKILL.md',
        '.agents/skills/write-lesson/SKILL.md',
        '.agents/skills/write-lesson/reference/lesson.yaml',
        '.agents/skills/write-lesson/reference/exercises.yaml',
        '.agents/skills/write-lesson/reference/CONTENT_FORMAT.md',
        '.agents/skills/write-lesson/reference/lesson-standard.md',
        '.agents/skills/write-questions/SKILL.md',
        '.agents/skills/set-weights/SKILL.md',
      ];
      const agents = readFileSync(join(pack, 'AGENTS.md'), 'utf8');
      expect(agents).toContain('npx academy check .');
      expect(agents).not.toContain('{{ACADEMY}}');
      expect(agents).toContain('.agents/skills/set-weights/SKILL.md');
      const readme = readFileSync(join(pack, 'README.md'), 'utf8');
      expect(readme).toContain('npx academy check .');
      for (const file of templateFiles) expect(existsSync(join(pack, file))).toBe(true);
      const transformedFiles = [
        '.agents/skills/write-lesson/SKILL.md',
        '.agents/skills/write-questions/SKILL.md',
        '.agents/skills/set-weights/SKILL.md',
        '.agents/skills/write-lesson/reference/CONTENT_FORMAT.md',
        '.agents/skills/write-lesson/reference/lesson-standard.md',
      ];
      for (const file of transformedFiles) {
        expect(readFileSync(join(pack, file), 'utf8')).not.toMatch(/content\/|docs\/|pnpm |apps\//);
      }
      const packWriteLesson = readFileSync(
        join(pack, '.agents/skills/write-lesson/SKILL.md'),
        'utf8',
      );
      expect(packWriteLesson).toContain('academy prereqs <concept-id>');
      expect(packWriteLesson).not.toContain('pnpm academy prereqs');
      const packWriteQuestions = readFileSync(
        join(pack, '.agents/skills/write-questions/SKILL.md'),
        'utf8',
      );
      expect(packWriteQuestions).toContain('../set-weights/SKILL.md');
      const packSetWeights = readFileSync(
        join(pack, '.agents/skills/set-weights/SKILL.md'),
        'utf8',
      );
      expect(packSetWeights).toContain('academy weights verify <uses.yaml> --pack <dir>');
      const yamlTemplateCopies = [
        ['content/lessons/gradient-descent.yaml', templateFiles[3]],
        ['content/exercises/gradient-descent.yaml', templateFiles[4]],
      ] as const;
      for (const [source, target] of yamlTemplateCopies) {
        expect(readFileSync(join(pack, target), 'utf8')).toBe(
          readFileSync(join(root, source), 'utf8'),
        );
      }
      const referenceLesson = parse(readFileSync(join(pack, templateFiles[3]), 'utf8')) as {
        knowledge_points: Array<{ tldr?: string }>;
      };
      expect(referenceLesson.knowledge_points.length).toBeGreaterThan(0);
      expect(referenceLesson.knowledge_points.every(({ tldr }) => Boolean(tldr))).toBe(true);
      expect(run(['init', pack, '--title', 'Replacement']).status).toBe(1);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 20_000);

  it('prints non-failing content warnings from academy check', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      expect(run(['init', pack, '--title', 'Applied Science']).status).toBe(0);
      for (const [id, title] of [
        ['second-topic', 'Second topic'],
        ['third-topic', 'Third topic'],
        ['fourth-topic', 'Fourth topic'],
        ['fifth-topic', 'Fifth topic'],
      ]) {
        expect(run(['new', 'topic', id, '--title', title, '--pack', pack]).status).toBe(0);
      }

      const result = run(['check', pack]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        'warning: concepts/main.yaml [fifth-topic] has no prerequisites but sits in unit 1 of Applied Science basics; is a link missing?',
      );
      expect(result.stdout).toContain('1 warning');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 30_000);

  it('prints prerequisite guidance for a draft with untaught notation', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      cpSync(join(root, 'tests/fixtures/content'), pack, { recursive: true });
      const notationFile = join(pack, 'notation.yaml');
      const notation = parse(readFileSync(notationFile, 'utf8')) as {
        terms: Array<{ id: string; label: string; match: string[]; introduced_by: string[] }>;
      };
      notation.terms.push({
        id: 'draft-only-term',
        label: 'draft-only term',
        match: ['draft-only-marker'],
        introduced_by: ['vectors'],
      });
      writeFileSync(notationFile, stringify(notation));
      const lessonFile = join(pack, 'lessons/derivatives.yaml');
      const lesson = parse(readFileSync(lessonFile, 'utf8')) as {
        knowledge_points: Array<{ explain: string }>;
      };
      const firstStep = lesson.knowledge_points[0];
      if (!firstStep) throw new Error('Missing derivatives fixture step');
      firstStep.explain += '\n\nThis draft uses draft-only-marker.';
      writeFileSync(lessonFile, stringify(lesson));

      expect(run(['check', pack]).status).not.toBe(0);
      const result = run(['prereqs', 'derivatives', '--pack', pack]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('derivatives');
      expect(result.stderr).toMatch(
        /Note: content has \d+ check errors \(run academy check\)\. Showing prerequisites anyway\./,
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('skips missing prerequisite ids in prerequisite guidance', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      cpSync(join(root, 'tests/fixtures/content'), pack, { recursive: true });
      const conceptFile = join(pack, 'concepts/math.yaml');
      const concepts = parse(readFileSync(conceptFile, 'utf8')) as {
        concepts: Array<{
          id: string;
          prereqs: Array<{ id: string; strength?: 'hard' | 'soft' }>;
        }>;
      };
      const topic = concepts.concepts.find(({ id }) => id === 'derivatives');
      if (!topic) throw new Error('Missing derivatives fixture topic');
      topic.prereqs.push({ id: 'missing-prerequisite', strength: 'hard' });
      writeFileSync(conceptFile, stringify(concepts));

      const result = run(['prereqs', 'derivatives', '--pack', pack]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('derivatives');
      expect(result.stderr).toContain('Note: content has');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('explains how to teach notation before using it in a lesson', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      cpSync(join(root, 'tests/fixtures/content'), pack, { recursive: true });

      const notationFile = join(pack, 'notation.yaml');
      const notation = parse(readFileSync(notationFile, 'utf8')) as {
        terms: {
          id: string;
          label: string;
          match: string[];
          introduced_by: string[];
        }[];
        avoid?: unknown[];
      };
      const starterNotation = parse(
        readFileSync(join(root, 'packages/engine/src/cli/template/notation.yaml'), 'utf8'),
      ) as typeof notation;
      const sumTerm = starterNotation.terms.find(({ id }) => id === 'sum');
      const nablaTerm = starterNotation.terms.find(({ id }) => id === 'nabla');
      if (!sumTerm || !nablaTerm) throw new Error('Missing starter notation terms');
      notation.terms.push(sumTerm, nablaTerm);

      const lessonFile = join(pack, 'lessons/vectors.yaml');
      const lesson = parse(readFileSync(lessonFile, 'utf8')) as {
        knowledge_points: { explain: string }[];
      };
      const firstPoint = lesson.knowledge_points[0];
      if (!firstPoint) throw new Error('Missing vector knowledge point');
      firstPoint.explain = `${firstPoint.explain}\n\nThe symbol ${String.raw`\sum`} adds values. The symbol ∇ points along the gradient.`;

      writeFileSync(notationFile, stringify(notation));
      writeFileSync(lessonFile, stringify(lesson));
      for (const directory of ['lessons', 'exercises']) {
        for (const concept of ['switching-topic', 'supervised-learning']) {
          const contentFile = join(pack, directory, `${concept}.yaml`);
          const content = readFileSync(contentFile, 'utf8');
          const sumPattern = directory === 'lessons' ? String.raw`\sum` : String.raw`\\sum`;
          writeFileSync(contentFile, content.replaceAll(sumPattern, 'sum'));
        }
      }
      const switchingLessonFile = join(pack, 'lessons/switching-topic.yaml');
      const switchingLesson = parse(readFileSync(switchingLessonFile, 'utf8')) as {
        knowledge_points: { explain: string }[];
      };
      const switchingFirstPoint = switchingLesson.knowledge_points[0];
      if (!switchingFirstPoint) throw new Error('Missing switching-topic knowledge point');
      switchingFirstPoint.explain = `${switchingFirstPoint.explain}\n\nThe lowercase sigma symbol σ appears here as prose.`;
      writeFileSync(switchingLessonFile, stringify(switchingLesson));

      const missingIntroducer = run(['check', pack]);
      expect(missingIntroducer.status).toBe(1);
      expect(missingIntroducer.stderr).toContain(
        'uses Σ summation, but no topic teaches it yet; near "',
      );
      expect(missingIntroducer.stderr).toContain(
        '. Add the topic that teaches it to introduced_by in notation.yaml',
      );
      expect(missingIntroducer.stderr).toContain(
        'uses ∇ gradient, but no topic teaches it yet; near "',
      );
      expect(missingIntroducer.stderr).not.toContain('lowercase sigma symbol σ');

      const sum = notation.terms.find(({ id }) => id === 'sum');
      if (!sum) throw new Error('Missing summation notation term');
      sum.introduced_by = ['vectors'];
      writeFileSync(notationFile, stringify(notation));
      const missingNablaIntroducer = run(['check', pack]);
      expect(missingNablaIntroducer.status).toBe(1);
      expect(missingNablaIntroducer.stderr).not.toContain(
        'uses Σ summation, but no topic teaches it yet',
      );
      expect(missingNablaIntroducer.stderr).toContain(
        'uses ∇ gradient, but no topic teaches it yet; near "',
      );
      expect(missingNablaIntroducer.stderr).not.toContain('lowercase sigma symbol σ');

      const nabla = notation.terms.find(({ id }) => id === 'nabla');
      if (!nabla) throw new Error('Missing gradient notation term');
      nabla.introduced_by = ['vectors'];
      writeFileSync(notationFile, stringify(notation));
      expect(run(['check', pack]).status).toBe(0);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('creates topics and courses while preserving YAML comments', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      expect(run(['init', pack, '--title', 'Applied Science']).status).toBe(0);
      const conceptFile = join(pack, 'concepts/main.yaml');
      writeFileSync(conceptFile, `# Keep this note\n${readFileSync(conceptFile, 'utf8')}`);
      expect(
        run([
          'new',
          'topic',
          'second-topic',
          '--title',
          'Second topic',
          '--requires',
          'applied-science-first-topic',
          '--course',
          'applied-science-basics',
          '--unit',
          '1',
          '--pack',
          pack,
        ]).status,
      ).toBe(0);
      expect(readFileSync(conceptFile, 'utf8')).toContain('# Keep this note');
      const course = parse(
        readFileSync(join(pack, 'courses/applied-science-basics.yaml'), 'utf8'),
      ) as { units: Array<{ concepts: string[] }> };
      expect(course.units[0]?.concepts).toEqual(['applied-science-first-topic', 'second-topic']);
      const concepts = parse(readFileSync(conceptFile, 'utf8')) as {
        concepts: Array<{ id: string; prereqs: Array<{ id: string }> }>;
      };
      expect(concepts.concepts.find(({ id }) => id === 'second-topic')?.prereqs).toContainEqual({
        id: 'applied-science-first-topic',
      });
      expect(
        run(['new', 'course', 'advanced-path', '--title', 'Advanced path', '--pack', pack]).status,
      ).toBe(0);
      const checked = run(['check', pack]);
      expect(checked.status).toBe(0);
      expect(checked.stdout).toContain('3 topics, 0 lessons, 0 questions, 2 courses');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('adds a topic without course options to the default course', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      expect(run(['init', pack, '--title', 'Applied Science']).status).toBe(0);
      const created = run([
        'new',
        'topic',
        'second-topic',
        '--title',
        'Second topic',
        '--pack',
        pack,
      ]);
      expect(created.status).toBe(0);
      expect(created.stdout).toContain('Added second-topic to Applied Science basics, unit 1.');
      expect(created.stdout).toContain('Removed the starter topic applied-science-first-topic.');
      const course = parse(
        readFileSync(join(pack, 'courses/applied-science-basics.yaml'), 'utf8'),
      ) as { units: Array<{ concepts: string[] }> };
      expect(course.units[0]?.concepts).toEqual(['second-topic']);
      const concepts = parse(readFileSync(join(pack, 'concepts/main.yaml'), 'utf8')) as {
        concepts: Array<{ id: string }>;
      };
      expect(concepts.concepts.map(({ id }) => id)).toEqual(['second-topic']);
      const checked = run(['check', pack]);
      expect(checked.status).toBe(0);
      expect(checked.stdout).toContain('1 topics, 0 lessons, 0 questions, 1 courses');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('removes the starter topic with explicit course and unit options', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      expect(run(['init', pack, '--title', 'Applied Science']).status).toBe(0);
      const created = run([
        'new',
        'topic',
        'second-topic',
        '--title',
        'Second topic',
        '--course',
        'applied-science-basics',
        '--unit',
        '1',
        '--pack',
        pack,
      ]);
      expect(created.status, created.stderr).toBe(0);
      expect(created.stdout.trim()).toBe('Removed the starter topic applied-science-first-topic.');
      const course = parse(
        readFileSync(join(pack, 'courses/applied-science-basics.yaml'), 'utf8'),
      ) as { units: Array<{ concepts: string[] }> };
      expect(course.units[0]?.concepts).toEqual(['second-topic']);
      const concepts = parse(readFileSync(join(pack, 'concepts/main.yaml'), 'utf8')) as {
        concepts: Array<{ id: string }>;
      };
      expect(concepts.concepts.map(({ id }) => id)).toEqual(['second-topic']);
      const checked = run(['check', pack]);
      expect(checked.status).toBe(0);
      expect(checked.stdout).toContain('1 topics, 0 lessons, 0 questions, 1 courses');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('keeps a starter topic after its lesson is created', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      expect(run(['init', pack, '--title', 'Applied Science']).status).toBe(0);
      const starterId = 'applied-science-first-topic';
      expect(run(['new', 'lesson', starterId, '--pack', pack]).status).toBe(0);
      const created = run([
        'new',
        'topic',
        'second-topic',
        '--title',
        'Second topic',
        '--course',
        'applied-science-basics',
        '--unit',
        '1',
        '--pack',
        pack,
      ]);
      expect(created.status, created.stderr).toBe(0);
      expect(created.stdout).not.toContain(`Removed the starter topic ${starterId}.`);
      expect(existsSync(join(pack, 'lessons', `${starterId}.yaml`))).toBe(true);
      expect(existsSync(join(pack, 'exercises', `${starterId}.yaml`))).toBe(true);
      const course = parse(
        readFileSync(join(pack, 'courses/applied-science-basics.yaml'), 'utf8'),
      ) as { units: Array<{ concepts: string[] }> };
      expect(course.units[0]?.concepts).toEqual([starterId, 'second-topic']);
      const concepts = parse(readFileSync(join(pack, 'concepts/main.yaml'), 'utf8')) as {
        concepts: Array<{ id: string }>;
      };
      expect(concepts.concepts.map(({ id }) => id)).toContain(starterId);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('keeps a starter topic referenced by another course unit', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      expect(run(['init', pack, '--title', 'Applied Science']).status).toBe(0);
      const starterId = 'applied-science-first-topic';
      const courseFile = join(pack, 'courses/applied-science-basics.yaml');
      const originalCourse = parse(readFileSync(courseFile, 'utf8')) as {
        id: string;
        title: string;
        description: string;
        subject: string;
      };
      writeFileSync(
        join(pack, 'courses/other-course.yaml'),
        stringify({
          ...originalCourse,
          id: 'other-course',
          title: 'Other course',
          units: [{ title: 'Basics', concepts: [starterId] }],
        }),
      );
      const curriculumFile = join(pack, 'curriculum.yaml');
      const curriculum = parse(readFileSync(curriculumFile, 'utf8')) as {
        courses: string[];
      };
      curriculum.courses.push('other-course');
      writeFileSync(curriculumFile, stringify(curriculum));

      const created = run([
        'new',
        'topic',
        'second-topic',
        '--title',
        'Second topic',
        '--course',
        'applied-science-basics',
        '--unit',
        '1',
        '--pack',
        pack,
      ]);
      expect(created.status, created.stderr).toBe(0);
      expect(created.stdout).not.toContain(`Removed the starter topic ${starterId}.`);
      const otherCourse = parse(readFileSync(join(pack, 'courses/other-course.yaml'), 'utf8')) as {
        units: Array<{ concepts: string[] }>;
      };
      expect(otherCourse.units[0]?.concepts).toContain(starterId);
      const concepts = parse(readFileSync(join(pack, 'concepts/main.yaml'), 'utf8')) as {
        concepts: Array<{ id: string }>;
      };
      expect(concepts.concepts.map(({ id }) => id)).toContain(starterId);
      expect(run(['check', pack]).status).toBe(0);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('removes an untouched placeholder created for a new course', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      expect(run(['init', pack, '--title', 'Applied Science']).status).toBe(0);
      expect(
        run(['new', 'course', 'advanced-path', '--title', 'Advanced path', '--pack', pack]).status,
      ).toBe(0);
      const created = run([
        'new',
        'topic',
        'advanced-topic',
        '--title',
        'Advanced topic',
        '--course',
        'advanced-path',
        '--unit',
        '1',
        '--pack',
        pack,
      ]);
      expect(created.status, created.stderr).toBe(0);
      expect(created.stdout.trim()).toBe('Removed the starter topic advanced-path-first-topic.');
      const course = parse(readFileSync(join(pack, 'courses/advanced-path.yaml'), 'utf8')) as {
        units: Array<{ concepts: string[] }>;
      };
      expect(course.units[0]?.concepts).toEqual(['advanced-topic']);
      const checked = run(['check', pack]);
      expect(checked.status).toBe(0);
      expect(checked.stdout).toContain('2 topics, 0 lessons, 0 questions, 2 courses');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('keeps a new-course starter after its course title is changed', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      expect(run(['init', pack, '--title', 'Applied Science']).status).toBe(0);
      expect(
        run(['new', 'course', 'advanced-path', '--title', 'Advanced path', '--pack', pack]).status,
      ).toBe(0);
      const courseFile = join(pack, 'courses/advanced-path.yaml');
      const courseData = parse(readFileSync(courseFile, 'utf8')) as {
        title: string;
        units: Array<{ concepts: string[] }>;
      };
      courseData.title = 'Renamed path';
      writeFileSync(courseFile, stringify(courseData));

      const created = run([
        'new',
        'topic',
        'advanced-topic',
        '--title',
        'Advanced topic',
        '--course',
        'advanced-path',
        '--unit',
        '1',
        '--pack',
        pack,
      ]);
      expect(created.status, created.stderr).toBe(0);
      expect(created.stdout).not.toContain('Removed the starter topic advanced-path-first-topic.');
      expect(courseData.units[0]?.concepts).toEqual(['advanced-path-first-topic']);
      const updatedCourse = parse(readFileSync(courseFile, 'utf8')) as {
        units: Array<{ concepts: string[] }>;
      };
      expect(updatedCourse.units[0]?.concepts).toEqual([
        'advanced-path-first-topic',
        'advanced-topic',
      ]);
      expect(run(['check', pack]).status).toBe(0);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('keeps a starter topic when its title has been edited', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      expect(run(['init', pack, '--title', 'Applied Science']).status).toBe(0);
      const starterId = 'applied-science-first-topic';
      const conceptsFile = join(pack, 'concepts/main.yaml');
      const conceptFile = parse(readFileSync(conceptsFile, 'utf8')) as {
        concepts: Array<{ id: string; title: string }>;
      };
      const starter = conceptFile.concepts.find(({ id }) => id === starterId);
      if (!starter) throw new Error('Missing starter topic');
      starter.title = 'Foundations';
      writeFileSync(conceptsFile, stringify(conceptFile));

      const created = run([
        'new',
        'topic',
        'second-topic',
        '--title',
        'Second topic',
        '--pack',
        pack,
      ]);
      expect(created.status, created.stderr).toBe(0);
      expect(created.stdout).not.toContain(`Removed the starter topic ${starterId}.`);
      expect(readFileSync(conceptsFile, 'utf8')).toContain('title: Foundations');
      expect(run(['check', pack]).status).toBe(0);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('keeps a starter topic owned by a differently named exercises file', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      expect(run(['init', pack, '--title', 'Applied Science']).status).toBe(0);
      const starterId = 'applied-science-first-topic';
      mkdirSync(join(pack, 'exercises'), { recursive: true });
      writeFileSync(
        join(pack, 'exercises/other-name.yaml'),
        stringify({
          concept: starterId,
          exercises: [
            {
              id: 'starter-diagnostic',
              dimension: 'conceptual',
              type: 'mc',
              role: 'diagnostic',
              difficulty: 1,
              est_minutes: 1,
              prompt: 'Choose the starter topic.',
              hints: [],
              solution: 'This exercise belongs to the starter topic.',
              options: [
                { id: 'starter', text: 'The starter topic', correct: true },
                { id: 'other', text: 'Another topic', correct: false },
              ],
            },
          ],
        }),
      );

      const created = run([
        'new',
        'topic',
        'second-topic',
        '--title',
        'Second topic',
        '--pack',
        pack,
      ]);
      expect(created.status, created.stderr).toBe(0);
      expect(created.stdout).not.toContain(`Removed the starter topic ${starterId}.`);
      const course = parse(
        readFileSync(join(pack, 'courses/applied-science-basics.yaml'), 'utf8'),
      ) as { units: Array<{ concepts: string[] }> };
      expect(course.units[0]?.concepts).toEqual([starterId, 'second-topic']);
      expect(run(['check', pack]).status).toBe(0);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('keeps a starter topic referenced by a curriculum goal when removal fails validation', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      expect(run(['init', pack, '--title', 'Applied Science']).status).toBe(0);
      const starterId = 'applied-science-first-topic';
      const curriculumFile = join(pack, 'curriculum.yaml');
      const curriculum = parse(readFileSync(curriculumFile, 'utf8')) as {
        goals: Array<{ id: string; text: string; concepts: string[] }>;
      };
      curriculum.goals = [
        { id: 'foundations', text: 'Learn the foundations.', concepts: [starterId] },
      ];
      writeFileSync(curriculumFile, stringify(curriculum));
      expect(run(['check', pack]).status).toBe(0);

      const created = run([
        'new',
        'topic',
        'second-topic',
        '--title',
        'Second topic',
        '--pack',
        pack,
      ]);
      expect(created.status, created.stderr).toBe(0);
      expect(created.stdout).not.toContain(`Removed the starter topic ${starterId}.`);
      const course = parse(
        readFileSync(join(pack, 'courses/applied-science-basics.yaml'), 'utf8'),
      ) as { units: Array<{ concepts: string[] }> };
      expect(course.units[0]?.concepts).toEqual([starterId, 'second-topic']);
      const concepts = parse(readFileSync(join(pack, 'concepts/main.yaml'), 'utf8')) as {
        concepts: Array<{ id: string }>;
      };
      expect(concepts.concepts.map(({ id }) => id)).toContain(starterId);
      expect(concepts.concepts.map(({ id }) => id)).toContain('second-topic');
      expect(run(['check', pack]).status).toBe(0);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('finds concept files by their domain header and topic ID', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'content');
      cpSync(join(root, 'content'), pack, { recursive: true });
      const topicId = 'new-post-training-topic';
      const createdTopic = run([
        'new',
        'topic',
        topicId,
        '--title',
        'New post-training topic',
        '--domain',
        'llm-post-training',
        '--pack',
        pack,
      ]);
      expect(createdTopic.status).toBe(0);
      expect(readFileSync(join(pack, 'concepts/post-training.yaml'), 'utf8')).toContain(
        `id: ${topicId}`,
      );
      expect(existsSync(join(pack, 'concepts/llm-post-training.yaml'))).toBe(false);

      const postTraining = parse(
        readFileSync(join(pack, 'concepts/post-training.yaml'), 'utf8'),
      ) as { concepts: Array<{ id: string; status: string }> };
      const stub = postTraining.concepts.find((concept) => concept.status === 'stub');
      if (!stub) throw new Error('Expected a stub topic in post-training.yaml');
      expect(run(['new', 'lesson', stub.id, '--pack', pack]).status).toBe(0);

      const checked = runWithInitCwd(['check', pack], parent);
      expect(checked.status).toBe(1);
      const issues = checked.stderr.trim().split('\n').filter(Boolean);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.every((issue) => issue.includes('TODO field at '))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 60_000);

  it('adds course placeholders to the existing domain file regardless of its filename', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      expect(run(['init', pack, '--title', 'Applied Science']).status).toBe(0);
      const renamedFile = join(pack, 'concepts/science.yaml');
      renameSync(join(pack, 'concepts/main.yaml'), renamedFile);
      const created = run([
        'new',
        'course',
        'advanced-path',
        '--title',
        'Advanced path',
        '--pack',
        pack,
      ]);
      expect(created.status).toBe(0);
      expect(readFileSync(renamedFile, 'utf8')).toContain('advanced-path-first-topic');
      expect(existsSync(join(pack, 'concepts/main.yaml'))).toBe(false);
      expect(run(['check', pack]).status).toBe(0);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('finds renamed course files and refuses to overwrite a file owned by another course', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      expect(run(['init', pack, '--title', 'Applied Science']).status).toBe(0);
      const courseFile = join(pack, 'courses/advanced-path.yaml');
      renameSync(join(pack, 'courses/applied-science-basics.yaml'), courseFile);
      const added = run([
        'new',
        'topic',
        'second-topic',
        '--title',
        'Second topic',
        '--pack',
        pack,
      ]);
      expect(added.status).toBe(0);
      expect(readFileSync(courseFile, 'utf8')).toContain('second-topic');
      const original = readFileSync(courseFile, 'utf8');
      const conflict = run([
        'new',
        'course',
        'advanced-path',
        '--title',
        'Advanced path',
        '--pack',
        pack,
      ]);
      expect(conflict.status).toBe(1);
      expect(conflict.stderr).toContain('Refusing to overwrite');
      expect(readFileSync(courseFile, 'utf8')).toBe(original);
      expect(run(['check', pack]).status).toBe(0);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('creates a valid unit placeholder when the first domain has no concept file', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      run(['init', pack, '--title', 'Applied Science']);
      const conceptFile = join(pack, 'concepts/main.yaml');
      const conceptData = parse(readFileSync(conceptFile, 'utf8')) as {
        concepts: Array<{ id: string }>;
        domain: string;
      };
      conceptData.domain = 'other';
      const firstConcept = conceptData.concepts[0];
      if (!firstConcept) throw new Error('Missing generated concept');
      firstConcept.id = 'anchor-topic';
      renameSync(conceptFile, join(pack, 'concepts/other.yaml'));
      writeFileSync(join(pack, 'concepts/other.yaml'), stringify(conceptData));

      const curriculumFile = join(pack, 'curriculum.yaml');
      const curriculum = parse(readFileSync(curriculumFile, 'utf8')) as {
        domains: Array<{ id: string; title: string; description: string }>;
      };
      curriculum.domains.push({
        id: 'other',
        title: 'Other',
        description: 'Other topics.',
      });
      writeFileSync(curriculumFile, stringify(curriculum));

      const courseFile = join(pack, 'courses/applied-science-basics.yaml');
      const course = parse(readFileSync(courseFile, 'utf8')) as {
        units: Array<{ concepts: string[] }>;
      };
      const firstUnit = course.units[0];
      if (!firstUnit) throw new Error('Missing generated course unit');
      firstUnit.concepts = ['anchor-topic'];
      writeFileSync(courseFile, stringify(course));

      expect(
        run(['new', 'course', 'advanced-path', '--title', 'Advanced path', '--pack', pack]).status,
      ).toBe(0);
      expect(readFileSync(join(pack, 'concepts/main.yaml'), 'utf8')).toContain(
        'id: advanced-path-first-topic',
      );
      expect(run(['check', pack]).status).toBe(0);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('generates lesson and exercise skeletons with actionable TODO fields', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      run(['init', pack, '--title', 'Applied Science']);
      const topicId = 'applied-science-first-topic';
      const exerciseFile = join(pack, 'exercises', `${topicId}.yaml`);
      mkdirSync(join(pack, 'exercises'), { recursive: true });
      writeFileSync(
        exerciseFile,
        stringify({
          concept: topicId,
          exercises: [
            {
              id: `${topicId}-diagnostic`,
              dimension: 'conceptual',
              type: 'mc',
              role: 'diagnostic',
              difficulty: 1,
              est_minutes: 1,
              prompt: 'Existing diagnostic question.',
              options: [
                { id: 'a', text: 'Correct', correct: true, feedback: 'Correct.' },
                { id: 'b', text: 'Incorrect', correct: false, feedback: 'Incorrect.' },
              ],
              solution: 'The first option is correct.',
            },
          ],
        }),
      );
      const before = runWithInitCwd(['check', pack], parent);
      expect(before.status, before.stderr).toBe(0);
      const created = run(['new', 'lesson', topicId, '--pack', pack]);
      expect(created.status, created.stderr).toBe(0);
      expect(created.stdout.trim()).toBe(
        'Write it with .agents/skills/write-lesson/SKILL.md, then run academy check.',
      );
      const lessonFile = join(pack, 'lessons', `${topicId}.yaml`);
      const lessonSource = readFileSync(lessonFile, 'utf8');
      const lesson = parse(lessonSource) as {
        knowledge_points: Array<{ tldr?: string }>;
      };
      expect(lesson.knowledge_points[0]?.tldr).toContain(
        '- TODO: Write a short summary of this step.',
      );
      expect(lessonSource).toMatch(/tldr: \|\n\s+- TODO: Write a short summary of this step\./);
      const exercises = parse(readFileSync(exerciseFile, 'utf8')) as {
        exercises: Array<{ id: string; role: string; prompt: string }>;
      };
      const existingDiagnostic = exercises.exercises.filter(
        (exercise) => exercise.id === `${topicId}-diagnostic`,
      );
      expect(existingDiagnostic).toHaveLength(1);
      expect(existingDiagnostic[0]).toMatchObject({
        id: `${topicId}-diagnostic`,
        role: 'diagnostic',
        prompt: 'Existing diagnostic question.',
      });
      const checked = runWithInitCwd(['check', pack], parent);
      expect(checked.status).toBe(1);
      expect(checked.stderr).toContain('TODO field at .objective');
      expect(checked.stderr).toContain('TODO field at .knowledge_points[0].tldr');
      expect(checked.stderr).toContain('TODO field at .exercises[1].prompt');
      expect(
        checked.stderr
          .trim()
          .split('\n')
          .every((issue) => issue.includes('TODO field at ')),
      ).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('generates a loadable review pool for every dimension of a new lesson', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      const initialized = run(['init', pack, '--title', 'Applied Science']);
      expect(initialized.status, initialized.stderr).toBe(0);
      const topicId = 'applied-science-first-topic';
      const conceptFile = join(pack, 'concepts', 'main.yaml');
      const source = parse(readFileSync(conceptFile, 'utf8')) as {
        concepts: Array<{ dimensions: string[] }>;
      };
      const [concept] = source.concepts;
      if (!concept) throw new Error('Expected a starter concept');
      concept.dimensions = ['math', 'implementation'];
      writeFileSync(conceptFile, stringify(source));

      const created = run(['new', 'lesson', topicId, '--pack', pack]);
      expect(created.status, created.stderr).toBe(0);
      const checked = runWithInitCwd(['check', pack], parent);
      expect(checked.status).toBe(1);
      expect(checked.stderr).toContain('TODO field at .objective');
      expect(
        checked.stderr
          .trim()
          .split('\n')
          .every((issue) => issue.includes('TODO field at ')),
      ).toBe(true);

      const { exercises } = parse(
        readFileSync(join(pack, 'exercises', `${topicId}.yaml`), 'utf8'),
      ) as { exercises: Array<{ dimension: string; role: string }> };
      for (const dimension of concept.dimensions) {
        expect(
          exercises.filter(
            ({ dimension: questionDimension, role }) =>
              questionDimension === dimension && role === 'review',
          ),
        ).toHaveLength(5);
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('chooses a free skeleton ID when an existing exercise uses the base ID', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      run(['init', pack, '--title', 'Applied Science']);
      const topicId = 'applied-science-first-topic';
      const exerciseFile = join(pack, 'exercises', `${topicId}.yaml`);
      mkdirSync(join(pack, 'exercises'), { recursive: true });
      writeFileSync(
        exerciseFile,
        stringify({
          concept: topicId,
          exercises: [
            {
              id: `${topicId}-problem-1`,
              dimension: 'conceptual',
              type: 'mc',
              role: 'diagnostic',
              difficulty: 1,
              est_minutes: 1,
              prompt: 'Existing diagnostic question.',
              options: [
                { id: 'a', text: 'Correct', correct: true, feedback: 'Correct.' },
                { id: 'b', text: 'Incorrect', correct: false, feedback: 'Incorrect.' },
              ],
              solution: 'The first option is correct.',
            },
          ],
        }),
      );

      const before = runWithInitCwd(['check', pack], parent);
      expect(before.status, before.stderr).toBe(0);
      const created = run(['new', 'lesson', topicId, '--pack', pack]);
      expect(created.status, created.stderr).toBe(0);

      const lesson = parse(readFileSync(join(pack, 'lessons', `${topicId}.yaml`), 'utf8')) as {
        knowledge_points: Array<{ problems: string[] }>;
      };
      expect(lesson.knowledge_points[0]?.problems[0]).toBe(`${topicId}-problem-1-2`);

      const exercises = parse(readFileSync(exerciseFile, 'utf8')) as {
        exercises: Array<{ id: string; role: string; prompt: string }>;
      };
      const existingExercise = exercises.exercises.filter(
        (exercise) => exercise.id === `${topicId}-problem-1`,
      );
      expect(existingExercise).toHaveLength(1);
      expect(existingExercise[0]).toMatchObject({
        id: `${topicId}-problem-1`,
        role: 'diagnostic',
        prompt: 'Existing diagnostic question.',
      });
      expect(
        exercises.exercises.find((exercise) => exercise.id === `${topicId}-problem-1-2`),
      ).toMatchObject({
        id: `${topicId}-problem-1-2`,
        role: 'basics',
      });

      const checked = runWithInitCwd(['check', pack], parent);
      expect(checked.status).toBe(1);
      expect(checked.stderr).toContain('TODO field at .objective');
      expect(
        checked.stderr
          .trim()
          .split('\n')
          .every((issue) => issue.includes('TODO field at ')),
      ).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('adds and lists source files and marks missing indexed files', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      const source = join(parent, 'machine-learning-notes.pdf');
      run(['init', pack, '--title', 'Applied Science']);
      writeFileSync(source, 'fixture');
      expect(
        runWithInitCwd(
          [
            'sources',
            'add',
            'machine-learning-notes.pdf',
            '--title',
            'Machine learning notes',
            '--kind',
            'pdf',
            '--pack',
            'pack',
          ],
          parent,
        ).status,
      ).toBe(0);
      const sourceIndex = parse(readFileSync(join(pack, 'sources/index.yaml'), 'utf8')) as {
        sources: Array<{ added?: string }>;
      };
      expect(sourceIndex.sources[0]?.added).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(runWithInitCwd(['sources', 'list', '--pack', 'pack'], parent).stdout).toContain(
        'machine-learning-notes\tMachine learning notes',
      );
      writeFileSync(
        join(pack, 'sources/index.yaml'),
        'sources:\n  - id: missing\n    title: Missing\n    file: absent.pdf\n',
      );
      expect(runWithInitCwd(['sources', 'list', '--pack', 'pack'], parent).stdout).toContain(
        'missing\tMissing\tmissing',
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('reports broken packs and checks grounded lessons with and without citations', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'broken');
      cpSync(join(root, 'tests/fixtures/content'), pack, { recursive: true });
      const lesson = join(pack, 'lessons/derivatives.yaml');
      const original = readFileSync(lesson, 'utf8');
      const noCitation = original.replace(
        'sources: [{ source: fixture-notes, section: "Chapter 1" }]\n',
        '',
      );
      writeFileSync(lesson, noCitation);
      const invalid = run(['check', pack]);
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain('grounded curriculum requires at least one source citation');
      writeFileSync(lesson, original);
      expect(run(['check', pack]).status).toBe(0);
      writeFileSync(join(pack, 'curriculum.yaml'), 'curriculum: invalid\n');
      expect(run(['check', pack]).status).toBe(1);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('reports the missing curriculum for every command that reads a pack', () => {
    const parent = temporaryDirectory();
    try {
      const missingDirectory = join(parent, 'missing');
      const emptyDirectory = join(parent, 'without-curriculum');
      mkdirSync(emptyDirectory);
      const readers = [
        (directory: string) => ['check', directory],
        (directory: string) => ['dev', '--pack', directory],
        (directory: string) => ['new', 'topic', 'topic', '--title', 'Topic', '--pack', directory],
        (directory: string) => ['new', 'lesson', 'topic', '--pack', directory],
        (directory: string) => [
          'new',
          'course',
          'course',
          '--title',
          'Course',
          '--pack',
          directory,
        ],
        (directory: string) => ['sources', 'list', '--pack', directory],
        (directory: string) => ['sources', 'add', join(parent, 'missing.pdf'), '--pack', directory],
      ];
      for (const directory of [missingDirectory, emptyDirectory]) {
        const expected = `No course pack at ${directory} (missing curriculum.yaml).`;
        for (const args of readers) {
          const result = run(args(directory));
          expect(result.status).toBe(1);
          expect(result.stderr).toContain(expected);
        }
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 60_000);

  it('runs academy dev with the absolute pack directory in CONTENT_DIR', () => {
    const parent = temporaryDirectory();
    try {
      const pack = join(parent, 'pack');
      run(['init', pack, '--title', 'Applied Science']);
      const bin = join(parent, 'bin');
      const output = join(parent, 'content-dir');
      mkdirSync(bin);
      const fakePnpm = join(bin, 'pnpm');
      writeFileSync(fakePnpm, `#!/bin/sh\nprintf '%s' "$CONTENT_DIR" > '${output}'\n`);
      chmodSync(fakePnpm, 0o755);
      const result = spawnSync(process.execPath, ['--import', 'tsx', cli, 'dev', 'pack'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          INIT_CWD: parent,
          PATH: `${bin}:${process.env.PATH}`,
        },
      });
      expect(result.status).toBe(0);
      expect(readFileSync(output, 'utf8')).toBe(pack);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
