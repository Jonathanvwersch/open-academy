/** KaTeX supports the combining macron, but rejects the equivalent single-letter overline. */
export function normalizeUnicodeMath(value: string): string {
  return value.replace(/\u0305/g, '\u0304');
}
