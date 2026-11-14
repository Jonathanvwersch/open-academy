export interface PapersPayload {
  units: Array<{
    unit: number;
    title: string;
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
