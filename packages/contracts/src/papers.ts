export interface PapersPayload {
  weeks: Array<{
    week: number;
    papers: Array<{
      id: string;
      title: string;
      authors: string;
      year: number;
      est_minutes: number;
      status: 'not_started' | 'reading' | 'completed';
    }>;
  }>;
}
