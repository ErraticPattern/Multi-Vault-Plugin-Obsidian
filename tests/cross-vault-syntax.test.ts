import { describe, expect, it } from 'vitest';

import {
  formatCrossVaultTarget,
  isCrossVaultTarget,
  parseCrossVaultTarget,
} from '../src/cross-vault-syntax';

const knownVaults = ['mathematics', 'medicine', 'hobbies'];
const isKnownVault = (name: string) => knownVaults.includes(name);

describe('parsing cross-vault link targets', () => {
  it('parses the vault::note form', () => {
    expect(parseCrossVaultTarget('mathematics::Claude', isKnownVault))
      .toEqual({ vaultName: 'mathematics', noteName: 'Claude' });
  });

  it('parses the note@vault form', () => {
    expect(parseCrossVaultTarget('Claude@mathematics', isKnownVault))
      .toEqual({ vaultName: 'mathematics', noteName: 'Claude' });
  });

  it('keeps folders in the note name', () => {
    expect(parseCrossVaultTarget('Glossary/Claude@mathematics', isKnownVault))
      .toEqual({ vaultName: 'mathematics', noteName: 'Glossary/Claude' });
  });

  it('strips the subpath from both forms', () => {
    expect(parseCrossVaultTarget('Claude@mathematics#Proof', isKnownVault)?.noteName).toBe('Claude');
    expect(parseCrossVaultTarget('mathematics::Claude#Proof', isKnownVault)?.noteName).toBe('Claude');
  });

  it('leaves an @ that does not name a vault as an ordinary link', () => {
    expect(parseCrossVaultTarget('joao@gmail.com', isKnownVault)).toBeNull();
    expect(parseCrossVaultTarget('Meeting@work', isKnownVault)).toBeNull();
    expect(parseCrossVaultTarget('@mathematics', isKnownVault)).toBeNull();
  });

  it('splits on the last @ so note names may contain one', () => {
    expect(parseCrossVaultTarget('user@host@medicine', isKnownVault))
      .toEqual({ vaultName: 'medicine', noteName: 'user@host' });
  });

  it('rejects anything that is not a cross-vault target', () => {
    expect(parseCrossVaultTarget('Ordinary Note', isKnownVault)).toBeNull();
    expect(parseCrossVaultTarget('', isKnownVault)).toBeNull();
    expect(parseCrossVaultTarget('::Claude', isKnownVault)).toBeNull();
  });

  it('accepts vault::note even when the vault is unknown, so a stale link still reads as cross-vault', () => {
    expect(parseCrossVaultTarget('retired::Claude', isKnownVault))
      .toEqual({ vaultName: 'retired', noteName: 'Claude' });
  });
});

describe('writing cross-vault link targets', () => {
  it('defaults to the note@vault form', () => {
    expect(formatCrossVaultTarget('mathematics', 'Claude')).toBe('Claude@mathematics');
  });

  it('writes the legacy form on request', () => {
    expect(formatCrossVaultTarget('mathematics', 'Claude', 'vault-double-colon'))
      .toBe('mathematics::Claude');
  });

  it('refuses to write an incomplete target', () => {
    expect(() => formatCrossVaultTarget('', 'Claude')).toThrow();
    expect(() => formatCrossVaultTarget('mathematics', '  ')).toThrow();
  });

  it('round-trips both formats', () => {
    for (const format of ['note-at-vault', 'vault-double-colon'] as const) {
      const written = formatCrossVaultTarget('medicine', 'Folder/Note', format);
      expect(parseCrossVaultTarget(written, isKnownVault))
        .toEqual({ vaultName: 'medicine', noteName: 'Folder/Note' });
    }
  });
});

describe('detecting links that already point elsewhere', () => {
  it('recognises both forms', () => {
    expect(isCrossVaultTarget('mathematics::Claude', isKnownVault)).toBe(true);
    expect(isCrossVaultTarget('Claude@mathematics', isKnownVault)).toBe(true);
    expect(isCrossVaultTarget('Claude', isKnownVault)).toBe(false);
  });
});
