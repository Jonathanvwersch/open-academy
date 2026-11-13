import { normalizeDisplayMath } from '@academy/shared/markdown';
import { describe, expect, it } from 'vitest';

describe('normalizeDisplayMath', () => {
  it('moves display math after text onto its own lines', () => {
    expect(normalizeDisplayMath('Formula: $$x^2$$')).toBe('Formula: \n\n$$\nx^2\n$$\n\n');
  });

  it('moves standalone one-line display math onto its own lines', () => {
    expect(normalizeDisplayMath('$$x$$')).toBe('\n\n$$\nx\n$$\n\n');
  });

  it('leaves already fenced display math unchanged', () => {
    const md = 'Before\n\n$$\nx^2\n$$\n\nAfter';
    expect(normalizeDisplayMath(md)).toBe(md);
  });

  it('normalizes two display spans in one string', () => {
    expect(normalizeDisplayMath('First $$x$$ then $$y$$.')).toBe(
      'First \n\n$$\nx\n$$\n\n then \n\n$$\ny\n$$\n\n.',
    );
  });

  it('leaves inline math untouched', () => {
    expect(normalizeDisplayMath('Inline $a$ stays inline.')).toBe('Inline $a$ stays inline.');
  });

  it('normalizes inline TeX math delimiters', () => {
    expect(normalizeDisplayMath(String.raw`Inline \(x + y\).`)).toBe('Inline $x + y$.');
  });

  it('normalizes display TeX math delimiters', () => {
    expect(normalizeDisplayMath(String.raw`Before \[x^2\] after`)).toBe(
      'Before \n\n$$\nx^2\n$$\n\n after',
    );
  });

  it('normalizes multiline display TeX math delimiters', () => {
    const markdown = String.raw`Before
\[
\frac{a}{b}=x
\]
After`;
    expect(normalizeDisplayMath(markdown)).toBe('Before\n$$\n\\frac{a}{b}=x\n$$\nAfter');
  });

  it('leaves TeX delimiters inside inline code unchanged', () => {
    const markdown = 'Keep `\\(x\\)` and `\\[y\\]` unchanged.';
    expect(normalizeDisplayMath(markdown)).toBe(markdown);
  });

  it('leaves TeX delimiters inside fenced code unchanged', () => {
    const markdown = '```md\n\\[x\\]\n\\(y\\)\n```\nOutside \\(z\\)';
    expect(normalizeDisplayMath(markdown)).toBe('```md\n\\[x\\]\n\\(y\\)\n```\nOutside $z$');
  });

  it('leaves escaped aligned spacing and existing display math unchanged', () => {
    const markdown = String.raw`$$
\begin{aligned}
a &= b \\[2pt]
\end{aligned}
$$`;
    expect(normalizeDisplayMath(markdown)).toBe(markdown);
  });
});
