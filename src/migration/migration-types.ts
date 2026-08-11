import type { IndexedNotePath } from './destination-paths';
import type { IndexMutation } from '../indexer/index-mutations';

export type MigrationMode = 'move' | 'copy' | 'relink';
export type DestinationPolicy = 'create-only' | 'overwrite-reviewed';
export type LinkKind = 'wikilink' | 'embed' | 'markdown';
export type SkippedLinkReason =
  | 'already-cross-vault'
  | 'attachment'
  | 'embed'
  | 'markdown-link'
  | 'self-link'
  | 'unresolved';

export interface LinkSnapshot {
  sourcePath: string;
  original: string;
  linkTarget: string;
  startOffset: number;
  endOffset: number;
  resolvedPath: string | null;
  kind: LinkKind;
}

export interface NoteSnapshot {
  path: string;
  basename: string;
  content: string;
  links: LinkSnapshot[];
}

export interface SkippedLink {
  sourcePath: string;
  original: string;
  reason: SkippedLinkReason;
}

export interface LinkRewritePreview {
  before: string;
  after: string;
}

export interface PlannedFileEdit {
  path: string;
  originalContent: string;
  updatedContent: string;
  rewrittenLinks: number;
  rewrites?: LinkRewritePreview[];
}

export interface TargetCatalogFingerprint {
  vaultId: string;
  targetRelativePath: string;
  sameBasenamePaths: string[];
}

export interface MigrationPlanFingerprint {
  sourceMtime: number;
  backlinks: Array<[sourcePath: string, count: number]>;
  target?: TargetCatalogFingerprint;
}

export interface MigrationPlan {
  mode: MigrationMode;
  sourcePath: string;
  sourceOriginalContent: string;
  destinationAbsolutePath: string | null;
  destinationRelativePath: string | null;
  destinationContent: string | null;
  destinationPolicy?: DestinationPolicy;
  destinationOriginalContent?: string | null;
  backlinkEdits: PlannedFileEdit[];
  outgoingLinksRewritten: number;
  backlinksRewritten: number;
  skipped: SkippedLink[];
  fingerprint?: MigrationPlanFingerprint;
  indexMutations?: IndexMutation[];
}

export interface MoveCopyPlanningInput {
  mode: 'move' | 'copy';
  sourcePath: string;
  sourceVaultName: string;
  targetVaultName: string;
  destinationAbsolutePath: string;
  destinationRelativePath: string;
  notes: NoteSnapshot[];
  sourceIndexedFiles: IndexedNotePath[];
  targetIndexedFiles: IndexedNotePath[];
  preserveLinks: boolean;
}

export interface RelinkPlanningInput {
  sourcePath: string;
  targetVaultName: string;
  targetRelativePath: string;
  notes: NoteSnapshot[];
  targetIndexedFiles: IndexedNotePath[];
}
