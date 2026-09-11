import { describe, expect, it } from 'vitest';
import { executeUnresolvedLinkEdits } from '../src/unresolved-links/unresolved-link-transaction';
import type { SourceTextEdit } from '../src/unresolved-links/unresolved-link-planner';

const edit = (sourcePath: string, expected: string, replacement: string): SourceTextEdit => ({
  sourcePath, startOffset: 0, endOffset: expected.length, expected, replacement,
});

describe('unresolved link transaction', () => {
  it('applies edits and skips stale notes', async () => {
    const files = new Map([['A.md', '[[a]]'], ['B.md', 'changed']]);
    const result = await executeUnresolvedLinkEdits([
      edit('A.md', '[[a]]', '[[a@math]]'), edit('B.md', '[[b]]', '[[b@math]]'),
    ], { read: async path => files.get(path)!, write: async (path, content) => { files.set(path, content); } });
    expect(files.get('A.md')).toBe('[[a@math]]');
    expect(files.get('B.md')).toBe('changed');
    expect(result).toMatchObject({ changedPaths: ['A.md'], stalePaths: ['B.md'], convertedOccurrences: 1 });
  });

  it('restores prior writes when a later write fails', async () => {
    const files = new Map([['A.md', '[[a]]'], ['B.md', '[[b]]']]);
    let failing = true;
    const result = await executeUnresolvedLinkEdits([
      edit('A.md', '[[a]]', '[[a@math]]'), edit('B.md', '[[b]]', '[[b@math]]'),
    ], {
      read: async path => files.get(path)!,
      write: async (path, content) => {
        if (path === 'B.md' && failing) { failing = false; throw new Error('disk full'); }
        files.set(path, content);
      },
    });
    expect(files.get('A.md')).toBe('[[a]]');
    expect(result.failure).toContain('B.md');
    expect(result.changedPaths).toEqual([]);
  });
});
