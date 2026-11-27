import {
  ContentValidationError,
  loadContentFromDirectory,
  loadContentReportFromDirectory,
  loadContentUncheckedFromDirectory,
} from '@open-academy/engine/course/load';
import type { ContentIndex, ContentIssue } from '@open-academy/engine/course/types';
import { repositoryPath } from '../paths.js';

export { ContentValidationError };

export function resolveContentDirectory(directory = process.env.CONTENT_DIR ?? 'content'): string {
  return repositoryPath(directory);
}

export async function loadContent(
  directory = process.env.CONTENT_DIR ?? 'content',
): Promise<ContentIndex> {
  return loadContentFromDirectory(resolveContentDirectory(directory));
}

export async function loadContentUnchecked(
  directory = process.env.CONTENT_DIR ?? 'content',
): Promise<ContentIndex> {
  return loadContentUncheckedFromDirectory(resolveContentDirectory(directory));
}

export async function loadContentReport(
  directory = process.env.CONTENT_DIR ?? 'content',
): Promise<{ content: ContentIndex; warnings: ContentIssue[] }> {
  return loadContentReportFromDirectory(resolveContentDirectory(directory));
}
