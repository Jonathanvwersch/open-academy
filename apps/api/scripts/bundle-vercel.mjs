import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = resolve(apiRoot, 'dist-vercel');

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

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
