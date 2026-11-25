import { afterEach, expect, test, vi } from 'vitest';
import { checkTutorSvg, tutorSvgPlaceholder } from './tutor-svg.js';

const namespaceURI = 'http://www.w3.org/2000/svg';

function stubParser({
  rootName = 'svg',
  namespace = namespaceURI,
  errors = [],
  elements = [],
}: {
  rootName?: string;
  namespace?: string;
  errors?: object[];
  elements?: object[];
} = {}) {
  const parseFromString = vi.fn(() => ({
    documentElement: {
      localName: rootName,
      namespaceURI: namespace,
      getAttribute: (name: string) => (name === 'aria-label' ? ' A projection ' : null),
    },
    getElementsByTagName: (name: string) => (name === 'parsererror' ? errors : elements),
  }));
  vi.stubGlobal(
    'DOMParser',
    class {
      parseFromString = parseFromString;
    },
  );
  return parseFromString;
}

afterEach(() => vi.unstubAllGlobals());

test('checks XML and uses the root accessible label for a valid diagram', () => {
  const parse = stubParser({
    elements: [{ localName: 'use', attributes: [{ localName: 'href', value: '#arrow' }] }],
  });
  const source = `<svg xmlns="${namespaceURI}" aria-label=" A projection "><use href="#arrow"/></svg>`;
  expect(checkTutorSvg(source)).toEqual({ status: 'valid', label: 'A projection' });
  expect(parse).toHaveBeenCalledWith(source, 'image/svg+xml');
});

test('allows diagram text that resembles an attribute', () => {
  stubParser({ elements: [{ localName: 'text', attributes: [] }] });
  expect(
    checkTutorSvg(
      `<svg xmlns="${namespaceURI}"><text>on = 1, href = "the horizontal axis"</text></svg>`,
    ),
  ).toEqual({ status: 'valid', label: 'A projection' });
});

test.each([{ errors: [{}] }, { rootName: 'html' }, { namespace: '' }])(
  'rejects parser errors or a non-SVG root (%j)',
  (parsed) => {
    stubParser(parsed);
    expect(checkTutorSvg('<svg>')).toEqual({ status: 'invalid' });
  },
);

test.each([
  ['<script/>', { localName: 'script', attributes: [] }],
  ['<foreignObject/>', { localName: 'foreignObject', attributes: [] }],
  ['<g onLoad="handler()"/>', { localName: 'g', attributes: [{ localName: 'onLoad' }] }],
  [
    '<image href="https://example.test/image.svg"/>',
    {
      localName: 'image',
      attributes: [{ localName: 'href', value: 'https://example.test/image.svg' }],
    },
  ],
])('rejects forbidden parsed markup: %s', (source, element) => {
  stubParser({ elements: [element] });
  expect(checkTutorSvg(`<svg xmlns="${namespaceURI}">${source}</svg>`)).toEqual({
    status: 'unsafe',
  });
});

test('checks decoded, namespaced hrefs', () => {
  stubParser({
    elements: [{ localName: 'use', attributes: [{ localName: 'href', value: 'other.svg#arrow' }] }],
  });
  expect(
    checkTutorSvg(
      `<svg xmlns="${namespaceURI}" xmlns:link="http://www.w3.org/1999/xlink"><use link:href="&#111;ther.svg#arrow"/></svg>`,
    ),
  ).toEqual({ status: 'unsafe' });
});

test('uses the drawing placeholder only for invalid SVG that is still streaming', () => {
  expect(tutorSvgPlaceholder('invalid', true)).toBe('Drawing…');
  expect(tutorSvgPlaceholder('invalid', false)).toBe("Diagram couldn't be shown");
  expect(tutorSvgPlaceholder('unsafe', true)).toBe("Diagram couldn't be shown");
});
