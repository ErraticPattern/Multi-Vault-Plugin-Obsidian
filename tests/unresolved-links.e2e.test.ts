import { describe, expect, it } from 'vitest';
import { buildUnresolvedLinkPlan, createProposalEdits } from '../src/unresolved-links/unresolved-link-planner';
import { executeUnresolvedLinkEdits } from '../src/unresolved-links/unresolved-link-transaction';
import type { IndexedFile } from '../src/types';

function indexed(vaultId: string, vaultName: string, relativePath: string): IndexedFile {
  return { id: `${vaultId}:${relativePath}`, vaultId, vaultName, relativePath, absolutePath: `/${vaultName}/${relativePath}`,
    basename: relativePath.split('/').pop()!.replace(/\.md$/, ''), extension: '.md', mtime: 1, size: 1 };
}

describe('unresolved cross-vault links E2E', () => {
  it('reviews and converts only selected current-vault links without creating notes', async () => {
    const notes = new Map([
      ['A.md', 'Study [[fusion]] and ![[fusion#Rate|plot]]. Keep [[unknown]].'],
      ['B.md', 'Related [[fusion]]. Ambiguous [[common]].'],
    ]);
    const catalog = [
      indexed('ideas', 'ideas', 'A.md'), indexed('ideas', 'ideas', 'B.md'),
      indexed('math', 'mathematics', 'fusion.md'), indexed('math', 'mathematics', 'common.md'),
      indexed('hobby', 'hobbies', 'common.md'),
    ];
    const plan = buildUnresolvedLinkPlan([...notes].map(([path, content]) => ({ path, content })), catalog, {
      currentVaultId: 'ideas', isResolvedLocally: () => false,
    });
    const fusion = plan.groups.find(group => group.target === 'fusion')!;
    expect(fusion.occurrences).toHaveLength(3);
    expect(plan.groups.find(group => group.target === 'common')!.candidates).toHaveLength(2);
    expect(plan.groups.find(group => group.target === 'unknown')!.candidates).toHaveLength(0);

    const result = await executeUnresolvedLinkEdits(
      createProposalEdits(fusion, fusion.candidates[0], 'note-at-vault', catalog),
      { read: async path => notes.get(path)!, write: async (path, content) => { notes.set(path, content); } },
    );
    expect(result.convertedOccurrences).toBe(3);
    expect(notes.get('A.md')).toBe('Study [[fusion@mathematics]] and ![[fusion@mathematics#Rate|plot]]. Keep [[unknown]].');
    expect(notes.get('B.md')).toBe('Related [[fusion@mathematics]]. Ambiguous [[common]].');
    expect(notes.has('fusion.md')).toBe(false);

    const rescanned = buildUnresolvedLinkPlan([...notes].map(([path, content]) => ({ path, content })), catalog, {
      currentVaultId: 'ideas', isResolvedLocally: () => false,
    });
    expect(rescanned.groups.some(group => group.target === 'fusion')).toBe(false);
  });
});
