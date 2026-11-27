import type { IndexedPaper } from '@open-academy/engine/internal/course/types';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { loadContent } from '../../content/load.js';
import { HttpPaperFetcher } from './fetcher.js';

const pdf = new TextEncoder().encode('%PDF-1.4 test document');
let paper: IndexedPaper;

beforeAll(async () => {
  const content = await loadContent('tests/fixtures/content');
  const fixture = content.papers[0];
  if (!fixture) throw new Error('Missing paper fixture');
  paper = fixture;
});

afterEach(() => vi.unstubAllGlobals());

function pdfResponse() {
  return new Response(pdf, { headers: { 'content-type': 'application/pdf; charset=binary' } });
}

test.each([
  'arxiv.org',
  'homes.cs.washington.edu',
  'proceedings.neurips.cc',
  'people.math.harvard.edu',
])('fetches PDF bytes from %s', async (host) => {
  const fetch = vi.fn().mockResolvedValue(pdfResponse());
  vi.stubGlobal('fetch', fetch);
  const url = `https://${host}/paper.pdf`;

  await expect(new HttpPaperFetcher().fetch({ ...paper, source: { url } })).resolves.toEqual(pdf);
  expect(fetch).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'manual' }));
});

test('follows relative and cross-host redirects between allowed PDF hosts', async () => {
  const url = 'https://proceedings.neurips.cc/paper.pdf';
  const redirected = 'https://people.math.harvard.edu/paper.pdf';
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: '/files/paper.pdf' } }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: redirected } }))
    .mockResolvedValueOnce(pdfResponse());
  vi.stubGlobal('fetch', fetch);

  await expect(new HttpPaperFetcher().fetch({ ...paper, source: { url } })).resolves.toEqual(pdf);
  expect(fetch.mock.calls.map(([requested]) => requested)).toEqual([
    url,
    'https://proceedings.neurips.cc/files/paper.pdf',
    redirected,
  ]);
});

test.each([
  'http://proceedings.neurips.cc/paper.pdf',
  'https://people.math.harvard.edu.example.com/paper.pdf',
  'https://example.com/paper.pdf',
])('rejects an unsafe initial URL before fetching: %s', async (url) => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(new HttpPaperFetcher().fetch({ ...paper, source: { url } })).rejects.toThrow(
    'PDF URL is not on an allowed host',
  );
  expect(fetch).not.toHaveBeenCalled();
});

test.each(['https://example.com/paper.pdf', 'http://people.math.harvard.edu/paper.pdf'])(
  'rejects a redirect to %s before following it',
  async (location) => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
    vi.stubGlobal('fetch', fetch);
    await expect(
      new HttpPaperFetcher().fetch({
        ...paper,
        source: { url: 'https://proceedings.neurips.cc/paper.pdf' },
      }),
    ).rejects.toThrow('PDF URL is not on an allowed host');
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

test.each(['proceedings.neurips.cc', 'people.math.harvard.edu'])(
  'requires a PDF content type and valid PDF bytes on %s',
  async (host) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(pdf, { headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(
        new Response('<html/>', { headers: { 'content-type': 'application/pdf' } }),
      );
    vi.stubGlobal('fetch', fetch);
    const input = { ...paper, source: { url: `https://${host}/paper.pdf` } };
    await expect(new HttpPaperFetcher().fetch(input)).rejects.toThrow('non-PDF content type');
    await expect(new HttpPaperFetcher().fetch(input)).rejects.toThrow('invalid PDF bytes');
  },
);
