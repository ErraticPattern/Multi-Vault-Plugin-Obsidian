import { describe, expect, it } from 'vitest';
import {
  createMigrationPlanFingerprint,
  createTargetCatalogFingerprint,
  isMigrationPlanFingerprintCurrent,
  isTargetCatalogFingerprintCurrent,
  PreparedPlanCache,
} from '../src/migration/prepared-plan-cache';
import type { MigrationPlan } from '../src/migration/migration-types';

const plan = {
  mode: 'relink',
  sourcePath: 'Lab/README.md',
  sourceOriginalContent: 'Lab.',
  destinationAbsolutePath: null,
  destinationRelativePath: null,
  destinationContent: null,
  backlinkEdits: [],
  outgoingLinksRewritten: 0,
  backlinksRewritten: 0,
  skipped: [],
} as MigrationPlan;

describe('PreparedPlanCache', () => {
  it('reuses only a current plan with the same target key', () => {
    const cache = new PreparedPlanCache();
    cache.store('medicine:', plan);

    expect(cache.get('medicine:', () => true)).toBe(plan);
    expect(cache.get('mathematics:', () => true)).toBeNull();

    cache.store('medicine:', plan);
    expect(cache.get('medicine:', () => false)).toBeNull();
    expect(cache.get('medicine:', () => true)).toBeNull();
  });

  it('coalesces concurrent preparation for the same target', async () => {
    const cache = new PreparedPlanCache();
    let preparations = 0;
    const prepare = async () => { preparations += 1; return plan; };

    const [first, second] = await Promise.all([
      cache.getOrPrepare('medicine:', () => true, prepare),
      cache.getOrPrepare('medicine:', () => true, prepare),
    ]);

    expect(first).toBe(plan);
    expect(second).toBe(plan);
    expect(preparations).toBe(1);
  });
});

describe('migration plan fingerprints', () => {
  it('tracks exact backlink paths and counts without confusing duplicate basenames', () => {
    const resolvedLinks = {
      'Root index.md': { 'README.md': 2 },
      'Lab index.md': { 'Lab/README.md': 1 },
      'Unrelated.md': { 'Other.md': 4 },
    };
    const fingerprint = createMigrationPlanFingerprint(
      'Lab/README.md',
      123,
      resolvedLinks,
    );

    expect(fingerprint).toEqual({
      sourceMtime: 123,
      backlinks: [['Lab index.md', 1]],
    });
    expect(isMigrationPlanFingerprintCurrent(
      fingerprint,
      'Lab/README.md',
      123,
      resolvedLinks,
    )).toBe(true);
    expect(isMigrationPlanFingerprintCurrent(
      fingerprint,
      'Lab/README.md',
      124,
      resolvedLinks,
    )).toBe(false);
  });

  it('invalidates when resolved backlink metadata changes', () => {
    const fingerprint = createMigrationPlanFingerprint('Source.md', 1, {
      'Index.md': { 'Source.md': 1 },
    });

    expect(isMigrationPlanFingerprintCurrent(fingerprint, 'Source.md', 1, {
      'Index.md': { 'Source.md': 2 },
    })).toBe(false);
  });

  it('invalidates when a new target-vault basename collision appears', () => {
    const target = createTargetCatalogFingerprint(
      'medicine',
      'Notes/README.md',
      [{ relativePath: 'Notes/README.md', basename: 'README' }],
    );

    expect(isTargetCatalogFingerprintCurrent(target, [
      { relativePath: 'Notes/README.md', basename: 'README' },
    ])).toBe(true);
    expect(isTargetCatalogFingerprintCurrent(target, [
      { relativePath: 'Notes/README.md', basename: 'README' },
      { relativePath: 'Archive/README.md', basename: 'README' },
    ])).toBe(false);
  });
});
