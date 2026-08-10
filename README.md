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
Write `[[VaultName::NoteTitle]]` in any note. The plugin parses these references and allows you to click them to instantly open the cross-vault note in the read-only preview. If the name is ambiguous, clicking opens a searchable chooser showing each full relative path. Generated links use `[[vault::Folder/README]]` when a basename is duplicated; a duplicated note at the vault root uses `[[vault::/README]]`. **Copy Cross-Vault Link for Current File** opens a vault chooser and copies this natural wikilink format instead of a protocol URL.

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
- **Find Duplicate Notes**
- **Open Global Tag Explorer**
- **Open Cross-Vault Daily Notes**
- **Refresh Index**

---

## Settings

Go to **Settings > Multi-Vault Navigator** to configure:
- **Vault List**: Toggle indexing for specific vaults, configure custom colors and icons, or remove them.
- **Add Manual Vault**: Add an absolute path to a vault if it wasn't auto-detected.
- **Appearance**: Choose between "Classic" and "Modern Card" layouts for search results.
- **Refresh & Clear Index**: Manually rebuild or wipe the cross-vault index cache. Normal startup refreshes only new, changed, or removed entries.
- **Max Preview Characters**: Length of text snippets saved for search indexing.
- **Global Exclude Patterns**: Comma-separated list of folder/file names to ignore across all vaults (e.g., `Private, secrets`).

---

## Safe migration behavior

The Move/Copy review reports the selected destination path, outgoing links, backlinks, affected source files, and skipped references. Existing cross-vault links, embeds, attachments, unresolved links, self-links, and Markdown-style links are left unchanged and reported rather than guessed.

The destination folder is optional and defaults to the target vault root. Destination files are never overwritten. Backlink discovery uses Obsidian's resolved-link metadata and reads only the source plus actual backlink notes. Preview and Review reuse one current plan. Migration aborts if an affected source note changes after review.

If writing a destination, updating backlinks, or trashing the source fails, completed edits are rolled back from originals held in memory; no backup files are created. After a successful migration, only created, deleted, or edited index entries are refreshed. A post-commit index failure does not misreport the migration as rolled back; the notice asks you to run **Refresh Index**.

Cross-vault references use the shortest safe target. A unique note becomes `[[vault::Note]]`; duplicate basenames use an extensionless path such as `[[vault::Folder/Note]]`.

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
