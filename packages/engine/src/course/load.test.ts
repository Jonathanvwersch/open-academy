import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { ContentValidationError, loadContentFromDirectory, parseCourses } from './load.js';

async function readPackFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith('.yaml')) {
        files[relative(root, path).replaceAll('\\', '/')] = await readFile(path, 'utf8');
      }
    }
  }

  await visit(root);
  return files;
}

async function captureValidationError(
  run: () => unknown | Promise<unknown>,
): Promise<ContentValidationError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ContentValidationError) return error;
    throw error;
  }
  throw new Error('Expected content validation to fail');
}

it('parses the same content as the directory loader', async () => {
  const directory = resolve('tests/fixtures/content');
  expect(parseCourses(await readPackFiles(directory))).toEqual(
    await loadContentFromDirectory(directory),
  );
});

it('reports the same invalid file as the directory loader', async () => {
  const directory = resolve('tests/fixtures/content');
  const files = await readPackFiles(directory);
  files['courses/fixture-course.yaml'] = 'course: [';
  const scratch = await mkdtemp(join(tmpdir(), 'engine-content-'));

  try {
    for (const [file, source] of Object.entries(files)) {
      const path = join(scratch, ...file.split('/'));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, source);
    }

    const parseError = await captureValidationError(() => parseCourses(files));
    const directoryError = await captureValidationError(() => loadContentFromDirectory(scratch));
    expect(parseError.message).toBe(directoryError.message);
    expect(parseError.issues).toEqual(directoryError.issues);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
