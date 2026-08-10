# Safe Cross-Vault Note Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve incoming and outgoing wikilinks during cross-vault moves, add standalone backlink relinking, and allow users to select a destination folder.

**Architecture:** Pure migration modules calculate immutable plans from note snapshots and apply offset-safe wikilink rewrites. A transaction service executes those plans through an injected I/O boundary with stale-plan checks and rollback. Obsidian adapters and focused modals collect vault metadata, folders, and target notes, then present a mandatory review before execution.

**Tech Stack:** TypeScript ES2022, Obsidian plugin API 1.12.7+, Node filesystem/path APIs, Vitest 3 with a local Obsidian mock, esbuild.

## Global Constraints

- Rewrite both backlinks to a moved note and outgoing links from the moved note.
- Copy rewrites only outgoing links in the destination copy.
- Standalone relink rewrites backlinks but never edits or deletes the active duplicate.
- Preserve aliases, heading fragments, and block fragments.
- Skip and report existing cross-vault links, embeds, unresolved links, self-links, and unsupported Markdown-link syntax.
- Never overwrite an existing destination file.
- Never create backup files; rollback uses originals retained in memory.
- Never manually edit `CHANGELOG.md`.
- Keep minimum Obsidian version `1.12.7`.
- Deploy only after all automated verification passes.

---

### Task 1: Establish the test harness and offset-safe wikilink rewriting

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `tests/mocks/obsidian.ts`
- Create: `tests/link-rewriter.test.ts`
- Create: `src/migration/link-rewriter.ts`

**Interfaces:**
- Produces `splitLinkSubpath(target: string): { linkpath: string; subpath: string }`.
- Produces `rewriteWikilinkOriginal(original: string, replacementTarget: string): string | null`.
- Produces `applyTextEdits(content: string, edits: TextEdit[]): string` where `TextEdit` contains `startOffset`, `endOffset`, `expected`, and `replacement`.
- Later tasks consume these functions without importing Obsidian.

- [ ] **Step 1: Add a test script and Vitest development dependency**

Add scripts and dependency:

```json
"scripts": {
  "dev": "node esbuild.config.mjs",
  "build": "tsc -noEmit -skipLibCheck && node esbuild.config.mjs production",
  "test": "vitest run"
},
"devDependencies": {
  "@types/node": "^20.11.0",
  "esbuild": "^0.28.1",
  "obsidian": "latest",
  "tslib": "^2.6.2",
  "typescript": "^5.3.3",
  "vitest": "^3.2.4"
}
```

Run `npm install` so `package-lock.json` is regenerated. Add `tests/**/*.ts` to the existing TypeScript include implicitly through `**/*.ts` and configure the alias:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  test: { environment: 'node' },
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL('./tests/mocks/obsidian.ts', import.meta.url))
    }
  }
});
```

The initial mock exports only runtime symbols imported by tested modules and expands in later tasks.

- [ ] **Step 2: Write failing link-rewriter tests**

Cover these exact cases:

```ts
expect(rewriteWikilinkOriginal('[[Zerotier]]', 'mathematics::Zerotier'))
  .toBe('[[mathematics::Zerotier]]');
expect(rewriteWikilinkOriginal('[[Zerotier#Setup|network]]', 'mathematics::Zerotier#Setup'))
  .toBe('[[mathematics::Zerotier#Setup|network]]');
expect(rewriteWikilinkOriginal('[[Zerotier#^block-id]]', 'mathematics::Zerotier#^block-id'))
  .toBe('[[mathematics::Zerotier#^block-id]]');
expect(rewriteWikilinkOriginal('![[diagram.png]]', 'mathematics::diagram.png')).toBeNull();
expect(rewriteWikilinkOriginal('[network](Zerotier.md)', 'mathematics::Zerotier')).toBeNull();
```

Test that `applyTextEdits` applies multiple edits from highest to lowest offset and throws `StaleTextEditError` when `content.slice(startOffset, endOffset) !== expected`.

- [ ] **Step 3: Run tests and verify RED**

Run: `npm test -- tests/link-rewriter.test.ts`

Expected: FAIL because `src/migration/link-rewriter.ts` does not exist.

- [ ] **Step 4: Implement the minimal pure rewriter**

Use these public types:

```ts
export interface TextEdit {
  startOffset: number;
  endOffset: number;
  expected: string;
  replacement: string;
}

export class StaleTextEditError extends Error {}
```

`rewriteWikilinkOriginal` must accept only `[[...]]`, retain everything after the first unescaped `|`, and reject `![[...]]` plus non-wikilink syntax. `applyTextEdits` must reject overlapping edits and verify every expected slice before changing content.

- [ ] **Step 5: Run focused and full tests**

Run:

```bash
npm test -- tests/link-rewriter.test.ts
npm test
npm run build
```

Expected: all tests pass and type checking/build complete without warnings.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts tests/mocks/obsidian.ts tests/link-rewriter.test.ts src/migration/link-rewriter.ts
git commit -m "test: add migration link rewriter"
```

---

### Task 2: Add safe destination discovery and unambiguous cross-vault targets

**Files:**
- Create: `tests/destination-paths.test.ts`
- Create: `src/migration/destination-paths.ts`

**Interfaces:**
- Produces `listDestinationFolders(vaultRoot: string): string[]`.
- Produces `resolveDestinationPath(vaultRoot: string, folder: string, fileName: string): { absolutePath: string; relativePath: string }`.
- Produces `extensionlessMarkdownPath(relativePath: string): string`.
- Produces `chooseCrossVaultNotePath(destinationRelativePath: string, indexedFiles: Pick<IndexedFile, 'relativePath' | 'basename'>[]): string`.

- [ ] **Step 1: Write failing destination tests with temporary directories**

Build a temporary target vault containing:

```text
.obsidian/
Notes/
Notes/Networks/
Attachments/
.git/
node_modules/
.hidden/
```

Assert that folder discovery returns `/`, `Attachments`, `Notes`, and `Notes/Networks`, but excludes `.obsidian`, `.git`, `.hidden`, and `node_modules`.

Assert that `resolveDestinationPath(root, 'Notes/Networks', 'Zerotier.md')` yields an absolute path under the vault and relative path `Notes/Networks/Zerotier.md`. Assert that `..`, absolute paths, and paths escaping through mixed separators throw `UnsafeDestinationPathError`.

Assert basename selection:

```ts
expect(chooseCrossVaultNotePath('Notes/Zerotier.md', [
  { relativePath: 'Notes/Zerotier.md', basename: 'Zerotier' }
])).toBe('Zerotier');

expect(chooseCrossVaultNotePath('Notes/Zerotier.md', [
  { relativePath: 'Notes/Zerotier.md', basename: 'Zerotier' },
  { relativePath: 'Archive/Zerotier.md', basename: 'Zerotier' }
])).toBe('Notes/Zerotier');
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/destination-paths.test.ts`

Expected: FAIL because destination helpers are missing.

- [ ] **Step 3: Implement safe folder traversal and path validation**

Use `fs.readdirSync(..., { withFileTypes: true })`, sort folders by normalized forward-slash path, and never follow symbolic links. Exclude segments beginning with `.` and the exact directory `node_modules`.

Resolve both root and destination with `path.resolve`; permit the root itself or a destination beginning with `root + path.sep`, and reject every other result.

- [ ] **Step 4: Verify focused and full tests**

Run:

```bash
npm test -- tests/destination-paths.test.ts
npm test
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/destination-paths.test.ts src/migration/destination-paths.ts
git commit -m "feat: add safe destination selection"
```

---

### Task 3: Build immutable move, copy, and standalone relink plans

**Files:**
- Create: `tests/migration-planner.test.ts`
- Create: `src/migration/migration-types.ts`
- Create: `src/migration/migration-planner.ts`
- Create: `src/migration/obsidian-snapshot.ts`

**Interfaces:**
- Produces `MigrationMode = 'move' | 'copy' | 'relink'`.
- Produces `NoteSnapshot`, `LinkSnapshot`, `SkippedLink`, `PlannedFileEdit`, and `MigrationPlan` interfaces.
- Produces `planMoveOrCopy(input: MoveCopyPlanningInput): MigrationPlan`.
- Produces `planStandaloneRelink(input: RelinkPlanningInput): MigrationPlan`.
- Produces `collectSourceVaultSnapshot(app: App): Promise<SourceVaultSnapshot>` for the Obsidian adapter.

Use these central shapes:

```ts
export interface LinkSnapshot {
  sourcePath: string;
  original: string;
  linkTarget: string;
  startOffset: number;
  endOffset: number;
  resolvedPath: string | null;
  kind: 'wikilink' | 'embed' | 'markdown';
}

export interface NoteSnapshot {
  path: string;
  basename: string;
  content: string;
  links: LinkSnapshot[];
}

export interface PlannedFileEdit {
  path: string;
  originalContent: string;
  updatedContent: string;
  rewrittenLinks: number;
}

export interface MigrationPlan {
  mode: MigrationMode;
  sourcePath: string;
  destinationAbsolutePath: string | null;
  destinationRelativePath: string | null;
  destinationContent: string | null;
  backlinkEdits: PlannedFileEdit[];
  outgoingLinksRewritten: number;
  backlinksRewritten: number;
  skipped: SkippedLink[];
}
```

- [ ] **Step 1: Write failing move-planning tests**

Create a snapshot where `Projects/Zerotier.md` contains `[[EEG#Acquisition|EEG setup]]`, `Notes/Index.md` contains `[[Zerotier]]`, and `Notes/Other.md` contains an unresolved link, an existing cross-vault link, and an embed.

For a move to `mathematics/Notes/Zerotier.md`, assert:

- Destination content contains `[[ideas::EEG#Acquisition|EEG setup]]`.
- `Notes/Index.md` becomes `[[mathematics::Zerotier]]` when unique.
- Duplicate target basenames produce `[[mathematics::Notes/Zerotier]]`.
- The move plan reports one outgoing and one backlink rewrite.
- Existing cross-vault, unresolved, embedded, self, and Markdown links appear under the correct skipped reasons.

- [ ] **Step 2: Run move-planning test and verify RED**

Run: `npm test -- tests/migration-planner.test.ts -t "plans both sides of a move"`

Expected: FAIL because planner modules do not exist.

- [ ] **Step 3: Implement move planning minimally**

Use `splitLinkSubpath` to preserve `#...`; resolve eligibility using each `LinkSnapshot.resolvedPath`; create text edits through `rewriteWikilinkOriginal`; and apply them through `applyTextEdits`.

Backlinks are links in notes other than `sourcePath` where `resolvedPath === sourcePath`. Outgoing links are links in the source note whose resolved path is another Markdown source-vault note.

- [ ] **Step 4: Verify move planning GREEN**

Run the focused test and expect PASS.

- [ ] **Step 5: Write failing copy and relink tests**

Assert that copy produces transformed destination content but an empty `backlinkEdits` array. Assert that standalone relink produces backlink edits but `destinationContent`, `destinationAbsolutePath`, and `destinationRelativePath` are null and never changes the active note.

- [ ] **Step 6: Run copy/relink tests and verify RED**

Run: `npm test -- tests/migration-planner.test.ts`

Expected: new copy/relink tests fail because only move behavior exists.

- [ ] **Step 7: Implement copy and standalone planning**

Reuse the same pure rewrite functions. `planStandaloneRelink` receives the selected target vault name and selected indexed target path, then uses `chooseCrossVaultNotePath` to generate backlink targets.

- [ ] **Step 8: Add and test the Obsidian snapshot adapter**

Expand `tests/mocks/obsidian.ts` with structural `TFile` and cache reference types. Test that `collectSourceVaultSnapshot`:

- Reads all current-vault Markdown notes.
- Uses `metadataCache.getFirstLinkpathDest(reference.link, sourcePath)`.
- Classifies cache `links` as wikilink or Markdown syntax from `reference.original`.
- Includes cache `embeds` as `kind: 'embed'`.
- Copies exact start/end offsets and original source slices.

- [ ] **Step 9: Verify all tests and build**

Run:

```bash
npm test
npm run build
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add tests/migration-planner.test.ts tests/mocks/obsidian.ts src/migration/migration-types.ts src/migration/migration-planner.ts src/migration/obsidian-snapshot.ts
git commit -m "feat: plan cross-vault link migrations"
```

---

### Task 4: Execute migration plans transactionally with rollback

**Files:**
- Create: `tests/migration-transaction.test.ts`
- Create: `tests/cross-vault-migration.e2e.test.ts`
- Create: `src/migration/migration-transaction.ts`
- Create: `src/migration/obsidian-migration-io.ts`

**Interfaces:**
- Produces `MigrationIo` with exact methods:

```ts
export interface MigrationIo {
  destinationExists(absolutePath: string): Promise<boolean>;
  readDestination(absolutePath: string): Promise<string>;
  writeDestination(absolutePath: string, content: string): Promise<void>;
  removeDestination(absolutePath: string): Promise<void>;
  readSourceFile(vaultPath: string): Promise<string>;
  writeSourceFile(vaultPath: string, content: string): Promise<void>;
  trashSourceFile(vaultPath: string): Promise<void>;
}
```

- Produces `executeMigrationPlan(plan: MigrationPlan, io: MigrationIo): Promise<MigrationExecutionResult>`.
- Produces `ObsidianMigrationIo`, adapting the current vault to `App` and external destinations to Node `fs/promises`.

- [ ] **Step 1: Write failing transaction and end-to-end workflow tests**

Use temporary source/target vault directories and a concrete test `MigrationIo` backed by the filesystem. Assert complete move ordering through an operation log:

```ts
expect(log).toEqual([
  'check-stale:Projects/Zerotier.md',
  'check-stale:Notes/Index.md',
  'check-destination',
  'write-destination',
  'write-backlink:Notes/Index.md',
  'trash-source:Projects/Zerotier.md'
]);
```

Also assert copy never writes backlinks or trashes source, and standalone relink never creates a destination or trashes source.

In `tests/cross-vault-migration.e2e.test.ts`, create temporary `ideas` and `mathematics` directories with `.obsidian` folders and these notes:

```text
ideas/Projects/Zerotier.md       contains [[EEG#Acquisition|EEG setup]]
ideas/Notes/EEG.md               contains ordinary content
ideas/Notes/Network index.md     contains [[Zerotier|ZeroTier]]
mathematics/Notes/               destination folder
```

Build snapshots with positions from the fixture text, create a plan through the real planner, and execute it through the real transaction function. Assert the destination contains `[[ideas::EEG#Acquisition|EEG setup]]`, the source backlink becomes `[[mathematics::Zerotier|ZeroTier]]`, the source note is absent, and no unrelated note changes. Add failing copy and standalone cases that assert copy leaves source/backlinks unchanged and standalone relink leaves both duplicate notes present.

- [ ] **Step 2: Run transaction and workflow tests and verify RED**

Run:

```bash
npm test -- tests/migration-transaction.test.ts
npm test -- tests/cross-vault-migration.e2e.test.ts
```

Expected: FAIL because the transaction module is missing.

- [ ] **Step 3: Implement successful execution and stale checks**

Before any write, compare current source and every backlink file with plan originals. Throw `StaleMigrationPlanError` on mismatch. Check destination collision before writing and throw `DestinationExistsError`. Execute move, copy, and relink in the specified order.

- [ ] **Step 4: Verify successful paths GREEN**

Run the focused transaction tests and expect PASS.

- [ ] **Step 5: Write failing rollback tests**

Inject failures during destination write, the second backlink write, and source trash. Assert:

- Every already edited backlink is restored.
- A created destination is removed.
- The original source remains when trash fails.
- `MigrationExecutionError` includes the original failure plus any rollback failures.
- No `.bak`, `.backup`, or temporary sibling files exist.

- [ ] **Step 6: Run rollback tests and verify RED**

Run the rollback subset and verify failures occur because rollback is not implemented.

- [ ] **Step 7: Implement in-memory rollback**

Track completed writes. Restore backlink files in reverse order and remove the destination if created. Do not perform any fallible operation after a successful source trash except returning the result.

- [ ] **Step 8: Implement and test the Obsidian/Node I/O adapter**

`ObsidianMigrationIo` resolves source files through `app.vault.getAbstractFileByPath`, requires a `TFile`, uses `app.vault.read/modify`, and trashes through `app.fileManager.trashFile`. External writes use `fs.mkdir(..., { recursive: true })`, `fs.writeFile` with `{ flag: 'wx' }`, and `fs.unlink` for rollback.

- [ ] **Step 9: Verify all tests and build**

Run:

```bash
npm test
npm run build
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add tests/migration-transaction.test.ts tests/cross-vault-migration.e2e.test.ts tests/mocks/obsidian.ts src/migration/migration-transaction.ts src/migration/obsidian-migration-io.ts
git commit -m "feat: execute migrations transactionally"
```

---

### Task 5: Add folder selection, review, enhanced Move/Copy, and standalone relink UI

**Files:**
- Create: `tests/migration-commands.test.ts`
- Create: `src/modals/folder-suggest-modal.ts`
- Create: `src/modals/target-note-suggest-modal.ts`
- Create: `src/modals/migration-review-modal.ts`
- Create: `src/modals/relink-backlinks-modal.ts`
- Create: `src/migration/migration-controller.ts`
- Modify: `src/modals/file-operation-modal.ts`
- Modify: `src/main.ts`
- Modify: `src/views/search-page-view.ts`
- Modify: `styles.css`
- Modify: `tests/mocks/obsidian.ts`

**Interfaces:**
- Produces `MigrationController.planMoveCopy`, `planRelink`, and `execute` methods that compose snapshot, planner, transaction, notices, and index refresh.
- Produces `FolderSuggestModal`, `TargetNoteSuggestModal`, and `MigrationReviewModal` callback-based UI classes.
- Produces command constant `RELINK_BACKLINKS_COMMAND_ID = 'multi-vault-relink-backlinks'`.

- [ ] **Step 1: Write failing controller and command tests**

Test the controller with fixture snapshots and an in-memory `MigrationIo`. Verify it returns review data before execution and calls `indexer.buildFullIndex(true)` only after successful execution.

Test command definitions through an exported function:

```ts
export function registerMigrationCommands(
  plugin: MultiVaultNavigatorPlugin,
  controller: MigrationController
): void;
```

Use a mock plugin that records `addCommand` calls. Assert both IDs are registered:

```ts
expect(ids).toContain('multi-vault-move-copy');
expect(ids).toContain('multi-vault-relink-backlinks');
```

Invoke each callback and assert it opens the correct modal class through injected modal factories.

- [ ] **Step 2: Run command tests and verify RED**

Run: `npm test -- tests/migration-commands.test.ts`

Expected: FAIL because controller and registration function do not exist.

- [ ] **Step 3: Implement the controller and registration boundary**

Keep filesystem mutation out of modal classes. The controller gathers fresh snapshots during planning, constructs destination paths, and creates an `ObsidianMigrationIo` only when executing an approved plan.

After success, call `void indexer.buildFullIndex(true)`. Catch index failures only around the refresh and show a warning without rolling back note changes.

- [ ] **Step 4: Verify controller/registration GREEN**

Run the focused tests and expect PASS.

- [ ] **Step 5: Write failing picker and review-model tests**

Extract pure item providers from the modal classes and assert:

- Folder items contain `/` and sorted safe paths.
- Target-note items contain only Markdown files from the selected target vault.
- Review data reports destination, outgoing count, backlink count, affected-file count, and skipped reasons.
- Changing target vault resets destination folder and selected note.

- [ ] **Step 6: Run picker/review tests and verify RED**

Run the focused tests and confirm expected missing behavior.

- [ ] **Step 7: Implement the modal classes**

Use `FuzzySuggestModal<string>` for folders and `FuzzySuggestModal<IndexedFile>` for target notes. Display the relative path as secondary text so duplicate basenames are distinguishable.

`MigrationReviewModal` renders a summary and affected paths, with Cancel and Confirm buttons. Disable Confirm after the first click.

- [ ] **Step 8: Replace direct file operations in FileOperationModal**

The modal must render:

- Target Vault dropdown
- Destination Folder setting with current path and Choose button
- Operation dropdown
- Preserve cross-vault links toggle defaulting to true
- Review Changes call-to-action

When preservation is disabled, construct a plan with unchanged destination content and no backlink edits. If the destination exists, show a notice containing `Use “Relink Backlinks to Existing Cross-Vault Note” when this note already exists there.`

- [ ] **Step 9: Implement standalone relink modal**

Require an active Markdown file, target another configured vault, choose an existing indexed Markdown target, generate a backlink-only plan, show review, and execute without deleting the current note.

- [ ] **Step 10: Add the new command to the Command Center**

Add a quick action next to Move/Copy in `src/views/search-page-view.ts`, using the same command ID constant. Add only the minimal styles required for path lists and skipped-reason summaries.

- [ ] **Step 11: Run all automated verification**

Run:

```bash
npm test
npm run build
```

Expected: all tests and type checking pass.

- [ ] **Step 12: Commit**

```bash
git add tests/migration-commands.test.ts tests/mocks/obsidian.ts src/migration/migration-controller.ts src/modals/folder-suggest-modal.ts src/modals/target-note-suggest-modal.ts src/modals/migration-review-modal.ts src/modals/relink-backlinks-modal.ts src/modals/file-operation-modal.ts src/main.ts src/views/search-page-view.ts styles.css
git commit -m "feat: add safe cross-vault note migration"
```

---

### Task 6: Document, version, build, integrate, and deploy

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `manifest.json`
- Modify: `versions.json`
- Build output: `main.js` remains gitignored
- Deploy output: `main.js`, `manifest.json`, and `styles.css` in each configured vault plugin directory

**Interfaces:**
- Publishes plugin version `2.5.0` with minimum Obsidian version `1.12.7`.
- Uses the existing `deploy-targets.json`; no downloader script is required for local deployment.

- [ ] **Step 1: Update documentation**

Document:

- Destination-folder selection in Move/Copy
- Both-direction link preservation for Move
- Outgoing-only preservation for Copy
- `Relink Backlinks to Existing Cross-Vault Note`
- Preview, collision, skip, and rollback behavior
- Local `npm run build` deployment through `deploy-targets.json`
- Published-release fallback using repository `ErraticPattern/Multi-Vault-Plugin-Obsidian` and a matching release tag

Do not modify `CHANGELOG.md`.

- [ ] **Step 2: Bump synchronized version metadata**

Set version `2.5.0` in `package.json`, `package-lock.json`, and `manifest.json`. Add:

```json
"2.5.0": "1.12.7"
```

to `versions.json`.

- [ ] **Step 3: Run release verification in the feature workspace**

Run:

```bash
npm ci
npm test
npm run build
git diff --check
git status --short
```

Expected: tests and build pass; only intended source, test, documentation, and version files are changed.

- [ ] **Step 4: Commit release metadata and documentation**

```bash
git add README.md package.json package-lock.json manifest.json versions.json
git commit -m "chore: prepare 2.5.0 release"
```

- [ ] **Step 5: Review the complete branch**

Run:

```bash
git diff --stat main...HEAD
git log --oneline main..HEAD
npm test
npm run build
```

Inspect every changed file and resolve all correctness, type, test, lint, and UI issues before integration.

- [ ] **Step 6: Integrate the feature branch into local main**

Use the finishing-a-development-branch workflow. Preserve the existing design commit and feature commits. Do not add an agent co-author.

- [ ] **Step 7: Build from main to deploy all four vaults**

From `C:/Users/joaop/git/ErraticPattern/Multi-Vault-Plugin-Obsidian` on integrated `main`, run:

```bash
npm ci
npm test
npm run build
```

The existing `deploy-targets.json` must copy assets to:

```text
C:/Users/joaop/obsidian/ideas/.obsidian/plugins/multi-vault-navigator
C:/Users/joaop/obsidian/hobbies/.obsidian/plugins/multi-vault-navigator
C:/Users/joaop/obsidian/mathematics/.obsidian/plugins/multi-vault-navigator
C:/Users/joaop/obsidian/medicine/.obsidian/plugins/multi-vault-navigator
```

- [ ] **Step 8: Verify deployed assets byte-for-byte**

Calculate SHA-256 for repository `main.js`, `manifest.json`, and `styles.css`, then compare each corresponding file in all four vaults. Every asset must have one identical hash across all five locations. Verify every deployed manifest reports `2.5.0`.

- [ ] **Step 9: Perform a disposable Obsidian smoke test**

Use temporary vault directories, not personal notes. Load the built plugin in an Obsidian test vault and verify:

- Move/Copy opens and the folder picker lists nested folders.
- Move review shows outgoing/backlink counts.
- Confirming a fixture move creates the destination and rewrites both directions.
- Standalone relink updates backlinks without deleting the source.
- Destination collision blocks execution.
- The modal layout is readable without clipping in the default theme.

- [ ] **Step 10: Report reload requirement**

Tell the user to restart Obsidian or disable/re-enable Multi-Vault Navigator in each currently open vault so the new `main.js` is loaded.
