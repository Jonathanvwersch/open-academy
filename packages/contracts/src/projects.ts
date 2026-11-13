export interface ProjectPayload {
  project: {
    title: string;
    objective: string;
    background: string;
    status: 'authored' | 'stub';
    tasks: Array<{ id: string; title: string; md: string }>;
    acceptance: string[];
  };
  checksTotal: number;
  latestSubmission: {
    results: {
      tests: Array<{ id: string; passed: boolean; message: string }>;
    };
  } | null;
  evidence: string | null;
  reflection: Array<{ id: string; prompt: string }>;
  status: 'not_started' | 'in_progress' | 'completed';
}
