import type { IndexedFile } from '../types';

function extensionless(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.md$/i, '').toLowerCase();
}

export function resolveExternalCandidates(files: IndexedFile[], currentVaultId: string, linkpath: string): IndexedFile[] {
  const reference = extensionless(linkpath);
  const explicit = reference.includes('/');
  return files.filter(file => {
    if (file.vaultId === currentVaultId || file.extension.toLowerCase() !== '.md') return false;
    return explicit
      ? extensionless(file.relativePath) === reference
      : file.basename.toLowerCase() === reference;
  }).sort((left, right) => left.vaultName.localeCompare(right.vaultName) || left.relativePath.localeCompare(right.relativePath));
}

export function shortestUnambiguousReference(candidate: IndexedFile, files: IndexedFile[]): string {
  const duplicates = files.filter(file => file.vaultId === candidate.vaultId
    && file.extension.toLowerCase() === '.md'
    && file.basename.toLowerCase() === candidate.basename.toLowerCase());
  return duplicates.length === 1
    ? candidate.basename
    : candidate.relativePath.replace(/\.md$/i, '');
}
