import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

rmSync('dist', { recursive: true, force: true });
cpSync('src/cli/template', 'dist/cli/template', { recursive: true });

const repositoryResources = [
  '.agents/skills/write-lesson/SKILL.md',
  '.agents/skills/write-questions/SKILL.md',
  '.agents/skills/set-weights/SKILL.md',
  'content/lessons/gradient-descent.yaml',
  'content/exercises/gradient-descent.yaml',
  'docs/CONTENT_FORMAT.md',
  'docs/design/lesson-standard.md',
];

for (const file of repositoryResources) {
  const destination = join('dist/cli/template', file);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(join('../..', file), destination);
}
