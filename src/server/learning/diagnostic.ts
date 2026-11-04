import type { ContentIndex, IndexedExercise } from '../content/types.js';

export type DiagnosticDomainStatus = 'active' | 'completed' | 'unassessed';

export interface DiagnosticDomainProgress {
  position: number;
  answers: number;
  status: DiagnosticDomainStatus;
  correctConceptIds: string[];
  gapConceptIds: string[];
  endedAt?: string;
}

export interface DiagnosticRunState {
  cursor: number;
  domains: Record<string, DiagnosticDomainProgress>;
  answerCount: number;
}

export interface DiagnosticEvidence {
  conceptId: string;
  dimension: IndexedExercise['dimension'];
  exerciseId: string;
  correct: boolean;
  source: 'diagnostic';
  mode: 'diagnostic';
}

export interface DiagnosticAnswerResult {
  state: DiagnosticRunState;
  evidence: DiagnosticEvidence;
  inferredPrerequisiteIds: string[];
  endedDomain: boolean;
}

export function createDiagnosticState(content: ContentIndex): DiagnosticRunState {
  const domains: Record<string, DiagnosticDomainProgress> = {};
  for (const ladder of content.diagnostic?.domains ?? []) {
    domains[ladder.domain] = {
      position: ladder.start - 1,
      answers: 0,
      status: 'active',
      correctConceptIds: [],
      gapConceptIds: [],
    };
  }
  return { cursor: 0, domains, answerCount: 0 };
}

export function nextDiagnosticExercise(
  state: DiagnosticRunState,
  content: ContentIndex,
): IndexedExercise | undefined {
  const ladders = content.diagnostic?.domains ?? [];
  if (ladders.length === 0) {
    return undefined;
  }
  for (let offset = 0; offset < ladders.length; offset += 1) {
    const index = (state.cursor + offset) % ladders.length;
    const ladder = ladders[index];
    if (!ladder) {
      continue;
    }
    const progress = state.domains[ladder.domain];
    if (progress?.status !== 'active') {
      continue;
    }
    const exerciseId = ladder.ladder[progress.position];
    if (!exerciseId) {
      continue;
    }
    const exercise = content.exercisesById.get(exerciseId);
    if (exercise) {
      return exercise;
    }
  }
  return undefined;
}

export function recordDiagnosticAnswer(
  state: DiagnosticRunState,
  exercise: IndexedExercise,
  correct: boolean,
  content: ContentIndex,
  now: Date,
): DiagnosticAnswerResult {
  const ladder = content.diagnostic?.domains.find((entry) => entry.ladder.includes(exercise.id));
  if (!ladder) {
    throw new Error(`Exercise ${exercise.id} is not on a diagnostic ladder`);
  }
  const previous = state.domains[ladder.domain];
  if (previous?.status !== 'active') {
    throw new Error(`Diagnostic domain ${ladder.domain} is not active`);
  }
  const concept = content.conceptsById.get(exercise.concept);
  if (!concept) {
    throw new Error(`Missing diagnostic concept ${exercise.concept}`);
  }

  const position = previous.position + (correct ? 1 : -1);
  const answers = previous.answers + 1;
  const endedDomain = answers >= 3 || position < 0 || position >= ladder.ladder.length;
  const progress: DiagnosticDomainProgress = {
    ...previous,
    position,
    answers,
    status: endedDomain ? 'completed' : 'active',
    correctConceptIds: correct
      ? [...previous.correctConceptIds, concept.id]
      : previous.correctConceptIds,
    gapConceptIds: correct ? previous.gapConceptIds : [...previous.gapConceptIds, concept.id],
    ...(endedDomain ? { endedAt: now.toISOString() } : {}),
  };
  const ladders = content.diagnostic?.domains ?? [];
  const domainIndex = ladders.findIndex((entry) => entry.domain === ladder.domain);
  const nextState: DiagnosticRunState = {
    cursor: ladders.length > 0 ? (domainIndex + 1) % ladders.length : 0,
    domains: { ...state.domains, [ladder.domain]: progress },
    answerCount: state.answerCount + 1,
  };
  const inferredPrerequisiteIds = correct
    ? concept.prereqs.filter((prerequisite) => prerequisite.strength === 'hard').map(({ id }) => id)
    : [];
  return {
    state: nextState,
    evidence: {
      conceptId: concept.id,
      dimension: exercise.dimension,
      exerciseId: exercise.id,
      correct,
      source: 'diagnostic',
      mode: 'diagnostic',
    },
    inferredPrerequisiteIds,
    endedDomain,
  };
}

export function markDiagnosticUnassessed(
  state: DiagnosticRunState,
  domain: string,
  now: Date,
): DiagnosticRunState {
  const previous = state.domains[domain];
  if (previous?.status !== 'active') {
    return state;
  }
  const ladders = Object.keys(state.domains);
  const index = ladders.indexOf(domain);
  return {
    ...state,
    cursor: ladders.length > 0 ? (index + 1) % ladders.length : 0,
    domains: {
      ...state.domains,
      [domain]: { ...previous, status: 'unassessed', endedAt: now.toISOString() },
    },
  };
}

export function diagnosticComplete(state: DiagnosticRunState): boolean {
  return Object.values(state.domains).every((domain) => domain.status !== 'active');
}
