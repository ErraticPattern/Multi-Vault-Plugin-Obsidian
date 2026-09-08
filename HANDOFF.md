# Handoff: cross-machine (Windows and Linux) compatibility

## Why this work exists

The plugin is used across two machines that hold the same four vaults: a Windows
desktop (`C:/Users/joaop/obsidian/...`) and a Debian laptop
(`/home/jamaro/obsidian/...`). The vaults are kept identical by Syncthing and
backed up to GitHub, so the same `.obsidian/plugins/multi-vault-navigator/data.json`
reaches both machines.

On Linux the plugin found none of the other vaults. Windows was fine. The
settings file is not portable, and worse, it degrades every time it crosses over.

## What was actually observed

`data.json`, present in all four vaults, stores one absolute path per vault:

```json
{ "id": "de23b3770a710f37", "name": "hobbies",
  "path": "C:/Users/joaop/obsidian/hobbies", "enabled": true }
```

None of those resolve on Linux, so `validateVaultPath` rejects them and the
navigator is empty.

It also accumulates. Opening `ideas` on Linux appended a second entry for the
same vault rather than reconciling with the existing one:

```json
{ "id": "vault-1784830687431", "name": "ideas", "path": "C:/Users/joaop/obsidian/ideas" },
{ "id": "vault-1788630870393", "name": "ideas", "path": "/home/jamaro/obsidian/ideas" }
```

That file then syncs back, so each machine grows a duplicate of every vault it
opens, and the list is a union of two machines' paths where at most half are
valid anywhere.

## Root causes, with locations

1. **Absolute paths are the stored identity.** `VaultConfig.path`
   (`src/types.ts:4`) is written verbatim and compared with `path.resolve`
   (`src/vault-registry.ts:118`). There is no portable form: no `~` expansion, no
   environment variables, no vault-relative or home-relative encoding.

2. **Auto-detection is blind on Linux Flatpak.**
   `getGlobalObsidianConfigPath()` (`src/vault-registry.ts:137`) returns
   `~/.config/obsidian/obsidian.json` for Linux, and the code comment at line 144
   already notes "Could be in flatpak or snap, but normally in .config". Under the
   Flathub build `XDG_CONFIG_HOME` is redirected, so the real registry is at
   `~/.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json`. The path check
   fails, `autoDetectGlobalVaults` returns silently
   (`src/vault-registry.ts:101`), and the one mechanism that could have recovered
   the correct local paths never runs. Snap has the same problem under
   `~/snap/obsidian/current/.config`.

3. **Vault identity is not stable across machines.** Auto-detected vaults are
   keyed by Obsidian's own registry key, which is good, but manually added ones
   get a generated `vault-<timestamp>` id. The same vault therefore has different
   ids on the two machines and nothing reconciles them, which is what produces the
   duplicates above.

## Goals

1. **A `data.json` that is safe to share between machines.** Separate what is
   genuinely shared (identity, display name, colour, icon, enabled, include and
   exclude patterns) from what is machine-local (the absolute path). Machine-local
   state should either live outside the synced file, or be keyed by machine so
   entries never collide.

2. **Resolve paths at runtime rather than trusting the stored one.** Obsidian's
   own registry already knows where each vault lives on this machine. Prefer it,
   and fall back to the stored path only when the registry has nothing.

3. **Fix Linux detection.** Probe the Flatpak and Snap locations as well as
   `~/.config`, and honour `XDG_CONFIG_HOME` when it is set.

4. **Accept portable path forms** for hand-written entries: `~`, `$HOME` and
   `%USERPROFILE%`, plus normalisation of `\` and `/` so a path typed on one OS is
   not fatal on the other.

5. **Make loading idempotent.** Reconcile on load by stable identity and, failing
   that, by vault name and basename, so opening a vault on a second machine
   updates an entry instead of appending one. Existing polluted files should be
   repaired on first load, not left to the user.

## Non-goals

- Do not change how the index or search work. This is about vault resolution.
- Do not require the two machines to use the same folder layout. They already
  differ by drive and home directory and that is expected.
- Do not solve this by telling users to stop syncing `data.json`. That is the
  workaround currently in place on this setup and the reason this task exists.

## Acceptance criteria

- With a `data.json` written on Windows, opening any vault on Linux lists all
  vaults that exist locally, with no manual re-indexing.
- Opening a vault on the second machine does not add a duplicate entry, and the
  file after a round trip Windows to Linux to Windows is stable.
- Auto-detection works on the Flathub build of Obsidian, verified by pointing at
  `~/.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json`.
- A vault registered in Obsidian on only one machine degrades gracefully: it is
  shown as unavailable there, not deleted from the shared settings.
- Loading an already-polluted `data.json` (two entries per vault, one per OS)
  collapses it to one entry per vault.

## Notes for testing

Real polluted examples are in this setup's vaults under
`~/obsidian/*/.obsidian/plugins/multi-vault-navigator/data.json`. They are
currently excluded from both Syncthing and git on this machine, so editing them
is safe and will not propagate. `medicine` has the oldest shape, with escaped
Windows separators (`C:\\Users\\joaop\\obsidian\\medicine`), which is a useful
parsing case.

The fork is `ErraticPattern/Multi-Vault-Plugin-Obsidian`; push there, not
upstream.
