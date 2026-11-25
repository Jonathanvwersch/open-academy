export function fsrsFuzzEnabled(): boolean {
  return process.env.NODE_ENV !== 'test';
}
