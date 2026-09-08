# Portable Vault Paths for 2.6 Design

## Purpose

Make Multi-Vault Navigator 2.6 portable between machines whose synchronized vaults have different absolute roots, without regressing shared settings, virtual links, public APIs, migration safety, or incremental indexing.

This supersedes the implementation based on stale 2.5.1 source. The observed data and acceptance criteria remain in `HANDOFF.md`.

## Baseline and upstream

The implementation base is `origin/feat/shared-config-api` at `68a457e`, version 2.6.0, author ErraticPattern. It already contains `origin/feat/safe-overwrite` and matches the feature set visible in the installed 2.6.0 bundle.

Upstream release 2.3.3 fixes Reading View cross-vault anchor rewriting and explicit MiniSearch result typing. Both fixes already exist in 2.6.0, whose link implementation additionally supports Live Preview, ambiguity selection, appearance settings, and both link syntaxes. No upstream commit will be cherry-picked because doing so would replace newer fork behavior with an older implementation.

Two inherited Linux baseline failures are repaired first: foreign Windows absolute destination paths must be rejected independently of host OS, and the authoritative shared-settings test must assert that auto-detection is skipped rather than expecting the stray detected vault.

## State separation

Vault state has two categories:

- Shared: stable ID, name, enabled state, colour, icon, include/exclude patterns, and relationships referenced by shared and virtual-link settings.
- Local: the absolute filesystem root used on one machine.

`VaultConfig` remains the resolved runtime model. Persistence and shared projections use a portable record without an authoritative absolute path. Legacy records with `path` and `pathKey` remain readable during migration.

A versioned local overlay is stored outside synchronized vaults, beside the active Obsidian global registry:

```json
{
  "version": 1,
  "vaultPaths": {
    "stable-shared-id": "/home/jamaro/obsidian/ideas"
  }
}
```

Writes are atomic and update memory only after the temporary file is renamed successfully.

## Discovery

Discovery checks every applicable registry instead of returning one path:

- Windows: `%APPDATA%/Obsidian/obsidian.json`
- macOS: `~/Library/Application Support/obsidian/obsidian.json`
- Linux: `$XDG_CONFIG_HOME`, `~/.config`, Flatpak under `~/.var/app/md.obsidian.Obsidian`, and Snap under `~/snap/obsidian/current/.config`

Missing and malformed candidates are isolated. Valid later candidates still load. The local overlay lives beside the registry containing the current vault, then beside the first existing registry, then in the normal platform configuration location.

Typed and legacy paths accept leading `~`, `$HOME`, `${HOME}`, and `%USERPROFILE%`, plus either slash style. Absolute-path detection recognizes POSIX and Windows forms on every host.

## Identity and resolution

An existing shared ID is stable and never replaced by a machine-specific Obsidian registry ID. Registry IDs initialize newly discovered records only. A second machine matches an existing shared record by unambiguous normalized name/basename and then records its own local root under the existing ID.

Runtime resolution order is:

1. valid local overlay path keyed by stable shared ID
2. unambiguous local Obsidian registry match
3. valid legacy path from local settings or a schema-1 shared record
4. unavailable

Manual folder selection explicitly asserts that a selected root corresponds to the existing row, preserving its ID and all shared references.

Legacy duplicate entries merge only with positive evidence: equal ID, equal valid normalized path, or one unambiguous local registry/valid-path match with matching name and basename. Ambiguous same-name records remain separate. Canonical selection preserves the first existing shared ID. Removed IDs become aliases for cache and relationship migration.

Unavailable vaults remain in shared settings and UI, but operational consumers, scanners, and migration targets receive only available vaults.

## Shared settings journal

The shared-settings schema advances from version 1 to version 2. Version-2 vault records omit authoritative absolute `path` and `pathKey` fields. Shared IDs and metadata remain unchanged, so excluded-vault lists and virtual-link target maps continue to refer to the same records.

Schema-1 manifests and patches are accepted as migration input. Their paths may help establish a local root only when valid on the current machine. Publishing after migration emits schema 2. Projection application combines portable shared records with local resolution instead of replacing local roots with another machine's paths.

Concurrent journal semantics, immutable patches, locking, revision ordering, participation overrides, and authoritative startup behavior remain unchanged. Schema migration is deterministic and idempotent.

## Index portability

`vaultId + relativePath` is the portable indexed-file identity. Cached `absolutePath` is derived runtime data.

On cache load:

- rewrite duplicate aliases to canonical IDs
- normalize relative separators
- rebase safe relative paths under each available local root
- reject absolute or parent-traversing relative paths
- retain unavailable-vault records for later relinking
- persist once when migration changed IDs or paths

Incremental indexing and search semantics remain unchanged. A later scan updates stale metadata normally.

## Settings UX

Each vault row displays its resolved local path or `Unavailable on this device`. A folder button opens the desktop directory chooser. A valid selected vault writes only the local overlay, refreshes runtime resolution, rebases the cache, and preserves the shared ID. Cancellation changes nothing; validation or persistence failures show a Notice and leave state unchanged.

Manual Add accepts portable path forms. If the path unambiguously matches an existing shared row, it relinks instead of creating a duplicate.

## Recovery safety

Before the first schema/path migration, immutable one-time copies are created beside every affected source:

- `data.pre-portable-paths.json`
- `index-cache.pre-portable-paths.json`
- a shared-journal backup using the journal's existing filename plus `.pre-portable-paths`

Existing backups are never overwritten. If any required backup fails, migration aborts before writing migrated state. Installed `main.js`, `manifest.json`, and `styles.css` are separately backed up before test deployment. Rollback instructions identify exactly which files to restore after disabling the plugin.

## Components

- `vault-paths.ts`: portable expansion, normalization, candidate paths, safe rebasing
- `obsidian-vault-discovery.ts`: tolerant multi-registry parsing
- `local-vault-path-store.ts`: atomic machine-local overlay
- `vault-registry.ts`: reconciliation, availability, relinking, alias map
- `shared-settings-types.ts`, projection, service, and store: schema-2 portable records and schema-1 migration
- `index-store.ts` and `indexer.ts`: cache alias migration and rebasing
- `settings-tab.ts` and `vault-folder-picker.ts`: local relinking UI
- startup migration backup utility: settings, cache, and journal preservation before writes

Filesystem/environment dependencies are injectable for host-independent tests.

## Testing

Tests cover platform registry candidates, Flatpak/Snap/XDG discovery, malformed-candidate continuation, portable expansion, atomic overlay rollback, identity stability across different Windows/Linux registry IDs, conservative duplicate reconciliation, unavailable vault behavior, shared schema-1 to schema-2 migration, journal convergence without paths, virtual-link ID preservation, safe cache rebasing, relink behavior, and non-overwriting backups.

An E2E fixture combines polluted Windows `data.json`, a schema-1 shared journal, a Windows cache, and a Linux Flatpak registry. It must resolve all four local vaults, retain remote-only unavailable records, collapse proven duplicates, preserve shared relationships, rebase index paths, remove shared absolute paths, and produce byte-stable state on a second load.

Manual testing deploys a production build from the 2.6 worktree only after automated verification. It first backs up installed assets and uses the existing excluded real fixtures, including the escaped Windows path in `medicine`. The 2.6.0 installation and user data must be restorable byte-for-byte.
