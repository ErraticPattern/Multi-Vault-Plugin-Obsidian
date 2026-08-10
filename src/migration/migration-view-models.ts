import type { MigrationPlan, SkippedLinkReason } from './migration-types';
import type { IndexedFile } from '../types';

export interface MigrationReviewModel {
  destination: string | null;
  outgoingLinks: number;
  backlinks: number;
  affectedFiles: number;
  affectedPaths: string[];
  skippedByReason: Partial<Record<SkippedLinkReason, number>>;
}

export function getFolderSuggestions(folders: string[]): string[] {
  return [...new Set(folders)].sort((left, right) => {
    if (left === '/') return -1;
    if (right === '/') return 1;
    return left.localeCompare(right);
  });
}

export function getTargetNoteSuggestions(files: IndexedFile[], vaultId: string): IndexedFile[] {
  return files
    .filter((file) => file.vaultId === vaultId && file.extension.toLowerCase() === 'md')
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function makeMigrationReviewModel(plan: MigrationPlan): MigrationReviewModel {
  const skippedByReason: Partial<Record<SkippedLinkReason, number>> = {};
  for (const item of plan.skipped) {
    skippedByReason[item.reason] = (skippedByReason[item.reason] ?? 0) + 1;
  }
  return {
    destination: plan.destinationRelativePath,
    outgoingLinks: plan.outgoingLinksRewritten,
    backlinks: plan.backlinksRewritten,
    affectedFiles: plan.backlinkEdits.length,
    affectedPaths: plan.backlinkEdits.map((edit) => edit.path),
    skippedByReason,
  };
}
