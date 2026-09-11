import { formatCrossVaultTarget, type CrossVaultLinkFormat } from '../cross-vault-syntax';
import type { TextEdit } from '../migration/link-rewriter';
import type { IndexedFile } from '../types';
import { parseWikilinkOccurrences, type WikilinkOccurrence } from './unresolved-link-parser';
import { resolveExternalCandidates, shortestUnambiguousReference } from './unresolved-link-resolver';

export interface SourceSnapshot { path: string; content: string }
export interface PlannedOccurrence extends WikilinkOccurrence { sourcePath: string }
export interface UnresolvedLinkGroup {
  id: string;
  target: string;
  occurrences: PlannedOccurrence[];
  candidates: IndexedFile[];
}
export interface UnresolvedLinkPlan { groups: UnresolvedLinkGroup[]; files: IndexedFile[] }
export interface SourceTextEdit extends TextEdit { sourcePath: string }

export function buildUnresolvedLinkPlan(
  sources: SourceSnapshot[],
  files: IndexedFile[],
  options: { currentVaultId: string; isResolvedLocally(sourcePath: string, linkpath: string): boolean },
): UnresolvedLinkPlan {
  const groups = new Map<string, UnresolvedLinkGroup>();
  for (const source of sources) {
    for (const occurrence of parseWikilinkOccurrences(source.content)) {
      if (options.isResolvedLocally(source.path, occurrence.linkpath)) continue;
      const key = occurrence.linkpath.trim().toLowerCase();
      let group = groups.get(key);
      if (!group) {
        group = {
          id: key,
          target: occurrence.linkpath,
          occurrences: [],
          candidates: resolveExternalCandidates(files, options.currentVaultId, occurrence.linkpath),
        };
        groups.set(key, group);
      }
      group.occurrences.push({ ...occurrence, sourcePath: source.path });
    }
  }
  return { groups: [...groups.values()].sort((a, b) => a.target.localeCompare(b.target)), files };
}

export function createProposalEdits(
  group: UnresolvedLinkGroup,
  candidate: IndexedFile,
  format: CrossVaultLinkFormat,
  allFiles: IndexedFile[] = group.candidates,
): SourceTextEdit[] {
  const noteReference = shortestUnambiguousReference(candidate, allFiles);
  return group.occurrences.map(occurrence => {
    const target = formatCrossVaultTarget(candidate.vaultName, noteReference, format) + occurrence.subpath;
    const brackets = `[[${target}${occurrence.alias}]]`;
    return {
      sourcePath: occurrence.sourcePath,
      startOffset: occurrence.startOffset,
      endOffset: occurrence.endOffset,
      expected: occurrence.original,
      replacement: occurrence.embed ? `!${brackets}` : brackets,
    };
  });
}
