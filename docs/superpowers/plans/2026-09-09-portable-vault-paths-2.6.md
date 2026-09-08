# Portable Vault Paths 2.6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve vault roots per machine while preserving the 2.6 shared-settings journal, IDs, relationships, and indexes.

**Architecture:** Introduce pure path/discovery helpers and an atomic machine-local ID-to-root overlay. Convert local and shared persistence to portable vault records, migrate schema-1 journal paths into schema 2, resolve runtime vaults through `VaultRegistry`, and rebase cached absolute paths from canonical IDs plus relative paths.

**Tech Stack:** TypeScript 5, Node.js filesystem/path APIs, Obsidian desktop API, Vitest 3, esbuild

**Spec:** `docs/superpowers/specs/2026-09-09-portable-vault-paths-2.6-design.md`

## Global Constraints

- Base all work on version 2.6.0 commit `68a457e`.
- Preserve shared IDs, excluded-vault references, and virtual-link relationships.
- Never publish machine-local absolute paths in schema-2 shared state.
- Keep unavailable vaults configured and exclude them from filesystem operations.
- Back up settings, cache, and journal before migration; never overwrite backups.
- Do not cherry-pick upstream 2.3.3 because its fixes are already superseded.
- Do not modify `CHANGELOG.md`.

---

### Task 1: Repair inherited baseline

**Files:** Modify `src/migration/destination-paths.ts`, `tests/shared-settings-service.test.ts`

- [ ] Confirm `C:\\outside` fails on Linux and the authoritative projection test has a contradictory assertion.
- [ ] Use both `path.posix.isAbsolute` and `path.win32.isAbsolute` for destination folders.
- [ ] Change the authoritative test's first assertion to expect `stray` only when normal auto-detection is enabled and its second assertion not to contain `stray` when disabled.
- [ ] Run `npm test && npm run build` and commit as `fix: restore cross-platform baseline`.

### Task 2: Portable path discovery and local overlay

**Files:** Create `src/vault-paths.ts`, `src/obsidian-vault-discovery.ts`, `src/local-vault-path-store.ts`; create corresponding tests.

**Interfaces:**
```ts
getObsidianConfigCandidates(platform, env, home): string[]
expandPortablePath(value, env, home): string
normalizeVaultPath(value, platform): string
rebaseRelativePath(root, relative): string | null
discoverObsidianVaults(candidates, dependencies): DiscoveredVault[]
LocalVaultPathStore.load(): LocalVaultPathData
LocalVaultPathStore.set(id, path): void
```

- [ ] Write RED tests for Windows/macOS/XDG/Flatpak/Snap candidates, home expansion, mixed separators, malformed registries, safe rebasing, atomic writes, and rollback.
- [ ] Implement the pure helpers, tolerant discovery, config-directory selection, and version-1 atomic local store.
- [ ] Run focused tests and build; commit as `feat: add machine-local vault paths`.

### Task 3: Portable runtime registry and local settings

**Files:** Modify `src/types.ts`, `src/vault-registry.ts`, operational path consumers, `src/main.ts`; create `tests/vault-registry.test.ts`.

**Interfaces:**
```ts
interface SharedVaultConfig { id: string; name: string; enabled: boolean; /* appearance/patterns */ path?: string }
type VaultConfig = AvailableVaultConfig | UnavailableVaultConfig
VaultRegistry.getPersistedVaults(): SharedVaultConfig[]
VaultRegistry.getIdAliases(): ReadonlyMap<string, string>
VaultRegistry.relinkVault(id, path): boolean
```

- [ ] Write RED tests using the real polluted Windows/Linux shapes, different registry IDs, unavailable vaults, ambiguous names, valid later legacy paths, auto-discovery, and idempotence.
- [ ] Implement conservative reconciliation, stable shared IDs, resolution precedence, relinking, and portable saves.
- [ ] Make scanners, migrations, and target pickers consume only available vaults.
- [ ] Run registry tests, full suite, and build; commit as `feat: resolve portable vault identities`.

### Task 4: Shared journal schema 2

**Files:** Modify all `src/shared-settings/*` path-bearing types/projection/service/store files and tests.

**Interfaces:**
```ts
const SHARED_SETTINGS_SCHEMA_VERSION = 2
interface SharedVaultRecord { id: string; name: string; enabled: boolean; /* no path/pathKey */ }
type LegacySharedVaultRecord = SharedVaultRecord & { path: string; pathKey: string }
applySharedProjection(local, projection, resolver): MultiVaultSettings
```

- [ ] Write RED tests proving schema-1 manifests/patches load, schema-2 publishing omits paths, IDs and virtual-link references survive, a foreign path never replaces a local root, and a second migration is byte-stable.
- [ ] Add explicit schema-1 parsing and conversion rather than weakening schema-2 validation.
- [ ] Update projection canonicalization to group by stable IDs and reconcile names only through the registry resolver.
- [ ] Update current-vault exclusion checks to use the runtime registry/current shared ID, not shared path keys.
- [ ] Preserve locking, patch ordering, immutable journal behavior, and public API callbacks.
- [ ] Run every shared-settings test plus full suite/build; commit as `feat: make shared settings paths portable`.

### Task 5: Portable index cache

**Files:** Modify `src/indexer/index-store.ts`, `src/indexer/indexer.ts`; create `tests/index-store-portability.test.ts`.

- [ ] Write RED tests for alias migration, Windows-to-Linux rebasing, unsafe relative paths, unavailable records, and idempotent persistence.
- [ ] Return `{ files, migrated }` from cache loading and derive available absolute paths with `rebaseRelativePath`.
- [ ] Preserve incremental index behavior and snippet policy.
- [ ] Run index tests, performance tests, full suite/build; commit as `feat: rebase portable index cache`.

### Task 6: Relink UI and recovery backups

**Files:** Create `src/vault-folder-picker.ts`, `src/portable-migration-backup.ts`; modify `src/settings-tab.ts`, startup/shared-store wiring, mocks and tests.

- [ ] Write RED tests for folder selection/cancel/unavailable Electron API and immutable backups of `data.json`, cache, seed, and patch directory snapshot.
- [ ] Add folder button per vault, unavailable label, explicit relink, cache reinitialization, and manual-add reconciliation.
- [ ] Run backups before any local/shared migration write; abort migration on backup failure.
- [ ] Add exact rollback instructions to README without editing CHANGELOG.
- [ ] Run focused/full tests and build; commit as `feat: add safe per-device vault relinking`.

### Task 7: End-to-end verification and deployment

**Files:** Create `tests/portable-vaults.e2e.test.ts`; update README if necessary.

- [ ] Build an E2E fixture with polluted Windows settings, schema-1 journal, Windows cache, Flatpak registry, four local vaults, and one remote-only vault.
- [ ] Assert duplicate collapse, stable IDs, relationship preservation, local roots, unavailable retention, cache rebasing, path-free shared output, backups, and second-load stability.
- [ ] Run `npm test && npm run build && git diff --check` from a clean process.
- [ ] Review `2.3.2..2.3.3` once more and record that both fixes remain present without cherry-pick.
- [ ] Back up installed 2.6.0 assets, build from this worktree, deploy matching `main.js`, `manifest.json`, and `styles.css` to all four vaults, and verify checksums.
- [ ] Keep the branch/worktree unmerged for user testing.
