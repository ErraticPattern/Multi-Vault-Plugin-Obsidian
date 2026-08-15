import { describe, expect, it } from 'vitest';
import type { TFile } from 'obsidian';

import { applyUnlink, planUnlink, type UnlinkIo } from '../src/unlink-commands';

/** A TFile is only ever used here for its path. */
function tfile(path: string): TFile {
  return { path, extension: 'md', basename: path.replace(/\.md$/, '') } as TFile;
}

const known = (vaultName: string) => ['hobbies', 'mathematics'].includes(vaultName);

/** An in-memory vault, so planning and writing can be tested without Obsidian. */
function fakeIo(files: Record<string, string>): UnlinkIo & { files: Record<string, string> } {
  return {
    files,
    markdownFiles: () => Object.keys(files).map((path) => tfile(path)),
    read: async (file: TFile) => files[file.path] ?? '',
    write: async (file: TFile, expected: string, next: string) => {
      if (files[file.path] !== expected) return false;
      files[file.path] = next;
      return true;
    },
  };
}

describe('planning a vault-wide removal', () => {
  it('counts only the notes that actually change', async () => {
    const io = fakeIo({
      'Dashboard.md': 'Serves [[As@hobbies|as]] the [[Chemistry|chemistry]] store.',
      'Plain.md': 'Only a [[Local Note]] here.',
      'Empty.md': 'No links at all.',
    });

    const plan = await planUnlink(io, io.markdownFiles(), known);

    expect(plan.notes.map((note) => note.file.path)).toEqual(['Dashboard.md']);
    expect(plan.totalLinks).toBe(1);
    expect(plan.notes[0].text).toBe('Serves as the [[Chemistry|chemistry]] store.');
  });

  it('writes the planned text and skips notes edited since the scan', async () => {
    const io = fakeIo({
      'A.md': 'One [[A@hobbies|a]].',
      'B.md': 'Two [[B@hobbies|b]].',
    });
    const plan = await planUnlink(io, io.markdownFiles(), known);
    io.files['B.md'] = 'Someone typed here [[B@hobbies|b]].';

    const result = await applyUnlink(io, plan);

    expect(result).toEqual({ written: 1, skipped: 1 });
    expect(io.files['A.md']).toBe('One a.');
    expect(io.files['B.md']).toBe('Someone typed here [[B@hobbies|b]].');
  });
});
