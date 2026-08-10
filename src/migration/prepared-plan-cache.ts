import type { MigrationPlan, MigrationPlanFingerprint } from './migration-types';
export type { MigrationPlanFingerprint } from './migration-types';

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
