import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../src/features/tutor/prompts', import.meta.url));
const target = fileURLToPath(new URL('../dist/features/tutor/prompts', import.meta.url));
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
