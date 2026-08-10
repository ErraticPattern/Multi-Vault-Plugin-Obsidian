import type { IndexedFile } from './types';
import { isMarkdownExtension } from './migration/migration-view-models';

export type NoteResolution =
  | { kind: 'resolved'; target: IndexedFile }
  | { kind: 'ambiguous'; candidates: IndexedFile[] }
  | { kind: 'missing' };

function extensionless(value: string): string {
  return value.replace(/\\/g, '/').replace(/\.md$/i, '').toLowerCase();
}

export function resolveIndexedNote(
  files: IndexedFile[],
  vaultName: string,
  noteRef: string,
): NoteResolution {
  const vault = vaultName.trim().toLowerCase();
  const reference = extensionless(noteRef.trim());
  const candidates = files.filter((file) =>
    isMarkdownExtension(file.extension) && file.vaultName.toLowerCase() === vault);
  const isExplicitPath = reference.includes('/');
  if (isExplicitPath) {
    const canonicalPath = reference.replace(/^\/+/, '');
    const exactPaths = candidates.filter((file) =>
      extensionless(file.relativePath) === canonicalPath);
    if (exactPaths.length === 1) return { kind: 'resolved', target: exactPaths[0] };
    if (exactPaths.length > 1) {
      return { kind: 'ambiguous', candidates: sortByPath(exactPaths) };
    }
    return { kind: 'missing' };
  }
  const basenameMatches = candidates.filter((file) =>
    file.basename.toLowerCase() === reference);
  if (basenameMatches.length === 1) return { kind: 'resolved', target: basenameMatches[0] };
  if (basenameMatches.length > 1) {
    return { kind: 'ambiguous', candidates: sortByPath(basenameMatches) };
  }
  return { kind: 'missing' };
}

function sortByPath(files: IndexedFile[]): IndexedFile[] {
  return [...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
