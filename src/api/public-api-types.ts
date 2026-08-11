import type { VirtualLinkColorMode } from '../shared-settings/shared-settings-types';

export interface VaultIdentity {
  vaultId: string;
  relativePath: string;
}

export interface VaultDescriptor {
  vaultId: string;
  vaultName: string;
  color?: string;
}

export interface VirtualLinkIntegrationSettings {
  enabled: boolean;
  colorMode: VirtualLinkColorMode;
  colorIntensity: number;
}

export interface VirtualLinkTarget {
  identity: VaultIdentity;
  title: string;
  aliases: string[];
  vaultName: string;
  color?: string;
}

export interface TargetReference {
  vaultName: string;
  noteRef: string;
}

export type TargetResolution =
  | { kind: 'resolved'; target: VirtualLinkTarget }
  | { kind: 'ambiguous'; candidates: VirtualLinkTarget[] }
  | { kind: 'missing' };

export type MultiVaultApiEvent =
  | { kind: 'catalog-changed' }
  | { kind: 'appearance-changed' };

export interface MultiVaultPublicApiV1 {
  readonly apiVersion: 1;
  getCurrentVault(): VaultDescriptor | null;
  getVirtualLinkSettings(): VirtualLinkIntegrationSettings;
  listVirtualLinkTargets(): VirtualLinkTarget[];
  resolveTarget(reference: TargetReference): TargetResolution;
  formatWikilink(target: VaultIdentity, alias?: string): string;
  openTarget(target: VaultIdentity): Promise<void>;
  subscribe(listener: (event: MultiVaultApiEvent) => void): () => void;
}
