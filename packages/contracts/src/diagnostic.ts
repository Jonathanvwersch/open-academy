export type DiagnosticAnswerInput =
  | { exerciseId: string; answer: unknown; dontKnow?: false }
  | { exerciseId: string; dontKnow: true };

export interface DiagnosticResultsPayload {
  domains: Array<{
    id: string;
    title: string;
    outcome: string;
    answers: number;
    knownConcepts: string[];
    gaps: string[];
  }>;
  plan: {
    firstUnit: { title: string } | null;
    firstUnitConcepts: string[];
    firstSession: Array<{
      kind: string;
      conceptTitle?: string;
      plannedMinutes: number;
      reason: { summary: string };
    }>;
    path: Array<{ unit: number; title: string }>;
  };
}
