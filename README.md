# Multi-Vault Navigator


**Multi-Vault Navigator** is a local-first Obsidian plugin designed to bridge the gap between multiple vaults. If you use multiple vaults (e.g., work vault, personal vault, and writing vault), this plugin allows you to search, view, and switch between vaults as if they were all in one unified workspace.

[Baca dalam Bahasa Indonesia](README_id.md)

---

## Obsidian Policies Disclosure

To comply with the [Obsidian Developer Policies](https://docs.obsidian.md/Plugins/Releasing/Developer+policies), please review the following disclosures regarding this plugin:

- **Accessing files outside of Obsidian vaults**: This plugin requires accessing files outside of the currently active Obsidian vault. 
  - **Why this is needed**: This plugin's core feature is searching and previewing notes from your *other* Obsidian vaults. To achieve this, it uses Node's native `fs` module to read the markdown contents of vaults you have configured or that were automatically detected from your OS's global Obsidian configuration (`obsidian.json`). 
  - **Privacy**: All operations are 100% local. No files, metadata, or telemetry are ever sent over the internet or uploaded to any server.

---

## Key Features


### 1. Cross-Vault Command Center
Instead of remembering which vault a note is saved in, use the Command Center dashboard.
- Full-screen dashboard resembling a modern search engine.
- Displays notes across all your vaults with intelligent fuzzy search, vault-specific colors/icons, and snippet previews.
- Filter results by specific vaults or sort by Relevance, Newest, Oldest, or Vault Name.
- Pin your favorite cross-vault notes and save frequent searches directly to the sidebar.

### 2. Read-Only Cross-Vault View
Natively, Obsidian does not allow you to open a note from outside the active vault in a tab. This plugin solves that safely:
- When clicking a search result from another vault, the note opens in a **new tab** within your current vault.
- The note is displayed in a native-feeling **Read-Only Mode** with full markdown rendering.
- Includes actions to quickly "Open in Source Vault" or "Copy Cross-Vault Link."

### 3. Natural Cross-Vault Links
Write `[[NoteTitle@VaultName]]` (or the original `[[VaultName::NoteTitle]]`) in any note. The plugin parses these references and allows you to click them to instantly open the cross-vault note in the read-only preview. If the name is ambiguous, clicking opens a searchable chooser showing each full relative path. Generated links use `[[Folder/README@vault]]` when a basename is duplicated; a duplicated note at the vault root uses `[[/README@vault]]`. **Copy Cross-Vault Link for Current File** opens a vault chooser and copies this natural wikilink format instead of a protocol URL.

Both spellings always open, so a vault can switch format without breaking a single existing link. **Settings > Cross-Vault Links > Link format** decides which one is *written*; `Note@vault` is the default because it starts with the note name.

Typing a note name followed by `@` suggests the notes with that name in your other vaults, and picking one writes the whole link. It also works inside `[[`. The suggester only offers names that actually exist elsewhere, so `joao@gmail.com` and `Meeting@work` are left alone.

Two commands take them back out again. **Remove cross-vault links in current note** and **Remove cross-vault links in all notes** replace every `[[Note@vault]]` with the text it displays: `[[As@hobbies|as]]` becomes `as`, and a link with no alias becomes its note name. Links to notes in the current vault are never touched, and neither is anything inside code blocks, inline code, formulas or frontmatter.

This reads the note's source rather than Obsidian's link index, so it also reaches links inside a markdown table, where an unescaped `|` stops Obsidian from indexing the link at all. The vault-wide command previews the affected notes and asks before writing; the single-note command goes through the editor, so Ctrl+Z undoes it.

### 4. Recent Files & Quick Switch
- **Recent Files**: See the 50 most recently modified files across *all* your vaults.
- **Switch Vault**: Instantly launch your other vaults without going through the native Obsidian Vault Manager.

### 5. Safe Cross-Vault Move/Copy
Move or copy a note into any existing folder in another vault. The Smart Inbox Router still suggests a destination vault from the note's tags, while a searchable folder picker controls the final location.

Before execution, the plugin previews every link change. Move converts links inside the destination note back to notes remaining in the source vault and redirects source-vault backlinks to the moved note. Copy converts only outgoing links because the original remains available. Aliases, headings, and block references are preserved.

### 6. Standalone Backlink Relinking
Use **Relink Backlinks to Existing Cross-Vault Note** when the destination note already exists. Selecting that note is optional: when omitted, the plugin uses the current note name in the chosen vault. The pane previews the backlink count and exact `[[Note]]` to `[[vault::Note]]` conversions before review. The current duplicate is never moved, edited, or deleted.

### 7. Duplicate Note Detector
Scan all your connected vaults to find notes with the exact same name, helping you merge scattered information.

---

## Commands

Open the **Command Palette** (Ctrl/Cmd + P) and type `Multi-Vault Navigator` to see available commands:
- **Cross-Vault Command Center (Search Page)**
- **Search All Vaults**
- **Recent Files**
- **Switch Vault**
- **Move/Copy Current File to Vault**
- **Relink Backlinks to Existing Cross-Vault Note**
- **Copy Cross-Vault Link for Current File**
- **Remove cross-vault links in current note**
- **Remove cross-vault links in all notes**
- **Find Duplicate Notes**
- **Open Global Tag Explorer**
- **Open Cross-Vault Daily Notes**
- **Refresh Index**
- **Sync shared configuration now**
- **Show shared configuration status**

---

## Settings

Go to **Settings > Multi-Vault Navigator** to configure:
- **Vault List**: Toggle indexing for specific vaults, configure custom colors and icons, or remove them.
- **Add Manual Vault**: Add an absolute path to a vault if it wasn't auto-detected.
- **Appearance**: Choose between "Classic" and "Modern Card" layouts for search results.
- **Refresh & Clear Index**: Manually rebuild or wipe the cross-vault index cache. Normal startup refreshes only new, changed, or removed entries.
- **Max Preview Characters**: Length of text snippets saved for search indexing.
- **Global Exclude Patterns**: Comma-separated list of folder/file names to ignore across all vaults (e.g., `Private, secrets`).
- **Shared configuration**: Enable machine-wide shared settings, exclude individual vaults from participating, sync immediately, or inspect status. See [Shared configuration across vaults](#shared-configuration-across-vaults).
- **Cross-vault virtual links**: A separate settings group holding everything the [Virtual Linker](https://github.com/ErraticPattern/obsidian-virtual-linker) provides: enabling the integration, choosing which vaults the current vault may link into, and the link style (Off, Muted text tint, Colored underline, Soft color pill) and intensity (10–90, default 55). The group states whether the Virtual Linker is installed; without it these settings are stored and shared but have no effect.

---

## Safe migration behavior

The Move/Copy review reports the selected destination path, outgoing links, backlinks, affected source files, and skipped references. Existing cross-vault links, embeds, attachments, unresolved links, self-links, and Markdown-style links are left unchanged and reported rather than guessed.

The destination folder is optional and defaults to the target vault root. Overwrite is per operation, off by default, and requires a second confirmation before execution. The reviewed overwrite path rejects stale destinations whose current content no longer matches what was reviewed. Backlink discovery uses Obsidian's resolved-link metadata and reads only the source plus actual backlink notes. Preview and Review reuse one current plan. Migration aborts if an affected source note changes after review.

If writing a destination, updating backlinks, or trashing the source fails, completed edits are rolled back from originals held in memory; reviewed destination content is restored on recoverable failure and no backup files are created. After a successful migration, only created, deleted, or edited index entries are refreshed. A post-commit index failure does not misreport the migration as rolled back; the notice asks you to run **Refresh Index**.

Cross-vault references use the shortest safe target. A unique note becomes `[[vault::Note]]`; duplicate basenames use an extensionless path such as `[[vault::Folder/Note]]`.

---

## Shared configuration across vaults

Shared configuration lets every vault on this machine agree on one vault catalog and one cross-vault appearance, instead of repeating the same settings in each vault. It is **off by default** and nothing is written until you turn it on.

### Where it lives

State is kept outside your vaults, in Obsidian's own application data folder:

```
%APPDATA%\Obsidian\multi-vault-navigator\shared-settings-v1\
├── seed.json
└── patches\
    ├── <logical-clock>-<writer>-<sequence>-<random>.json
    └── ...
```

(macOS: `~/Library/Application Support/obsidian/…`; Linux: `$XDG_CONFIG_HOME/obsidian/…`.)

This is an **immutable journal**, not a mutable file guarded by a lock. `seed.json` is written exactly once. Every later change is a new patch file, written to a unique temporary name and then atomically renamed into place. No vault ever rewrites `seed.json`, an existing patch, or another vault's data, so two vaults changing settings at the same moment cannot corrupt each other and no inter-process lock is needed.

Readers fold the seed and all patches into the effective configuration. Ordering is by each patch's logical clock, with a deterministic tie-break on the patch ID; wall-clock timestamps are diagnostic only, so a clock change on your machine cannot reorder history. The reported **revision** is simply the number of patches folded so far.

### What is shared and what stays local

Shared: the vault catalog (identity, path, display name, color, icon, enabled state, include/exclude patterns), per-vault participation, cross-vault badge and link-color settings, and all Virtual Linker integration settings (global enablement, per-source target vaults, style, intensity).

Local to each vault: saved searches, pinned files, layout, snippets, index cache, and every other runtime preference.

Vault identity is the vault's real filesystem path, resolved through symlinks and Windows junctions and normalized (case-folded on Windows). Folder names are never treated as identity, so two vaults with the same folder name stay distinct.

### Turning it on

The first vault to enable shared configuration must be **Ideas**. It reads only `.obsidian/plugins/multi-vault-navigator/data.json` from that vault and shows you a mandatory preview of the proposed catalog, colors, and shared fields. The store is created only after you confirm. Cancelling, or an invalid Ideas configuration, writes nothing.

In any other participating vault, enable shared configuration and run **Sync shared configuration now**.

### Disabling and opting out

- The **global** toggle turns synchronization off everywhere. The last applied values stay in each vault's local settings.
- **Per-vault exclusion** keeps one vault out. An excluded vault can still read status, but neither applies nor publishes shared changes — including its own un-exclusion. A participating vault (normally Ideas) has to remove the exclusion.

### Failure behavior

A malformed or future-schema seed or patch is never rewritten and never resets your settings; the vault keeps its last good local values and reports the error under **Show shared configuration status**. Half-written patch files are ignored until their atomic rename completes. Because configuration edits are infrequent, the journal stays small and needs no compaction.

### Privacy and scope

Shared records contain **absolute vault paths**, and the store lives in your local Obsidian application data folder. It is per-machine and is not synced by the plugin; do not place it in a shared or cloud-synced location if those paths are sensitive.

---

## Optional public API

Other plugins can cooperate with Multi-Vault Navigator through a versioned, read-only runtime API, without either side depending on the other's package:

```ts
const provider = app.plugins.plugins['multi-vault-navigator'];
const api = provider?.publicApi;
if (api?.apiVersion === 1) { /* … */ }
```

`publicApi` appears only after the plugin's index is initialized and is removed on unload, so consumers must re-check it rather than caching it. The v1 surface exposes the current vault descriptor, effective integration settings, the projected external target list, duplicate-safe target resolution, canonical cross-vault wikilink formatting, target opening, and a `subscribe()` event stream (`catalog-changed`, `appearance-changed`).

Integration is **off by default**. Targets are exposed only for vaults you explicitly select for the current source vault, and only indexed Markdown notes with their title and normalized aliases — never note content, snippets, searches, or absolute paths. `resolveTarget()` reports ambiguity instead of silently picking the first duplicate.

## Installation

*(Currently manual installation only)*

1. Download the latest release (`main.js`, `manifest.json`, `styles.css`).
2. Create a folder in your vault: `<your-vault-path>/.obsidian/plugins/multi-vault-navigator/`.
3. Paste the three files into the folder.
4. Go to **Settings > Community plugins** in Obsidian.
5. Disable **Safe mode**.
6. **Enable** the Multi-Vault Navigator plugin.

---

## Building from source

```bash
npm install
npm run dev    # watch build; auto-copies output to vaults in deploy-targets.json
npm run build  # type-check + production build
```

To get automatic local deploys on every build, copy `deploy-targets.example.json`
to `deploy-targets.json` (gitignored) and list your own vaults'
`.obsidian/plugins/multi-vault-navigator` folders. Without that file the build
just produces `main.js` in the repo root. This is the preferred local deployment
path for the ErraticPattern fork and replaces scripts that download hard-coded
versions from `Finarfin12/Multi-Vault-Plugin-Obsidian`.

For a published release, download all three assets from a matching tag under
`ErraticPattern/Multi-Vault-Plugin-Obsidian`: `main.js`, `manifest.json`, and
`styles.css`.

Releases are built by CI: pushing a version tag (`git tag 2.3.0 && git push --tags`)
creates a GitHub release with `main.js`, `manifest.json`, and `styles.css` attached.

### Version compatibility

This fork runs on Obsidian **1.12.7 and newer**. The settings tab uses the 1.13
declarative Settings API natively and falls back to a manual `display()` renderer
on older versions.

---

## Contributors

- [Hir43th](https://github.com/Finarfin12) — original author
- ErraticPattern — fork owner
- Claude Fable 5 (Anthropic) — cross-vault link engine, 1.12.x compat shim, build/release pipeline, security audit

---

## License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
