export function sessionActivityLabel(kind: string) {
  const labels: Record<string, string> = {
    learn: 'New lesson',
    practice: 'Continue lesson',
    remediate: 'Remediation',
    transfer: 'Apply it',
    review: 'Review',
    mixed_quiz: 'Timed quiz',
    quick_check: 'Quiz',
    assessment: 'Assessment',
    lab: 'Project',
    teachback: 'Teach-back',
    reflect: 'Reflection',
    paper: 'Paper',
  };
  return labels[kind] ?? kind.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
}
