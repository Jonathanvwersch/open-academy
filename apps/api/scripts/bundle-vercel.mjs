import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serialize } from 'node:v8';
import { build } from 'esbuild';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(apiRoot, 'dist-vercel');
const { loadContent } = await import(pathToFileURL(resolve(apiRoot, 'src/content/load.ts')).href);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

// Validate and index authored YAML at build time instead of on every function cold start.
// V8 serialization preserves the Maps and shared object references in ContentIndex.
await writeFile(resolve(outputDirectory, 'content.bin'), serialize(await loadContent()));

await build({
  entryPoints: [resolve(apiRoot, 'src/vercel.ts')],
  outfile: resolve(outputDirectory, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['pdfjs-dist'],
  banner: {
    js: "import { createRequire as __cr } from 'node:module';\nconst require = __cr(import.meta.url);",
  },
});

await cp(resolve(apiRoot, 'src/features/tutor/prompts'), resolve(outputDirectory, 'prompts'), {
  recursive: true,
});
