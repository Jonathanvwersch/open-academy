import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { ContentValidationError, loadContentFromDirectory, parseCourses } from './load.js';

async function readPackFiles(root: string): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      (await readdir(root, { recursive: true }))
        .filter((file) => file.endsWith('.yaml'))
        .map(
          async (file) =>
            [file.replaceAll('\\', '/'), await readFile(join(root, file), 'utf8')] as const,
        ),
    ),
  );
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
