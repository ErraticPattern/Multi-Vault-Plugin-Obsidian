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

export async function collectSourceVaultSnapshot(app: App): Promise<NoteSnapshot[]> {
  const notes: NoteSnapshot[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    const content = await app.vault.read(file);
    const cache = app.metadataCache.getFileCache(file);
    const links = (cache?.links ?? []).map((reference) =>
      snapshotReference(app, file, content, reference, classifyLink(reference)));
    const embeds = (cache?.embeds ?? []).map((reference) =>
      snapshotReference(app, file, content, reference, 'embed'));
    notes.push({
      path: file.path,
      basename: file.basename,
      content,
      links: [...links, ...embeds]
        .sort((left, right) => left.startOffset - right.startOffset),
    });
  }
  return notes;
}
