import type { MigrationPlan, SkippedLinkReason } from './migration-types';
import type { IndexedFile } from '../types';

export interface MigrationReviewModel {
  destination: string | null;
  overwritesDestination: boolean;
  destinationOriginalBytes: number | null;
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

export function isMarkdownExtension(extension: string): boolean {
  return extension.replace(/^\./, '').toLowerCase() === 'md';
}

export function getTargetNoteSuggestions(files: IndexedFile[], vaultId: string): IndexedFile[] {
  return files
    .filter((file) => file.vaultId === vaultId && isMarkdownExtension(file.extension))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export interface RelinkPreviewModel {
  backlinks: number;
  affectedFiles: number;
  examples: Array<{ sourcePath: string; before: string; after: string }>;
}

export function makeRelinkPreviewModel(plan: MigrationPlan): RelinkPreviewModel {
  return {
    backlinks: plan.backlinksRewritten,
    affectedFiles: plan.backlinkEdits.length,
    examples: plan.backlinkEdits.flatMap((edit) =>
      (edit.rewrites ?? []).map((rewrite) => ({
        sourcePath: edit.path,
        before: rewrite.before,
        after: rewrite.after,
      }))),
  };
}

export function makeMigrationReviewModel(plan: MigrationPlan): MigrationReviewModel {
  const skippedByReason: Partial<Record<SkippedLinkReason, number>> = {};
  for (const item of plan.skipped) {
    skippedByReason[item.reason] = (skippedByReason[item.reason] ?? 0) + 1;
  }
  return {
    destination: plan.destinationRelativePath,
    overwritesDestination: plan.destinationPolicy === 'overwrite-reviewed',
    destinationOriginalBytes: plan.destinationOriginalContent == null
      ? null
      : Buffer.byteLength(plan.destinationOriginalContent, 'utf8'),
    outgoingLinks: plan.outgoingLinksRewritten,
    backlinks: plan.backlinksRewritten,
    affectedFiles: plan.backlinkEdits.length,
    affectedPaths: plan.backlinkEdits.map((edit) => edit.path),
    skippedByReason,
  };
}
