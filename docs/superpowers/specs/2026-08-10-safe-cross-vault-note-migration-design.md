# Safe Cross-Vault Note Migration Design

## Goal

Make cross-vault note moves preserve both sides of the link graph, let users choose the destination folder, and provide a standalone way to redirect backlinks when the destination note already exists.

## Scope

The feature covers Markdown notes and Obsidian wikilinks. It adds behavior to the existing Move/Copy command and adds a standalone backlink relink command. It does not merge note contents, delete duplicates in the standalone workflow, rewrite embeds or attachments, or overwrite an existing destination file.

## Workflows

### Move

The user selects a target vault, an existing folder in that vault, and Move. Link preservation is enabled by default.

Before writing, the plugin calculates two sets of edits:

1. Links inside the moving note that resolve to Markdown notes remaining in the source vault become cross-vault links back to the source vault.
2. Links in other source-vault notes that resolve to the moving note become cross-vault links to its final destination.

After showing a review, the plugin writes the transformed destination note, updates backlinks, and trashes the source note last.

### Copy

The user selects a target vault and folder. The copied note's outgoing links to source-vault notes become cross-vault links. Source-vault backlinks remain internal because the original note remains present.

### Standalone backlink relink

The command `Relink Backlinks to Existing Cross-Vault Note` uses the active note as the source duplicate. The user selects another vault and then an existing Markdown note in that vault. The plugin previews and rewrites source-vault notes whose links resolve to the active note. The active note is not edited or deleted.

## User Interface

The existing Move/Copy modal contains:

- Target vault dropdown
- Destination folder row with a searchable folder picker
- Operation dropdown with Move and Copy
- Preserve cross-vault links toggle, enabled by default
- Review changes button

The folder picker lists the vault root and existing folders recursively. It excludes Obsidian configuration, trash, version-control, dependency, and other hidden directories. Changing the target vault resets the selected folder to the root.

The review modal shows:

- Final destination path
- Number of outgoing links to convert
- Number of backlinks and source files to update
- Skipped links grouped by reason
- A final confirmation action

When the destination file already exists, Move/Copy stops without overwriting it and directs the user to the standalone relink command.

The standalone modal contains a target-vault dropdown and a searchable target-note picker populated from the cross-vault index. Its review lists every source note that will be edited. Applying the operation leaves the active duplicate in place.

## Link Resolution and Rewriting

The conversion engine uses Obsidian's metadata cache to resolve local links in the source vault. It does not use a blind whole-file regular expression to decide link targets.

Eligible links are ordinary wikilinks that resolve to Markdown files. Rewriting preserves:

- Aliases, such as `[[Note|label]]`
- Heading fragments, such as `[[Note#Heading]]`
- Block fragments, such as `[[Note#^block-id]]`

The engine skips and reports:

- Existing `vault::note` links
- Embeds and attachment references
- Unresolved links
- Self-links
- References outside the operation's intended source or destination

Generated cross-vault targets use `vault::basename` when the basename is unique in the target vault. When duplicate basenames exist, they use the extensionless relative path, for example `vault::Folder/Note`.

For a move from `ideas` to `mathematics/Notes`:

- A link inside the moving note, `[[EEG]]`, resolving to an Ideas note becomes `[[ideas::EEG]]`.
- A source-vault backlink, `[[Zerotier]]`, to the moving note becomes `[[mathematics::Zerotier]]` when unique, or `[[mathematics::Notes/Zerotier]]` when disambiguation is required.

## Components

### Link migration engine

A focused module computes edit plans without writing files. It accepts note content, cached references, resolution callbacks, source and target vault descriptors, and destination paths. It returns transformed content, per-file backlink changes, and skipped-reference diagnostics.

The module applies edits from the end of each file toward the beginning so cached offsets remain valid. It verifies that each cached source slice still equals the expected original text before replacement.

### Folder and note discovery

A filesystem helper enumerates safe destination folders under a configured vault root and validates selected relative paths against path traversal. A target-note provider filters indexed Markdown files by vault for fuzzy selection.

### File operation service

A service owns move, copy, and standalone relink transactions. UI classes gather choices and display plans but do not perform filesystem mutation directly.

### Modals and command registration

The existing file-operation modal delegates planning and execution to the services. New fuzzy folder and target-note pickers provide selection. A review modal presents the immutable operation plan. The standalone command reuses the backlink planner and review modal.

## Transaction and Failure Handling

Every plan records the exact source text used to calculate offsets. Immediately before execution, the service re-reads all affected files and aborts if any differ from the planned originals.

Move execution order is:

1. Validate that the destination remains inside the target vault and does not exist.
2. Create the transformed destination file.
3. Apply planned source-vault backlink edits.
4. Trash the source note through Obsidian's file manager.
5. Refresh the cross-vault index in the background.

The service retains original backlink contents in memory. If an edit or source-trash step fails, it restores already modified backlink files and removes the new destination file. Rollback failures are reported explicitly. No backup files are created.

Copy creates only the transformed destination file. Standalone relink edits only planned backlink files and rolls them back on failure. Index refresh failure does not roll back a successful migration because it does not alter note data.

## Testing

The repository will gain a test runner and an Obsidian test mock sufficient for pure and service-level tests.

Coverage includes:

- Plain, aliased, heading, and block wikilinks
- Existing cross-vault links, embeds, unresolved links, and self-links
- Both-direction move conversion
- Outgoing-only copy conversion
- Backlink-only standalone relink
- Duplicate basenames and relative-path disambiguation
- Zero-link operations
- Destination folder enumeration and traversal rejection
- Existing destination collision
- Stale-plan detection
- Destination-write, backlink-write, and trash failures with rollback
- Command registration and modal/service wiring
- Type checking and production build

A temporary multi-vault fixture will exercise a complete move, copy, and standalone relink from the user's perspective without touching real vault notes.

## Documentation, Versioning, and Deployment

README documentation will describe destination-folder selection, link preservation, the standalone relink command, and the local deployment workflow. `CHANGELOG.md` remains untouched because it is not manually maintained.

The feature receives a minor version bump. `manifest.json`, `package.json`, `package-lock.json`, and `versions.json` remain synchronized. The built `main.js`, manifest, and stylesheet are deployed using the existing gitignored `deploy-targets.json`, which already targets the Ideas, Hobbies, Mathematics, and Medicine vaults.

After deployment, SHA-256 hashes of all three assets must match across the repository and all four vault plugin directories. Obsidian must then reload the plugin, either by restarting each open vault or toggling the plugin off and on.
