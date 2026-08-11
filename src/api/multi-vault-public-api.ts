import type { FileOpener } from '../file-opener';
import type { Indexer } from '../indexer/indexer';
import { isMarkdownExtension } from '../migration/migration-view-models';
import { formatCrossVaultWikilink } from '../migration/cross-vault-link';
import { resolveIndexedNote } from '../note-resolution';
import type { MultiVaultSettings, IndexedFile, VaultConfig } from '../types';
import type { VaultRegistry } from '../vault-registry';
import type { VirtualLinkColorMode } from '../shared-settings/shared-settings-types';
import type {
  MultiVaultApiEvent,
  MultiVaultPublicApiV1,
  TargetReference,
  TargetResolution,
  VaultDescriptor,
  VaultIdentity,
  VirtualLinkIntegrationSettings,
  VirtualLinkTarget,
} from './public-api-types';

const VALID_COLOR = /^#[0-9a-f]{6}$/i;
const VALID_COLOR_MODES: readonly VirtualLinkColorMode[] = [
  'off',
  'muted-text',
  'colored-underline',
  'soft-pill',
];
const DISABLED_SETTINGS: VirtualLinkIntegrationSettings = {
  enabled: false,
  colorMode: 'off',
  colorIntensity: 55,
};

type PublicApiVaultRegistry = Pick<VaultRegistry, 'getCurrentVaultId' | 'getVaultById'>;
type PublicApiIndexer = Pick<Indexer, 'getIndexedFiles' | 'onCatalogChanged'>;
type PublicApiFileOpener = Pick<FileOpener, 'openFile'>;
type ApiListener = (event: MultiVaultApiEvent) => void;

interface ProjectedFile {
  indexedFile: IndexedFile;
  resolverFile: IndexedFile;
  target: VirtualLinkTarget;
}

function validColor(color: string | undefined): string | undefined {
  return color !== undefined && VALID_COLOR.test(color) ? color : undefined;
}

function normalizeAliases(value: unknown): string[] {
  const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const candidate of values) {
    if (typeof candidate !== 'string') continue;
    const alias = candidate.trim();
    const key = alias.toLowerCase();
    if (!alias || seen.has(key)) continue;
    seen.add(key);
    aliases.push(alias);
  }
  return aliases;
}

function foldRelativePath(relativePath: string, platform: NodeJS.Platform): string {
  const normalized = relativePath.replace(/\\/g, '/');
  // Only Windows guarantees case-insensitive paths; folding elsewhere would conflate
  // notes that a case-sensitive filesystem keeps distinct.
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function withoutMarkdownExtension(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/\.md$/i, '');
}

function withOptionalColor<T extends object>(value: T, color: string | undefined): T & { color?: string } {
  return color === undefined ? value : { ...value, color };
}

export class MultiVaultPublicApi implements MultiVaultPublicApiV1 {
  readonly apiVersion = 1 as const;

  private readonly listeners = new Set<ApiListener>();
  private readonly unsubscribeIndexer: () => void;
  private disposed = false;
  private eventFlushScheduled = false;
  private catalogEventPending = false;
  private appearanceEventPending = false;
  private catalogFingerprint: string;
  private appearanceFingerprint: string;

  constructor(
    private readonly settings: MultiVaultSettings,
    private readonly vaultRegistry: PublicApiVaultRegistry,
    private readonly indexer: PublicApiIndexer,
    private readonly fileOpener: PublicApiFileOpener,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.catalogFingerprint = this.computeCatalogFingerprint();
    this.appearanceFingerprint = this.computeAppearanceFingerprint();
    this.unsubscribeIndexer = this.indexer.onCatalogChanged(() => {
      this.scheduleEvent('catalog-changed');
    });
  }

  getCurrentVault(): VaultDescriptor | null {
    if (this.disposed) return null;
    const vault = this.currentVault();
    if (!vault) return null;
    return withOptionalColor({
      vaultId: vault.id,
      vaultName: vault.name,
    }, validColor(vault.color));
  }

  getVirtualLinkSettings(): VirtualLinkIntegrationSettings {
    if (this.disposed) return { ...DISABLED_SETTINGS };
    const configured = this.settings.virtualLinks;
    if (!configured) return { ...DISABLED_SETTINGS };

    const sourceVaultId = this.vaultRegistry.getCurrentVaultId();
    const excludedSourceVaultIds = Array.isArray(configured.excludedSourceVaultIds)
      ? configured.excludedSourceVaultIds
      : [];
    const sourceEnabled = sourceVaultId !== null
      && !excludedSourceVaultIds.includes(sourceVaultId);
    const colorMode = VALID_COLOR_MODES.includes(configured.colorMode)
      ? configured.colorMode
      : DISABLED_SETTINGS.colorMode;
    const intensity = Number.isFinite(configured.colorIntensity)
      ? Math.min(90, Math.max(10, Math.round(configured.colorIntensity)))
      : DISABLED_SETTINGS.colorIntensity;
    return {
      // Integration is only effectively enabled when this source vault actually has
      // at least one valid, selectable external target vault.
      enabled: configured.enabled === true
        && sourceEnabled
        && this.effectiveTargetVaultIds().length > 0,
      colorMode,
      colorIntensity: intensity,
    };
  }

  listVirtualLinkTargets(): VirtualLinkTarget[] {
    return this.projectedFiles().map(({ target }) => ({
      ...target,
      identity: { ...target.identity },
      aliases: [...target.aliases],
    }));
  }

  resolveTarget(reference: TargetReference): TargetResolution {
    const projected = this.projectedFiles();
    if (projected.length === 0) return { kind: 'missing' };
    const resolution = resolveIndexedNote(
      projected.map(({ resolverFile }) => resolverFile),
      reference.vaultName,
      reference.noteRef,
    );
    if (resolution.kind === 'missing') return resolution;

    const targets = new Map(projected.map(({ resolverFile, target }) => [
      this.normalizedIdentity(resolverFile),
      target,
    ]));
    if (resolution.kind === 'resolved') {
      const target = targets.get(this.normalizedIdentity(resolution.target));
      return target ? { kind: 'resolved', target: this.cloneTarget(target) } : { kind: 'missing' };
    }
    return {
      kind: 'ambiguous',
      candidates: resolution.candidates.flatMap((candidate) => {
        const target = targets.get(this.normalizedIdentity(candidate));
        return target ? [this.cloneTarget(target)] : [];
      }),
    };
  }

  formatWikilink(target: VaultIdentity, alias?: string): string {
    const projected = this.findProjectedFile(target);
    if (!projected) return '';

    const basenameResolution = resolveIndexedNote(
      this.projectedFiles().map(({ resolverFile }) => resolverFile),
      projected.target.vaultName,
      projected.target.title,
    );
    let noteReference = projected.target.title;
    if (basenameResolution.kind === 'ambiguous') {
      const pathReference = withoutMarkdownExtension(projected.target.identity.relativePath);
      noteReference = pathReference.includes('/') ? pathReference : `/${pathReference}`;
    }

    const wikilink = formatCrossVaultWikilink(projected.target.vaultName, noteReference);
    const label = alias?.trim();
    return label ? `${wikilink.slice(0, -2)}|${label}]]` : wikilink;
  }

  async openTarget(target: VaultIdentity): Promise<void> {
    const projected = this.findProjectedFile(target);
    if (!projected) return;
    await this.fileOpener.openFile(projected.indexedFile);
  }

  subscribe(listener: ApiListener): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Re-reads the effective configuration and emits only the event categories that
   * actually changed. Consumers depend on this instead of the indexer callback so a
   * failing index refresh cannot leave them holding stale target scope or appearance.
   */
  refreshConfiguration(): void {
    if (this.disposed) return;
    const catalogFingerprint = this.computeCatalogFingerprint();
    const appearanceFingerprint = this.computeAppearanceFingerprint();
    const catalogChanged = catalogFingerprint !== this.catalogFingerprint;
    const appearanceChanged = appearanceFingerprint !== this.appearanceFingerprint;
    this.catalogFingerprint = catalogFingerprint;
    this.appearanceFingerprint = appearanceFingerprint;
    if (catalogChanged) this.scheduleEvent('catalog-changed');
    if (appearanceChanged) this.scheduleEvent('appearance-changed');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeIndexer();
    this.listeners.clear();
    this.catalogEventPending = false;
    this.appearanceEventPending = false;
  }

  private currentVault(): VaultConfig | undefined {
    const currentVaultId = this.vaultRegistry.getCurrentVaultId();
    return currentVaultId === null ? undefined : this.vaultRegistry.getVaultById(currentVaultId);
  }

  private normalizedIdentity(identity: VaultIdentity): string {
    return `${identity.vaultId}:${foldRelativePath(identity.relativePath, this.platform)}`;
  }

  /**
   * The external target vaults this source vault can actually link to: known,
   * enabled (therefore indexable), external, and deduplicated.
   */
  private effectiveTargetVaultIds(): string[] {
    const configured = this.settings.virtualLinks;
    if (!configured) return [];
    const currentVaultId = this.vaultRegistry.getCurrentVaultId();
    if (currentVaultId === null) return [];

    const configuredTargets = configured.targetVaultIdsBySource?.[currentVaultId];
    if (!Array.isArray(configuredTargets)) return [];

    const seen = new Set<string>();
    const effective: string[] = [];
    for (const vaultId of configuredTargets) {
      if (typeof vaultId !== 'string' || vaultId === currentVaultId || seen.has(vaultId)) continue;
      const vault = this.vaultRegistry.getVaultById(vaultId);
      if (!vault || vault.enabled !== true) continue;
      seen.add(vaultId);
      effective.push(vaultId);
    }
    return effective;
  }

  /** Everything that changes which external notes are reachable or how they are identified. */
  private computeCatalogFingerprint(): string {
    const targetVaultIds = [...this.effectiveTargetVaultIds()].sort();
    return JSON.stringify({
      sourceVaultId: this.vaultRegistry.getCurrentVaultId(),
      enabled: this.getVirtualLinkSettings().enabled,
      globalExcludePatterns: this.settings.indexOptions?.globalExcludePatterns ?? null,
      targets: targetVaultIds.map((vaultId) => {
        const vault = this.vaultRegistry.getVaultById(vaultId);
        return {
          vaultId,
          name: vault?.name ?? null,
          enabled: vault?.enabled === true,
          includePatterns: vault?.includePatterns ?? null,
          excludePatterns: vault?.excludePatterns ?? null,
        };
      }),
    });
  }

  /** Everything API-visible that only changes how external links should look. */
  private computeAppearanceFingerprint(): string {
    const settings = this.getVirtualLinkSettings();
    return JSON.stringify({
      colorMode: settings.colorMode,
      colorIntensity: settings.colorIntensity,
      sourceColor: validColor(this.currentVault()?.color) ?? null,
      targetColors: [...this.effectiveTargetVaultIds()].sort().map((vaultId) => (
        validColor(this.vaultRegistry.getVaultById(vaultId)?.color) ?? null
      )),
    });
  }

  private projectedFiles(): ProjectedFile[] {
    if (!this.getVirtualLinkSettings().enabled) return [];
    const currentVaultId = this.vaultRegistry.getCurrentVaultId();
    if (currentVaultId === null) return [];
    const selectedVaultIds = new Set(this.effectiveTargetVaultIds());
    if (selectedVaultIds.size === 0) return [];

    const seen = new Set<string>();
    const projected: ProjectedFile[] = [];
    for (const file of this.indexer.getIndexedFiles()) {
      if (!selectedVaultIds.has(file.vaultId) || !isMarkdownExtension(file.extension)) continue;
      const vault = this.vaultRegistry.getVaultById(file.vaultId);
      if (!vault) continue;
      const identity = { vaultId: vault.id, relativePath: file.relativePath.replace(/\\/g, '/') };
      const identityKey = this.normalizedIdentity(identity);
      if (seen.has(identityKey)) continue;
      seen.add(identityKey);

      const target = withOptionalColor({
        identity,
        title: file.basename,
        aliases: normalizeAliases(file.frontmatter?.aliases),
        vaultName: vault.name,
      }, validColor(vault.color));
      projected.push({
        indexedFile: file,
        resolverFile: {
          ...file,
          vaultId: vault.id,
          vaultName: vault.name,
          relativePath: identity.relativePath,
        },
        target,
      });
    }
    return projected;
  }

  private findProjectedFile(identity: VaultIdentity): ProjectedFile | undefined {
    if (this.disposed) return undefined;
    const identityKey = this.normalizedIdentity(identity);
    return this.projectedFiles().find(({ target }) => this.normalizedIdentity(target.identity) === identityKey);
  }

  private cloneTarget(target: VirtualLinkTarget): VirtualLinkTarget {
    return {
      ...target,
      identity: { ...target.identity },
      aliases: [...target.aliases],
    };
  }

  private scheduleEvent(kind: MultiVaultApiEvent['kind']): void {
    if (this.disposed) return;
    if (kind === 'catalog-changed') this.catalogEventPending = true;
    if (kind === 'appearance-changed') this.appearanceEventPending = true;
    if (this.eventFlushScheduled) return;
    this.eventFlushScheduled = true;
    void Promise.resolve().then(() => this.flushEvents());
  }

  private flushEvents(): void {
    this.eventFlushScheduled = false;
    if (this.disposed) return;
    const catalogChanged = this.catalogEventPending;
    const appearanceChanged = this.appearanceEventPending;
    this.catalogEventPending = false;
    this.appearanceEventPending = false;
    if (catalogChanged) this.emit({ kind: 'catalog-changed' });
    if (appearanceChanged) this.emit({ kind: 'appearance-changed' });
  }

  private emit(event: MultiVaultApiEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A consumer must not break the provider or other independent consumers.
      }
    }
  }
}
