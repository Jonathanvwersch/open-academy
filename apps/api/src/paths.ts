import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function findRepositoryRoot(start: string): string | undefined {
  let directory = resolve(start);
  while (true) {
    if (existsSync(join(directory, 'content', 'curriculum.yaml'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

// Serverless bundlers relocate modules; discover the included content instead of assuming source depth.
const repositoryRoot =
  findRepositoryRoot(dirname(fileURLToPath(import.meta.url))) ??
  findRepositoryRoot(process.cwd()) ??
  process.cwd();
export const repositoryPath = (...parts: string[]) => resolve(repositoryRoot, ...parts);
