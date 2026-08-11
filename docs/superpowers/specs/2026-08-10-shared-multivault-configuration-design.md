# Shared Multi-Vault Configuration Design

**Status:** Approved design

## Purpose

Keep vault identity, colors, icons, cross-vault appearance, and integration scope consistent across local Obsidian vaults without copying whole plugin configurations or making local workflow preferences global.

## Architecture

A versioned shared manifest is the canonical source for synchronized fields. It resides under Obsidian's operating-system application-data directory, outside every vault. On Windows the directory is `%APPDATA%/Obsidian/multi-vault-navigator/`; equivalent Obsidian application-data locations are used on macOS and Linux.

Each vault retains its normal plugin `data.json`. Applied shared values are mirrored there as an offline fallback, but the central manifest wins while synchronization is enabled and valid.

Direct peer-to-peer copying of `data.json` is prohibited. Open vault windows otherwise retain stale settings, local identifiers conflict, and local-only fields can be overwritten.

## Canonical identity

Shared vault records are matched by normalized real filesystem path, using platform-appropriate case handling. Each record receives a stable opaque vault ID. Local records with different IDs but the same normalized path merge into that canonical record.

The initial manifest is seeded from the Ideas vault configuration after a mandatory preview. Its current palette becomes canonical:

- Ideas: `#fa0000`
- Hobbies: `#1fe1e5`
- Mathematics: `#d4c30c`
- Medicine: `#ac20df`

Other configured vaults, including disabled vaults, remain visible in the preview before activation.

## Shared fields

The manifest synchronizes:

- Vault stable ID, normalized path, display name, color, and icon.
- Enabled state, include patterns, and exclude patterns.
- Cross-vault badge and vault-colored-link settings.
- Virtual Linker integration enablement.
- Per-source-vault external target-vault selections.
- Virtual-link color mode and intensity.
- Global synchronization state and per-vault exclusions.

The following remain local:

- Saved searches.
- Pinned files.
- Search result layout.
- Index options, index cache, snippets, and generated timestamps.
- Runtime current-vault state.

## Manifest model

The manifest has a schema version, monotonic revision, update timestamp, and writer instance ID. Vaults are keyed by stable ID and contain normalized path keys. Cross-vault and Virtual Linker settings live in separate namespaced sections so API evolution does not change vault records.

Unknown future fields are preserved during read-modify-write operations. Unsupported future schema versions are never rewritten by an older plugin.

## Enabling and opting out

Synchronization defaults off. First activation:

1. Reads the Ideas configuration.
2. Builds and validates the proposed manifest.
3. Shows affected vaults, canonical identities, colors, and synchronized fields.
4. Writes only after explicit confirmation.

One global switch controls synchronization. Individual vaults can be excluded by canonical path. An excluded vault can still read synchronization status but neither applies nor publishes shared changes. Disabling synchronization leaves the last applied local values intact.

## Change propagation

Shared settings UI actions emit explicit field patches rather than rewriting a stale full object. Writers serialize updates through an inter-process lock, read the latest revision under that lock, apply the patch, validate the result, and publish it atomically. A stale lock has a bounded expiry and produces a visible warning rather than silent data loss.

Open vaults poll the small manifest for revision changes on a lightweight interval and also check on startup and settings-tab activation. Closed vaults apply the latest revision on next startup. A manual **Sync shared configuration now** command forces the same check. **Show shared configuration status** reports enabled state, revision, path, last application time, and any error.

Applying palette-only changes refreshes relevant views and link decorations. Catalog or inclusion changes schedule one coalesced incremental index refresh. They never trigger migration-time full scans.

## Failure handling

The service validates schema, types, normalized paths, duplicate identities, and color values before applying a manifest. If the file is absent, corrupt, inaccessible, too new, or fails validation:

- Local settings continue unchanged.
- The last valid in-memory and mirrored shared projection remains available.
- No empty/default manifest overwrites valid settings.
- A concise Notice and status entry identify the problem.

A failed target-vault mirror write does not invalidate the canonical central write. It is retried when that vault next loads.

## Privacy and portability

The manifest contains absolute vault paths and appearance/configuration metadata, but no note text, snippets, searches, or API secrets. It never leaves the machine through this plugin. Cross-machine path portability is outside this version's scope.

## Verification

Tests use a temporary application-data directory and four disposable vault configurations. Coverage includes:

- Ideas seed preview and confirmation.
- Path normalization, case rules, and canonical-ID convergence.
- Shared/local field partitioning.
- Global disable and per-vault exclusion.
- Revision polling and startup application.
- Concurrent disjoint patches and same-field conflicts.
- Lock timeout and stale-lock handling.
- Atomic-write failure.
- Corrupt, invalid, absent, and future-version manifests.
- Local mirror fallback.
- Coalesced index refresh after catalog changes.
- Zero writes to production vaults during tests.
