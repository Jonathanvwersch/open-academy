import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { paperPages } from '../../db/schema.js';

type PaperPdfDocument = {
  numPages: number;
  getPage(pageNumber: number): Promise<{
    getTextContent(): Promise<{ items: unknown[] }>;
  }>;
};

type PaperPdfLoader = (bytes: Uint8Array) => Promise<PaperPdfDocument>;

const pageLoads = new Map<string, Promise<void>>();

async function loadPaperPdfDocument(bytes: Uint8Array): Promise<PaperPdfDocument> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const standardFontDataUrl = fileURLToPath(
    new URL('../../standard_fonts/', import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs')),
  );
  return pdfjs.getDocument({ data: Uint8Array.from(bytes), standardFontDataUrl }).promise;
}

export async function extractPaperPages(
  db: Database,
  paperId: string,
  bytes: Uint8Array,
  loadDocument: PaperPdfLoader = loadPaperPdfDocument,
): Promise<void> {
  const pending = pageLoads.get(paperId);
  if (pending) return pending;
  const promise = (async () => {
    const existing = await db
      .select({ page: paperPages.page })
      .from(paperPages)
      .where(eq(paperPages.paperId, paperId));
    if (existing.length > 0) return;
    const document = await loadDocument(bytes);
    const rows = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      rows.push({
        paperId,
        page: pageNumber,
        text: content.items
          .map((item) =>
            typeof item === 'object' &&
            item !== null &&
            'str' in item &&
            typeof item.str === 'string'
              ? item.str
              : '',
          )
          .join(' '),
      });
    }
    if (rows.length) {
      await db.insert(paperPages).values(rows);
    }
  })();
  pageLoads.set(paperId, promise);
  try {
    await promise;
  } finally {
    pageLoads.delete(paperId);
  }
}
