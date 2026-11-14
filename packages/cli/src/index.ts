#!/usr/bin/env -S tsx
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ContentValidationError, loadContent } from '@academy/api/content';
import { isMap, isSeq, parse, parseDocument, stringify } from 'yaml';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(cliRoot, '../..');
const templateRoot = join(cliRoot, 'template');
const options = {
  help: { type: 'boolean', short: 'h' },
  pack: { type: 'string' },
  title: { type: 'string' },
  domain: { type: 'string' },
  requires: { type: 'string' },
  course: { type: 'string' },
  unit: { type: 'string' },
  kind: { type: 'string' },
} as const;

const helpText: Record<string, string> = {
  root: 'academy init <dir> --title <title> | check [dir] | dev [dir] | new <topic|lesson|course> ... | sources <add|list> ...',
  init: 'academy init <dir> --title <subject title>',
  check: 'academy check [dir] [--pack <dir>]',
  dev: 'academy dev [dir] [--pack <dir>]',
  'new topic':
    'academy new topic <id> --title <title> [--domain <id>] [--requires a,b] [--course <id> --unit <n>] [--pack <dir>]',
  'new lesson': 'academy new lesson <topic-id> [--pack <dir>]',
  'new course': 'academy new course <id> --title <title> [--pack <dir>]',
  'sources add': 'academy sources add <file> [--title <title>] [--kind <kind>] [--pack <dir>]',
  'sources list': 'academy sources list [--pack <dir>]',
};

function showHelp(command = 'root') {
  console.log(helpText[command] ?? helpText.root);
}

function parseOptions(args: string[]) {
  return parseArgs({ args, options, allowPositionals: true });
}

function invocationDirectory(): string {
  return process.env.INIT_CWD ?? process.cwd();
}

function packPath(positionals: string[], pack?: string): string {
  return resolve(
    invocationDirectory(),
    pack ?? positionals[0] ?? process.env.CONTENT_DIR ?? 'content',
  );
}

function fail(message: string): never {
  throw new Error(message);
}

function kebab(value: string, label: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) fail(`${label} must be kebab-case.`);
  return value;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'course'
  );
}

function writeYaml(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, stringify(value), 'utf8');
}

function editYaml(
  file: string,
  update: (document: ReturnType<typeof parseDocument>) => void,
): string {
  const document = parseDocument(readFileSync(file, 'utf8'));
  if (document.errors.length) fail(`Cannot parse ${file}: ${document.errors[0]?.message}`);
  update(document);
  return document.toString();
}

function fileIsNonempty(directory: string): boolean {
  return (
    existsSync(directory) &&
    (!statSync(directory).isDirectory() || readdirSync(directory).length > 0)
  );
}

function walkYaml(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? walkYaml(file) : /\.ya?ml$/i.test(entry.name) ? [file] : [];
  });
}

function conceptFileData(file: string): { domain?: unknown; concepts?: unknown } | undefined {
  const value: unknown = parse(readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as { domain?: unknown; concepts?: unknown };
}

function conceptFileContains(file: string, topicId: string): boolean {
  const concepts = conceptFileData(file)?.concepts;
  return (
    Array.isArray(concepts) &&
    concepts.some(
      (concept) =>
        Boolean(concept) &&
        typeof concept === 'object' &&
        !Array.isArray(concept) &&
        'id' in concept &&
        concept.id === topicId,
    )
  );
}

function conceptFileForTopic(directory: string, topicId: string, domain: string): string {
  const conceptDirectory = join(directory, 'concepts');
  const indexedFile = join(conceptDirectory, `${domain}.yaml`);
  if (existsSync(indexedFile) && conceptFileContains(indexedFile, topicId)) return indexedFile;
  for (const file of walkYaml(conceptDirectory)) {
    if (file !== indexedFile && conceptFileContains(file, topicId)) return file;
  }
  fail(`Could not find topic "${topicId}" in concepts/*.yaml.`);
}

function conceptFileForDomain(directory: string, domain: string): string {
  const conceptDirectory = join(directory, 'concepts');
  const indexedFile = join(conceptDirectory, `${domain}.yaml`);
  const files = existsSync(conceptDirectory) ? walkYaml(conceptDirectory) : [];
  if (files.includes(indexedFile) && conceptFileData(indexedFile)?.domain === domain) {
    return indexedFile;
  }
  for (const file of files) {
    if (file !== indexedFile && conceptFileData(file)?.domain === domain) return file;
  }
  if (existsSync(indexedFile)) {
    fail(`Concept file ${indexedFile} does not declare domain "${domain}".`);
  }
  return indexedFile;
}

function courseFileForId(directory: string, courseId: string): string {
  for (const file of walkYaml(join(directory, 'courses'))) {
    const course = parse(readFileSync(file, 'utf8')) as { id?: string };
    if (course.id === courseId) return file;
  }
  fail(`Could not find course "${courseId}" in courses/*.yaml.`);
}

function requirePack(directory: string): void {
  if (!existsSync(join(directory, 'curriculum.yaml'))) {
    fail(`No course pack at ${directory} (missing curriculum.yaml).`);
  }
}

async function loadPack(directory: string) {
  requirePack(directory);
  return loadContent(directory);
}

async function check(directory: string): Promise<number> {
  try {
    const content = await loadPack(directory);
    const issues: string[] = [];
    function scan(value: unknown, file: string, path: string) {
      if (typeof value === 'string' && /\bTODO\b/i.test(value)) {
        issues.push(`${file}: TODO field at ${path}`);
      } else if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) scan(item, file, `${path}[${index}]`);
      } else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) scan(item, file, `${path}.${key}`);
      }
    }
    for (const entry of ['curriculum.yaml', 'courses', 'concepts', 'lessons', 'exercises']) {
      const target = join(directory, entry);
      const files = existsSync(target)
        ? statSync(target).isDirectory()
          ? walkYaml(target)
          : [target]
        : [];
      for (const file of files) {
        try {
          scan(parse(readFileSync(file, 'utf8')), file.slice(directory.length + 1), '');
        } catch {
          // The content loader reports YAML syntax errors.
        }
      }
    }
    for (const issue of issues) console.error(issue);
    console.log(
      `${content.concepts.length} topics, ${content.lessons.length} lessons, ${content.exercises.length} questions, ${content.courses.length} courses`,
    );
    return issues.length ? 1 : 0;
  } catch (error) {
    if (error instanceof ContentValidationError) {
      for (const issue of error.issues) console.error(`${issue.file}: ${issue.message}`);
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    console.log('0 topics, 0 lessons, 0 questions, 0 courses');
    return 1;
  }
}

async function init(directory: string, title: string) {
  if (!title.trim()) fail('Pass a non-empty --title.');
  if (fileIsNonempty(directory)) fail(`Refusing to initialize non-empty directory: ${directory}`);
  mkdirSync(directory, { recursive: true });
  cpSync(join(templateRoot, 'AGENTS.md'), join(directory, 'AGENTS.md'));
  cpSync(join(templateRoot, '.agents'), join(directory, '.agents'), { recursive: true });
  const writeLessonDirectory = join(directory, '.agents/skills/write-lesson');
  const referenceDirectory = join(writeLessonDirectory, 'reference');
  mkdirSync(referenceDirectory, { recursive: true });
  copyFileSync(
    join(repoRoot, '.agents/skills/write-lesson/SKILL.md'),
    join(writeLessonDirectory, 'SKILL.md'),
  );
  for (const [source, target] of [
    ['content/lessons/gradient-descent.yaml', 'lesson.yaml'],
    ['content/exercises/gradient-descent.yaml', 'exercises.yaml'],
    ['docs/CONTENT_FORMAT.md', 'CONTENT_FORMAT.md'],
    ['docs/design/lesson-standard.md', 'lesson-standard.md'],
  ]) {
    copyFileSync(join(repoRoot, source), join(referenceDirectory, target));
  }
  const courseId = `${slug(title)}-basics`;
  const topicId = `${slug(title)}-first-topic`;
  writeYaml(join(directory, 'curriculum.yaml'), {
    schedule: { mon: 45, tue: 45, wed: 45, thu: 45, fri: 45, sat: 120, sun: 60 },
    domains: [{ id: 'main', title, description: `Topics in ${title}.` }],
    courses: [courseId],
    default_course: courseId,
    subject: { title },
    goals: [],
  });
  writeYaml(join(directory, 'courses', `${courseId}.yaml`), {
    id: courseId,
    title: `${title} basics`,
    description: `A first path through ${title}.`,
    units: [{ title: 'Basics', concepts: [topicId] }],
  });
  writeYaml(join(directory, 'concepts', 'main.yaml'), {
    domain: 'main',
    concepts: [
      {
        id: topicId,
        title: 'First topic',
        description: `The first topic in ${title}.`,
        difficulty: 1,
        est_minutes: 30,
        goal_weight: 0,
        dimensions: ['conceptual'],
        prereqs: [],
        related: [],
        objectives: [{ text: `Understand the basics of ${title}.`, dimension: 'conceptual' }],
        projects: [],
        sources: [],
        status: 'stub',
      },
    ],
  });
  writeYaml(join(directory, 'notation.yaml'), { terms: [], avoid: [] });
  writeYaml(join(directory, 'sources', 'index.yaml'), { sources: [] });
  writeFileSync(join(directory, 'sources', '.gitignore'), '*\n!index.yaml\n!.gitignore\n');
  writeFileSync(
    join(directory, 'README.md'),
    `This folder is a course pack for ${title}.\nRun \`academy dev\` to launch Open Academy with this pack.\nRun \`academy check\` to validate the pack.\nUse a separate database per pack, or give every topic an ID that's unique across your packs.\n`,
  );
  if ((await check(directory)) !== 0) fail('Generated course pack did not pass academy check.');
}

async function newTopic(
  id: string,
  title: string,
  values: ReturnType<typeof parseOptions>['values'],
  directory: string,
) {
  kebab(id, 'Topic id');
  if (!title.trim()) fail('Pass a non-empty --title.');
  const content = await loadPack(directory);
  if (content.conceptsById.has(id)) fail(`Topic "${id}" already exists.`);
  const domain = values.domain ?? content.curriculum?.domains[0]?.id;
  if (!domain || !content.curriculum?.domains.some((item) => item.id === domain)) {
    fail(`Unknown domain "${domain ?? ''}".`);
  }
  const prerequisites = (values.requires ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  for (const prerequisite of prerequisites) {
    kebab(prerequisite, 'Prerequisite id');
    if (!content.conceptsById.has(prerequisite)) fail(`Unknown prerequisite "${prerequisite}".`);
  }
  let courseId = values.course;
  let unit = values.unit;
  let defaultCourse: Awaited<ReturnType<typeof loadContent>>['courses'][number] | undefined;
  if (courseId || unit) {
    if (!courseId || !unit) fail('Use --course and --unit together.');
    const course = content.coursesById.get(courseId);
    const index = Number(unit) - 1;
    if (!Number.isInteger(index) || index < 0 || !course?.units[index]) {
      fail(`Unknown course unit "${courseId}" #${unit}.`);
    }
  } else {
    courseId = content.curriculum?.default_course;
    defaultCourse = courseId ? content.coursesById.get(courseId) : undefined;
    if (!courseId || !defaultCourse?.units.length) {
      fail('The curriculum must define a default course with at least one unit.');
    }
    unit = String(defaultCourse.units.length);
  }
  const conceptFile = conceptFileForDomain(directory, domain);
  const concept = {
    id,
    title,
    description: `${title}.`,
    difficulty: 1,
    est_minutes: 30,
    goal_weight: 0,
    dimensions: ['conceptual'],
    prereqs: prerequisites.map((prereq) => ({ id: prereq })),
    related: [],
    objectives: [{ text: `Understand ${title}.`, dimension: 'conceptual' }],
    projects: [],
    sources: [],
    status: 'stub',
  };
  if (existsSync(conceptFile)) {
    const source = editYaml(conceptFile, (document) => {
      const concepts = document.get('concepts', true);
      if (!isSeq(concepts)) fail(`Expected concepts sequence in ${conceptFile}.`);
      concepts.add(concept);
    });
    writeFileSync(conceptFile, source);
  } else {
    writeYaml(conceptFile, { domain, concepts: [concept] });
  }
  if (courseId && unit) {
    const courseFile = courseFileForId(directory, courseId);
    const source = editYaml(courseFile, (document) => {
      const units = document.get('units', true);
      if (!isSeq(units)) fail(`Expected units sequence in ${courseFile}.`);
      const unitNode = units.items[Number(unit) - 1];
      if (!isMap(unitNode)) fail(`Expected unit mapping in ${courseFile}.`);
      const concepts = unitNode.get('concepts', true);
      if (!isSeq(concepts)) fail(`Expected concepts sequence in unit ${unit}.`);
      concepts.add(id);
    });
    writeFileSync(courseFile, source);
  }
  if (defaultCourse) console.log(`Added ${id} to ${defaultCourse.title}, unit ${unit}.`);
}

async function newLesson(topicId: string, directory: string) {
  const content = await loadPack(directory);
  const concept = content.conceptsById.get(topicId);
  if (!concept) fail(`Unknown topic "${topicId}".`);
  if (content.lessonsByConcept.has(topicId)) fail(`Lesson for "${topicId}" already exists.`);
  if (existsSync(join(directory, 'lessons', `${topicId}.yaml`))) {
    fail(`Refusing to overwrite existing lesson file: ${topicId}.yaml`);
  }
  const usedExerciseIds = new Set(content.exercisesById.keys());
  function uniqueExerciseId(baseId: string): string {
    let id = baseId;
    for (let suffix = 2; usedExerciseIds.has(id); suffix += 1) {
      id = `${baseId}-${suffix}`;
    }
    usedExerciseIds.add(id);
    return id;
  }
  const problemIds = Array.from({ length: 5 }, (_, index) =>
    uniqueExerciseId(`${topicId}-problem-${index + 1}`),
  );
  const selfExplanationId = uniqueExerciseId(`${topicId}-self-explanation`);
  const finalId = uniqueExerciseId(`${topicId}-explain`);
  const conceptFile = conceptFileForTopic(directory, topicId, concept.domain);
  const source = editYaml(conceptFile, (document) => {
    const concepts = document.get('concepts', true);
    if (!isSeq(concepts)) fail(`Expected concepts sequence in ${conceptFile}.`);
    const item = concepts.items.find((node) => isMap(node) && node.get('id') === topicId);
    if (!isMap(item)) fail(`Could not find topic "${topicId}" in ${conceptFile}.`);
    item.set('status', 'authored');
  });
  writeYaml(join(directory, 'lessons', `${topicId}.yaml`), {
    concept: topicId,
    version: 1,
    objective: 'TODO: Write the lesson objective.',
    where_this_fits:
      'TODO: Explain how this topic connects to prior knowledge, what new idea it introduces, why that idea matters, and how the learner will use it in later lessons, exercises, projects, and real work across the rest of the course.',
    knowledge_points: [
      {
        id: `${topicId}-core-idea`,
        title: 'TODO: Name this knowledge point.',
        explain: 'TODO: Explain the idea.',
        worked: 'TODO: Write a worked example.',
        problems: [...problemIds, selfExplanationId],
      },
    ],
    final: finalId,
    summary: 'TODO: Summarize the lesson.\n\n**Next:** TODO: Name the next topic.',
  });
  const skeletonExercises = [
    ...problemIds.map((problemId, index) => ({
      id: problemId,
      dimension: 'conceptual',
      type: 'mc',
      role: index === 0 ? 'basics' : 'practice',
      difficulty: (index % 3) + 1,
      est_minutes: 2,
      prompt: 'TODO: Write a practice question.',
      hints: [],
      solution: 'TODO: Explain the answer.',
      options: [
        {
          id: 'answer',
          text: 'TODO: Correct answer.',
          correct: true,
          feedback: 'TODO: Explain why this is correct.',
        },
        {
          id: 'distractor',
          text: 'TODO: Plausible alternative.',
          correct: false,
          feedback: 'TODO: Explain why this is not the answer.',
        },
      ],
    })),
    {
      id: selfExplanationId,
      dimension: 'conceptual',
      type: 'mc',
      role: 'check',
      difficulty: 1,
      est_minutes: 2,
      lesson_only: true,
      prompt: 'TODO: Ask the learner to explain the worked example.',
      hints: [],
      solution: 'TODO: Explain the worked example.',
      options: [
        {
          id: 'answer',
          text: 'TODO: Correct explanation.',
          correct: true,
          feedback: 'TODO: Explain why this is correct.',
        },
        {
          id: 'distractor',
          text: 'TODO: Plausible alternative.',
          correct: false,
          feedback: 'TODO: Explain why this is not the answer.',
        },
      ],
    },
    {
      id: finalId,
      dimension: 'conceptual',
      type: 'explain',
      role: 'core',
      difficulty: 2,
      est_minutes: 3,
      prompt: 'TODO: Ask the learner to explain the key idea.',
      hints: [],
      solution: 'TODO: Explain what a strong answer includes.',
      rubric: [{ id: 'key-idea', criterion: 'TODO: Identify the core idea.', weight: 1 }],
      exemplar: 'TODO: Write an exemplar answer.',
    },
  ];
  const exerciseFile = join(directory, 'exercises', `${topicId}.yaml`);
  if (existsSync(exerciseFile)) {
    const exerciseSource = editYaml(exerciseFile, (document) => {
      const exercises = document.get('exercises', true);
      if (!isSeq(exercises)) fail(`Expected exercises sequence in ${exerciseFile}.`);
      for (const exercise of skeletonExercises) exercises.add(exercise);
    });
    writeFileSync(exerciseFile, exerciseSource);
  } else {
    writeYaml(exerciseFile, { concept: topicId, exercises: skeletonExercises });
  }
  writeFileSync(conceptFile, source);
  console.log('Write it with .agents/skills/write-lesson/SKILL.md, then run academy check.');
}

async function newCourse(id: string, title: string, directory: string) {
  kebab(id, 'Course id');
  if (!title.trim()) fail('Pass a non-empty --title.');
  const content = await loadPack(directory);
  if (content.coursesById.has(id)) fail(`Course "${id}" already exists.`);
  if (existsSync(join(directory, 'courses', `${id}.yaml`))) {
    fail(`Refusing to overwrite existing course file: ${id}.yaml`);
  }
  const domain = content.curriculum?.domains[0]?.id;
  if (!domain) fail('The curriculum must define a domain.');
  const placeholderId = `${id}-first-topic`;
  if (!content.conceptsById.has(placeholderId)) {
    const conceptFile = conceptFileForDomain(directory, domain);
    const concept = {
      id: placeholderId,
      title: `${title} topic`,
      description: `A placeholder topic for ${title}.`,
      difficulty: 1,
      est_minutes: 30,
      goal_weight: 0,
      dimensions: ['conceptual'],
      prereqs: [],
      related: [],
      objectives: [{ text: `Understand ${title}.`, dimension: 'conceptual' }],
      projects: [],
      sources: [],
      status: 'stub',
    };
    if (existsSync(conceptFile)) {
      const source = editYaml(conceptFile, (document) => {
        const concepts = document.get('concepts', true);
        if (!isSeq(concepts)) fail(`Expected concepts sequence in ${conceptFile}.`);
        concepts.add(concept);
      });
      writeFileSync(conceptFile, source);
    } else {
      writeYaml(conceptFile, { domain, concepts: [concept] });
    }
  }
  writeYaml(join(directory, 'courses', `${id}.yaml`), {
    id,
    title,
    description: `A course in ${title}.`,
    units: [{ title: 'Unit 1', concepts: [placeholderId] }],
  });
  const curriculumFile = join(directory, 'curriculum.yaml');
  const source = editYaml(curriculumFile, (document) => {
    const courses = document.get('courses', true);
    if (!isSeq(courses)) fail('Expected courses sequence in curriculum.yaml.');
    courses.add(id);
  });
  writeFileSync(curriculumFile, source);
}

async function addSource(
  file: string,
  title: string | undefined,
  kind: string | undefined,
  directory: string,
) {
  requirePack(directory);
  const sourceFile = resolve(invocationDirectory(), file);
  if (!existsSync(sourceFile) || !statSync(sourceFile).isFile())
    fail(`Source file not found: ${file}`);
  const filename = basename(sourceFile);
  const sourceId = basename(filename, extname(filename))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const id = kebab(sourceId, 'Source id');
  if (kind && !['pdf', 'notes', 'book', 'paper', 'slides', 'other'].includes(kind)) {
    fail(`Unknown source kind "${kind}".`);
  }
  const indexFile = join(directory, 'sources', 'index.yaml');
  mkdirSync(dirname(indexFile), { recursive: true });
  const entries = existsSync(indexFile)
    ? ((parse(readFileSync(indexFile, 'utf8')) as { sources?: Array<{ id: string }> }).sources ??
      [])
    : [];
  if (entries.some((source) => source.id === id)) fail(`Source "${id}" already exists.`);
  const target = join(directory, 'sources', filename);
  if (existsSync(target)) fail(`Source file already exists: ${target}`);
  const ignoreFile = join(directory, 'sources', '.gitignore');
  const ignoreRules = '*\n!index.yaml\n!.gitignore\n';
  const existingRules = existsSync(ignoreFile) ? readFileSync(ignoreFile, 'utf8') : '';
  if (!existingRules.includes(ignoreRules)) {
    writeFileSync(
      ignoreFile,
      `${existingRules}${existingRules.endsWith('\n') || !existingRules ? '' : '\n'}${ignoreRules}`,
    );
  }
  copyFileSync(sourceFile, target);
  const entry = {
    id,
    title: title ?? basename(filename, extname(filename)),
    file: filename,
    added: new Date().toISOString().slice(0, 10),
    ...(kind ? { kind } : {}),
  };
  if (existsSync(indexFile)) {
    const source = editYaml(indexFile, (document) => {
      const sources = document.get('sources', true);
      if (!isSeq(sources)) fail('Expected sources sequence in sources/index.yaml.');
      sources.add(entry);
    });
    writeFileSync(indexFile, source);
  } else {
    writeYaml(indexFile, { sources: [entry] });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') return showHelp();
  const command = args.shift();
  if (command === 'new' || command === 'sources') {
    const subcommand = args.shift();
    const validSubcommands = command === 'new' ? ['topic', 'lesson', 'course'] : ['add', 'list'];
    if (!subcommand || !validSubcommands.includes(subcommand)) {
      showHelp(command);
      process.exitCode = 1;
      return;
    }
    const name = `${command} ${subcommand}`;
    const parsed = parseOptions(args);
    if (parsed.values.help) return showHelp(name);
    const directory = packPath([], parsed.values.pack);
    if (command === 'new' && subcommand === 'topic') {
      const [id] = parsed.positionals;
      if (!id) return showHelp(name);
      return newTopic(id, parsed.values.title ?? '', parsed.values, directory);
    }
    if (command === 'new' && subcommand === 'lesson') {
      const [id] = parsed.positionals;
      if (!id) return showHelp(name);
      return newLesson(id, directory);
    }
    if (command === 'new' && subcommand === 'course') {
      const [id] = parsed.positionals;
      if (!id) return showHelp(name);
      return newCourse(id, parsed.values.title ?? '', directory);
    }
    if (command === 'sources' && subcommand === 'add') {
      const [file] = parsed.positionals;
      if (!file) return showHelp(name);
      return addSource(file, parsed.values.title, parsed.values.kind, directory);
    }
    if (command === 'sources' && subcommand === 'list') {
      const content = await loadPack(directory);
      for (const source of content.sourceIndex?.sources ?? []) {
        const missing = !existsSync(join(directory, 'sources', source.file));
        console.log(`${source.id}\t${source.title}${missing ? '\tmissing' : ''}`);
      }
      return;
    }
    return showHelp(name);
  }
  if (!['init', 'check', 'dev'].includes(command ?? '')) {
    showHelp();
    process.exitCode = 1;
    return;
  }
  const parsed = parseOptions(args);
  if (parsed.values.help) return showHelp(command);
  if (command === 'init') {
    return init(packPath(parsed.positionals, parsed.values.pack), parsed.values.title ?? '');
  }
  const directory = packPath(parsed.positionals, parsed.values.pack);
  if (command === 'check') {
    process.exitCode = await check(directory);
    return;
  }
  if (command === 'dev') {
    requirePack(directory);
    const child = spawn('pnpm', ['dev'], {
      cwd: repoRoot,
      env: { ...process.env, CONTENT_DIR: directory },
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
    });
    return;
  }
  showHelp();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
