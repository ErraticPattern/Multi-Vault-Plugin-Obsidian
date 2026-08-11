# Shared Multi-Vault Configuration and API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synchronize canonical vault identity, colors, cross-vault appearance, and Virtual Linker integration scope through one revisioned local manifest, then expose that state through optional API v1.

**Architecture:** A focused shared-settings subsystem separates schema/projection, filesystem storage, and plugin lifecycle. Records converge by normalized real path and explicit patches serialize through an inter-process lock. A read-only public API projects indexed targets and emits bounded catalog/appearance events without coupling consumers to plugin internals.

**Tech Stack:** TypeScript, Node filesystem/path/crypto APIs, Obsidian Plugin API, Vitest 3.

## Global Constraints

- Synchronization defaults off.
- First activation seeds from Ideas only after preview and confirmation.
- One global switch and per-vault exclusions control participation.
- Sync no note text, snippets, saved searches, pinned files, secrets, or index caches.
- Vault identity is canonical by normalized real filesystem path, not local ID.
- Preserve unknown manifest fields; never rewrite unsupported future schema versions.
- Corrupt, absent, inaccessible, or invalid shared data must not reset valid local settings.
- External target vaults remain opt-in per source vault.
- No network, Dataview, Omnisearch, or QuickAdd dependency.
- Tests redirect application data and vaults to temporary directories.
- Build verification uses `MVN_SKIP_DEPLOY=1` until explicit deployment approval.

---

### Task 1: Define Schema, Path Identity, and Shared Projection

**Files:**
- Create: `src/shared-settings/shared-settings-types.ts`
- Create: `src/shared-settings/path-identity.ts`
- Create: `src/shared-settings/shared-settings-projection.ts`
- Modify: `src/types.ts`
- Create: `tests/shared-settings-projection.test.ts`

**Interfaces:**
- Produces: `SHARED_SETTINGS_SCHEMA_VERSION = 1`
- Produces: `normalizeVaultPath(input, platform): Promise<string>`
- Produces: `projectSharedSettings(local, currentPathKey): SharedSettingsProjection`
- Produces: `applySharedProjection(local, projection): MultiVaultSettings`

- [ ] **Step 1: Write failing schema/projection tests**

Cover Windows case folding, slash normalization, trailing separators, same-path ID convergence, shared/local field partitioning, alias-safe cloning, and invalid colors:

```ts
expect(await normalizeVaultPath('C:\\Users\\Jo\\Vault\\', 'win32'))
  .toBe('c:/users/jo/vault');
const applied = applySharedProjection(localSettings, sharedProjection);
expect(applied.savedSearches).toEqual(localSettings.savedSearches);
expect(applied.vaults.find(v => v.path.endsWith('ideas'))?.color).toBe('#fa0000');
```

Use temporary real directories for `realpath` tests and a pure `normalizePathKey` helper for platform-specific lexical cases.

- [ ] **Step 2: Run focused test and verify RED**

```bash
npm test -- tests/shared-settings-projection.test.ts
```

Expected: module-not-found failures.

- [ ] **Step 3: Define exact schema**

Use these core types:

```ts
export interface SharedVaultRecord {
  id: string;
  pathKey: string;
  path: string;
  name: string;
  color?: string;
  icon?: string;
  enabled: boolean;
  includePatterns?: string[];
  excludePatterns?: string[];
}

export type VirtualLinkColorMode = 'off' | 'muted-text' | 'colored-underline' | 'soft-pill';

export interface SharedVirtualLinkSettings {
  enabled: boolean;
  excludedSourceVaultIds: string[];
  targetVaultIdsBySource: Record<string, string[]>;
  colorMode: VirtualLinkColorMode;
  colorIntensity: number;
}

export interface SharedSettingsProjection {
  enabled: boolean;
  excludedVaultIds: string[];
  vaults: SharedVaultRecord[];
  crossVaultLinks: {
    showVaultBadge: boolean;
    useVaultColorForLinks: boolean;
  };
  virtualLinks: SharedVirtualLinkSettings;
}

export interface SharedSettingsManifest extends SharedSettingsProjection {
  schemaVersion: 1;
  revision: number;
  updatedAt: string;
  writerInstanceId: string;
  extensions?: Record<string, unknown>;
}
```

Add local `sharedSettings` metadata to `MultiVaultSettings` containing last applied revision/time and local participation override, but keep it out of the shared projection.

- [ ] **Step 4: Implement normalization and projection**

Normalize paths through `realpath` when present, `path.resolve`, slash conversion, root-safe trailing-separator removal, and lowercase only on Windows. Validate colors with `/^#[0-9a-f]{6}$/i`, clamp intensity to integers from 10 through 90, deduplicate arrays, and sort vaults by `pathKey` for deterministic output.

Map incoming shared records to existing local vaults by `pathKey`; shared canonical IDs replace conflicting local IDs. Preserve local-only top-level settings exactly.

- [ ] **Step 5: Run focused test and verify GREEN**

```bash
npm test -- tests/shared-settings-projection.test.ts
```

Expected: all projection tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/shared-settings src/types.ts tests/shared-settings-projection.test.ts
git commit -m "feat: define shared vault configuration"
```

### Task 2: Build Revisioned, Locked Manifest Store

**Files:**
- Create: `src/shared-settings/shared-settings-store.ts`
- Create: `src/shared-settings/shared-settings-errors.ts`
- Create: `tests/shared-settings-store.test.ts`

**Interfaces:**
- Consumes: Task 1 `SharedSettingsManifest`
- Produces: `SharedSettingsStore.read()`, `initialize()`, and `patch()`
- Produces: `SharedSettingsPatch` discriminated union for exact field edits

- [ ] **Step 1: Write failing store tests**

Use a temporary application-data directory. Cover absent read, valid initialize, monotonic revision, unknown extension preservation, disjoint concurrent patches, same-field serialization, lock timeout, stale lock expiry, malformed JSON, schema validation, unsupported future version, and write interruption.

Representative assertion:

```ts
await Promise.all([
  storeA.patch({ kind: 'set-vault-color', vaultId: 'ideas', color: '#112233' }),
  storeB.patch({ kind: 'set-vault-icon', vaultId: 'ideas', icon: 'brain' }),
]);
const saved = await storeA.read();
expect(saved?.vaults[0]).toMatchObject({ color: '#112233', icon: 'brain' });
expect(saved?.revision).toBe(3);
```

- [ ] **Step 2: Run focused test and verify RED**

```bash
npm test -- tests/shared-settings-store.test.ts
```

Expected: module-not-found failures.

- [ ] **Step 3: Define explicit patches**

Use a discriminated union rather than accepting arbitrary whole-manifest replacement:

```ts
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
```

- [ ] **Step 4: Implement lock/read/patch/write**

Create `shared-settings-v1.json`, `.lock`, and a unique staging file in the shared directory. Acquire lock with `open(lockPath, 'wx')`, retry with bounded jitter for at most two seconds, and remove a lock older than 30 seconds only after rechecking its mtime. Under lock: read latest, reject future schema, apply one patch, validate, increment revision, set writer/timestamp, write and fsync staging content, publish it, then remove lock in `finally`.

On Windows, use a replace routine that preserves either the complete old or complete new JSON and cleans staging files. Never interpret malformed content as an empty manifest.

- [ ] **Step 5: Run focused test and verify GREEN**

```bash
npm test -- tests/shared-settings-store.test.ts
```

Expected: all store tests pass, including two independent store instances.

- [ ] **Step 6: Commit**

```bash
git add src/shared-settings/shared-settings-store.ts src/shared-settings/shared-settings-errors.ts tests/shared-settings-store.test.ts
git commit -m "feat: add revisioned shared settings store"
```

### Task 3: Add Synchronization Lifecycle and Local Mirror

**Files:**
- Create: `src/shared-settings/shared-settings-service.ts`
- Modify: `src/main.ts`
- Modify: `src/vault-registry.ts`
- Modify: `src/indexer/indexer.ts`
- Create: `tests/shared-settings-service.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2 projection/store
- Produces: `SharedSettingsService.initialize()`, `applyLatest()`, `publish(patch)`, `getStatus()`, `dispose()`
- Produces: coalesced `appearance-changed` and `catalog-changed` callbacks

- [ ] **Step 1: Write failing lifecycle tests**

Create four local settings fixtures against one temporary manifest. Prove enabled peers apply a color patch, excluded peers do not apply/publish, disabled sync leaves local values, a closed peer applies on later initialize, invalid manifests preserve local state, catalog changes request one incremental refresh, and appearance changes request no index rebuild.

```ts
await ideas.publish({ kind: 'set-vault-color', vaultId: 'medicine', color: '#abcdef' });
await medicine.applyLatest();
expect(medicineSettings.vaults.find(v => v.id === 'medicine')?.color).toBe('#abcdef');
expect(refreshIncremental).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run focused test and verify RED**

```bash
npm test -- tests/shared-settings-service.test.ts
```

Expected: missing service failure.

- [ ] **Step 3: Implement service state machine**

Track `lastValidManifest`, `lastAppliedRevision`, `lastError`, and `disposed`. `initialize()` reads and validates but does not create a manifest. `applyLatest()` returns one of:

```ts
export type SyncApplyResult =
  | { kind: 'unchanged'; revision: number | null }
  | { kind: 'disabled'; revision: number | null }
  | { kind: 'excluded'; revision: number }
  | { kind: 'applied'; revision: number; appearanceChanged: boolean; catalogChanged: boolean }
  | { kind: 'error'; message: string; revision: number | null };
```

Split startup into two phases. After `loadSettings()` but before constructing `VaultRegistry`, call `initializeAndApplyToSettings()` using the current adapter base path; this applies a valid newer projection to the plain settings object. Construct `VaultRegistry`, `Indexer`, and views from those settings, then call `attachRuntime()` with callbacks for later revisions.

Later applications update plugin settings, replace `VaultRegistry` canonical records through a new `replaceVaults(vaults)` method, save the local mirror, refresh views for appearance, and call `indexer.refreshIncremental(false)` once for catalog changes.

- [ ] **Step 4: Register lightweight polling and disposal**

After startup, use one plugin-owned interval to stat/read only when manifest mtime changes. Check immediately at settings-tab activation and through the manual command. Serialize apply operations with one promise. `dispose()` clears timers and callbacks.

Do not have peers write each other's `data.json`; each open peer mirrors its own applied projection through `saveData`.

- [ ] **Step 5: Run focused test and verify GREEN**

```bash
npm test -- tests/shared-settings-service.test.ts
```

Expected: all lifecycle tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/shared-settings/shared-settings-service.ts src/main.ts src/vault-registry.ts src/indexer/indexer.ts tests/shared-settings-service.test.ts
git commit -m "feat: synchronize shared vault settings"
```

### Task 4: Add Ideas Seed Preview, Settings, and Commands

**Files:**
- Create: `src/modals/shared-settings-seed-modal.ts`
- Create: `src/modals/shared-settings-status-modal.ts`
- Create: `src/modals/virtual-link-targets-modal.ts`
- Modify: `src/settings-tab.ts`
- Modify: `src/main.ts`
- Create: `tests/shared-settings-ui.test.ts`

**Interfaces:**
- Consumes: Task 3 service
- Produces: first-run Ideas seed workflow
- Produces: `VirtualLinkTargetsModal(app, sourceVault, candidates, selectedIds, onSave)`
- Produces commands: `multi-vault-sync-shared-settings`, `multi-vault-show-sync-status`

- [ ] **Step 1: Write failing pure view-model tests**

Extract and test `makeSharedSeedPreview()` and `makeSharedStatusModel()`. The Ideas fixture must expose the approved four-color palette and list every synchronized field. Status must include path, enabled state, current revision, last application time, current exclusion, and error.

- [ ] **Step 2: Run focused test and verify RED**

```bash
npm test -- tests/shared-settings-ui.test.ts
```

Expected: missing model/modal failures.

- [ ] **Step 3: Implement Ideas discovery and seed modal**

Find the canonical Ideas vault by normalized basename/name `ideas`, read only its Multi-Vault `data.json`, validate it through Task 1 projection, and show a non-editable preview. Confirmation calls `store.initialize(seed, writerInstanceId)`; cancellation writes nothing. If Ideas config is missing or invalid, show an error and keep synchronization off.

- [ ] **Step 4: Add settings controls**

Add a **Shared configuration** group with:

- Global enable/disable.
- Per-vault participation exclusions.
- Sync now.
- Show status.
- Virtual Linker global enable.
- Per-source opt-in target vault selection through `VirtualLinkTargetsModal`. The modal lists every non-source vault with color, full path, and toggle, then publishes one `set-virtual-link-targets` patch on Save.
- Color mode dropdown with `off`, `muted-text`, `colored-underline`, `soft-pill`.
- Intensity slider from 10 to 90, default 55.

When sync is enabled, shared fields publish explicit patches through the service. Local-only fields continue through `saveSettings()`.

- [ ] **Step 5: Register commands and refresh hooks**

Register the two command IDs. `Sync now` calls `applyLatest(true)` and reports result. Status opens the status modal. Settings-tab `display/update` asks the service to check for a new revision before rendering.

- [ ] **Step 6: Run focused and full UI-adjacent tests**

```bash
npm test -- tests/shared-settings-ui.test.ts tests/shared-settings-service.test.ts
```

Expected: tests pass without touching real `%APPDATA%` or vault plugin directories.

- [ ] **Step 7: Commit**

```bash
git add src/modals/shared-settings-seed-modal.ts src/modals/shared-settings-status-modal.ts src/modals/virtual-link-targets-modal.ts src/settings-tab.ts src/main.ts tests/shared-settings-ui.test.ts
git commit -m "feat: add shared settings controls"
```

### Task 5: Expose Optional Public API v1

**Files:**
- Create: `src/api/public-api-types.ts`
- Create: `src/api/multi-vault-public-api.ts`
- Modify: `src/main.ts`
- Modify: `src/indexer/indexer.ts`
- Create: `tests/public-api.test.ts`

**Interfaces:**
- Consumes: shared canonical records, Virtual Link settings, `Indexer`, existing note resolver/link formatter/FileOpener
- Produces: `MultiVaultPublicApiV1` on `plugin.publicApi`

- [ ] **Step 1: Write failing contract tests**

Cover API version, current-vault descriptor/color, disabled empty target list, per-source target scope, normalized aliases, no note content, duplicate-safe resolution, root/path formatting, opening, appearance events, catalog events, unsubscribe, and post-dispose behavior.

```ts
expect(api.apiVersion).toBe(1);
expect(api.listVirtualLinkTargets()).toEqual([
  expect.objectContaining({
    identity: { vaultId: 'medicine', relativePath: 'Notes/ZeroTier.md' },
    title: 'ZeroTier', aliases: ['ZT'], vaultName: 'medicine', color: '#ac20df',
  }),
]);
expect(JSON.stringify(api.listVirtualLinkTargets())).not.toContain('contentPreview');
```

- [ ] **Step 2: Run focused test and verify RED**

```bash
npm test -- tests/public-api.test.ts
```

Expected: module-not-found failure.

- [ ] **Step 3: Define provider contract**

Define exact structural types from the approved spec, including:

```ts
export interface VaultIdentity { vaultId: string; relativePath: string; }
export interface VaultDescriptor { vaultId: string; vaultName: string; color?: string; }
export interface VirtualLinkTarget {
  identity: VaultIdentity;
  title: string;
  aliases: string[];
  vaultName: string;
  color?: string;
}
export type MultiVaultApiEvent =
  | { kind: 'catalog-changed' }
  | { kind: 'appearance-changed' };
```

`getCurrentVault()` returns `VaultDescriptor | null`. `resolveTarget` returns `resolved`, `ambiguous`, or `missing`; never a nullable first match.

- [ ] **Step 4: Implement API projection and lifecycle**

Normalize frontmatter aliases from string or string array, remove empty/duplicate aliases, and include only indexed Markdown files in explicitly selected external vaults. Delegate resolution to canonical path-aware helpers, formatting to existing cross-vault link formatting, and opening to `FileOpener`.

Expose `readonly publicApi` after core initialization. Dispose subscriptions in `onunload`. Add an indexer change callback so incremental/full changes emit one coalesced catalog event; shared palette changes emit appearance only.

- [ ] **Step 5: Run focused test and verify GREEN**

```bash
npm test -- tests/public-api.test.ts
```

Expected: all contract tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/api src/main.ts src/indexer/indexer.ts tests/public-api.test.ts
git commit -m "feat: expose optional multi-vault API"
```

### Task 6: Integration Fixtures, Documentation, and Performance

**Files:**
- Create: `tests/shared-settings-integration.e2e.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: complete shared service and API
- Produces: disposable four-vault proof and documented API/settings behavior

- [ ] **Step 1: Write failing four-vault integration test**

Create four temporary plugin-data fixtures plus a temporary application-data root. Seed from Ideas, apply to all peers, patch Medicine color from Hobbies, exclude Mathematics, and verify three participating views converge while Mathematics remains local. Restart one service instance and verify it restores the latest revision. Assert no note or cache files are read.

- [ ] **Step 2: Run E2E and verify RED if wiring is incomplete**

```bash
npm test -- tests/shared-settings-integration.e2e.test.ts
```

Expected before final wiring: a propagation, exclusion, or restart assertion fails. If all pass, inject an invalid expected color once, observe failure, restore it, and continue.

- [ ] **Step 3: Add real-scale read-only benchmark fixture**

Use generated metadata for 28,000 targets, not production vault writes. Measure projection and API listing. Assert target listing avoids note reads and remains below a documented 250 ms CI budget after warm initialization.

- [ ] **Step 4: Document settings and API contract**

Update README with central manifest location, shared/local field lists, Ideas seed, global/per-vault disable behavior, status commands, failure fallback, privacy note, and API v1 capability discovery. State that external integration remains off until explicitly enabled.

- [ ] **Step 5: Run complete verification**

```bash
npm test
MVN_SKIP_DEPLOY=1 npm run build
npm audit
git diff --check
```

Expected: full suite passes, TypeScript/build pass without deployment, audit reports zero vulnerabilities.

- [ ] **Step 6: Commit**

```bash
git add tests/shared-settings-integration.e2e.test.ts README.md
git commit -m "test: verify shared vault configuration"
```

### Task 7: Review and Release Gate

**Files:**
- Review only: all shared-configuration/API changes

**Interfaces:**
- Produces: verified Multi-Vault provider build ready for the Virtual Linker consumer stage

- [ ] **Step 1: Request code review**

Review path canonicalization, synchronization exclusions, lock recovery, stale-write behavior, future-schema preservation, local/shared partitioning, API target leakage, duplicate resolution, event disposal, and indexing side effects.

- [ ] **Step 2: Fix accepted findings through red-green tests**

Add one focused failing test per accepted finding, observe failure, implement the smallest fix, rerun focused and full tests, then commit with an exact `fix:` subject.

- [ ] **Step 3: Run final verification**

```bash
npm ci
npm audit
npm test
MVN_SKIP_DEPLOY=1 npm run build
git diff --check
git status --short
```

Expected: zero vulnerabilities, full green suite, successful non-deploying build, clean diff, clean working tree.

- [ ] **Step 4: Stop at release gate**

Do not activate shared configuration in production vaults, version, merge, deploy, tag, push, or begin Virtual Linker implementation until the user approves the provider-stage result.
