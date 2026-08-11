import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import * as properLockfile from 'proper-lockfile';
import type { LockOptions } from 'proper-lockfile';

import {
  InvalidSharedSettingsError,
  MalformedSharedSettingsError,
  SharedSettingsAlreadyInitializedError,
  SharedSettingsCommittedWithLockReleaseError,
  SharedSettingsLockCompromisedError,
  SharedSettingsLockTimeoutError,
  SharedSettingsNotInitializedError,
  UnsupportedSharedSettingsVersionError,
} from './shared-settings-errors';
import {
  SHARED_SETTINGS_SCHEMA_VERSION,
  type SharedSettingsManifest,
  type SharedSettingsProjection,
  type SharedVaultRecord,
  type VirtualLinkColorMode,
} from './shared-settings-types';

export const SHARED_SETTINGS_MANIFEST_FILE_NAME = 'shared-settings-v1.json';
export const SHARED_SETTINGS_LOCK_FILE_NAME = `${SHARED_SETTINGS_MANIFEST_FILE_NAME}.lock`;

const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const DEFAULT_RETRY_MIN_MS = 10;
const DEFAULT_RETRY_MAX_MS = 50;
const DEFAULT_LOCK_UPDATE_MS = 5_000;
const WINDOWS_RENAME_RETRY_MS = 2_000;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const VALID_COLOR_MODES: readonly VirtualLinkColorMode[] = [
  'off',
  'muted-text',
  'colored-underline',
  'soft-pill',
];

export type SharedSettingsPatch =
  | { kind: 'set-enabled'; enabled: boolean }
  | { kind: 'set-vault-excluded'; vaultId: string; excluded: boolean }
  | { kind: 'upsert-vault'; vault: SharedVaultRecord }
  | { kind: 'remove-vault'; vaultId: string }
  | { kind: 'set-vault-color'; vaultId: string; color?: string }
  | { kind: 'set-vault-icon'; vaultId: string; icon?: string }
  | { kind: 'set-vault-enabled'; vaultId: string; enabled: boolean }
  | { kind: 'set-vault-patterns'; vaultId: string; include: string[]; exclude: string[] }
  | { kind: 'set-cross-vault-appearance'; showBadge: boolean; useColor: boolean }
  | { kind: 'set-virtual-links-enabled'; enabled: boolean }
  | { kind: 'set-virtual-link-source-excluded'; vaultId: string; excluded: boolean }
  | { kind: 'set-virtual-link-targets'; sourceVaultId: string; targetVaultIds: string[] }
  | { kind: 'set-virtual-link-style'; mode: VirtualLinkColorMode; intensity: number };

type ReleaseLock = () => Promise<void>;
type LockFile = (file: string, options: LockOptions) => Promise<ReleaseLock>;

export interface SharedSettingsStoreOptions {
  lockTimeoutMs?: number;
  staleLockMs?: number;
  lockUpdateMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  now?: () => Date;
  publishStagedFile?: (stagingPath: string, manifestPath: string) => Promise<void>;
  lockFile?: LockFile;
  beforePublishStagedFile?: () => Promise<void>;
  onLockCompromised?: (error: Error) => void;
}

interface LockLease {
  release: ReleaseLock;
  assertActive: () => void;
  getCompromiseError: () => Error | undefined;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new InvalidSharedSettingsError(`Invalid shared settings manifest: ${message}`);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${field} must be an object.`);
  return value;
}

function requireBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== 'boolean') invalid(`${field} must be a boolean.`);
}

function requireNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(`${field} must be a non-empty string.`);
  }
}

function requireStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    invalid(`${field} must be an array of strings.`);
  }

  if (new Set(value).size !== value.length) {
    invalid(`${field} must not contain duplicates.`);
  }
}

function validateVault(vaultValue: unknown, index: number): asserts vaultValue is SharedVaultRecord {
  const field = `vaults[${index}]`;
  const vault = requireRecord(vaultValue, field);
  requireNonEmptyString(vault.id, `${field}.id`);
  requireNonEmptyString(vault.pathKey, `${field}.pathKey`);
  requireNonEmptyString(vault.path, `${field}.path`);
  requireNonEmptyString(vault.name, `${field}.name`);
  requireBoolean(vault.enabled, `${field}.enabled`);

  if (vault.pathKey.includes('\\')) invalid(`${field}.pathKey must use forward slashes.`);
  if (vault.color !== undefined && (typeof vault.color !== 'string' || !HEX_COLOR_PATTERN.test(vault.color))) {
    invalid(`${field}.color must be a six-digit hexadecimal color.`);
  }
  if (vault.icon !== undefined && typeof vault.icon !== 'string') invalid(`${field}.icon must be a string.`);
  if (vault.includePatterns !== undefined) requireStringArray(vault.includePatterns, `${field}.includePatterns`);
  if (vault.excludePatterns !== undefined) requireStringArray(vault.excludePatterns, `${field}.excludePatterns`);
}

function validateManifest(value: unknown): asserts value is SharedSettingsManifest {
  const manifest = requireRecord(value, 'manifest');

  if (typeof manifest.schemaVersion === 'number' && manifest.schemaVersion > SHARED_SETTINGS_SCHEMA_VERSION) {
    throw new UnsupportedSharedSettingsVersionError(manifest.schemaVersion);
  }
  if (manifest.schemaVersion !== SHARED_SETTINGS_SCHEMA_VERSION) {
    invalid(`schemaVersion must be ${SHARED_SETTINGS_SCHEMA_VERSION}.`);
  }
  if (!Number.isSafeInteger(manifest.revision) || (manifest.revision as number) < 1) {
    invalid('revision must be a positive safe integer.');
  }
  requireNonEmptyString(manifest.updatedAt, 'updatedAt');
  if (Number.isNaN(Date.parse(manifest.updatedAt))) invalid('updatedAt must be a valid timestamp.');
  requireNonEmptyString(manifest.writerInstanceId, 'writerInstanceId');
  requireBoolean(manifest.enabled, 'enabled');
  requireStringArray(manifest.excludedVaultIds, 'excludedVaultIds');

  if (!Array.isArray(manifest.vaults)) invalid('vaults must be an array.');
  manifest.vaults.forEach((vault, index) => validateVault(vault, index));
  const vaultIds = manifest.vaults.map((vault) => vault.id);
  const pathKeys = manifest.vaults.map((vault) => vault.pathKey);
  if (new Set(vaultIds).size !== vaultIds.length) invalid('vault IDs must be unique.');
  if (new Set(pathKeys).size !== pathKeys.length) invalid('vault path keys must be unique.');
  const knownVaultIds = new Set(vaultIds);
  if (manifest.excludedVaultIds.some((id) => !knownVaultIds.has(id))) {
    invalid('excludedVaultIds must reference known vaults.');
  }

  const crossVaultLinks = requireRecord(manifest.crossVaultLinks, 'crossVaultLinks');
  requireBoolean(crossVaultLinks.showVaultBadge, 'crossVaultLinks.showVaultBadge');
  requireBoolean(crossVaultLinks.useVaultColorForLinks, 'crossVaultLinks.useVaultColorForLinks');

  const virtualLinks = requireRecord(manifest.virtualLinks, 'virtualLinks');
  requireBoolean(virtualLinks.enabled, 'virtualLinks.enabled');
  requireStringArray(virtualLinks.excludedSourceVaultIds, 'virtualLinks.excludedSourceVaultIds');
  if ((virtualLinks.excludedSourceVaultIds as string[]).some((id) => !knownVaultIds.has(id))) {
    invalid('virtualLinks.excludedSourceVaultIds must reference known vaults.');
  }

  const targets = requireRecord(virtualLinks.targetVaultIdsBySource, 'virtualLinks.targetVaultIdsBySource');
  for (const [sourceId, targetIds] of Object.entries(targets)) {
    if (!knownVaultIds.has(sourceId)) invalid('virtual link sources must reference known vaults.');
    requireStringArray(targetIds, `virtualLinks.targetVaultIdsBySource.${sourceId}`);
    if (targetIds.some((targetId) => !knownVaultIds.has(targetId))) {
      invalid('virtual link targets must reference known vaults.');
    }
  }

  if (typeof virtualLinks.colorMode !== 'string'
    || !VALID_COLOR_MODES.includes(virtualLinks.colorMode as VirtualLinkColorMode)) {
    invalid('virtualLinks.colorMode is unsupported.');
  }
  if (!Number.isInteger(virtualLinks.colorIntensity)
    || (virtualLinks.colorIntensity as number) < 10
    || (virtualLinks.colorIntensity as number) > 90) {
    invalid('virtualLinks.colorIntensity must be an integer from 10 through 90.');
  }

  if (manifest.extensions !== undefined && !isRecord(manifest.extensions)) {
    invalid('extensions must be an object.');
  }
}

function cloneVault(vault: SharedVaultRecord): SharedVaultRecord {
  return {
    ...vault,
    includePatterns: vault.includePatterns ? [...vault.includePatterns] : undefined,
    excludePatterns: vault.excludePatterns ? [...vault.excludePatterns] : undefined,
  };
}

function mergeVaultForUpsert(existing: SharedVaultRecord, replacement: SharedVaultRecord): SharedVaultRecord {
  const merged = { ...existing, ...cloneVault(replacement) };
  const optionalFields = ['color', 'icon', 'includePatterns', 'excludePatterns'] as const;
  for (const field of optionalFields) {
    if (replacement[field] === undefined) delete merged[field];
  }
  return merged;
}

function toggleId(ids: readonly string[], id: string, included: boolean): string[] {
  if (included) return ids.includes(id) ? [...ids] : [...ids, id];
  return ids.filter((candidate) => candidate !== id);
}

function findVaultIndex(manifest: SharedSettingsManifest, vaultId: string): number {
  const index = manifest.vaults.findIndex((vault) => vault.id === vaultId);
  if (index < 0) invalid(`patch references unknown vault ${JSON.stringify(vaultId)}.`);
  return index;
}

function replaceVault(
  manifest: SharedSettingsManifest,
  vaultId: string,
  update: (vault: SharedVaultRecord) => SharedVaultRecord,
): SharedVaultRecord[] {
  const index = findVaultIndex(manifest, vaultId);
  return manifest.vaults.map((vault, candidateIndex) => candidateIndex === index ? update(vault) : vault);
}

function applyPatch(manifest: SharedSettingsManifest, patch: SharedSettingsPatch): SharedSettingsManifest {
  switch (patch.kind) {
    case 'set-enabled':
      return { ...manifest, enabled: patch.enabled };

    case 'set-vault-excluded':
      findVaultIndex(manifest, patch.vaultId);
      return {
        ...manifest,
        excludedVaultIds: toggleId(manifest.excludedVaultIds, patch.vaultId, patch.excluded),
      };

    case 'upsert-vault': {
      const existingIndex = manifest.vaults.findIndex((vault) => vault.id === patch.vault.id);
      const vaults = existingIndex < 0
        ? [...manifest.vaults, cloneVault(patch.vault)]
        : manifest.vaults.map((vault, index) => (
          index === existingIndex ? mergeVaultForUpsert(vault, patch.vault) : vault
        ));
      return { ...manifest, vaults };
    }

    case 'remove-vault': {
      const targetVaultIdsBySource = Object.fromEntries(
        Object.entries(manifest.virtualLinks.targetVaultIdsBySource)
          .filter(([sourceId]) => sourceId !== patch.vaultId)
          .map(([sourceId, targetIds]) => [
            sourceId,
            targetIds.filter((targetId) => targetId !== patch.vaultId),
          ]),
      );
      return {
        ...manifest,
        vaults: manifest.vaults.filter((vault) => vault.id !== patch.vaultId),
        excludedVaultIds: manifest.excludedVaultIds.filter((id) => id !== patch.vaultId),
        virtualLinks: {
          ...manifest.virtualLinks,
          excludedSourceVaultIds: manifest.virtualLinks.excludedSourceVaultIds.filter(
            (id) => id !== patch.vaultId,
          ),
          targetVaultIdsBySource,
        },
      };
    }

    case 'set-vault-color':
      return {
        ...manifest,
        vaults: replaceVault(manifest, patch.vaultId, (vault) => {
          const updated = { ...vault, color: patch.color };
          if (patch.color === undefined) delete updated.color;
          return updated;
        }),
      };

    case 'set-vault-icon':
      return {
        ...manifest,
        vaults: replaceVault(manifest, patch.vaultId, (vault) => {
          const updated = { ...vault, icon: patch.icon };
          if (patch.icon === undefined) delete updated.icon;
          return updated;
        }),
      };

    case 'set-vault-enabled':
      return {
        ...manifest,
        vaults: replaceVault(manifest, patch.vaultId, (vault) => ({ ...vault, enabled: patch.enabled })),
      };

    case 'set-vault-patterns':
      return {
        ...manifest,
        vaults: replaceVault(manifest, patch.vaultId, (vault) => ({
          ...vault,
          includePatterns: [...patch.include],
          excludePatterns: [...patch.exclude],
        })),
      };

    case 'set-cross-vault-appearance':
      return {
        ...manifest,
        crossVaultLinks: {
          ...manifest.crossVaultLinks,
          showVaultBadge: patch.showBadge,
          useVaultColorForLinks: patch.useColor,
        },
      };

    case 'set-virtual-links-enabled':
      return {
        ...manifest,
        virtualLinks: { ...manifest.virtualLinks, enabled: patch.enabled },
      };

    case 'set-virtual-link-source-excluded':
      findVaultIndex(manifest, patch.vaultId);
      return {
        ...manifest,
        virtualLinks: {
          ...manifest.virtualLinks,
          excludedSourceVaultIds: toggleId(
            manifest.virtualLinks.excludedSourceVaultIds,
            patch.vaultId,
            patch.excluded,
          ),
        },
      };

    case 'set-virtual-link-targets':
      findVaultIndex(manifest, patch.sourceVaultId);
      return {
        ...manifest,
        virtualLinks: {
          ...manifest.virtualLinks,
          targetVaultIdsBySource: {
            ...manifest.virtualLinks.targetVaultIdsBySource,
            [patch.sourceVaultId]: [...patch.targetVaultIds],
          },
        },
      };

    case 'set-virtual-link-style':
      return {
        ...manifest,
        virtualLinks: {
          ...manifest.virtualLinks,
          colorMode: patch.mode,
          colorIntensity: patch.intensity,
        },
      };

    default:
      throw new InvalidSharedSettingsError(
        `Invalid shared settings patch: unsupported kind ${JSON.stringify((patch as { kind?: unknown }).kind)}.`,
      );
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function defaultPublishStagedFile(stagingPath: string, manifestPath: string): Promise<void> {
  if (process.platform !== 'win32') {
    await rename(stagingPath, manifestPath);
    return;
  }

  const deadline = Date.now() + WINDOWS_RENAME_RETRY_MS;
  while (true) {
    try {
      // Node's Windows rename uses replacement semantics. Never unlink the destination first:
      // readers must always observe either the old complete file or the new complete file.
      await rename(stagingPath, manifestPath);
      return;
    } catch (error) {
      const retryable = isNodeError(error, 'EACCES')
        || isNodeError(error, 'EPERM')
        || isNodeError(error, 'EBUSY');
      if (!retryable || Date.now() >= deadline) throw error;
      await sleep(Math.min(20, Math.max(1, deadline - Date.now())));
    }
  }
}

export class SharedSettingsStore {
  readonly directory: string;
  readonly manifestPath: string;
  readonly lockPath: string;

  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly lockUpdateMs: number;
  private readonly retryMinMs: number;
  private readonly retryMaxMs: number;
  private readonly now: () => Date;
  private readonly publishStagedFile: (stagingPath: string, manifestPath: string) => Promise<void>;
  private readonly lockFile: LockFile;
  private readonly beforePublishStagedFile: () => Promise<void>;
  private readonly onLockCompromised?: (error: Error) => void;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(directory: string, options: SharedSettingsStoreOptions = {}) {
    this.directory = path.resolve(directory);
    this.manifestPath = path.join(this.directory, SHARED_SETTINGS_MANIFEST_FILE_NAME);
    this.lockPath = path.join(this.directory, SHARED_SETTINGS_LOCK_FILE_NAME);
    this.lockTimeoutMs = Math.max(0, Math.min(DEFAULT_LOCK_TIMEOUT_MS, options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS));
    this.staleLockMs = Math.max(2_000, options.staleLockMs ?? DEFAULT_STALE_LOCK_MS);
    this.lockUpdateMs = Math.max(
      1_000,
      Math.min(this.staleLockMs / 2, options.lockUpdateMs ?? DEFAULT_LOCK_UPDATE_MS),
    );
    this.retryMinMs = Math.max(1, options.retryMinMs ?? DEFAULT_RETRY_MIN_MS);
    this.retryMaxMs = Math.max(this.retryMinMs, options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS);
    this.now = options.now ?? (() => new Date());
    this.publishStagedFile = options.publishStagedFile ?? defaultPublishStagedFile;
    this.lockFile = options.lockFile ?? properLockfile.lock;
    this.beforePublishStagedFile = options.beforePublishStagedFile ?? (async () => undefined);
    this.onLockCompromised = options.onLockCompromised;
  }

  async read(): Promise<SharedSettingsManifest | null> {
    let content: string;
    try {
      content = await readFile(this.manifestPath, 'utf8');
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new MalformedSharedSettingsError(
        `Shared settings manifest at ${this.manifestPath} contains malformed JSON.`,
        { cause: error },
      );
    }

    validateManifest(parsed);
    return parsed;
  }

  async initialize(seed: SharedSettingsProjection, writerInstanceId: string): Promise<SharedSettingsManifest> {
    return this.serializeWrite(async () => {
      await mkdir(this.directory, { recursive: true });
      return this.withLock(async (assertLockActive) => {
        const existing = await this.read();
        if (existing) {
          throw new SharedSettingsAlreadyInitializedError(
            `Shared settings manifest already exists at ${this.manifestPath}.`,
          );
        }

        const manifest = {
          ...seed,
          schemaVersion: SHARED_SETTINGS_SCHEMA_VERSION,
          revision: 1,
          updatedAt: this.now().toISOString(),
          writerInstanceId,
        } as SharedSettingsManifest;
        validateManifest(manifest);
        await this.writeManifest(manifest, assertLockActive);
        return manifest;
      });
    });
  }

  async patch(patch: SharedSettingsPatch, writerInstanceId: string): Promise<SharedSettingsManifest> {
    return this.serializeWrite(async () => {
      await mkdir(this.directory, { recursive: true });
      return this.withLock(async (assertLockActive) => {
        const latest = await this.read();
        if (!latest) {
          throw new SharedSettingsNotInitializedError(
            `Shared settings manifest does not exist at ${this.manifestPath}.`,
          );
        }

        const next = {
          ...applyPatch(latest, patch),
          revision: latest.revision + 1,
          updatedAt: this.now().toISOString(),
          writerInstanceId,
        };
        validateManifest(next);
        await this.writeManifest(next, assertLockActive);
        return next;
      });
    });
  }

  private serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async withLock(
    operation: (assertLockActive: () => void) => Promise<SharedSettingsManifest>,
  ): Promise<SharedSettingsManifest> {
    const lease = await this.acquireLock();
    let operationFailed = false;
    let operationError: unknown;
    let result!: SharedSettingsManifest;

    try {
      result = await operation(lease.assertActive);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }

    let releaseError: unknown;
    try {
      await lease.release();
    } catch (error) {
      releaseError = error;
    }

    if (operationFailed) throw operationError;

    const compromiseError = lease.getCompromiseError();
    if (releaseError !== undefined || compromiseError !== undefined) {
      throw new SharedSettingsCommittedWithLockReleaseError(result, {
        cause: compromiseError ?? releaseError,
      });
    }
    return result;
  }

  private async acquireLock(): Promise<LockLease> {
    const startedAt = Date.now();
    const retryInterval = Math.max(
      this.retryMinMs,
      Math.min(this.retryMaxMs, Math.max(1, this.lockTimeoutMs)),
    );
    const retries = this.lockTimeoutMs === 0 ? 0 : Math.floor(this.lockTimeoutMs / retryInterval);
    let compromiseError: Error | undefined;

    let release: ReleaseLock;
    try {
      release = await this.lockFile(this.manifestPath, {
        stale: this.staleLockMs,
        update: this.lockUpdateMs,
        realpath: false,
        retries: {
          retries,
          factor: 1,
          minTimeout: retryInterval,
          maxTimeout: retryInterval,
          randomize: false,
        },
        onCompromised: (error) => {
          compromiseError = error;
          try {
            this.onLockCompromised?.(error);
          } catch {
            // A diagnostic callback must not replace the actual compromise error.
          }
        },
      });
    } catch (error) {
      if (isNodeError(error, 'ELOCKED')) {
        throw new SharedSettingsLockTimeoutError(
          `Timed out after ${Date.now() - startedAt}ms waiting for ${this.lockPath}.`,
          { cause: error },
        );
      }
      throw error;
    }

    return {
      release,
      getCompromiseError: () => compromiseError,
      assertActive: () => {
        if (compromiseError) {
          throw new SharedSettingsLockCompromisedError(
            `The shared settings lock for ${this.manifestPath} was compromised before publication.`,
            { cause: compromiseError },
          );
        }
      },
    };
  }

  private async writeManifest(
    manifest: SharedSettingsManifest,
    assertLockActive: () => void,
  ): Promise<void> {
    const stagingPath = path.join(
      this.directory,
      `.${SHARED_SETTINGS_MANIFEST_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
    );
    let operationFailed = false;

    try {
      const handle = await open(stagingPath, 'wx', 0o600);
      let writeFailed = false;
      try {
        await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        await handle.sync();
      } catch (error) {
        writeFailed = true;
        throw error;
      } finally {
        try {
          await handle.close();
        } catch (error) {
          if (!writeFailed) throw error;
        }
      }

      await this.beforePublishStagedFile();
      assertLockActive();
      await this.publishStagedFile(stagingPath, this.manifestPath);
    } catch (error) {
      operationFailed = true;
      throw error;
    } finally {
      try {
        await unlink(stagingPath);
      } catch (error) {
        if (!isNodeError(error, 'ENOENT') && !operationFailed) throw error;
      }
    }
  }
}
