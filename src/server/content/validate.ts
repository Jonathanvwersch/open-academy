import { parse as parseExpression } from 'mathjs';
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

  findCycles(data, issues);
  return issues;
}

function valueDomain(concept: { id: string }, data: ContentSourceData): string {
  return data.concepts.find((entry) => entry.value.id === concept.id)?.domain ?? '<unknown>';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
