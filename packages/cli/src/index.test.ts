import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = join(root, 'packages/cli/src/index.ts');

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

describe('academy CLI', () => {
  it('prints root and per-command help', () => {
    expect(run([]).status).toBe(0);
    expect(run(['--help']).status).toBe(0);
    expect(run(['new', 'topic', '--help']).stdout).toContain('academy new topic');
    expect(run(['sources', 'add', '--help']).stdout).toContain('academy sources add');
  });

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
      const result = run(['check', pack]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('1 topics, 0 lessons, 0 questions, 1 courses');
      expect(runWithInitCwd(['check', 'my-pack'], parent).status).toBe(0);
      expect(runWithInitCwd(['check'], parent, { CONTENT_DIR: 'my-pack' }).status).toBe(0);
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
      ];
      expect(readFileSync(join(pack, 'AGENTS.md'), 'utf8')).toBe(
        readFileSync(join(root, 'packages/cli/template/AGENTS.md'), 'utf8'),
      );
      for (const file of templateFiles) expect(existsSync(join(pack, file))).toBe(true);
      const templateCopies = [
        ['.agents/skills/write-lesson/SKILL.md', '.agents/skills/write-lesson/SKILL.md'],
        ['content/lessons/gradient-descent.yaml', templateFiles[3]],
        ['content/exercises/gradient-descent.yaml', templateFiles[4]],
        ['docs/CONTENT_FORMAT.md', templateFiles[5]],
        ['docs/design/lesson-standard.md', templateFiles[6]],
      ] as const;
      for (const [source, target] of templateCopies) {
        expect(readFileSync(join(pack, target), 'utf8')).toBe(
          readFileSync(join(root, source), 'utf8'),
        );
      }
      expect(run(['init', pack, '--title', 'Replacement']).status).toBe(1);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 20_000);

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
      const course = parse(
        readFileSync(join(pack, 'courses/applied-science-basics.yaml'), 'utf8'),
      ) as { units: Array<{ concepts: string[] }> };
      expect(course.units[0]?.concepts).toContain('second-topic');
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
      const source = join(parent, 'robotics-notes.pdf');
      run(['init', pack, '--title', 'Applied Science']);
      writeFileSync(source, 'fixture');
      expect(
        runWithInitCwd(
          [
            'sources',
            'add',
            'robotics-notes.pdf',
            '--title',
            'Robot notes',
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
        'robotics-notes\tRobot notes',
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
