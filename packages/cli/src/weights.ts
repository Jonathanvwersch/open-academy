import type { ContentIndex } from '@academy/api/content';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function verifyEdge(
  entry: unknown,
  exerciseIds: string[],
  stepIds: Set<string>,
  edge: string,
): number {
  if (!isRecord(entry) || !isRecord(entry.uses)) {
    throw new Error(`${edge}: expected {weight, exercises, steps, uses}.`);
  }
  if (stepIds.size === 0) {
    throw new Error(`${edge}: verification requires prerequisite steps.`);
  }
  if (entry.exercises !== exerciseIds.length || entry.steps !== stepIds.size) {
    throw new Error(`${edge}: expected ${exerciseIds.length} exercises and ${stepIds.size} steps.`);
  }

  const eligibleExercises = new Set(exerciseIds);
  let usedSteps = 0;
  for (const [exerciseId, used] of Object.entries(entry.uses)) {
    if (!eligibleExercises.delete(exerciseId)) {
      throw new Error(`${edge}: unexpected exercise id "${exerciseId}".`);
    }
    if (!Array.isArray(used)) {
      throw new Error(`${edge}: expected a list of step ids for "${exerciseId}".`);
    }
    const seen = new Set<string>();
    for (const step of used) {
      if (typeof step !== 'string' || !stepIds.has(step)) {
        throw new Error(`${edge}: unknown prerequisite step "${step}" in "${exerciseId}".`);
      }
      if (seen.has(step)) {
        throw new Error(`${edge}: duplicate step "${step}" in "${exerciseId}".`);
      }
      seen.add(step);
    }
    usedSteps += seen.size;
  }
  if (eligibleExercises.size > 0) {
    throw new Error(`${edge}: missing uses for ${[...eligibleExercises].join(', ')}.`);
  }

  const weight = Math.round((100 * usedSteps) / (exerciseIds.length * stepIds.size)) / 100;
  if (entry.weight !== weight) {
    throw new Error(`${edge}: expected weight ${weight.toFixed(2)} from uses.`);
  }
  return weight;
}

export function verifyWeights(content: ContentIndex, uses: unknown): number {
  if (!isRecord(uses)) throw new Error('Expected a uses mapping keyed by concept id.');
  for (const id of Object.keys(uses)) {
    if (!content.conceptsById.has(id)) throw new Error(`Unknown concept "${id}" in uses.`);
  }

  let count = 0;
  for (const concept of content.concepts) {
    const exerciseIds = (content.exercisesByConcept.get(concept.id) ?? [])
      .filter(({ role }) => role !== 'recall')
      .map(({ id }) => id);
    if (exerciseIds.length === 0) continue;

    const required = new Set(
      concept.prereqs.filter(({ strength }) => strength === 'hard').map(({ id }) => id),
    );
    for (const step of content.lessonsByConcept.get(concept.id)?.knowledge_points ?? []) {
      for (const id of step.key_prereqs ?? []) required.add(id);
    }

    const entries = Object.hasOwn(uses, concept.id) ? uses[concept.id] : {};
    if (!isRecord(entries)) throw new Error(`${concept.id}: expected a prerequisite mapping.`);
    for (const id of Object.keys(entries)) {
      if (!required.has(id)) throw new Error(`${concept.id} -> ${id}: unexpected edge in uses.`);
    }

    const recorded = new Map(concept.encompassings?.map(({ id, weight }) => [id, weight]));
    for (const id of recorded.keys()) {
      if (!required.has(id)) {
        throw new Error(`${concept.id} -> ${id}: unexpected encompassing in concept file.`);
      }
    }
    for (const id of required) {
      const edge = `${concept.id} -> ${id}`;
      if (!Object.hasOwn(entries, id)) throw new Error(`${edge}: missing edge in uses.`);
      const stepIds = new Set(
        content.lessonsByConcept.get(id)?.knowledge_points?.map(({ id }) => id),
      );
      const weight = verifyEdge(entries[id], exerciseIds, stepIds, edge);
      if (recorded.get(id) !== weight) {
        throw new Error(
          `${edge}: expected encompassing weight ${weight.toFixed(2)} in concept file.`,
        );
      }
      count += 1;
    }
  }
  return count;
}
