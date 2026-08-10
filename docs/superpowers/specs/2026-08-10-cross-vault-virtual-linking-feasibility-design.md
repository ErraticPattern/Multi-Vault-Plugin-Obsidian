# Cross-Vault Virtual Linking Feasibility Design

**Date:** 2026-08-10

**Repositories:**

- `C:\Users\joaop\git\ErraticPattern\Multi-Vault-Plugin-Obsidian`
- `C:\Users\joaop\git\ErraticPattern\obsidian-virtual-linker`

## Purpose

Assess and then implement three related improvements without risking João's four production vaults:

1. Make Multi-Vault Navigator correct when several notes share a basename such as `README.md`.
2. Remove full-vault work from interactive migration commands.
3. Let Virtual Linker recognize opted-in notes and aliases from other vaults, open them through Multi-Vault Navigator, and convert reviewed virtual matches in the current note to literal real links.

The work is divided into independently testable workstreams. Multi-Vault correctness and performance are completed before cross-plugin integration. Cross-plugin integration is completed before broad deployment.

## Current Evidence

### Duplicate note identities

The current Multi-Vault index contains 464 duplicate-basename groups covering 976 files. Ideas alone contains both `README.md` and `1 - Rough Notes/Lab Notebook/Musings/README.md`.

Multi-Vault Navigator already generates a path-qualified cross-vault link in some migration paths, but runtime opening still uses the first matching indexed file. Basename-only lookup therefore can silently open the wrong note.

### Migration performance

The current relink workflow performs redundant global work:

1. Opening the relink modal calls `refreshPreview()`.
2. `refreshPreview()` calls `planRelink()`.
3. `planRelink()` calls `collectSourceVaultSnapshot()`, which reads every Markdown note in the current vault.
4. Clicking **Review changes** calls `planRelink()` again and repeats the reads.
5. Executing any migration calls `buildFullIndex(true)`, which scans, reads, parses, and serializes all enabled vaults.
6. Startup independently schedules another full index after five seconds when automatic refresh is enabled.

A direct sequential filesystem benchmark read the Markdown content in approximately:

| Vault | Files | Raw read time |
| --- | ---: | ---: |
| Ideas | 2,865 | 2.5 s |
| Hobbies | 11,752 | 10.8 s |
| Mathematics | 5,991 | 6.0 s |
| Medicine | 7,258 | 6.7 s |

These measurements exclude Obsidian metadata access, parsing, JSON serialization, sync contention, and UI yielding. A multi-minute migration is therefore consistent with the current architecture rather than with the size of the requested note change.

### Existing plugin indexes

Dataview, Omnisearch, and QuickAdd must not be correctness-critical dependencies:

- Dataview exposes inlinks and outlinks, but native Obsidian `metadataCache.resolvedLinks` is authoritative, has no plugin lag, and is available in all vaults. Dataview is disabled in Hobbies and Mathematics.
- Omnisearch is enabled in all four vaults and exposes a search API, but each instance indexes only its hosting vault. It does not provide a canonical external-vault link graph.
- QuickAdd provides prompts and orchestration rather than a stable cross-vault index. It is enabled only in Ideas.

Optional reporting or command wrappers may be considered later, but core behavior uses native Obsidian metadata and Multi-Vault Navigator's own external index.

### Virtual Linker architecture

Virtual Linker 1.5.2 builds successfully from source and is licensed under Apache-2.0. Its trie stores current-vault `TFile` objects. Live Preview and Reading View each perform matching, and the current conversion command reads rendered CodeMirror DOM nodes from the selected visible range.

That DOM approach cannot convert an entire note reliably because CodeMirror renders only visible ranges. The matcher also needs a generic target identity before it can represent external notes.

The two open upstream pull requests add search highlighting and a ribbon activation toggle. Neither addresses external indexes, canonical cross-vault identity, or whole-note conversion.

## Approved Architecture

### Workstream 1: Multi-Vault correctness and performance

#### Canonical identity

A note is identified by `{ vaultId, relativePath }`. Basenames are labels and shorthand only.

Resolution returns a discriminated result:

- `resolved`: one canonical candidate
- `ambiguous`: multiple canonical candidates
- `missing`: no candidate

A short link such as `[[medicine::README]]` resolves directly only when unique. When ambiguous, opening presents a searchable chooser labeled with vault and full relative path. Generated links use the basename when unique and the extensionless relative path when required, for example `[[medicine::Notes/Cardiology/README]]`.

No runtime resolver may silently use the first array match.

#### Targeted backlink discovery

Obsidian's public `metadataCache.resolvedLinks` map identifies source notes that resolve to the active note path. Migration planning reads only:

1. The active source note
2. Notes listed as actual backlink sources for the active source path

The active note's cached links provide its outgoing references. This retains Obsidian's context-sensitive duplicate-name resolution while avoiding a vault-wide content read.

#### Reusable plans

The relink modal stores one immutable plan with a fingerprint of the active source and selected target. The review modal reuses that plan. A target change, relevant metadata change, or source content change invalidates it and requests a new plan.

#### Incremental index updates

Migration execution submits an explicit index change set:

- created destination
- deleted source for Move
- changed backlink notes
- unchanged source for Copy and standalone Relink

The indexer reparses only changed or created files, removes deleted entries, and persists the cache once. Migration execution never invokes a full index build.

Startup refresh compares cached `mtime` and `size`, reparses changed entries only, and coalesces concurrent refresh requests behind one promise. Full index rebuilding remains an explicit maintenance command.

#### Performance budgets

On the current Ideas vault:

- Relink preview with no backlinks completes within 250 ms.
- Relink preview with up to 100 backlink notes completes within 1 s.
- Review of an unchanged preview performs no second scan and opens within 100 ms.
- Relink execution, excluding user confirmation time, completes within 2 s.
- No migration-triggered full-vault scan occurs.

Stage timing covers backlink discovery, required reads, planning, execution, incremental indexing, and cache persistence.

### Workstream 2: optional cross-plugin integration

#### Multi-Vault Navigator API

Multi-Vault Navigator owns a versioned, read-only API:

```ts
interface MultiVaultNavigatorApiV1 {
  version: 1;
  listVirtualTargets(targetVaultIds: string[]): VirtualTarget[];
  resolveReference(vaultName: string, noteRef: string): ResolutionResult;
  formatWikilink(targetId: string, label?: string): string;
  openTarget(targetId: string): Promise<void>;
  onCatalogChanged(callback: () => void): () => void;
}

interface VirtualTarget {
  id: string;
  vaultId: string;
  vaultName: string;
  relativePath: string;
  basename: string;
  aliases: string[];
}
```

`id` combines the vault ID and normalized relative path. Returned records are immutable snapshots. The API does not expose internal arrays, filesystem handles, cache file formats, or private plugin classes.

#### API discovery

Multi-Vault Navigator publishes the API through a versioned global symbol, `Symbol.for('multi-vault-navigator.api.v1')`, and removes only its own registered object on unload. Virtual Linker reads that symbol and validates `version === 1` before use. This avoids Obsidian's untyped private plugin-manager fields and avoids importing either plugin's runtime bundle into the other. The shared TypeScript interface lives in a small source file copied verbatim into both repositories and guarded by contract tests.

#### Virtual Linker providers

Virtual Linker's trie stores a generic `LinkTarget` rather than `TFile`. Providers adapt target sources:

- `LocalVaultProvider` wraps current-vault files.
- `MultiVaultProvider` consumes `MultiVaultNavigatorApiV1` when available and compatible.

Virtual Linker retains full local functionality when Multi-Vault Navigator is absent or disabled.

#### Vault scope

Cross-vault virtual matching is opt-in per target vault. All external vaults are disabled initially in each source vault. Virtual Linker's settings display the vaults reported by Multi-Vault Navigator and persist the selected target vault IDs.

#### Matching and disambiguation

Titles and aliases from all enabled providers enter one trie. A text match retains every canonical candidate.

- A single candidate opens directly.
- Multiple candidates open a searchable chooser showing vault, basename, and relative path.
- Local and external candidates may coexist; local candidates sort first but are not selected silently.
- Duplicate basenames never collapse into one record.

Cross-vault virtual links display a subtle vault badge using Multi-Vault Navigator's configured color. Local virtual-link styling remains unchanged.

#### Provider-owned actions

Virtual Linker delegates external opening and formatting to Multi-Vault Navigator.

Examples:

```markdown
[[medicine::Atrial fibrillation]]
[[medicine::Notes/Cardiology/README|README]]
[[medicine::Atrial fibrillation|AF]]
```

The first form is used only when the basename is unique. The second preserves identity when duplicates exist. The third preserves visible alias text.

#### Catalog updates and failures

Multi-Vault Navigator emits a catalog-change event only after an incremental index commit. Virtual Linker debounces and coalesces external-trie rebuilds.

If a target disappears after rendering, opening is non-destructive and reports that the external index needs refresh. An incompatible API version disables external matching with a settings warning while local matching continues.

### Workstream 3: whole-note virtual-link conversion

#### Shared pure matcher

Matching logic is extracted into a DOM-independent engine shared by Live Preview, Reading View, selection conversion, and current-note conversion. It accepts text, canonical targets, settings, and exclusion ranges, then returns offset-based match records.

The engine excludes YAML frontmatter, existing wikilinks, Markdown links, embeds, code blocks, inline code, URLs, and tags. Header inclusion follows the existing setting. Longer overlapping matches retain priority.

#### Review-first command

**Convert Virtual Links in Current Note to Real Links** opens a review modal. Matches are grouped by normalized visible term. Each group shows:

- occurrence count
- first matching line and context
- chosen target with vault and full relative path
- ambiguity state
- before-and-after conversion

The default converts the first occurrence of each distinct visible term. Different aliases that lead to one note remain distinct groups. A group can be changed to all occurrences or skipped. Ambiguous groups require one target selection, reused for selected occurrences in that group.

#### Atomic and stale-safe writing

Opening the modal never changes note content. On confirmation, the command verifies that the editor text still equals the reviewed source. It then applies all replacements in one public `Editor.transaction()`, producing one undo step. Changed source text aborts conversion and requires a refreshed preview.

## Feasibility Assessment

### Automated foundation

Multi-Vault Navigator extends its existing Vitest suite. Virtual Linker first gains Vitest, Obsidian mocks, and fixture builders because it currently has no automated tests.

Fixtures cover:

- duplicate basenames in separate folders
- context-sensitive backlinks to one duplicate
- unique and path-qualified cross-vault formatting
- titles and aliases from local and external providers
- repeated-term grouping
- longer overlapping matches
- Markdown syntax exclusions
- first-only and all-occurrence conversion
- stale-review rejection
- plugin-absent and incompatible-version fallbacks

### Isolated integration spike

Before full integration, an isolated branch or worktree validates:

1. API discovery without private-field access.
2. Transfer of 30,000 immutable external title and alias records.
3. Duplicate candidates retained by canonical identity.
4. Cross-vault opening through the API.
5. Reading View and Live Preview decorations alongside ordinary links.
6. Clean fallback when either plugin is disabled.
7. Current-note conversion through one editor transaction.

The spike passes when catalog transfer is below 100 ms, external trie construction is below 2 s, and visible-range decoration remains responsive with the external catalog enabled.

### Disposable Obsidian UI sandbox

Automated tests use temporary directories and do not touch production vaults. Final Obsidian-dependent smoke testing uses two disposable vaults created only after explicit approval:

- `mvn-source-test`
- `mvn-target-test`

The fixtures include duplicate `README.md` notes, aliases, repeated terms, ambiguous local and external matches, and backlink notes. João's Ideas, Hobbies, Mathematics, and Medicine notes and `.obsidian` configurations remain unchanged during feasibility assessment.

## Delivery Sequence

1. Establish performance instrumentation and duplicate-resolution fixtures.
2. Implement and release Multi-Vault correctness and performance independently.
3. Add Virtual Linker's automated test foundation and pure matcher.
4. Run the isolated cross-plugin API spike.
5. Stop and report if the spike misses identity, compatibility, or responsiveness criteria.
6. If the spike passes, implement the production API and provider integration.
7. Implement and test the review-first current-note conversion command.
8. Run disposable two-vault UI smoke tests after explicit approval.
9. Deploy to production vaults only after separate approval and successful verification.

Each workstream has its own review and release gate. A failure in cross-plugin integration does not block the Multi-Vault performance and ambiguity corrections.

## Out of Scope

- Depending on Dataview, Omnisearch, or QuickAdd for correctness
- Reading another plugin's private persisted index
- Automatically modifying production vault notes or plugin settings
- Converting virtual links without review
- Silently selecting the first duplicate match
- Merging Virtual Linker into Multi-Vault Navigator
- Incorporating unrelated upstream Virtual Linker pull requests during the feasibility spike
