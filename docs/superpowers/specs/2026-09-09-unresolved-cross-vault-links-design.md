# Unresolved Cross-Vault Link Reconciliation Design

## Purpose

Add an MVN command that finds unresolved wikilinks in the currently open vault, discovers matching notes in other configured vaults, and lets the user review and convert selected occurrences to MVN cross-vault links without creating notes.

Example: unresolved `[[fusion]]` links in Ideas can become `[[fusion@mathematics]]` when Mathematics already contains the target note.

## Scope

Each run analyzes and rewrites only the currently open vault. Candidate destinations come from other available, indexed vaults. Both ordinary wikilinks and embeds are eligible.

The feature does not create, move, copy, rename, or delete notes. It does not modify already resolved local links, existing cross-vault links, external Markdown links, or unavailable destination vaults. It does not change the index schema.

## Discovery

The scanner enumerates Markdown files in the current vault and uses Obsidian metadata to determine which link targets are unresolved locally. Exact source parsing then locates editable wikilink occurrences while excluding fenced code, inline code, escaped syntax, and non-wikilink text.

An occurrence records:

- source file path
- exact source offsets and original text
- embed status
- unresolved linkpath
- heading or block subpath
- alias text

Occurrences are grouped by normalized unresolved target. One group therefore represents one user decision and can affect several occurrences across several notes.

## Candidate resolution

Candidates are Markdown entries in other available vaults from MVN's current index.

- A target containing a folder path matches an extensionless relative path exactly.
- A target without a folder path matches note basenames.
- Matching is case-insensitive while preserving the destination's actual casing.
- A unique match is selected by default.
- Multiple matching notes, whether in one vault or several vaults, are all shown and require explicit user selection.
- Targets with no candidate are omitted from conversion proposals and reported in scan totals.

The selected candidate contains both `vaultId` and `relativePath`; display names alone never identify a destination.

## Link generation

Generated targets use the configured `crossVaultLinkFormat`. Both supported syntaxes remain readable, but new links follow the user's output preference.

The shortest unambiguous destination reference is used. A unique basename uses the basename. A basename duplicated within the destination vault uses its extensionless relative path. Existing heading and block suffixes and aliases are preserved exactly.

Examples:

```markdown
[[fusion]]                         -> [[fusion@mathematics]]
[[fusion|Fusion topic]]            -> [[fusion@mathematics|Fusion topic]]
[[fusion#Reaction rates]]          -> [[fusion@mathematics#Reaction rates]]
![[fusion]]                        -> ![[fusion@mathematics]]
[[Topics/fusion#rate|label]]       -> [[Topics/fusion@mathematics#rate|label]]
```

The formatter delegates cross-vault syntax ordering to the existing syntax module rather than constructing `@` or `::` strings independently.

## Dashboard

The command opens a dedicated workspace view suitable for reviewing large result sets.

Each proposal row shows:

- unresolved target
- occurrence count
- affected-note count
- selected candidate vault and relative path
- candidate selector when multiple matches exist
- selection checkbox
- expandable affected-note list

Unique matches are selected by default. Ambiguous groups remain unselected until a candidate is chosen. Controls provide Select all unambiguous, Clear selection, Rescan, and Convert selected links.

The view preserves scan results until the user rescans or executes. After execution it displays converted occurrence count, changed-note count, stale-note skips, unresolved/no-candidate count, and failures.

## Planning and execution

The planner is pure: it accepts current-vault source snapshots, metadata resolution facts, indexed candidates, and link-format settings, and returns grouped proposals plus exact text edits.

Before applying, the executor rereads every affected note and validates all expected ranges using the existing stale-edit mechanism. A note with changed content is skipped and reported before any edit is applied to that note.

Selected edits are combined per note and applied from highest to lowest offsets. Writes execute one note at a time while retaining every original in memory. If any write fails, all notes changed by that operation are restored. Rollback failures are surfaced explicitly.

After a successful operation, MVN incrementally refreshes only affected current-vault index entries and notifies existing catalog listeners. The destination index is unchanged.

## Components

- `unresolved-link-parser.ts`: exact wikilink/embed source parsing and code exclusion
- `unresolved-link-resolver.ts`: current-vault unresolved filtering, candidate matching, ambiguity, and shortest safe target selection
- `unresolved-link-planner.ts`: grouped proposals and per-note text edits
- `unresolved-link-transaction.ts`: stale validation, writes, rollback, and execution result
- `unresolved-links-view-model.ts`: dashboard-safe rows, counts, and selection state
- `unresolved-links-view.ts`: workspace dashboard rendering and interaction
- `unresolved-links-command.ts`: command registration and view activation
- `main.ts`: view and command registration plus dependency wiring

Units expose narrow interfaces and reuse `rewriteWikilinkOriginal`, `applyTextEdits`, cross-vault syntax formatting, `resolveIndexedNote` patterns, and incremental index mutations where applicable.

## Error handling

- An unavailable current filesystem adapter prevents scanning and shows a Notice.
- Metadata-cache gaps cause conservative omission, not guessed rewrites.
- Missing or unavailable destination vaults are excluded.
- A stale source note is skipped and reported.
- A write failure triggers rollback of prior writes in the same operation.
- A rollback failure is reported with the affected note path.
- Rescan replaces obsolete proposals and selections.
- Closing the view never writes changes.

## Testing

Unit tests cover:

- ordinary links and embeds
- aliases, headings, blocks, and explicit paths
- inline/fenced code and escaped syntax exclusion
- case-insensitive matching with case preservation
- unique, missing, and ambiguous candidates
- ambiguity within one vault and across vaults
- destination-path qualification for duplicate basenames
- both configured cross-vault output formats
- exact multi-occurrence edits
- stale source detection
- partial-write rollback and rollback failure reporting
- unavailable vault exclusion
- current-vault-only source scope
- dashboard selection and candidate-choice behavior

An E2E test creates multiple unresolved `[[fusion]]` and `![[fusion]]` occurrences in the current vault, a Mathematics candidate, an unrelated unresolved target, and an ambiguous target. It verifies scan grouping, review selection, exact conversion, no note creation, untouched unrelated links, incremental index refresh, and stable results after rescanning.

Manual verification uses disposable notes in the current vault, reviews the dashboard at narrow and wide workspace sizes, tests keyboard and mouse selection, converts a subset, and confirms the target notes and unselected source notes remain untouched.
