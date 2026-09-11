import { describe, expect, it } from 'vitest';
import { UnresolvedLinksViewModel } from '../src/unresolved-links/unresolved-links-view-model';
import type { UnresolvedLinkPlan } from '../src/unresolved-links/unresolved-link-planner';

const plan: UnresolvedLinkPlan = { files: [], groups: [
  { id: 'unique', target: 'unique', occurrences: [], candidates: [{ id: 'm:a', vaultId: 'm', vaultName: 'math', relativePath: 'a.md', absolutePath: '', basename: 'a', extension: '.md', mtime: 1, size: 1 }] },
  { id: 'ambiguous', target: 'ambiguous', occurrences: [], candidates: [
    { id: 'm:b', vaultId: 'm', vaultName: 'math', relativePath: 'b.md', absolutePath: '', basename: 'b', extension: '.md', mtime: 1, size: 1 },
    { id: 'h:b', vaultId: 'h', vaultName: 'hobbies', relativePath: 'b.md', absolutePath: '', basename: 'b', extension: '.md', mtime: 1, size: 1 },
  ] },
  { id: 'missing', target: 'missing', occurrences: [], candidates: [] },
] };

describe('UnresolvedLinksViewModel', () => {
  it('selects unique matches by default and requires a choice for ambiguity', () => {
    const model = new UnresolvedLinksViewModel(plan);
    expect(model.selected()).toEqual([{ groupId: 'unique', candidateId: 'm:a' }]);
    model.choose('ambiguous', 'h:b');
    expect(model.selected()).toContainEqual({ groupId: 'ambiguous', candidateId: 'h:b' });
    model.clear();
    expect(model.selected()).toEqual([]);
    model.selectAllUnambiguous();
    expect(model.selected()).toEqual([{ groupId: 'unique', candidateId: 'm:a' }]);
  });
});
