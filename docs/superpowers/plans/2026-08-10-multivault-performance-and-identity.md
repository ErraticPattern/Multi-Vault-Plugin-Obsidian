# Multi-Vault Performance and Canonical Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cross-vault links ambiguity-safe and make migration preview and execution proportional to the changed notes rather than all 27,866 indexed notes.

**Architecture:** Canonical note identity is `{ vaultId, relativePath }`; basename lookup returns resolved, ambiguous, or missing. Migration snapshots use Obsidian's `metadataCache.resolvedLinks`, reviewed plans are reused, and execution submits targeted index mutations. Startup refresh becomes mtime/size incremental and all index requests are coalesced.

**Tech Stack:** TypeScript, Obsidian plugin API, Node filesystem APIs, Vitest, esbuild

## Global Constraints

- Short cross-vault links resolve directly only when unique.
- Ambiguous links must show a chooser with vault and full relative path; never select the first array match.
- Preserve aliases, headings, block fragments, and existing migration rollback guarantees.
- Use native Obsidian `metadataCache.resolvedLinks`; do not depend on Dataview, Omnisearch, or QuickAdd.
- Migration execution must never trigger a full-vault index rebuild.
- Relink preview with no backlinks must complete within 250 ms on Ideas.
- Relink preview with up to 100 backlink notes must complete within 1 s on Ideas.
- Review of an unchanged preview must not rescan and must open within 100 ms.
- Relink execution must complete within 2 s, excluding user confirmation.
- Do not touch production vault notes or `.obsidian` configuration during development.
- Do not deploy or release without a separate approval after verification.
- Every development and verification build must set `MVN_SKIP_DEPLOY=1`.

---

## File Structure

### Create

- `src/note-resolution.ts`: canonical external-note resolver and result types.
- `src/modals/cross-vault-target-suggest-modal.ts`: chooser for ambiguous runtime links.
- `src/indexer/index-mutations.ts`: index mutation types and deduplication.
- `src/migration/prepared-plan-cache.ts`: keyed immutable relink preview plan reuse.
- `tests/note-resolution.test.ts`: unique, path-qualified, ambiguous, and missing resolution.
- `tests/obsidian-snapshot.test.ts`: targeted source/backlink snapshot behavior.
- `tests/indexer-incremental.test.ts`: incremental mutation and coalescing behavior.
- `tests/migration-performance.test.ts`: operation-count and plan-reuse regression tests.

### Modify

- `src/cross-vault-links.ts`: replace `.find()` resolution with result handling and chooser.
- `src/migration/obsidian-snapshot.ts`: read source plus actual backlink files only.
- `src/migration/migration-controller.ts`: reuse targeted snapshot and apply index mutations.
- `src/migration/migration-types.ts`: carry optional targeted index mutations.
- `src/modals/relink-backlinks-modal.ts`: cache the prepared plan for review.
- `src/indexer/file-scanner.ts`: scan one known path and expose entry snapshots.
- `src/indexer/indexer.ts`: incremental refresh, mutation application, and request coalescing.
- `src/main.ts`: use incremental startup refresh and explicit full rebuild command.
- `esbuild.config.mjs`: honor `MVN_SKIP_DEPLOY=1` so verification builds cannot copy into production vaults.
- `tests/migration-commands.test.ts`: assert plan reuse and no full rebuild.
- `tests/cross-vault-migration.e2e.test.ts`: duplicate README and targeted-update fixtures.
- `tests/mocks/obsidian.ts`: add the minimum metadata and modal mocks required by tests.
- `README.md`: document path-qualified links and performance behavior.

---

### Task 0: Make Verification Builds Non-Deploying

**Files:**
- Modify: `esbuild.config.mjs`

**Interfaces:**
- Produces: `MVN_SKIP_DEPLOY=1 npm run build` with no writes to configured deployment targets.

- [ ] **Step 1: Guard deployment target loading and copying**

Add:

```js
const skipDeploy = process.env.MVN_SKIP_DEPLOY === '1';
```

Set `deployTargets = []` when `skipDeploy` is true, and make `copyToTargets()` return immediately. Log `Skipping local deployment because MVN_SKIP_DEPLOY=1` after a successful build.

- [ ] **Step 2: Verify the guarded production build**

Record hashes and mtimes for the four currently installed `main.js` files, run:

```bash
MVN_SKIP_DEPLOY=1 npm run build
```

Then verify all installed hashes and mtimes are unchanged while repository `main.js` was rebuilt.

- [ ] **Step 3: Commit**

```bash
git add esbuild.config.mjs
git commit -m "build: allow non-deploying verification"
```

---

### Task 1: Canonical and Ambiguity-Safe Note Resolution

**Files:**
- Create: `src/note-resolution.ts`
- Create: `src/modals/cross-vault-target-suggest-modal.ts`
- Create: `tests/note-resolution.test.ts`
- Modify: `src/cross-vault-links.ts`
- Modify: `tests/mocks/obsidian.ts`

**Interfaces:**
- Produces: `resolveIndexedNote(files, vaultName, noteRef): NoteResolution`
- Produces: `NoteResolution = { kind: 'resolved'; target } | { kind: 'ambiguous'; candidates } | { kind: 'missing' }`
- Consumes later: API work and Virtual Linker use the same resolution semantics.

- [ ] **Step 1: Write resolver tests for every result state**

```ts
import { describe, expect, it } from 'vitest';
import { resolveIndexedNote } from '../src/note-resolution';
import type { IndexedFile } from '../src/types';

const files = [
  { vaultName: 'ideas', relativePath: 'README.md', basename: 'README', extension: '.md' },
  { vaultName: 'ideas', relativePath: 'Lab/README.md', basename: 'README', extension: '.md' },
  { vaultName: 'ideas', relativePath: 'Notes/Unique.md', basename: 'Unique', extension: '.md' },
] as IndexedFile[];

describe('resolveIndexedNote', () => {
  it('resolves a unique basename', () => {
    expect(resolveIndexedNote(files, 'ideas', 'Unique')).toMatchObject({
      kind: 'resolved', target: { relativePath: 'Notes/Unique.md' },
    });
  });

  it('resolves an exact extensionless relative path', () => {
    expect(resolveIndexedNote(files, 'ideas', 'Lab/README')).toMatchObject({
      kind: 'resolved', target: { relativePath: 'Lab/README.md' },
    });
  });

  it('returns every candidate for an ambiguous basename', () => {
    const result = resolveIndexedNote(files, 'ideas', 'README');
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates.map((file) => file.relativePath)).toEqual(['Lab/README.md', 'README.md']);
    }
  });

  it('returns missing instead of an arbitrary match', () => {
    expect(resolveIndexedNote(files, 'ideas', 'Absent')).toEqual({ kind: 'missing' });
  });
});
```

- [ ] **Step 2: Run the focused test and verify red**

Run: `npm test -- tests/note-resolution.test.ts`

Expected: FAIL because `src/note-resolution.ts` does not exist.

- [ ] **Step 3: Implement normalized canonical resolution**

```ts
import type { IndexedFile } from './types';
import { isMarkdownExtension } from './migration/migration-view-models';

export type NoteResolution =
  | { kind: 'resolved'; target: IndexedFile }
  | { kind: 'ambiguous'; candidates: IndexedFile[] }
  | { kind: 'missing' };

const extensionless = (value: string) => value.replace(/\\/g, '/').replace(/\.md$/i, '').toLowerCase();

export function resolveIndexedNote(
  files: IndexedFile[],
  vaultName: string,
  noteRef: string,
): NoteResolution {
  const vault = vaultName.trim().toLowerCase();
  const ref = extensionless(noteRef.trim());
  const candidates = files.filter((file) =>
    isMarkdownExtension(file.extension) && file.vaultName.toLowerCase() === vault);
  const exactPaths = candidates.filter((file) => extensionless(file.relativePath) === ref);
  if (exactPaths.length === 1) return { kind: 'resolved', target: exactPaths[0] };
  if (exactPaths.length > 1) return { kind: 'ambiguous', candidates: exactPaths };
  const basenameMatches = candidates
    .filter((file) => file.basename.toLowerCase() === ref)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (basenameMatches.length === 1) return { kind: 'resolved', target: basenameMatches[0] };
  if (basenameMatches.length > 1) return { kind: 'ambiguous', candidates: basenameMatches };
  return { kind: 'missing' };
}
```

- [ ] **Step 4: Run the resolver tests and verify green**

Run: `npm test -- tests/note-resolution.test.ts`

Expected: 4 tests PASS.

- [ ] **Step 5: Add the ambiguous target chooser**

Implement `CrossVaultTargetSuggestModal extends FuzzySuggestModal<IndexedFile>` with item text `${vaultName}  ${relativePath}` and separate vault/path render rows. Its callback receives the exact `IndexedFile` selected by the user.

- [ ] **Step 6: Route runtime opening through `NoteResolution`**

Replace `findCrossVaultTarget(...).find(...)` in `src/cross-vault-links.ts`. Handle results exactly:

```ts
const resolution = resolveIndexedNote(plugin.indexer.getIndexedFiles(), ref.vaultName, ref.noteName);
if (resolution.kind === 'resolved') {
  void plugin.fileOpener.openFile(resolution.target);
} else if (resolution.kind === 'ambiguous') {
  new CrossVaultTargetSuggestModal(plugin.app, resolution.candidates, (target) => {
    void plugin.fileOpener.openFile(target);
  }).open();
} else {
  new Notice(`File "${ref.noteName}" not found in vault "${ref.vaultName}".`);
}
```

Apply the same resolver to the context-menu path. Preserve heading/block parsing already performed by `parseCrossVaultHref()`.

- [ ] **Step 7: Run focused and complete tests**

Run: `npm test -- tests/note-resolution.test.ts tests/link-rewriter.test.ts && npm test`

Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/note-resolution.ts src/modals/cross-vault-target-suggest-modal.ts src/cross-vault-links.ts tests/note-resolution.test.ts tests/mocks/obsidian.ts
git commit -m "fix: disambiguate cross-vault note identities"
```

---

### Task 2: Targeted Migration Snapshots and Plan Reuse

**Files:**
- Create: `tests/obsidian-snapshot.test.ts`
- Create: `tests/migration-performance.test.ts`
- Create: `src/migration/prepared-plan-cache.ts`
- Modify: `src/migration/obsidian-snapshot.ts`
- Modify: `src/migration/migration-controller.ts`
- Modify: `src/modals/relink-backlinks-modal.ts`
- Modify: `tests/migration-commands.test.ts`

**Interfaces:**
- Produces: `collectMigrationSnapshot(app, sourcePath): Promise<NoteSnapshot[]>`
- Produces: `PreparedPlanCache.get(key, isCurrent): MigrationPlan | null`.
- Produces: `MigrationPlanFingerprint` containing source mtime and exact backlink path/count pairs.
- Consumes: public `MetadataCache.resolvedLinks`.

- [ ] **Step 1: Write a targeted snapshot test with unrelated notes and duplicate READMEs**

```ts
it('reads only the source and notes whose resolved links target the exact source path', async () => {
  const files = [
    testFile('README.md'),
    testFile('Lab/README.md'),
    testFile('Index.md'),
    testFile('Unrelated.md'),
  ];
  const reads: string[] = [];
  const app = appFixture(files, {
    resolvedLinks: {
      'Index.md': { 'Lab/README.md': 1 },
      'Unrelated.md': { 'README.md': 1 },
    },
    onRead: (path) => reads.push(path),
  });

  const notes = await collectMigrationSnapshot(app as never, 'Lab/README.md');

  expect(notes.map((note) => note.path)).toEqual(['Index.md', 'Lab/README.md']);
  expect(reads.sort()).toEqual(['Index.md', 'Lab/README.md']);
});
```

- [ ] **Step 2: Run the focused test and verify red**

Run: `npm test -- tests/obsidian-snapshot.test.ts`

Expected: FAIL because `collectMigrationSnapshot` is missing and the current function reads all files.

- [ ] **Step 3: Implement exact backlink path discovery**

```ts
function migrationPaths(app: App, sourcePath: string): string[] {
  const paths = new Set([sourcePath]);
  for (const [candidatePath, destinations] of Object.entries(app.metadataCache.resolvedLinks)) {
    if ((destinations[sourcePath] ?? 0) > 0) paths.add(candidatePath);
  }
  return [...paths].sort();
}

export async function collectMigrationSnapshot(app: App, sourcePath: string): Promise<NoteSnapshot[]> {
  const notes: NoteSnapshot[] = [];
  for (const filePath of migrationPaths(app, sourcePath)) {
    const file = app.vault.getFileByPath(filePath);
    if (!file) continue;
    notes.push(await snapshotNote(app, file));
  }
  return notes;
}
```

Extract existing per-file logic into `snapshotNote(app, file)`. Do not use basename matching to discover backlinks.

- [ ] **Step 4: Update both controller planning paths**

Replace both `collectSourceVaultSnapshot(this.app)` calls with:

```ts
collectMigrationSnapshot(this.app, activeFile.path)
```

Delete the old all-vault snapshot export after every call site is migrated.

- [ ] **Step 5: Write and implement a keyed plan-cache test**

```ts
it('reuses only a current plan with the same target key', () => {
  const cache = new PreparedPlanCache();
  cache.store('medicine:', plan);
  expect(cache.get('medicine:', () => true)).toBe(plan);
  expect(cache.get('mathematics:', () => true)).toBeNull();
  expect(cache.get('medicine:', () => false)).toBeNull();
});
```

Implement `PreparedPlanCache` with one private `{ key, plan }` entry, `store()`, `get()`, and `invalidate()`. `get()` clears and returns `null` when the key differs or `isCurrent(plan)` is false.

- [ ] **Step 6: Add a cheap plan fingerprint**

Store the active source file mtime plus sorted `[backlinkSourcePath, resolvedLinkCount]` pairs for the exact source path. Add `MigrationController.isPlanCurrent(plan, activeFile)` that compares current mtime and the in-memory `resolvedLinks` pairs without reading note content.

- [ ] **Step 7: Cache the prepared plan in the relink modal**

Store the latest successful `{ targetVaultId, targetNoteId, plan }`. `refreshPreview()` replaces it after the generation check. **Review changes** reuses it only when the key matches and `isPlanCurrent()` returns true; otherwise it prepares once. Existing execution stale-content checks remain the final safety boundary.

- [ ] **Step 8: Add an operation-count regression with 10,000 unrelated files**

Build a mock `resolvedLinks` object where only two files target the source. Assert exactly three vault reads and assert review does not add reads. Do not use a flaky wall-clock assertion in CI.

- [ ] **Step 9: Run focused and complete tests**

Run: `npm test -- tests/obsidian-snapshot.test.ts tests/migration-performance.test.ts tests/migration-commands.test.ts && npm test`

Expected: all tests PASS; the 10,000-unrelated-file fixture performs three reads.

- [ ] **Step 10: Commit**

```bash
git add src/migration/prepared-plan-cache.ts src/migration/obsidian-snapshot.ts src/migration/migration-controller.ts src/modals/relink-backlinks-modal.ts tests/obsidian-snapshot.test.ts tests/migration-performance.test.ts tests/migration-commands.test.ts
git commit -m "perf: target migration backlink snapshots"
```

---

### Task 3: Incremental Index Mutations After Migration

**Files:**
- Create: `src/indexer/index-mutations.ts`
- Create: `tests/indexer-incremental.test.ts`
- Modify: `src/indexer/file-scanner.ts`
- Modify: `src/indexer/indexer.ts`
- Modify: `src/migration/migration-controller.ts`
- Modify: `src/migration/migration-types.ts`
- Modify: `tests/migration-commands.test.ts`
- Modify: `tests/cross-vault-migration.e2e.test.ts`

**Interfaces:**
- Produces: `IndexMutation = { kind: 'upsert' | 'remove'; vaultId: string; relativePath: string }`
- Produces: `Indexer.applyMutations(mutations): Promise<void>`
- Produces: `FileScanner.scanFileAsync(vault, relativePath): Promise<FileEntry | null>`
- Produces: controller execution result with `indexUpdated` and optional `indexError` so post-commit cache failure is never reported as migration rollback.

- [ ] **Step 1: Write mutation deduplication and incremental-index tests**

```ts
it('reparses only upserts, removes deleted paths, and saves once', async () => {
  const harness = indexerHarness([
    indexed('ideas', 'Index.md'),
    indexed('ideas', 'Source.md'),
  ]);

  await harness.indexer.applyMutations([
    { kind: 'upsert', vaultId: 'ideas', relativePath: 'Index.md' },
    { kind: 'upsert', vaultId: 'ideas', relativePath: 'Index.md' },
    { kind: 'remove', vaultId: 'ideas', relativePath: 'Source.md' },
    { kind: 'upsert', vaultId: 'medicine', relativePath: 'Notes/Source.md' },
  ]);

  expect(harness.parsedPaths).toEqual(['Index.md', 'Notes/Source.md']);
  expect(harness.saved).toBe(1);
  expect(harness.indexer.getIndexedFiles().map((f) => f.id).sort()).toEqual([
    'ideas:Index.md', 'medicine:Notes/Source.md',
  ]);
});
```

- [ ] **Step 2: Run the focused test and verify red**

Run: `npm test -- tests/indexer-incremental.test.ts`

Expected: FAIL because mutation APIs do not exist.

- [ ] **Step 3: Implement normalized mutation types**

```ts
export interface IndexMutation {
  kind: 'upsert' | 'remove';
  vaultId: string;
  relativePath: string;
}

export function deduplicateMutations(mutations: IndexMutation[]): IndexMutation[] {
  const byIdentity = new Map<string, IndexMutation>();
  for (const mutation of mutations) {
    const normalized = mutation.relativePath.replace(/\\/g, '/');
    byIdentity.set(`${mutation.vaultId}:${normalized.toLowerCase()}`, { ...mutation, relativePath: normalized });
  }
  return [...byIdentity.values()];
}
```

The last mutation for one identity wins.

- [ ] **Step 4: Add single-file scanning**

`scanFileAsync()` resolves inside the configured vault root, rejects traversal, verifies `.md`, stats the file, and returns the same `FileEntry` shape as full scanning. Missing files return `null`.

- [ ] **Step 5: Implement `Indexer.applyMutations()`**

Use an identity map keyed by `${vaultId}:${relativePath}`. Apply removals immediately. For each upsert, resolve its enabled `VaultConfig`, call `scanFileAsync()`, parse the returned entry, and replace the indexed record. Save the resulting cache exactly once after all mutations succeed.

- [ ] **Step 6: Attach mutations to prepared plans**

Add optional `indexMutations?: IndexMutation[]` to `MigrationPlan`. In `MigrationController`, attach:

- Move: remove source, upsert destination, upsert each backlink edit.
- Copy: upsert destination only.
- Relink: upsert each backlink edit only.

Use current and target vault IDs from the controller, not vault display names.

- [ ] **Step 7: Replace the full rebuild after execution**

```ts
async execute(plan: MigrationPlan): Promise<MigrationControllerExecutionResult> {
  const result = await executeMigrationPlan(plan, this.ioFactory());
  try {
    await this.indexer.applyMutations(plan.indexMutations ?? []);
    return { ...result, indexUpdated: true };
  } catch (error: unknown) {
    return {
      ...result,
      indexUpdated: false,
      indexError: error instanceof Error ? error.message : String(error),
    };
  }
}
```

Do not call `buildFullIndex()` from migration code. Update both migration modals to report that the migration committed but the index needs manual refresh when `indexUpdated` is false. Never label this post-commit condition as a rolled-back migration failure.

- [ ] **Step 8: Update controller and end-to-end assertions**

Replace the old `refreshes === 1` expectation with exact parsed paths and one cache save. Add a duplicate `README.md` move fixture and verify the backlink becomes path-qualified when needed.

- [ ] **Step 9: Run focused and complete tests**

Run: `npm test -- tests/indexer-incremental.test.ts tests/migration-commands.test.ts tests/cross-vault-migration.e2e.test.ts && npm test`

Expected: all tests PASS and no migration test observes `buildFullIndex()`.

- [ ] **Step 10: Commit**

```bash
git add src/indexer/index-mutations.ts src/indexer/file-scanner.ts src/indexer/indexer.ts src/migration/migration-controller.ts src/migration/migration-types.ts tests/indexer-incremental.test.ts tests/migration-commands.test.ts tests/cross-vault-migration.e2e.test.ts
git commit -m "perf: update migration index incrementally"
```

---

### Task 4: Incremental and Coalesced Startup Refresh

**Files:**
- Modify: `src/indexer/indexer.ts`
- Modify: `src/main.ts`
- Modify: `tests/indexer-incremental.test.ts`

**Interfaces:**
- Produces: `Indexer.refreshIncremental(showNotice?: boolean): Promise<void>`
- Produces: one serialized index-operation queue shared by refresh, full rebuild, and mutations.
- Preserves: `Indexer.buildFullIndex(showNotice?: boolean): Promise<void>` as explicit forced rebuild.

- [ ] **Step 1: Write changed-only and coalescing tests**

```ts
it('parses only new or mtime/size-changed files', async () => {
  const harness = indexerHarness([indexed('ideas', 'Stable.md', 10, 100)]);
  harness.scannedEntries = [
    entry('Stable.md', 10, 100),
    entry('Changed.md', 11, 200),
  ];
  await harness.indexer.refreshIncremental();
  expect(harness.parsedPaths).toEqual(['Changed.md']);
});

it('coalesces concurrent incremental refresh callers', async () => {
  const harness = delayedIndexerHarness();
  await Promise.all([
    harness.indexer.refreshIncremental(),
    harness.indexer.refreshIncremental(),
    harness.indexer.refreshIncremental(),
  ]);
  expect(harness.scanCalls).toBe(1);
});
```

- [ ] **Step 2: Run the focused tests and verify red**

Run: `npm test -- tests/indexer-incremental.test.ts`

Expected: FAIL because `refreshIncremental` is missing.

- [ ] **Step 3: Implement one shared refresh promise and serialized write queue**

Store `private refreshPromise: Promise<void> | null = null` for caller coalescing and a private operation tail for all index state writes:

```ts
private operationTail: Promise<void> = Promise.resolve();

private enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = this.operationTail.then(operation, operation);
  this.operationTail = result.then(() => undefined, () => undefined);
  return result;
}
```

`refreshIncremental()` returns its existing promise when present. Incremental refresh, full rebuild, and `applyMutations()` all run through `enqueue()` so stale scan results cannot overwrite a completed migration mutation.

- [ ] **Step 4: Implement mtime/size comparison**

Scan enabled vault entries, compare each entry with the cached index by canonical identity, parse only new or changed entries, retain unchanged records, remove records absent from the scan, and persist once. Use a bounded worker pool of eight parser tasks rather than unbounded `Promise.all()` or sequential parsing.

- [ ] **Step 5: Keep full rebuild explicit**

`buildFullIndex()` remains the command/settings maintenance operation and may reuse the worker pool, but it reparses every scanned entry. Remove the 15-second silent cooldown in favor of shared-promise coalescing and a clear notice when a forced rebuild is already active.

- [ ] **Step 6: Change startup behavior**

In `src/main.ts`, keep the five-second startup delay but call:

```ts
await this.indexer.refreshIncremental(false);
```

Migration commands do not wait for this operation unless they request the same index mutation lock. Mutation application queues behind an active cache commit and then processes only its explicit paths.

- [ ] **Step 7: Run complete tests and production build**

Run: `npm test && MVN_SKIP_DEPLOY=1 npm run build && git diff --check`

Expected: all tests PASS; TypeScript and esbuild succeed; diff check is clean.

- [ ] **Step 8: Commit**

```bash
git add src/indexer/indexer.ts src/main.ts tests/indexer-incremental.test.ts
git commit -m "perf: refresh external index incrementally"
```

---

### Task 5: Evidence, Documentation, and Release Gate

**Files:**
- Modify: `README.md`
- Modify only after approval: `manifest.json`, `package.json`, `package-lock.json`, `versions.json`

**Interfaces:**
- Produces: measured feasibility report in the implementation-session summary.
- Does not deploy or release without explicit approval.

- [ ] **Step 1: Run the operation-count regression suite**

Run:

```bash
npm ci
npm audit
npm test -- tests/note-resolution.test.ts tests/obsidian-snapshot.test.ts tests/indexer-incremental.test.ts tests/migration-performance.test.ts
```

Expected: PASS and zero vulnerabilities.

- [ ] **Step 2: Measure against a read-only copy or disposable Ideas-scale fixture**

Record `performance.now()` around backlink discovery, required reads, planning, review reuse, transaction execution, mutation parsing, and cache save. Verify the budgets from Global Constraints. Do not benchmark by modifying production notes.

- [ ] **Step 3: Run complete verification**

Run:

```bash
npm test
MVN_SKIP_DEPLOY=1 npm run build
git diff --check
git status --short
```

Expected: all tests and build PASS; only intended repository files are modified.

- [ ] **Step 4: Update documentation**

Document that ambiguous short links open a chooser, path-qualified links are canonical for duplicates, migrations use targeted backlinks, and full refresh is manual maintenance rather than migration behavior.

- [ ] **Step 5: Request code review**

Use `superpowers:requesting-code-review`. Resolve all correctness, rollback, identity, concurrency, and performance findings before proceeding.

- [ ] **Step 6: Commit verified documentation**

```bash
git add README.md
git commit -m "docs: explain canonical cross-vault links"
```

- [ ] **Step 7: Stop at the release gate**

Report exact timings, test count, build result, audit result, and repository status. Ask for explicit approval before version changes, deployment to the four production vaults, tagging, pushing, or publishing a release.
