import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

import {
  InvalidSharedSettingsError,
  MalformedSharedSettingsError,
  SharedSettingsInitializationConflictError,
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

export const SHARED_SETTINGS_DIRECTORY_NAME = 'shared-settings-v1';
export const SHARED_SETTINGS_SEED_FILE_NAME = 'seed.json';
export const SHARED_SETTINGS_PATCH_DIRECTORY_NAME = 'patches';

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const PATCH_ID_PATTERN = /^\d{16}-[0-9a-f]{16}-[0-9a-f]{12}-[0-9a-f]{32}$/;
const MAX_ERROR_FILE_NAME_LENGTH = 160;
const VALID_COLOR_MODES: readonly VirtualLinkColorMode[] = [
  'off',
  'muted-text',
  'colored-underline',
  'soft-pill',
];

const processWriterPatchSequences = new Map<string, bigint>();

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

export interface SharedSettingsPatchEnvelope {
  schemaVersion: 1;
  id: string;
  writerInstanceId: string;
  logicalClock: number;
  createdAt: string;
  patch: SharedSettingsPatch;
}

export interface SharedSettingsStoreOptions {
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
  beforePublishPatch?: (pendingPath: string, finalPath: string) => Promise<void>;
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

function invalidManifest(message: string): never {
  throw new InvalidSharedSettingsError(`Invalid shared settings manifest: ${message}`);
}

function invalidPatch(message: string): never {
  throw new InvalidSharedSettingsError(`Invalid shared settings patch: ${message}`);
}

function requireRecord(
  value: unknown,
  field: string,
  invalid: (message: string) => never = invalidManifest,
): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${field} must be an object.`);
  return value;
}

function requireOnlyFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  subject: string,
  invalid: (message: string) => never,
): void {
  const allowed = new Set(fields);
  const unexpected = Object.keys(value).find((field) => !allowed.has(field));
  if (unexpected !== undefined) invalid(`${subject} contains unexpected field ${JSON.stringify(unexpected)}.`);
}

function requireBoolean(
  value: unknown,
  field: string,
  invalid: (message: string) => never = invalidManifest,
): asserts value is boolean {
  if (typeof value !== 'boolean') invalid(`${field} must be a boolean.`);
}

function requireNonEmptyString(
  value: unknown,
  field: string,
  invalid: (message: string) => never = invalidManifest,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    invalid(`${field} must be a non-empty string.`);
  }
}

function requireStringArray(
  value: unknown,
  field: string,
  invalid: (message: string) => never = invalidManifest,
): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    invalid(`${field} must be an array of strings.`);
  }
  if (new Set(value).size !== value.length) invalid(`${field} must not contain duplicates.`);
}

function validateVault(
  vaultValue: unknown,
  field: string,
  invalid: (message: string) => never = invalidManifest,
): asserts vaultValue is SharedVaultRecord {
  const vault = requireRecord(vaultValue, field, invalid);
  requireNonEmptyString(vault.id, `${field}.id`, invalid);
  requireNonEmptyString(vault.pathKey, `${field}.pathKey`, invalid);
  requireNonEmptyString(vault.path, `${field}.path`, invalid);
  requireNonEmptyString(vault.name, `${field}.name`, invalid);
  requireBoolean(vault.enabled, `${field}.enabled`, invalid);

  if (vault.pathKey.includes('\\')) invalid(`${field}.pathKey must use forward slashes.`);
  if (vault.color !== undefined && (typeof vault.color !== 'string' || !HEX_COLOR_PATTERN.test(vault.color))) {
    invalid(`${field}.color must be a six-digit hexadecimal color.`);
  }
  if (vault.icon !== undefined && typeof vault.icon !== 'string') invalid(`${field}.icon must be a string.`);
  if (vault.includePatterns !== undefined) requireStringArray(vault.includePatterns, `${field}.includePatterns`, invalid);
  if (vault.excludePatterns !== undefined) requireStringArray(vault.excludePatterns, `${field}.excludePatterns`, invalid);
}

function validateManifest(value: unknown, expectedRevision?: number): asserts value is SharedSettingsManifest {
  const manifest = requireRecord(value, 'manifest');

  if (typeof manifest.schemaVersion === 'number' && manifest.schemaVersion > SHARED_SETTINGS_SCHEMA_VERSION) {
    throw new UnsupportedSharedSettingsVersionError(manifest.schemaVersion);
  }
  if (manifest.schemaVersion !== SHARED_SETTINGS_SCHEMA_VERSION) {
    invalidManifest(`schemaVersion must be ${SHARED_SETTINGS_SCHEMA_VERSION}.`);
  }
  if (!Number.isSafeInteger(manifest.revision) || (manifest.revision as number) < 0) {
    invalidManifest('revision must be a non-negative safe integer.');
  }
  if (expectedRevision !== undefined && manifest.revision !== expectedRevision) {
    invalidManifest(`revision must be ${expectedRevision}.`);
  }
  requireNonEmptyString(manifest.updatedAt, 'updatedAt');
  if (Number.isNaN(Date.parse(manifest.updatedAt))) invalidManifest('updatedAt must be a valid timestamp.');
  requireNonEmptyString(manifest.writerInstanceId, 'writerInstanceId');
  requireBoolean(manifest.enabled, 'enabled');
  requireStringArray(manifest.excludedVaultIds, 'excludedVaultIds');

  if (!Array.isArray(manifest.vaults)) invalidManifest('vaults must be an array.');
  manifest.vaults.forEach((vault, index) => validateVault(vault, `vaults[${index}]`));
  const vaultIds = manifest.vaults.map((vault) => vault.id);
  const pathKeys = manifest.vaults.map((vault) => vault.pathKey);
  if (new Set(vaultIds).size !== vaultIds.length) invalidManifest('vault IDs must be unique.');
  if (new Set(pathKeys).size !== pathKeys.length) invalidManifest('vault path keys must be unique.');
  const knownVaultIds = new Set(vaultIds);
  if (manifest.excludedVaultIds.some((id) => !knownVaultIds.has(id))) {
    invalidManifest('excludedVaultIds must reference known vaults.');
  }

  const crossVaultLinks = requireRecord(manifest.crossVaultLinks, 'crossVaultLinks');
  requireBoolean(crossVaultLinks.showVaultBadge, 'crossVaultLinks.showVaultBadge');
  requireBoolean(crossVaultLinks.useVaultColorForLinks, 'crossVaultLinks.useVaultColorForLinks');

  const virtualLinks = requireRecord(manifest.virtualLinks, 'virtualLinks');
  requireBoolean(virtualLinks.enabled, 'virtualLinks.enabled');
  requireStringArray(virtualLinks.excludedSourceVaultIds, 'virtualLinks.excludedSourceVaultIds');
  if ((virtualLinks.excludedSourceVaultIds as string[]).some((id) => !knownVaultIds.has(id))) {
    invalidManifest('virtualLinks.excludedSourceVaultIds must reference known vaults.');
  }

  const targets = requireRecord(virtualLinks.targetVaultIdsBySource, 'virtualLinks.targetVaultIdsBySource');
  for (const [sourceId, targetIds] of Object.entries(targets)) {
    if (!knownVaultIds.has(sourceId)) invalidManifest('virtual link sources must reference known vaults.');
    requireStringArray(targetIds, `virtualLinks.targetVaultIdsBySource.${sourceId}`);
    if (targetIds.some((targetId) => !knownVaultIds.has(targetId))) {
      invalidManifest('virtual link targets must reference known vaults.');
    }
  }

  if (typeof virtualLinks.colorMode !== 'string'
    || !VALID_COLOR_MODES.includes(virtualLinks.colorMode as VirtualLinkColorMode)) {
    invalidManifest('virtualLinks.colorMode is unsupported.');
  }
  if (!Number.isInteger(virtualLinks.colorIntensity)
    || (virtualLinks.colorIntensity as number) < 10
    || (virtualLinks.colorIntensity as number) > 90) {
    invalidManifest('virtualLinks.colorIntensity must be an integer from 10 through 90.');
  }

  if (manifest.extensions !== undefined && !isRecord(manifest.extensions)) {
    invalidManifest('extensions must be an object.');
  }
}

function validatePatch(value: unknown): asserts value is SharedSettingsPatch {
  const patch = requireRecord(value, 'patch', invalidPatch);
  requireNonEmptyString(patch.kind, 'patch.kind', invalidPatch);

  switch (patch.kind) {
    case 'set-enabled':
      requireOnlyFields(patch, ['kind', 'enabled'], 'set-enabled patch', invalidPatch);
      requireBoolean(patch.enabled, 'patch.enabled', invalidPatch);
      return;
    case 'set-vault-excluded':
      requireOnlyFields(patch, ['kind', 'vaultId', 'excluded'], 'set-vault-excluded patch', invalidPatch);
      requireNonEmptyString(patch.vaultId, 'patch.vaultId', invalidPatch);
      requireBoolean(patch.excluded, 'patch.excluded', invalidPatch);
      return;
    case 'upsert-vault':
      requireOnlyFields(patch, ['kind', 'vault'], 'upsert-vault patch', invalidPatch);
      validateVault(patch.vault, 'patch.vault', invalidPatch);
      return;
    case 'remove-vault':
      requireOnlyFields(patch, ['kind', 'vaultId'], 'remove-vault patch', invalidPatch);
      requireNonEmptyString(patch.vaultId, 'patch.vaultId', invalidPatch);
      return;
    case 'set-vault-color':
      requireOnlyFields(patch, ['kind', 'vaultId', 'color'], 'set-vault-color patch', invalidPatch);
      requireNonEmptyString(patch.vaultId, 'patch.vaultId', invalidPatch);
      if (patch.color !== undefined && (typeof patch.color !== 'string' || !HEX_COLOR_PATTERN.test(patch.color))) {
        invalidPatch('patch.color must be a six-digit hexadecimal color.');
      }
      return;
    case 'set-vault-icon':
      requireOnlyFields(patch, ['kind', 'vaultId', 'icon'], 'set-vault-icon patch', invalidPatch);
      requireNonEmptyString(patch.vaultId, 'patch.vaultId', invalidPatch);
      if (patch.icon !== undefined && typeof patch.icon !== 'string') invalidPatch('patch.icon must be a string.');
      return;
    case 'set-vault-enabled':
      requireOnlyFields(patch, ['kind', 'vaultId', 'enabled'], 'set-vault-enabled patch', invalidPatch);
      requireNonEmptyString(patch.vaultId, 'patch.vaultId', invalidPatch);
      requireBoolean(patch.enabled, 'patch.enabled', invalidPatch);
      return;
    case 'set-vault-patterns':
      requireOnlyFields(patch, ['kind', 'vaultId', 'include', 'exclude'], 'set-vault-patterns patch', invalidPatch);
      requireNonEmptyString(patch.vaultId, 'patch.vaultId', invalidPatch);
      requireStringArray(patch.include, 'patch.include', invalidPatch);
      requireStringArray(patch.exclude, 'patch.exclude', invalidPatch);
      return;
    case 'set-cross-vault-appearance':
      requireOnlyFields(patch, ['kind', 'showBadge', 'useColor'], 'set-cross-vault-appearance patch', invalidPatch);
      requireBoolean(patch.showBadge, 'patch.showBadge', invalidPatch);
      requireBoolean(patch.useColor, 'patch.useColor', invalidPatch);
      return;
    case 'set-virtual-links-enabled':
      requireOnlyFields(patch, ['kind', 'enabled'], 'set-virtual-links-enabled patch', invalidPatch);
      requireBoolean(patch.enabled, 'patch.enabled', invalidPatch);
      return;
    case 'set-virtual-link-source-excluded':
      requireOnlyFields(
        patch,
        ['kind', 'vaultId', 'excluded'],
        'set-virtual-link-source-excluded patch',
        invalidPatch,
      );
      requireNonEmptyString(patch.vaultId, 'patch.vaultId', invalidPatch);
      requireBoolean(patch.excluded, 'patch.excluded', invalidPatch);
      return;
    case 'set-virtual-link-targets':
      requireOnlyFields(
        patch,
        ['kind', 'sourceVaultId', 'targetVaultIds'],
        'set-virtual-link-targets patch',
        invalidPatch,
      );
      requireNonEmptyString(patch.sourceVaultId, 'patch.sourceVaultId', invalidPatch);
      requireStringArray(patch.targetVaultIds, 'patch.targetVaultIds', invalidPatch);
      return;
    case 'set-virtual-link-style':
      requireOnlyFields(patch, ['kind', 'mode', 'intensity'], 'set-virtual-link-style patch', invalidPatch);
      if (typeof patch.mode !== 'string' || !VALID_COLOR_MODES.includes(patch.mode as VirtualLinkColorMode)) {
        invalidPatch('patch.mode is unsupported.');
      }
      if (!Number.isInteger(patch.intensity)
        || (patch.intensity as number) < 10
        || (patch.intensity as number) > 90) {
        invalidPatch('patch.intensity must be an integer from 10 through 90.');
      }
      return;
    default:
      invalidPatch(`unsupported kind ${JSON.stringify(patch.kind)}.`);
  }
}

function validateEnvelope(value: unknown, expectedId: string): asserts value is SharedSettingsPatchEnvelope {
  const envelope = requireRecord(value, 'patch envelope', invalidPatch);
  requireOnlyFields(
    envelope,
    ['schemaVersion', 'id', 'writerInstanceId', 'logicalClock', 'createdAt', 'patch'],
    'patch envelope',
    invalidPatch,
  );
  if (typeof envelope.schemaVersion === 'number' && envelope.schemaVersion > SHARED_SETTINGS_SCHEMA_VERSION) {
    throw new UnsupportedSharedSettingsVersionError(envelope.schemaVersion);
  }
  if (envelope.schemaVersion !== SHARED_SETTINGS_SCHEMA_VERSION) {
    invalidPatch(`schemaVersion must be ${SHARED_SETTINGS_SCHEMA_VERSION}.`);
  }
  requireNonEmptyString(envelope.id, 'patch envelope.id', invalidPatch);
  if (!PATCH_ID_PATTERN.test(envelope.id)) invalidPatch('patch envelope.id has an invalid format.');
  if (envelope.id !== expectedId) invalidPatch('patch envelope.id must match its filename.');
  requireNonEmptyString(envelope.writerInstanceId, 'patch envelope.writerInstanceId', invalidPatch);
  if (!Number.isSafeInteger(envelope.logicalClock) || (envelope.logicalClock as number) < 1) {
    invalidPatch('patch envelope.logicalClock must be a positive safe integer.');
  }
  requireNonEmptyString(envelope.createdAt, 'patch envelope.createdAt', invalidPatch);
  if (Number.isNaN(Date.parse(envelope.createdAt))) invalidPatch('patch envelope.createdAt must be a valid timestamp.');
  validatePatch(envelope.patch);
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

function hasVault(manifest: SharedSettingsManifest, vaultId: string): boolean {
  return manifest.vaults.some((vault) => vault.id === vaultId);
}

function replaceVault(
  manifest: SharedSettingsManifest,
  vaultId: string,
  update: (vault: SharedVaultRecord) => SharedVaultRecord,
): SharedVaultRecord[] {
  const index = manifest.vaults.findIndex((vault) => vault.id === vaultId);
  if (index < 0) return manifest.vaults;
  return manifest.vaults.map((vault, candidateIndex) => candidateIndex === index ? update(vault) : vault);
}

function applyPatch(manifest: SharedSettingsManifest, patch: SharedSettingsPatch): SharedSettingsManifest {
  switch (patch.kind) {
    case 'set-enabled':
      return { ...manifest, enabled: patch.enabled };
    case 'set-vault-excluded':
      if (!hasVault(manifest, patch.vaultId)) return manifest;
      return { ...manifest, excludedVaultIds: toggleId(manifest.excludedVaultIds, patch.vaultId, patch.excluded) };
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
      if (!hasVault(manifest, patch.vaultId)) return manifest;
      const targetVaultIdsBySource = Object.fromEntries(
        Object.entries(manifest.virtualLinks.targetVaultIdsBySource)
          .filter(([sourceId]) => sourceId !== patch.vaultId)
          .map(([sourceId, targetIds]) => [sourceId, targetIds.filter((targetId) => targetId !== patch.vaultId)]),
      );
      return {
        ...manifest,
        vaults: manifest.vaults.filter((vault) => vault.id !== patch.vaultId),
        excludedVaultIds: manifest.excludedVaultIds.filter((id) => id !== patch.vaultId),
        virtualLinks: {
          ...manifest.virtualLinks,
          excludedSourceVaultIds: manifest.virtualLinks.excludedSourceVaultIds.filter((id) => id !== patch.vaultId),
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
      return { ...manifest, virtualLinks: { ...manifest.virtualLinks, enabled: patch.enabled } };
    case 'set-virtual-link-source-excluded':
      if (!hasVault(manifest, patch.vaultId)) return manifest;
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
    case 'set-virtual-link-targets': {
      if (!hasVault(manifest, patch.sourceVaultId)) return manifest;
      const targetVaultIds = patch.targetVaultIds.filter((vaultId) => hasVault(manifest, vaultId));
      return {
        ...manifest,
        virtualLinks: {
          ...manifest.virtualLinks,
          targetVaultIdsBySource: {
            ...manifest.virtualLinks.targetVaultIdsBySource,
            [patch.sourceVaultId]: targetVaultIds,
          },
        },
      };
    }
    case 'set-virtual-link-style':
      return {
        ...manifest,
        virtualLinks: {
          ...manifest.virtualLinks,
          colorMode: patch.mode,
          colorIntensity: patch.intensity,
        },
      };
  }
}

function seedComparable(manifest: SharedSettingsManifest): Record<string, unknown> {
  const {
    schemaVersion: _schemaVersion,
    revision: _revision,
    updatedAt: _updatedAt,
    writerInstanceId: _writerInstanceId,
    ...projection
  } = manifest;
  return projection;
}

function boundedFileName(fileName: string): string {
  return fileName.length <= MAX_ERROR_FILE_NAME_LENGTH
    ? fileName
    : `${fileName.slice(0, MAX_ERROR_FILE_NAME_LENGTH - 3)}...`;
}

async function parseJsonFile(filePath: string, description: string): Promise<unknown> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    throw error;
  }

  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw new MalformedSharedSettingsError(`${description} contains malformed JSON.`, { cause: error });
  }
}

async function writeSyncedFile(filePath: string, value: unknown): Promise<void> {
  const handle = await open(filePath, 'wx', 0o600);
  let failed = false;
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      if (!failed) throw error;
    }
  }
}

async function cleanupPending(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // Pending files are never read and cleanup is best-effort.
  }
}

function comparePatchEnvelopes(
  left: SharedSettingsPatchEnvelope,
  right: SharedSettingsPatchEnvelope,
): number {
  if (left.logicalClock !== right.logicalClock) {
    return left.logicalClock < right.logicalClock ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

interface SharedSettingsJournalState {
  manifest: SharedSettingsManifest;
  envelopes: SharedSettingsPatchEnvelope[];
}

export class SharedSettingsStore {
  readonly applicationDataRoot: string;
  readonly directory: string;
  readonly seedPath: string;
  readonly patchesDirectory: string;

  private readonly now: () => Date;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly beforePublishPatch: (pendingPath: string, finalPath: string) => Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(applicationDataRoot: string, options: SharedSettingsStoreOptions = {}) {
    this.applicationDataRoot = path.resolve(applicationDataRoot);
    this.directory = path.join(this.applicationDataRoot, SHARED_SETTINGS_DIRECTORY_NAME);
    this.seedPath = path.join(this.directory, SHARED_SETTINGS_SEED_FILE_NAME);
    this.patchesDirectory = path.join(this.directory, SHARED_SETTINGS_PATCH_DIRECTORY_NAME);
    this.now = options.now ?? (() => new Date());
    this.randomBytes = options.randomBytes ?? cryptoRandomBytes;
    this.beforePublishPatch = options.beforePublishPatch ?? (async () => undefined);
  }

  async read(): Promise<SharedSettingsManifest | null> {
    return (await this.readJournal())?.manifest ?? null;
  }

  async initialize(seed: SharedSettingsProjection, writerInstanceId: string): Promise<SharedSettingsManifest> {
    return this.serializeWrite(() => this.initializeNow(seed, writerInstanceId));
  }

  async patch(patch: SharedSettingsPatch, writerInstanceId: string): Promise<SharedSettingsManifest> {
    return this.serializeWrite(() => this.patchNow(patch, writerInstanceId));
  }

  private async initializeNow(
    seed: SharedSettingsProjection,
    writerInstanceId: string,
  ): Promise<SharedSettingsManifest> {
    requireNonEmptyString(writerInstanceId, 'writerInstanceId');
    const createdAt = this.now();
    if (Number.isNaN(createdAt.getTime())) invalidManifest('updatedAt must be a valid timestamp.');
    const candidate = {
      ...seed,
      schemaVersion: SHARED_SETTINGS_SCHEMA_VERSION,
      revision: 0,
      updatedAt: createdAt.toISOString(),
      writerInstanceId,
    } as SharedSettingsManifest;
    validateManifest(candidate, 0);

    const existing = await this.readSeed();
    if (existing) return this.resolveExistingSeed(existing, candidate);

    await mkdir(this.patchesDirectory, { recursive: true });
    const pendingPath = path.join(
      this.directory,
      `.pending-seed-${process.pid}-${this.randomBytes(16).toString('hex')}`,
    );

    try {
      await writeSyncedFile(pendingPath, candidate);
      try {
        await link(pendingPath, this.seedPath);
        return candidate;
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
        const published = await this.readSeed();
        if (!published) throw error;
        return this.resolveExistingSeed(published, candidate);
      }
    } finally {
      await cleanupPending(pendingPath);
    }
  }

  private async patchNow(
    patch: SharedSettingsPatch,
    writerInstanceId: string,
  ): Promise<SharedSettingsManifest> {
    requireNonEmptyString(writerInstanceId, 'writerInstanceId', invalidPatch);
    validatePatch(patch);
    const journal = await this.readJournal();
    if (!journal) {
      throw new SharedSettingsNotInitializedError(
        `Shared settings seed does not exist at ${this.seedPath}.`,
      );
    }

    const preview = applyPatch(journal.manifest, patch);
    validateManifest(preview, journal.manifest.revision);

    const maxObservedClock = journal.envelopes.reduce(
      (maximum, envelope) => Math.max(maximum, envelope.logicalClock),
      0,
    );
    if (maxObservedClock >= Number.MAX_SAFE_INTEGER) {
      invalidPatch('patch logical clock is exhausted.');
    }
    const logicalClock = maxObservedClock + 1;

    await mkdir(this.patchesDirectory, { recursive: true });
    const createdAt = this.now();
    if (Number.isNaN(createdAt.getTime())) invalidPatch('patch createdAt must be a valid timestamp.');
    const id = this.createPatchId(logicalClock, writerInstanceId);
    const envelope: SharedSettingsPatchEnvelope = {
      schemaVersion: SHARED_SETTINGS_SCHEMA_VERSION,
      id,
      writerInstanceId,
      logicalClock,
      createdAt: createdAt.toISOString(),
      patch,
    };
    validateEnvelope(envelope, id);

    const pendingPath = path.join(
      this.patchesDirectory,
      `.pending-${id}-${this.randomBytes(16).toString('hex')}`,
    );
    const finalPath = path.join(this.patchesDirectory, `${id}.json`);
    try {
      await writeSyncedFile(pendingPath, envelope);
      await this.beforePublishPatch(pendingPath, finalPath);
      await rename(pendingPath, finalPath);
    } finally {
      await cleanupPending(pendingPath);
    }

    const result = await this.read();
    if (!result) {
      throw new SharedSettingsNotInitializedError('Shared settings seed disappeared after patch publication.');
    }
    return result;
  }

  private serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readJournal(): Promise<SharedSettingsJournalState | null> {
    const seed = await this.readSeed();
    if (!seed) return null;

    const envelopes = await this.readPatchEnvelopes();
    let manifest = seed;
    for (const [index, envelope] of envelopes.entries()) {
      manifest = {
        ...applyPatch(manifest, envelope.patch),
        revision: index + 1,
        updatedAt: envelope.createdAt,
        writerInstanceId: envelope.writerInstanceId,
      };
      validateManifest(manifest, index + 1);
    }
    return { manifest, envelopes };
  }

  private async readPatchEnvelopes(): Promise<SharedSettingsPatchEnvelope[]> {
    let entries;
    try {
      entries = await readdir(this.patchesDirectory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return [];
      throw error;
    }

    const patchFileNames = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('.pending-'))
      .map((entry) => entry.name)
      .sort();
    const envelopes: SharedSettingsPatchEnvelope[] = [];
    for (const fileName of patchFileNames) {
      const id = fileName.slice(0, -'.json'.length);
      const parsed = await parseJsonFile(
        path.join(this.patchesDirectory, fileName),
        `Shared settings patch ${JSON.stringify(boundedFileName(fileName))}`,
      );
      validateEnvelope(parsed, id);
      envelopes.push(parsed);
    }
    return envelopes.sort(comparePatchEnvelopes);
  }

  private async readSeed(): Promise<SharedSettingsManifest | null> {
    let parsed: unknown;
    try {
      parsed = await parseJsonFile(this.seedPath, `Shared settings seed at ${this.seedPath}`);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null;
      throw error;
    }
    validateManifest(parsed, 0);
    return parsed;
  }

  private resolveExistingSeed(
    existing: SharedSettingsManifest,
    candidate: SharedSettingsManifest,
  ): SharedSettingsManifest {
    if (isDeepStrictEqual(seedComparable(existing), seedComparable(candidate))) return existing;
    throw new SharedSettingsInitializationConflictError(
      `Shared settings seed at ${this.seedPath} was initialized with conflicting settings.`,
    );
  }

  private createPatchId(logicalClock: number, writerInstanceId: string): string {
    const nextSequence = (processWriterPatchSequences.get(writerInstanceId) ?? 0n) + 1n;
    processWriterPatchSequences.set(writerInstanceId, nextSequence);
    const clock = String(logicalClock).padStart(16, '0');
    const writer = createHash('sha256').update(writerInstanceId).digest('hex').slice(0, 16);
    const sequence = nextSequence.toString(16).padStart(12, '0').slice(-12);
    const random = this.randomBytes(16).toString('hex');
    return `${clock}-${writer}-${sequence}-${random}`;
  }
}
