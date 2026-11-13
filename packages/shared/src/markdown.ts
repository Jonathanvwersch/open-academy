export function normalizeDisplayMath(md: string): string {
  return normalizeTexDelimiters(md).replace(
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

function normalizeTexDelimiters(markdown: string): string {
  let output = '';
  let index = 0;

  while (index < markdown.length) {
    if (index === 0 || markdown[index - 1] === '\n') {
      const fence = markdownFenceAt(markdown, index);
      if (fence) {
        const end = findFencedBlockEnd(markdown, index, fence);
        output += markdown.slice(index, end);
        index = end;
        continue;
      }
    }

    const character = markdown[index];
    if (character === '`' && !isEscaped(markdown, index)) {
      const runEnd = endOfRun(markdown, index, '`');
      const runLength = runEnd - index;
      const codeEnd = findInlineCodeEnd(markdown, runEnd, runLength);
      if (codeEnd !== undefined) {
        output += markdown.slice(index, codeEnd);
        index = codeEnd;
      } else {
        output += markdown.slice(index, runEnd);
        index = runEnd;
      }
      continue;
    }

    if (character === '\\') {
      const runEnd = endOfRun(markdown, index, '\\');
      const runLength = runEnd - index;
      const opener = markdown[runEnd];
      if (runLength % 2 === 1 && (opener === '[' || opener === '(')) {
        const closing = findMathClose(markdown, runEnd + 1, opener === '[' ? ']' : ')');
        if (closing) {
          const delimiter = opener === '[' ? '$$' : '$';
          output += '\\'.repeat(runLength - 1);
          output += delimiter;
          output += markdown.slice(runEnd + 1, closing.start);
          output += delimiter;
          index = closing.end;
          continue;
        }
      }
      output += markdown.slice(index, runEnd);
      index = runEnd;
      continue;
    }

    output += character;
    index += 1;
  }

  return output;
}

function markdownFenceAt(
  markdown: string,
  lineStart: number,
): { marker: '`' | '~'; length: number } | undefined {
  const lineEnd = markdown.indexOf('\n', lineStart);
  const line = markdown.slice(lineStart, lineEnd === -1 ? markdown.length : lineEnd);
  const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
  if (!opening) return undefined;
  return { marker: opening[0] as '`' | '~', length: opening.length };
}

function findFencedBlockEnd(
  markdown: string,
  openingStart: number,
  fence: { marker: '`' | '~'; length: number },
): number {
  const openingLineEnd = markdown.indexOf('\n', openingStart);
  if (openingLineEnd === -1) return markdown.length;

  const closingPattern =
    fence.marker === '`' ? /^ {0,3}(`{3,})[ \t]*\r?$/ : /^ {0,3}(~{3,})[ \t]*\r?$/;
  let lineStart = openingLineEnd + 1;
  while (lineStart < markdown.length) {
    const lineEnd = markdown.indexOf('\n', lineStart);
    const end = lineEnd === -1 ? markdown.length : lineEnd;
    const closing = closingPattern.exec(markdown.slice(lineStart, end));
    if (closing && closing[1].length >= fence.length) {
      return lineEnd === -1 ? markdown.length : lineEnd + 1;
    }
    if (lineEnd === -1) break;
    lineStart = lineEnd + 1;
  }
  return markdown.length;
}

function endOfRun(value: string, start: number, character: string): number {
  let end = start;
  while (value[end] === character) end += 1;
  return end;
}

function findInlineCodeEnd(markdown: string, start: number, length: number): number | undefined {
  let index = start;
  while (index < markdown.length) {
    if (markdown[index] !== '`') {
      index += 1;
      continue;
    }
    const runEnd = endOfRun(markdown, index, '`');
    if (runEnd - index === length) return runEnd;
    index = runEnd;
  }
  return undefined;
}

function findMathClose(
  markdown: string,
  start: number,
  closingCharacter: ']' | ')',
): { start: number; end: number } | undefined {
  let index = start;
  while (index < markdown.length) {
    if (markdown[index] !== '\\') {
      index += 1;
      continue;
    }
    const runEnd = endOfRun(markdown, index, '\\');
    const runLength = runEnd - index;
    if (runLength % 2 === 1 && markdown[runEnd] === closingCharacter) {
      return { start: runEnd - 1, end: runEnd + 1 };
    }
    index = runEnd;
  }
  return undefined;
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}
