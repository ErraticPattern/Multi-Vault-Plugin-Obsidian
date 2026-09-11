import { describe, expect, it } from 'vitest';
import { buildUnresolvedLinkPlan, createProposalEdits } from '../src/unresolved-links/unresolved-link-planner';
import type { IndexedFile } from '../src/types';

const indexed = (vaultId: string, vaultName: string, relativePath: string): IndexedFile => ({
  id: `${vaultId}:${relativePath}`, vaultId, vaultName, relativePath, absolutePath: `/${vaultName}/${relativePath}`,
  basename: relativePath.split('/').pop()!.replace(/\.md$/i, ''), extension: '.md', mtime: 1, size: 1,
});

describe('unresolved link planning', () => {
  const files = [
    indexed('ideas', 'ideas', 'Source.md'),
    indexed('math', 'mathematics', 'fusion.md'),
    indexed('math', 'mathematics', 'Archive/common.md'),
    indexed('hobbies', 'hobbies', 'common.md'),
  ];

  it('groups locally unresolved occurrences and resolves external candidates', () => {
    const plan = buildUnresolvedLinkPlan([{ path: 'A.md', content: '[[fusion]] and ![[fusion#Rate|plot]] [[local]] [[missing]]' }], files, {
      currentVaultId: 'ideas',
      isResolvedLocally: (_source, target) => target === 'local',
    });
    expect(plan.groups.map(group => [group.target, group.occurrences.length, group.candidates.length])).toEqual([
      ['fusion', 2, 1], ['missing', 1, 0],
    ]);
    expect(createProposalEdits(plan.groups[0], plan.groups[0].candidates[0], 'note-at-vault').map(edit => edit.replacement)).toEqual([
      '[[fusion@mathematics]]', '![[fusion@mathematics#Rate|plot]]',
    ]);
  });

  it('requires candidate choice for ambiguous basenames and supports explicit paths and colon format', () => {
    const plan = buildUnresolvedLinkPlan([{ path: 'A.md', content: '[[common]] [[Archive/common]]' }], files, {
      currentVaultId: 'ideas', isResolvedLocally: () => false,
    });
    const ambiguous = plan.groups.find(group => group.target === 'common')!;
    const explicit = plan.groups.find(group => group.target === 'Archive/common')!;
    expect(ambiguous.candidates).toHaveLength(2);
    expect(explicit.candidates).toHaveLength(1);
    expect(createProposalEdits(explicit, explicit.candidates[0], 'vault-double-colon', files)[0].replacement)
      .toBe('[[mathematics::common]]');
  });
});
