import {
  chooseCrossVaultNotePath,
  type IndexedNotePath,
} from './destination-paths';
import {
  applyTextEdits,
  rewriteWikilinkOriginal,
  splitLinkSubpath,
  type TextEdit,
} from './link-rewriter';
import type {
  LinkSnapshot,
  MigrationPlan,
  MoveCopyPlanningInput,
  NoteSnapshot,
  PlannedFileEdit,
  RelinkPlanningInput,
  SkippedLink,
  SkippedLinkReason,
} from './migration-types';

export type {
  LinkSnapshot,
  MigrationPlan,
  MoveCopyPlanningInput,
  NoteSnapshot,
  PlannedFileEdit,
  RelinkPlanningInput,
  SkippedLink,
} from './migration-types';

function skipped(reference: LinkSnapshot, reason: SkippedLinkReason): SkippedLink {
  return {
    sourcePath: reference.sourcePath,
    original: reference.original,
    reason,
  };
}

function classifyIneligible(reference: LinkSnapshot, activeSourcePath: string): SkippedLinkReason | null {
  if (reference.kind === 'embed') return 'embed';
  if (reference.kind === 'markdown') return 'markdown-link';
  const { linkpath } = splitLinkSubpath(reference.linkTarget);
  if (linkpath.includes('::')) return 'already-cross-vault';
  if (!reference.resolvedPath) return 'unresolved';
  if (reference.resolvedPath === activeSourcePath) return 'self-link';
  if (!reference.resolvedPath.toLowerCase().endsWith('.md')) return 'attachment';
  return null;
}

function replacementFor(
  reference: LinkSnapshot,
  vaultName: string,
  resolvedPath: string,
  indexedFiles: IndexedNotePath[],
): string | null {
  const notePath = chooseCrossVaultNotePath(resolvedPath, indexedFiles);
  const { subpath } = splitLinkSubpath(reference.linkTarget);
  return rewriteWikilinkOriginal(reference.original, `${vaultName}::${notePath}${subpath}`);
}

function makeEdit(reference: LinkSnapshot, replacement: string): TextEdit {
  return {
    startOffset: reference.startOffset,
    endOffset: reference.endOffset,
    expected: reference.original,
    replacement,
  };
}

function planOutgoing(
  sourceNote: NoteSnapshot,
  sourceVaultName: string,
  sourceIndexedFiles: IndexedNotePath[],
): { content: string; count: number; skipped: SkippedLink[] } {
  const edits: TextEdit[] = [];
  const skippedLinks: SkippedLink[] = [];

  for (const reference of sourceNote.links) {
    const reason = classifyIneligible(reference, sourceNote.path);
    if (reason) {
      skippedLinks.push(skipped(reference, reason));
      continue;
    }
    const replacement = replacementFor(
      reference,
      sourceVaultName,
      reference.resolvedPath!,
      sourceIndexedFiles,
    );
    if (!replacement) {
      skippedLinks.push(skipped(reference, 'markdown-link'));
      continue;
    }
    edits.push(makeEdit(reference, replacement));
  }

  return {
    content: applyTextEdits(sourceNote.content, edits),
    count: edits.length,
    skipped: skippedLinks,
  };
}

function planBacklinks(
  notes: NoteSnapshot[],
  sourcePath: string,
  targetVaultName: string,
  targetRelativePath: string,
  targetIndexedFiles: IndexedNotePath[],
): { edits: PlannedFileEdit[]; count: number; skipped: SkippedLink[] } {
  const targetNotePath = chooseCrossVaultNotePath(targetRelativePath, targetIndexedFiles);
  const planned: PlannedFileEdit[] = [];
  const skippedLinks: SkippedLink[] = [];
  let count = 0;

  for (const note of notes) {
    if (note.path === sourcePath) continue;
    const edits: TextEdit[] = [];
    for (const reference of note.links) {
      if (reference.resolvedPath !== sourcePath) continue;
      if (reference.kind === 'embed') {
        skippedLinks.push(skipped(reference, 'embed'));
        continue;
      }
      if (reference.kind === 'markdown') {
        skippedLinks.push(skipped(reference, 'markdown-link'));
        continue;
      }
      const { subpath } = splitLinkSubpath(reference.linkTarget);
      const replacement = rewriteWikilinkOriginal(
        reference.original,
        `${targetVaultName}::${targetNotePath}${subpath}`,
      );
      if (!replacement) {
        skippedLinks.push(skipped(reference, 'markdown-link'));
        continue;
      }
      edits.push(makeEdit(reference, replacement));
    }
    if (edits.length === 0) continue;
    planned.push({
      path: note.path,
      originalContent: note.content,
      updatedContent: applyTextEdits(note.content, edits),
      rewrittenLinks: edits.length,
    });
    count += edits.length;
  }

  return { edits: planned, count, skipped: skippedLinks };
}

function findSource(notes: NoteSnapshot[], sourcePath: string): NoteSnapshot {
  const source = notes.find((note) => note.path === sourcePath);
  if (!source) throw new Error(`Source note not found in snapshot: ${sourcePath}`);
  return source;
}

export function planMoveOrCopy(input: MoveCopyPlanningInput): MigrationPlan {
  const source = findSource(input.notes, input.sourcePath);
  if (!input.preserveLinks) {
    return {
      mode: input.mode,
      sourcePath: input.sourcePath,
      sourceOriginalContent: source.content,
      destinationAbsolutePath: input.destinationAbsolutePath,
      destinationRelativePath: input.destinationRelativePath,
      destinationContent: source.content,
      backlinkEdits: [],
      outgoingLinksRewritten: 0,
      backlinksRewritten: 0,
      skipped: [],
    };
  }

  const outgoing = planOutgoing(source, input.sourceVaultName, input.sourceIndexedFiles);
  const backlinks = input.mode === 'move'
    ? planBacklinks(
        input.notes,
        input.sourcePath,
        input.targetVaultName,
        input.destinationRelativePath,
        input.targetIndexedFiles,
      )
    : { edits: [], count: 0, skipped: [] };

  return {
    mode: input.mode,
    sourcePath: input.sourcePath,
    sourceOriginalContent: source.content,
    destinationAbsolutePath: input.destinationAbsolutePath,
    destinationRelativePath: input.destinationRelativePath,
    destinationContent: outgoing.content,
    backlinkEdits: backlinks.edits,
    outgoingLinksRewritten: outgoing.count,
    backlinksRewritten: backlinks.count,
    skipped: [...outgoing.skipped, ...backlinks.skipped],
  };
}

export function planStandaloneRelink(input: RelinkPlanningInput): MigrationPlan {
  const source = findSource(input.notes, input.sourcePath);
  const backlinks = planBacklinks(
    input.notes,
    input.sourcePath,
    input.targetVaultName,
    input.targetRelativePath,
    input.targetIndexedFiles,
  );
  return {
    mode: 'relink',
    sourcePath: input.sourcePath,
    sourceOriginalContent: source.content,
    destinationAbsolutePath: null,
    destinationRelativePath: null,
    destinationContent: null,
    backlinkEdits: backlinks.edits,
    outgoingLinksRewritten: 0,
    backlinksRewritten: backlinks.count,
    skipped: backlinks.skipped,
  };
}
