import { describe, expect, it } from 'vitest';
import { normalizeDisplayMath } from '../src/shared/markdown';

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
});
