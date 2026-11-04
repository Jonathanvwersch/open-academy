export function normalizeDisplayMath(md: string): string {
  return md.replace(
    /\$\$([\s\S]*?)\$\$/g,
    (match, formula: string, offset: number, source: string) => {
      const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
      const after = offset + match.length;
      const nextNewline = source.indexOf('\n', after);
      const lineEnd = nextNewline === -1 ? source.length : nextNewline;
      const ownLines =
        source.slice(lineStart, offset).trim() === '' &&
        source.slice(after, lineEnd).trim() === '' &&
        formula.startsWith('\n') &&
        formula.endsWith('\n');
      if (ownLines) return match;
      return `\n\n$$\n${formula.trim()}\n$$\n\n`;
    },
  );
}
