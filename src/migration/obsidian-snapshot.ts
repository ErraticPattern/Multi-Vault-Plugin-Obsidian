import type { App, Reference, ReferenceCache, TFile } from 'obsidian';
import type { LinkKind, LinkSnapshot, NoteSnapshot } from './migration-types';

function snapshotReference(
  app: App,
  file: TFile,
  content: string,
  reference: ReferenceCache,
  kind: LinkKind,
): LinkSnapshot {
  const startOffset = reference.position.start.offset;
  const endOffset = reference.position.end.offset;
  const resolved = app.metadataCache.getFirstLinkpathDest(reference.link, file.path);
  return {
    sourcePath: file.path,
    original: content.slice(startOffset, endOffset),
    linkTarget: reference.link,
    startOffset,
    endOffset,
    resolvedPath: resolved?.path ?? null,
    kind,
  };
}

function classifyLink(reference: Reference): LinkKind {
  return reference.original.startsWith('[[') ? 'wikilink' : 'markdown';
}

async function snapshotNote(app: App, file: TFile): Promise<NoteSnapshot> {
  const content = await app.vault.read(file);
  const cache = app.metadataCache.getFileCache(file);
  const links = (cache?.links ?? []).map((reference) =>
    snapshotReference(app, file, content, reference, classifyLink(reference)));
  const embeds = (cache?.embeds ?? []).map((reference) =>
    snapshotReference(app, file, content, reference, 'embed'));
  return {
    path: file.path,
    basename: file.basename,
    content,
    links: [...links, ...embeds]
      .sort((left, right) => left.startOffset - right.startOffset),
  };
}

export async function collectMigrationSnapshot(
  app: App,
  sourcePath: string,
): Promise<NoteSnapshot[]> {
  const paths = new Set([sourcePath]);
  for (const [candidatePath, destinations] of Object.entries(app.metadataCache.resolvedLinks)) {
    if ((destinations[sourcePath] ?? 0) > 0) paths.add(candidatePath);
  }
  const notes: NoteSnapshot[] = [];
  for (const filePath of [...paths].sort()) {
    const file = app.vault.getFileByPath(filePath);
    if (file) notes.push(await snapshotNote(app, file));
  }
  return notes;
}
