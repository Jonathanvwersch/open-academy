import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IndexedPaper } from '../../content/types.js';
import { repositoryPath } from '../../paths.js';

const MAX_PDF_BYTES = 40 * 1024 * 1024;
const ALLOWED_HOSTS = new Set([
  'arxiv.org',
  'homes.cs.washington.edu',
  'proceedings.neurips.cc',
  'people.math.harvard.edu',
]);

export interface PaperFetcher {
  fetch(paper: IndexedPaper): Promise<Uint8Array>;
}

export class FixturePaperFetcher implements PaperFetcher {
  constructor(private readonly directory: string) {}

  fetch(paper: IndexedPaper) {
    return readFile(join(this.directory, `${paper.id}.pdf`));
  }
}

export class HttpPaperFetcher implements PaperFetcher {
  async fetch(paper: IndexedPaper): Promise<Uint8Array> {
    const source = paper.source;
    let url = 'arxiv' in source ? `https://arxiv.org/pdf/${source.arxiv}` : source.url;
    const signal = AbortSignal.timeout(60_000);
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
        throw new Error('PDF URL is not on an allowed host');
      }
      const response = await fetch(url, {
        redirect: 'manual',
        signal,
        headers: { 'User-Agent': 'academy-paper-reader' },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirects === 5) throw new Error('Too many PDF redirects');
        url = new URL(location, url).toString();
        continue;
      }
      if (!response.ok) throw new Error(`PDF upstream returned ${response.status}`);
      if (!response.headers.get('content-type')?.toLowerCase().includes('application/pdf')) {
        throw new Error('PDF upstream returned a non-PDF content type');
      }
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > MAX_PDF_BYTES) {
        throw new Error('PDF exceeds the 40 MB limit');
      }
      if (!response.body) throw new Error('PDF upstream returned no body');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_PDF_BYTES) {
          await reader.cancel();
          throw new Error('PDF exceeds the 40 MB limit');
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (new TextDecoder().decode(bytes.subarray(0, 4)) !== '%PDF') {
        throw new Error('PDF upstream returned invalid PDF bytes');
      }
      return bytes;
    }
    throw new Error('Too many PDF redirects');
  }
}

export function defaultPaperFetcher(): PaperFetcher {
  if (process.env.NODE_ENV === 'test' && process.env.PAPER_FIXTURE_DIR) {
    return new FixturePaperFetcher(repositoryPath(process.env.PAPER_FIXTURE_DIR));
  }
  return new HttpPaperFetcher();
}
