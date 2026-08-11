import type {
  MigrationPlan,
  MigrationPlanFingerprint,
  TargetCatalogFingerprint,
} from './migration-types';
import type { IndexedNotePath } from './destination-paths';
export type { MigrationPlanFingerprint, TargetCatalogFingerprint } from './migration-types';

export type ResolvedLinks = Record<string, Record<string, number>>;

export function createMigrationPlanFingerprint(
  sourcePath: string,
  sourceMtime: number,
  resolvedLinks: ResolvedLinks,
): MigrationPlanFingerprint {
  const backlinks = Object.entries(resolvedLinks)
    .map(([candidatePath, destinations]) =>
      [candidatePath, destinations[sourcePath] ?? 0] as [string, number])
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  return { sourceMtime, backlinks };
}

export function createTargetCatalogFingerprint(
  vaultId: string,
  targetRelativePath: string,
  indexedFiles: IndexedNotePath[],
): TargetCatalogFingerprint {
  const targetBasename = targetRelativePath.replace(/\\/g, '/').replace(/\.md$/i, '')
    .split('/').pop()!.toLowerCase();
  const sameBasenamePaths = indexedFiles
    .filter((file) => file.basename.toLowerCase() === targetBasename)
    .map((file) => file.relativePath.replace(/\\/g, '/'))
    .sort((left, right) => left.localeCompare(right));
  return { vaultId, targetRelativePath, sameBasenamePaths };
}

export function isTargetCatalogFingerprintCurrent(
  fingerprint: TargetCatalogFingerprint,
  indexedFiles: IndexedNotePath[],
): boolean {
  const current = createTargetCatalogFingerprint(
    fingerprint.vaultId,
    fingerprint.targetRelativePath,
    indexedFiles,
  );
  return JSON.stringify(current.sameBasenamePaths) ===
    JSON.stringify(fingerprint.sameBasenamePaths);
}

export function isMigrationPlanFingerprintCurrent(
  fingerprint: MigrationPlanFingerprint,
  sourcePath: string,
  sourceMtime: number,
  resolvedLinks: ResolvedLinks,
): boolean {
  if (fingerprint.sourceMtime !== sourceMtime) return false;
  const current = createMigrationPlanFingerprint(sourcePath, sourceMtime, resolvedLinks);
  return JSON.stringify(current.backlinks) === JSON.stringify(fingerprint.backlinks);
}

export function isMigrationPlanDestinationCurrent(
  plan: MigrationPlan,
  destinationExists: boolean,
  destinationOriginalContent: string | null,
): boolean {
  if (!plan.destinationAbsolutePath) return true;
  if (plan.destinationPolicy === 'overwrite-reviewed') {
    return destinationExists && destinationOriginalContent === (plan.destinationOriginalContent ?? null);
  }
  return !destinationExists;
}

export class PreparedPlanCache {
  private entry: { key: string; plan: MigrationPlan } | null = null;
  private pending: { key: string; promise: Promise<MigrationPlan> } | null = null;
  private generation = 0;

  store(key: string, plan: MigrationPlan): void {
    this.entry = { key, plan };
  }

  get(key: string, isCurrent: (plan: MigrationPlan) => boolean): MigrationPlan | null {
    if (!this.entry || this.entry.key !== key || !isCurrent(this.entry.plan)) {
      this.entry = null;
      return null;
    }
    return this.entry.plan;
  }

  async getOrPrepare(
    key: string,
    isCurrent: (plan: MigrationPlan) => boolean,
    prepare: () => Promise<MigrationPlan>,
  ): Promise<MigrationPlan> {
    const current = this.get(key, isCurrent);
    if (current) return current;
    if (this.pending?.key === key) return this.pending.promise;
    const generation = this.generation;
    const promise = prepare().then((plan) => {
      if (this.generation === generation) this.store(key, plan);
      return plan;
    }).finally(() => {
      if (this.pending?.promise === promise) this.pending = null;
    });
    this.pending = { key, promise };
    return promise;
  }

  invalidate(): void {
    this.generation += 1;
    this.entry = null;
    this.pending = null;
  }
}
