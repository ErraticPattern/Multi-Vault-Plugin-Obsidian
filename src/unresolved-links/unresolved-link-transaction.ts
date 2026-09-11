import { applyTextEdits, StaleTextEditError } from '../migration/link-rewriter';
import type { SourceTextEdit } from './unresolved-link-planner';

export interface UnresolvedLinkIO {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
}

export interface UnresolvedLinkTransactionResult {
  changedPaths: string[];
  stalePaths: string[];
  convertedOccurrences: number;
  failure?: string;
  rollbackFailures: string[];
}

export async function executeUnresolvedLinkEdits(
  edits: SourceTextEdit[], io: UnresolvedLinkIO,
): Promise<UnresolvedLinkTransactionResult> {
  const grouped = new Map<string, SourceTextEdit[]>();
  for (const edit of edits) grouped.set(edit.sourcePath, [...(grouped.get(edit.sourcePath) ?? []), edit]);

  const originals = new Map<string, string>();
  const replacements = new Map<string, string>();
  const stalePaths: string[] = [];
  for (const [sourcePath, fileEdits] of grouped) {
    const content = await io.read(sourcePath);
    try {
      replacements.set(sourcePath, applyTextEdits(content, fileEdits));
      originals.set(sourcePath, content);
    } catch (error) {
      if (!(error instanceof StaleTextEditError)) throw error;
      stalePaths.push(sourcePath);
    }
  }

  const written: string[] = [];
  try {
    for (const [sourcePath, content] of replacements) {
      await io.write(sourcePath, content);
      written.push(sourcePath);
    }
  } catch (error) {
    const failedPath = [...replacements.keys()][written.length] ?? 'unknown note';
    const rollbackFailures: string[] = [];
    for (const sourcePath of [...written].reverse()) {
      try { await io.write(sourcePath, originals.get(sourcePath)!); }
      catch { rollbackFailures.push(sourcePath); }
    }
    return {
      changedPaths: [], stalePaths, convertedOccurrences: 0, rollbackFailures,
      failure: `Failed to write ${failedPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return {
    changedPaths: written,
    stalePaths,
    convertedOccurrences: written.reduce((count, path) => count + (grouped.get(path)?.length ?? 0), 0),
    rollbackFailures: [],
  };
}
