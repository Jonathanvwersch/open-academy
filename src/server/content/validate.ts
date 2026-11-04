import { parse as parseExpression } from 'mathjs';
import { instantiateExercise, isTemplate } from './templates.js';
import type { ContentIssue, ContentSourceData } from './types.js';

function addIssue(issues: ContentIssue[], file: string, id: string, message: string) {
  issues.push({ file, id: id || '<file>', message });
}

function findCycles(data: ContentSourceData, issues: ContentIssue[]) {
  const concepts = new Map(data.concepts.map(({ value, file }) => [value.id, { value, file }]));
  const active = new Set<string>();
  const visited = new Set<string>();
  const reported = new Set<string>();
  const stack: string[] = [];

  function visit(id: string) {
    if (active.has(id)) {
      const cycleStart = stack.indexOf(id);
      const cycle = [...stack.slice(cycleStart), id];
      const key = [...new Set(cycle)].sort().join('|');
      if (!reported.has(key)) {
        reported.add(key);
        const entry = concepts.get(id);
        addIssue(
          issues,
          entry?.file ?? 'concepts',
          id,
          `hard prerequisite cycle: ${cycle.join(' -> ')}`,
        );
      }
      return;
    }
    if (visited.has(id)) {
      return;
    }
    const entry = concepts.get(id);
    if (!entry) {
      return;
    }
    active.add(id);
    stack.push(id);
    for (const prerequisite of entry.value.prereqs) {
      if (prerequisite.strength === 'hard' && concepts.has(prerequisite.id)) {
        visit(prerequisite.id);
      }
    }
    stack.pop();
    active.delete(id);
    visited.add(id);
  }

  for (const id of concepts.keys()) {
    visit(id);
  }
}

export function validateContent(data: ContentSourceData): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const concepts = new Map(data.concepts.map(({ value, file }) => [value.id, { value, file }]));
  const exercises = new Map<
    string,
    { concept: string; file: string; value: (typeof data.exercises)[number]['value'] }
  >();
  const projects = new Map(data.projects.map(({ value, file }) => [value.id, { value, file }]));
  const domains = new Set(data.curriculum?.value.domains.map((domain) => domain.id) ?? []);
  const seenGoals = new Set<string>();
  const seenWeeks = new Set<number>();
  const seenProjects = new Set<string>();
  const seenExercises = new Set<string>();
  const seenConcepts = new Set<string>();

  for (const { value, file } of data.concepts) {
    if (seenConcepts.has(value.id)) {
      addIssue(issues, file, value.id, 'duplicate concept id');
    }
    seenConcepts.add(value.id);
    if (domains.size > 0 && !domains.has(valueDomain(value, data))) {
      addIssue(issues, file, value.id, `unknown domain "${valueDomain(value, data)}"`);
    }
  }

  for (const { value, domain } of data.concepts) {
    for (const prerequisite of value.prereqs) {
      if (!concepts.has(prerequisite.id)) {
        addIssue(
          issues,
          data.concepts.find((entry) => entry.value.id === value.id)?.file ?? 'concepts',
          value.id,
          `missing prerequisite "${prerequisite.id}"`,
        );
      }
    }
    for (const relatedId of value.related) {
      if (!concepts.has(relatedId)) {
        addIssue(
          issues,
          data.concepts.find((entry) => entry.value.id === value.id)?.file ?? 'concepts',
          value.id,
          `unknown related concept "${relatedId}"`,
        );
      }
    }
    for (const projectId of value.projects) {
      if (!projects.has(projectId)) {
        addIssue(
          issues,
          data.concepts.find((entry) => entry.value.id === value.id)?.file ?? 'concepts',
          value.id,
          `unknown project "${projectId}"`,
        );
      }
    }
    if (domains.size > 0 && !domains.has(domain)) {
      addIssue(
        issues,
        data.concepts.find((entry) => entry.value.id === value.id)?.file ?? 'concepts',
        value.id,
        `domain "${domain}" is missing from the curriculum`,
      );
    }
  }

  for (const { value, concept, file } of data.exercises) {
    if (!concepts.has(concept)) {
      addIssue(issues, file, value.id, `unknown concept "${concept}"`);
    }
    if (seenExercises.has(value.id)) {
      addIssue(issues, file, value.id, 'duplicate exercise id');
    }
    seenExercises.add(value.id);
    exercises.set(value.id, { concept, file, value });
    if (value.type === 'mc' && !value.options.some((option) => option.correct)) {
      addIssue(
        issues,
        file,
        value.id,
        'multiple-choice exercise must have at least one correct option',
      );
    }
    if (value.type === 'debug' && !value.fix_options.some((option) => option.correct)) {
      addIssue(issues, file, value.id, 'debug exercise must have at least one correct fix option');
    }
    if (value.type === 'expression') {
      try {
        parseExpression(value.answer);
      } catch (error) {
        addIssue(issues, file, value.id, `expression answer does not parse: ${messageOf(error)}`);
      }
      for (const commonWrong of value.common_wrong ?? []) {
        try {
          parseExpression(commonWrong.answer);
        } catch (error) {
          addIssue(
            issues,
            file,
            value.id,
            `common_wrong expression does not parse: ${messageOf(error)}`,
          );
        }
      }
    }
  }

  for (const { value, file } of data.projects) {
    if (seenProjects.has(value.id)) {
      addIssue(issues, file, value.id, 'duplicate project id');
    }
    seenProjects.add(value.id);
    for (const prerequisiteId of value.prereqs) {
      if (!concepts.has(prerequisiteId)) {
        addIssue(issues, file, value.id, `unknown prerequisite concept "${prerequisiteId}"`);
      }
    }
    for (const test of value.tests) {
      for (const conceptId of test.concepts) {
        if (!concepts.has(conceptId)) {
          addIssue(
            issues,
            file,
            value.id,
            `test "${test.id}" references unknown concept "${conceptId}"`,
          );
        }
      }
    }
    for (const exerciseId of value.reflection) {
      if (!exercises.has(exerciseId)) {
        addIssue(issues, file, value.id, `reflection references unknown exercise "${exerciseId}"`);
      }
    }
  }

  const lessonsByConcept = new Map<
    string,
    { file: string; value: (typeof data.lessons)[number]['value'] }
  >();
  for (const { value, file } of data.lessons) {
    if (lessonsByConcept.has(value.concept)) {
      addIssue(issues, file, value.concept, 'duplicate lesson for concept');
    }
    lessonsByConcept.set(value.concept, { file, value });
    if (value.blocks[0]?.kind !== 'objective') {
      addIssue(issues, file, value.concept, 'lesson must start with an objective block');
    }
    if (value.blocks[value.blocks.length - 1]?.kind !== 'summary') {
      addIssue(issues, file, value.concept, 'lesson must end with a summary block');
    }
    if (!concepts.has(value.concept)) {
      addIssue(issues, file, value.concept, 'lesson references an unknown concept');
    }
    for (const block of value.blocks) {
      if (block.kind === 'check' || block.kind === 'faded') {
        const exercise = exercises.get(block.exercise);
        if (!exercise) {
          addIssue(
            issues,
            file,
            value.concept,
            `${block.kind} block references missing exercise "${block.exercise}"`,
          );
        } else if (exercise.concept !== value.concept) {
          addIssue(
            issues,
            file,
            value.concept,
            `${block.kind} block exercise "${block.exercise}" belongs to "${exercise.concept}"`,
          );
        }
      }
    }
  }

  for (const { value, file } of data.concepts) {
    if (value.status === 'authored') {
      if (!lessonsByConcept.has(value.id)) {
        addIssue(issues, file, value.id, 'authored concept is missing its lesson');
      }
      const conceptExercises = data.exercises.filter((entry) => entry.concept === value.id);
      if (conceptExercises.length < 3) {
        addIssue(
          issues,
          file,
          value.id,
          `authored concept has ${conceptExercises.length} exercises; at least 3 are required`,
        );
      }
      if (
        !conceptExercises.some(
          (entry) => entry.value.role === 'core' || entry.value.role === 'review',
        )
      ) {
        addIssue(issues, file, value.id, 'authored concept has no review-eligible exercise');
      }
    } else {
      if (lessonsByConcept.has(value.id)) {
        addIssue(
          issues,
          lessonsByConcept.get(value.id)?.file ?? 'lessons',
          value.id,
          'stub concept must not have a lesson',
        );
      }
      for (const exercise of data.exercises.filter((entry) => entry.concept === value.id)) {
        if (exercise.value.role !== 'diagnostic') {
          addIssue(
            issues,
            exercise.file,
            exercise.value.id,
            'stub concepts may only have diagnostic exercises',
          );
        }
      }
    }
  }

  const diagnostic = data.diagnostic;
  if (diagnostic) {
    const seenDiagnosticDomains = new Set<string>();
    for (const ladder of diagnostic.value.domains) {
      if (seenDiagnosticDomains.has(ladder.domain)) {
        addIssue(issues, diagnostic.file, ladder.domain, 'duplicate diagnostic domain ladder');
      }
      seenDiagnosticDomains.add(ladder.domain);
      if (ladder.start > ladder.ladder.length) {
        addIssue(
          issues,
          diagnostic.file,
          ladder.domain,
          `start index ${ladder.start} exceeds ladder length`,
        );
      }
      for (const exerciseId of ladder.ladder) {
        const exercise = exercises.get(exerciseId);
        if (!exercise) {
          addIssue(
            issues,
            diagnostic.file,
            ladder.domain,
            `diagnostic ladder references missing exercise "${exerciseId}"`,
          );
        } else {
          if (exercise.value.role !== 'diagnostic') {
            addIssue(
              issues,
              diagnostic.file,
              ladder.domain,
              `ladder item "${exerciseId}" is not diagnostic role`,
            );
          }
        }
      }
    }
  }

  if (data.curriculum) {
    const curriculum = data.curriculum.value;
    for (const goal of curriculum.goals) {
      if (seenGoals.has(goal.id)) {
        addIssue(issues, data.curriculum.file, goal.id, 'duplicate goal id');
      }
      seenGoals.add(goal.id);
      for (const conceptId of goal.concepts) {
        if (!concepts.has(conceptId)) {
          addIssue(
            issues,
            data.curriculum.file,
            goal.id,
            `references unknown concept "${conceptId}"`,
          );
        }
      }
    }
    for (const week of curriculum.weeks) {
      if (seenWeeks.has(week.week)) {
        addIssue(issues, data.curriculum.file, String(week.week), 'duplicate curriculum week');
      }
      seenWeeks.add(week.week);
      for (const conceptId of week.concepts) {
        if (!concepts.has(conceptId)) {
          addIssue(
            issues,
            data.curriculum.file,
            String(week.week),
            `references unknown concept "${conceptId}"`,
          );
        }
      }
      if (week.project && !projects.has(week.project)) {
        addIssue(
          issues,
          data.curriculum.file,
          String(week.week),
          `references unknown project "${week.project}"`,
        );
      }
    }
  }

  validateKnowledgePointContent(data, issues);
  validateNotationUsage(data, issues);
  findCycles(data, issues);
  return issues;
}

function validateKnowledgePointContent(data: ContentSourceData, issues: ContentIssue[]) {
  const exercises = new Map(data.exercises.map((entry) => [entry.value.id, entry]));
  const knowledgePointIds = new Set<string>();
  const references = new Map<string, number>();

  for (const { value: lesson, file } of data.lessons) {
    if (
      lesson.knowledge_points &&
      (lesson.knowledge_points.length < 2 || lesson.knowledge_points.length > 4)
    ) {
      addIssue(
        issues,
        file,
        lesson.concept,
        'knowledge-point lessons must have 2–4 knowledge points',
      );
    }
    for (const point of lesson.knowledge_points ?? []) {
      if (knowledgePointIds.has(point.id)) {
        addIssue(issues, file, point.id, 'duplicate knowledge-point id');
      }
      knowledgePointIds.add(point.id);
      if (!point.title.trim())
        addIssue(issues, file, point.id, 'knowledge-point title must not be empty');
      if (!point.explain.trim())
        addIssue(issues, file, point.id, 'knowledge-point explain must not be empty');
      if (!point.worked.trim())
        addIssue(issues, file, point.id, 'knowledge-point worked must not be empty');
      if (point.problems.length < 3) {
        addIssue(issues, file, point.id, 'knowledge point must reference at least 3 problems');
      }
      const fixedProblems = point.problems.filter((problemId) => {
        const problem = exercises.get(problemId)?.value;
        return problem !== undefined && !isTemplate(problem);
      });
      const hasTemplate = point.problems.some((problemId) => {
        const problem = exercises.get(problemId)?.value;
        return problem !== undefined && isTemplate(problem);
      });
      if (fixedProblems.length < 1) {
        addIssue(issues, file, point.id, 'knowledge point must include at least 1 fixed problem');
      }
      if (fixedProblems.length < 5 && !hasTemplate) {
        addIssue(
          issues,
          file,
          point.id,
          'knowledge point needs 5 fixed problems or at least 1 template',
        );
      }
      const listed = new Set<string>();
      for (const problemId of point.problems) {
        if (references.has(problemId)) {
          addIssue(
            issues,
            file,
            point.id,
            `problem "${problemId}" is listed more than once across knowledge points`,
          );
        }
        references.set(problemId, (references.get(problemId) ?? 0) + 1);
        if (listed.has(problemId)) {
          addIssue(issues, file, point.id, `problem "${problemId}" is listed more than once`);
        }
        listed.add(problemId);
        const problem = exercises.get(problemId);
        if (!problem) {
          addIssue(issues, file, point.id, `references missing problem "${problemId}"`);
          continue;
        }
        if (problem.concept !== lesson.concept) {
          addIssue(
            issues,
            file,
            point.id,
            `problem "${problemId}" belongs to "${problem.concept}"`,
          );
        }
        if (problem.value.role !== 'practice') {
          addIssue(issues, file, point.id, `problem "${problemId}" must have practice role`);
        }
      }
    }
  }

  for (const { value: exercise, file } of data.exercises) {
    if (exercise.role === 'practice' && references.get(exercise.id) !== 1) {
      addIssue(
        issues,
        file,
        exercise.id,
        references.has(exercise.id)
          ? 'practice exercise must be referenced by exactly one knowledge point'
          : 'practice exercise is not referenced by a knowledge point',
      );
    }
    if (isTemplate(exercise) && exercise.role !== 'practice') {
      addIssue(issues, file, exercise.id, 'templates must have practice role');
    }
    if (isTemplate(exercise)) validateTemplate(exercise, file, issues);
  }
}

function validateTemplate(
  exercise: Extract<ContentSourceData['exercises'][number]['value'], { type: 'numeric' }>,
  file: string,
  issues: ContentIssue[],
) {
  if (!isTemplate(exercise)) return;
  const answers = new Set<number>();
  let reportedFailure = false;
  for (let seed = 0; seed < 100; seed += 1) {
    try {
      const instance = instantiateExercise(exercise, seed);
      if (instance.exercise.type !== 'numeric' || !('answer' in instance.exercise)) {
        throw new Error('instantiation did not produce a concrete numeric exercise');
      }
      if (!Number.isFinite(instance.exercise.answer)) {
        throw new Error('answer is not finite');
      }
      answers.add(instance.exercise.answer);
      if (stringValues(instance.exercise).some((text) => text.includes('{{='))) {
        throw new Error('unresolved {{= placeholder remains after instantiation');
      }
      for (const wrong of instance.exercise.common_wrong ?? []) {
        if (!('answer' in wrong) || typeof wrong.answer !== 'number') continue;
        const tolerance = wrong.tolerance ?? instance.exercise.tolerance;
        const threshold = Math.max(
          tolerance.abs ?? 1e-6,
          (tolerance.rel ?? 0) *
            Math.max(Math.abs(wrong.answer), Math.abs(instance.exercise.answer)),
        );
        if (Math.abs(wrong.answer - instance.exercise.answer) <= threshold) {
          throw new Error('common-wrong answer is within tolerance of the correct answer');
        }
      }
    } catch (error) {
      if (!reportedFailure) {
        addIssue(issues, file, exercise.id, `template seed ${seed}: ${messageOf(error)}`);
        reportedFailure = true;
      }
      break;
    }
  }
  if (!reportedFailure && answers.size < 3) {
    addIssue(
      issues,
      file,
      exercise.id,
      'template must produce at least 3 distinct answers across seeds 0–99',
    );
  }
}

function validateNotationUsage(data: ContentSourceData, issues: ContentIssue[]) {
  const notation = data.notation;
  if (!notation) return;
  const concepts = new Map(data.concepts.map(({ value, file }) => [value.id, { value, file }]));
  const lessons = new Map(data.lessons.map(({ value, file }) => [value.concept, { value, file }]));
  const seenTerms = new Set<string>();

  for (const term of notation.value.terms) {
    if (seenTerms.has(term.id)) {
      addIssue(issues, notation.file, term.id, 'duplicate notation term id');
    }
    seenTerms.add(term.id);

    const introducedBy = new Set(term.introduced_by);
    for (const conceptId of introducedBy) {
      const concept = concepts.get(conceptId);
      if (!concept) {
        addIssue(
          issues,
          notation.file,
          term.id,
          `introducer references unknown concept "${conceptId}"`,
        );
        continue;
      }
      const lesson = lessons.get(conceptId);
      if (concept.value.status === 'authored' && lesson) {
        const lessonText = [
          ...lesson.value.blocks.map((block) => ('md' in block ? (block.md ?? '') : '')),
          ...(lesson.value.knowledge_points ?? []).flatMap((point) => [
            point.title,
            point.explain,
            point.worked,
          ]),
        ].join('\n');
        const teachesTerm = term.match.some((source) => {
          try {
            return new RegExp(source, 'i').test(lessonText);
          } catch {
            return false;
          }
        });
        if (!teachesTerm) {
          addIssue(
            issues,
            lesson.file,
            conceptId,
            `introducing lesson does not teach ${term.label}`,
          );
        }
      }
    }

    const patterns: Array<{ source: string; regex: RegExp }> = [];
    for (const source of term.match) {
      try {
        patterns.push({ source, regex: new RegExp(source, 'i') });
      } catch (error) {
        addIssue(
          issues,
          notation.file,
          term.id,
          `invalid match regex "${source}": ${messageOf(error)}`,
        );
      }
    }

    for (const { value: concept, file } of data.concepts) {
      const ancestors = hardAncestors(concept.id, concepts);
      if (introducedBy.has(concept.id) || [...introducedBy].some((id) => ancestors.has(id))) {
        continue;
      }
      const ownedText: Array<{ file: string; id: string; text: string }> = [];
      const lesson = lessons.get(concept.id);
      for (const block of lesson?.value.blocks ?? []) {
        if ('md' in block && block.md) {
          ownedText.push({ file: lesson?.file ?? file, id: concept.id, text: block.md });
        }
      }
      for (const point of lesson?.value.knowledge_points ?? []) {
        for (const text of [point.title, point.explain, point.worked]) {
          ownedText.push({ file: lesson?.file ?? file, id: point.id, text });
        }
      }
      for (const exercise of data.exercises) {
        if (exercise.concept === concept.id) {
          for (const text of stringValues(exercise.value)) {
            ownedText.push({
              file: exercise.file,
              id: exercise.value.id,
              text: text.replace(/\{\{=.*?\}\}/g, ''),
            });
          }
        }
      }
      const match = ownedText.flatMap((entry) =>
        patterns.flatMap(({ regex }) => {
          const found = regex.exec(entry.text);
          return found?.index === undefined ? [] : [{ ...entry, found }];
        }),
      )[0];
      if (match?.found.index !== undefined) {
        const snippet = snippetAround(match.text, match.found.index, match.found[0].length);
        addIssue(
          issues,
          match.file,
          match.id,
          `uses ${term.label} but none of ${term.introduced_by.join(', ')} is a hard prerequisite; near "${snippet}"`,
        );
      }
    }
  }
}

function hardAncestors(
  id: string,
  concepts: Map<string, { value: ContentSourceData['concepts'][number]['value']; file: string }>,
): Set<string> {
  const ancestors = new Set<string>();
  const visit = (conceptId: string) => {
    const concept = concepts.get(conceptId);
    for (const prerequisite of concept?.value.prereqs ?? []) {
      if (prerequisite.strength !== 'hard' || ancestors.has(prerequisite.id)) continue;
      ancestors.add(prerequisite.id);
      visit(prerequisite.id);
    }
  };
  visit(id);
  return ancestors;
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (typeof value === 'object' && value !== null) {
    const metadata = new Set(['id', 'type', 'role', 'dimension', 'category']);
    return Object.entries(value)
      .filter(([key]) => !metadata.has(key))
      .flatMap(([, child]) => stringValues(child));
  }
  return [];
}

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 20);
  const end = Math.min(text.length, index + length + 20);
  const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${snippet}${end < text.length ? '…' : ''}`;
}

function valueDomain(concept: { id: string }, data: ContentSourceData): string {
  return data.concepts.find((entry) => entry.value.id === concept.id)?.domain ?? '<unknown>';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
