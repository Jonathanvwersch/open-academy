# @open-academy/engine

The engine loads a course pack into a knowledge graph. It checks prerequisites and schedules spaced repetition with FIRe credit. It runs lessons, quizzes, and placement.

## Install

```sh
npm install @open-academy/engine
```

## Course packs

Pass YAML text in a map keyed by POSIX paths relative to the pack root. See the [course pack format](https://github.com/Jonathanvwersch/open-academy/blob/main/docs/CONTENT_FORMAT.md).

`parseCourses(files)` throws `ContentValidationError` when validation fails. Use `loadContentReportFromDirectory` to load a directory pack and collect warnings.

## Use the engine

```js
import { readdir, readFile } from 'node:fs/promises';
import { parseCourses } from '@open-academy/engine/course/load';
import { createEngine } from '@open-academy/engine/engine/create-engine';
import { memoryStore } from '@open-academy/engine/store/memory-store';

const paths = (await readdir('content', { recursive: true })).filter((p) => p.endsWith('.yaml'));
const pairs = await Promise.all(
  paths.map((p) => readFile(`content/${p}`, 'utf8').then((s) => [p, s])),
);
const files = Object.fromEntries(pairs);
const content = parseCourses(files);

const engine = createEngine({ content: async () => content, store: memoryStore() });

const now = () => new Date();
const random = Math.random;

const learner = engine.learner({ id: 'learner-1', timeZone: 'UTC', now, random });
const today = await learner.today();
console.log(today.status);
```

## Store and hooks

`CourseStore` defines the persistence interface. `memoryStore()` stores learner data in memory. A host can implement `CourseStore` with PostgreSQL. The engine does not connect to a database.

`grade` can be set on `createEngine` or overridden for one learner. It receives an exercise, an answer, and `{ random }`, and returns a grade result or a promise. `hasTutorReply` is a per-learner hook. It receives the store, learner ID, and problem ID and returns a promise of a boolean.

## CLI

Install the package in a course pack, then run the CLI with `npx academy`:

```sh
npx academy init my-pack --title "Applied Science"
npx academy check my-pack
npx academy new topic vectors --title "Vectors" --pack my-pack
npx academy new lesson vectors --pack my-pack
npx academy new course maths --title "Maths" --pack my-pack
npx academy sources add notes.pdf --pack my-pack
npx academy sources list --pack my-pack
npx academy prereqs vectors --pack my-pack
npx academy weights verify uses.yaml --pack my-pack
npx academy simulate --pack my-pack --days 3
```

`academy dev my-pack` launches the Open Academy app and needs its source checkout.

## Versioning

The package uses semantic versioning. Versions before 1.0.0 may include breaking changes.
