import { readdir, readFile } from 'node:fs/promises';
import { join, posix, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { buildContentIndex } from './index.js';
import type { LessonInput } from './schemas.js';
import {
  ConceptSchema,
  CourseSchema,
  CurriculumSchema,
  ExerciseSchema,
  IdSchema,
  LessonSchema,
  NotationSchema,
  normalizeLesson,
  PaperSchema,
  ProjectSchema,
  SourceIndexSchema,
} from './schemas.js';
import type { ContentIndex, ContentIssue, ContentSourceData } from './types.js';
import { validateContent } from './validate.js';
import { contentWarnings } from './warnings.js';

const ConceptHeaderSchema = z
  .object({
    domain: z.unknown(),
    concepts: z.array(z.unknown()),
  })
  .strict();
const ExerciseHeaderSchema = z
  .object({
    concept: z.unknown(),
    exercises: z.array(z.unknown()),
  })
  .strict();
const supportedExerciseTypes = new Set([
  'mc',
  'numeric',
  'expression',
  'text',
  'code_read',
  'code_complete',
  'debug',
  'explain',
]);

export class ContentValidationError extends Error {
  readonly issues: ContentIssue[];

  constructor(issues: ContentIssue[]) {
    super(`Content validation failed with ${issues.length} issue${issues.length === 1 ? '' : 's'}`);
    this.name = 'ContentValidationError';
    this.issues = issues;
  }
}

export async function loadContentFromDirectory(directory: string): Promise<ContentIndex> {
  const files = await readContentFiles(directory);
  return buildContentIndex(parseContentData(files));
}

export async function loadContentUncheckedFromDirectory(directory: string): Promise<ContentIndex> {
  const files = await readContentFiles(directory);
  return buildContentIndex(parseContentData(files, { validate: false }));
}

export async function loadContentReportFromDirectory(
  directory: string,
): Promise<{ content: ContentIndex; warnings: ContentIssue[] }> {
  const files = await readContentFiles(directory);
  const data = parseContentData(files);
  const content = buildContentIndex(data);
  return { content, warnings: contentWarnings(data, content) };
}

export function parseCourses(
  files: Record<string, string>,
  { validate = true }: { validate?: boolean } = {},
): ContentIndex {
  const normalizedFiles = Object.fromEntries(
    Object.entries(files).map(([key, value]) => [
      posix.normalize(key.replaceAll('\\', '/')),
      value,
    ]),
  );
  return buildContentIndex(parseContentData(normalizedFiles, { validate }));
}

function parseContentData(
  files: Record<string, string>,
  { validate = true }: { validate?: boolean } = {},
): ContentSourceData {
  const data: ContentSourceData = {
    concepts: [],
    courses: [],
    lessons: [],
    exercises: [],
    projects: [],
    papers: [],
  };
  const issues: ContentIssue[] = [];
  const lessonInputs: Array<{ value: LessonInput; file: string }> = [];

  const curriculumRaw = readYaml(files, 'curriculum.yaml', issues);
  if (curriculumRaw !== undefined) {
    const parsed = CurriculumSchema.safeParse(curriculumRaw);
    if (parsed.success) {
      data.curriculum = { value: parsed.data, file: 'curriculum.yaml' };
    } else {
      addZodIssues(issues, 'curriculum.yaml', curriculumRaw, parsed.error);
    }
  }

  const sourceIndexRaw = readYaml(files, 'sources/index.yaml', issues);
  if (sourceIndexRaw !== undefined) {
    const parsed = SourceIndexSchema.safeParse(sourceIndexRaw);
    if (parsed.success) {
      data.sourceIndex = { value: parsed.data, file: 'sources/index.yaml' };
    } else {
      addZodIssues(issues, 'sources/index.yaml', sourceIndexRaw, parsed.error);
    }
  }

  for (const displayFile of yamlFiles(files, 'courses')) {
    const raw = readYaml(files, displayFile, issues);
    const parsed = CourseSchema.safeParse(raw);
    if (parsed.success) {
      data.courses.push({ value: parsed.data, file: displayFile });
    } else {
      addZodIssues(issues, displayFile, raw, parsed.error);
    }
  }

  for (const displayFile of yamlFiles(files, 'concepts')) {
    const raw = readYaml(files, displayFile, issues);
    const header = ConceptHeaderSchema.safeParse(raw);
    if (!header.success) {
      addZodIssues(issues, displayFile, raw, header.error);
      continue;
    }
    const domain = IdSchema.safeParse(header.data.domain);
    if (!domain.success) {
      addZodIssues(issues, displayFile, { domain: header.data.domain }, domain.error);
    }
    header.data.concepts.forEach((item, index) => {
      const parsed = ConceptSchema.safeParse(item);
      if (parsed.success) {
        data.concepts.push({
          value: parsed.data,
          domain: domain.success ? domain.data : '<unknown>',
          file: displayFile,
        });
      } else {
        addZodIssues(issues, displayFile, item, parsed.error, index, 'concepts');
      }
    });
  }

  for (const displayFile of yamlFiles(files, 'lessons')) {
    const raw = readYaml(files, displayFile, issues);
    const parsed = LessonSchema.safeParse(raw);
    if (parsed.success) {
      lessonInputs.push({ value: parsed.data, file: displayFile });
    } else {
      addZodIssues(issues, displayFile, raw, parsed.error);
    }
  }

  for (const displayFile of yamlFiles(files, 'exercises')) {
    const raw = readYaml(files, displayFile, issues);
    const header = ExerciseHeaderSchema.safeParse(raw);
    if (!header.success) {
      addZodIssues(issues, displayFile, raw, header.error);
      continue;
    }
    const concept = IdSchema.safeParse(header.data.concept);
    if (!concept.success) {
      addZodIssues(issues, displayFile, { concept: header.data.concept }, concept.error);
    }
    header.data.exercises.forEach((item, index) => {
      const rawType = isRecord(item) ? item.type : undefined;
      const itemId =
        isRecord(item) && typeof item.id === 'string' ? item.id : `exercise-${index + 1}`;
      if (typeof rawType === 'string' && !supportedExerciseTypes.has(rawType)) {
        issues.push({
          file: displayFile,
          id: itemId,
          message: `unsupported exercise type "${rawType}"`,
        });
        return;
      }
      const parsed = ExerciseSchema.safeParse(item);
      if (parsed.success) {
        data.exercises.push({
          value: parsed.data,
          concept: concept.success ? concept.data : '<unknown>',
          file: displayFile,
        });
      } else {
        addZodIssues(issues, displayFile, item, parsed.error, index, 'exercises');
      }
    });
  }

  const exercisesById = new Map(data.exercises.map(({ value }) => [value.id, value]));
  for (const lesson of lessonInputs) {
    data.lessons.push({
      value:
        'blocks' in lesson.value
          ? lesson.value
          : normalizeLesson(lesson.value, (exerciseId) => {
              const exercise = exercisesById.get(exerciseId);
              return exercise?.type === 'numeric' && 'answer_expr' in exercise;
            }),
      file: lesson.file,
    });
  }

  const notationRaw = readYaml(files, 'notation.yaml', issues);
  if (notationRaw !== undefined) {
    const parsed = NotationSchema.safeParse(notationRaw);
    if (parsed.success) {
      data.notation = { value: parsed.data, file: 'notation.yaml' };
    } else {
      addZodIssues(issues, 'notation.yaml', notationRaw, parsed.error);
    }
  } else if (data.concepts.length > 0) {
    issues.push({
      file: 'notation.yaml',
      id: '<file>',
      message: 'notation registry is required',
    });
  }

  for (const displayFile of yamlFiles(files, 'projects')) {
    const raw = readYaml(files, displayFile, issues);
    const parsed = ProjectSchema.safeParse(raw);
    if (parsed.success) {
      data.projects.push({ value: parsed.data, file: displayFile });
    } else {
      addZodIssues(issues, displayFile, raw, parsed.error);
    }
  }

  for (const displayFile of yamlFiles(files, 'papers')) {
    const raw = readYaml(files, displayFile, issues);
    const parsed = PaperSchema.safeParse(raw);
    if (parsed.success) {
      data.papers.push({ value: parsed.data, file: displayFile });
    } else {
      addZodIssues(issues, displayFile, raw, parsed.error);
    }
  }

  if (validate) {
    issues.push(...validateContent(data));
    if (issues.length > 0) {
      throw new ContentValidationError(issues);
    }
  }
  return data;
}

async function readContentFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const paths = ['curriculum.yaml', 'sources/index.yaml', 'notation.yaml'];

  for (const directory of ['courses', 'concepts', 'lessons', 'exercises', 'projects', 'papers']) {
    paths.push(
      ...(await directoryYamlFiles(join(root, directory))).map((file) =>
        toContentRelative(root, file),
      ),
    );
  }

  for (const file of paths) {
    try {
      files[file] = await readFile(join(root, ...file.split('/')), 'utf8');
    } catch (error) {
      if (!isMissingFile(error)) {
        throw new ContentValidationError([{ file, id: '<file>', message: messageOf(error) }]);
      }
    }
  }
  return files;
}

async function directoryYamlFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
      .map((entry) => join(directory, entry.name))
      .sort();
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
}

function yamlFiles(files: Record<string, string>, directory: string): string[] {
  return Object.keys(files)
    .filter((file) => posix.dirname(file) === directory && file.endsWith('.yaml'))
    .sort();
}

function readYaml(
  files: Record<string, string>,
  displayFile: string,
  issues: ContentIssue[],
): unknown | undefined {
  if (!Object.hasOwn(files, displayFile)) return undefined;
  try {
    return parseYaml(files[displayFile]);
  } catch (error) {
    issues.push({ file: displayFile, id: '<file>', message: messageOf(error) });
    return undefined;
  }
}

function addZodIssues(
  issues: ContentIssue[],
  file: string,
  raw: unknown,
  error: z.ZodError,
  arrayIndex?: number,
  arrayName?: string,
) {
  for (const issue of relevantZodIssues(error.issues)) {
    let id = findId(raw);
    if (arrayIndex !== undefined && arrayName) {
      const source = raw as Record<string, unknown> | null;
      const values = source?.[arrayName];
      const item = Array.isArray(values) ? values[arrayIndex] : raw;
      id = findId(item) ?? id;
    }
    const location = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    issues.push({ file, id: id ?? '<file>', message: `${location}${issue.message}` });
  }
}

function relevantZodIssues(issues: z.ZodIssue[]): z.ZodIssue[] {
  return issues.flatMap((issue) => {
    if (issue.code !== 'invalid_union') {
      return [issue];
    }
    const matchingBranches = issue.errors.filter(
      (branch) =>
        !branch.some(
          (nested) =>
            nested.path[0] === 'type' && nested.code === 'invalid_value' && 'values' in nested,
        ),
    );
    const selectedBranch = matchingBranches.sort((left, right) => left.length - right.length)[0];
    return selectedBranch ? relevantZodIssues(selectedBranch) : issue.errors.flat();
  });
}

function findId(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of ['id', 'concept', 'domain']) {
    if (typeof value[key] === 'string') {
      return value[key];
    }
  }
  return undefined;
}

function toContentRelative(root: string, file: string): string {
  return relative(root, file).replaceAll('\\', '/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
