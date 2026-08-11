# Safe Destination Overwrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an off-by-default, double-confirmed Move/Copy overwrite path with destination freshness checks, ownership-safe rollback, and incremental index updates.

**Architecture:** Extend `MigrationPlan` with an explicit destination policy and reviewed destination snapshot. Planning captures collision state; transaction execution revalidates it and delegates compare-and-write/restore operations to `MigrationIo`. UI exposes one per-operation toggle and a dedicated destructive confirmation modal.

**Tech Stack:** TypeScript, Obsidian Plugin API, Node filesystem promises, Vitest 3.

## Global Constraints

- Overwrite defaults off every time the Move/Copy modal opens.
- Existing collision refusal remains unchanged while overwrite is off.
- Existing destination content is held in memory only; create no backup note.
- Destination changes after review abort before source or backlink writes.
- Move trashes the source last.
- Rollback must not replace or remove a destination no longer owned by the transaction.
- Migration execution must not trigger a full index rebuild.
- Tests use memory or disposable-vault fixtures, never production vaults.
- Build verification uses `MVN_SKIP_DEPLOY=1` until explicit deployment approval.

---

### Task 1: Model Destination Policy and Compare-and-Write I/O

**Files:**
- Modify: `src/migration/migration-types.ts`
- Modify: `src/migration/migration-transaction.ts`
- Modify: `src/migration/obsidian-migration-io.ts`
- Modify: `tests/migration-transaction.test.ts`
- Modify: `tests/obsidian-migration-io.test.ts`

**Interfaces:**
- Produces: `DestinationPolicy = 'create-only' | 'overwrite-reviewed'`
- Produces on `MigrationPlan`: `destinationPolicy`, `destinationOriginalContent`
- Replaces `MigrationIo.writeDestination(path, content)` with `writeDestination(path, content, expectedOriginal)`
- Replaces `removeDestination(path)` with `restoreDestination(path, writtenContent, originalContent)`

- [ ] **Step 1: Write failing transaction tests**

Add cases proving create-only refusal, reviewed overwrite, stale content refusal, overwrite rollback restoration, and rollback ownership protection:

```ts
const overwritePlan = plan('move');
overwritePlan.destinationPolicy = 'overwrite-reviewed';
overwritePlan.destinationOriginalContent = 'existing';
io.destination.set(overwritePlan.destinationAbsolutePath!, 'existing');
await executeMigrationPlan(overwritePlan, io);
expect(io.destination.get(overwritePlan.destinationAbsolutePath!))
  .toBe('Uses [[ideas::EEG]].');
```

For stale content, change the memory destination to `changed after review` and expect `StaleMigrationPlanError`. For rollback ownership, make a backlink write fail after replacing the destination, then mutate the destination before `restoreDestination`; expect the concurrent content to remain and the ownership error to appear in `rollbackErrors`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm test -- tests/migration-transaction.test.ts tests/obsidian-migration-io.test.ts
```

Expected: TypeScript/runtime failures because destination policy and new I/O methods do not exist.

- [ ] **Step 3: Add exact plan and I/O types**

Use:

```ts
export type DestinationPolicy = 'create-only' | 'overwrite-reviewed';

export interface MigrationPlan {
  // existing fields
  destinationPolicy?: DestinationPolicy;
  destinationOriginalContent?: string | null;
}
```

Use `undefined` only for backward-compatible relink plans. Move/Copy planning in Task 2 always sets both fields.

Change `MigrationIo` to:

```ts
writeDestination(
  absolutePath: string,
  content: string,
  expectedOriginal: string | null,
): Promise<void>;
restoreDestination(
  absolutePath: string,
  writtenContent: string,
  originalContent: string | null,
): Promise<void>;
```

- [ ] **Step 4: Implement transaction freshness and rollback**

Before writes, evaluate destination state:

```ts
const original = plan.destinationOriginalContent ?? null;
const policy = plan.destinationPolicy ?? 'create-only';
const exists = await io.destinationExists(destination);
if (policy === 'create-only' && exists) throw new DestinationExistsError(destination);
if (policy === 'overwrite-reviewed') {
  if (!exists || await io.readDestination(destination) !== original) {
    throw new StaleMigrationPlanError(destination);
  }
}
```

Call `writeDestination(destination, content, policy === 'overwrite-reviewed' ? original : null)`. Set `destinationWriteAttempted` before awaiting it. During rollback call `restoreDestination(destination, destinationContent, original)` so I/O verifies current content still equals the transaction's written content.

- [ ] **Step 5: Implement filesystem compare-and-write/restore**

For create, retain exclusive `open(path, 'wx')`. For overwrite, read and compare `expectedOriginal`, then write with `writeFile`. `restoreDestination` must read current content and throw `DestinationOwnershipError` unless it equals `writtenContent`; remove it for a newly created destination or write `originalContent` for overwrite.

Keep parent-directory creation and partial-write cleanup. A failed overwrite write must attempt restoration because `destinationWriteAttempted` was set before the call.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
npm test -- tests/migration-transaction.test.ts tests/obsidian-migration-io.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/migration/migration-types.ts src/migration/migration-transaction.ts src/migration/obsidian-migration-io.ts tests/migration-transaction.test.ts tests/obsidian-migration-io.test.ts
git commit -m "feat: add transactional destination overwrite"
```

### Task 2: Capture Destination State During Planning

**Files:**
- Modify: `src/migration/migration-controller.ts`
- Modify: `src/migration/prepared-plan-cache.ts`
- Modify: `tests/migration-commands.test.ts`
- Modify: `tests/migration-performance.test.ts`

**Interfaces:**
- Consumes: Task 1 destination policy fields and `MigrationIo.readDestination()`
- Changes: `planMoveCopy(activeFile, targetVaultId, targetFolder, mode, preserveLinks, overwriteDestination)`
- Produces: destination-existence state in the immutable reviewed plan

- [ ] **Step 1: Write failing controller tests**

Add tests for:

```ts
await expect(controller.planMoveCopy(file, 'math', '/', 'move', true, false))
  .rejects.toBeInstanceOf(DestinationExistsError);
const plan = await controller.planMoveCopy(file, 'math', '/', 'copy', true, true);
expect(plan).toMatchObject({
  destinationPolicy: 'overwrite-reviewed',
  destinationOriginalContent: 'existing target',
});
```

Also prove overwrite enabled with no collision yields `create-only` plus `null`, and reviewed plan reuse becomes false if target existence/catalog changes.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npm test -- tests/migration-commands.test.ts tests/migration-performance.test.ts
```

Expected: signature mismatch and absent destination metadata assertions fail.

- [ ] **Step 3: Implement planning snapshot**

After resolving destination, create one planning I/O instance and inspect the target before collecting backlinks:

```ts
const io = this.ioFactory();
const destinationExists = await io.destinationExists(destination.absolutePath);
if (destinationExists && !overwriteDestination) {
  throw new DestinationExistsError(destination.absolutePath);
}
const destinationOriginalContent = destinationExists
  ? await io.readDestination(destination.absolutePath)
  : null;
```

Set policy to `overwrite-reviewed` only when the file exists and the toggle is true; otherwise use `create-only`. Attach original content after `planMoveOrCopy()` returns. Preserve existing target-catalog fingerprints and index mutations.

- [ ] **Step 4: Run focused tests and verify GREEN**

```bash
npm test -- tests/migration-commands.test.ts tests/migration-performance.test.ts
```

Expected: focused tests pass and the no-backlink test still reads no unrelated note contents.

- [ ] **Step 5: Commit**

```bash
git add src/migration/migration-controller.ts src/migration/prepared-plan-cache.ts tests/migration-commands.test.ts tests/migration-performance.test.ts
git commit -m "feat: review destination overwrite state"
```

### Task 3: Add Toggle, Review Warning, and Destructive Confirmation

**Files:**
- Create: `src/modals/overwrite-confirm-modal.ts`
- Modify: `src/modals/file-operation-modal.ts`
- Modify: `src/modals/migration-review-modal.ts`
- Modify: `src/migration/migration-view-models.ts`
- Modify: `tests/migration-commands.test.ts`
- Modify: `tests/migration-planner.test.ts`

**Interfaces:**
- Consumes: Task 2 `planMoveCopy(..., overwriteDestination)`
- Produces: `OverwriteConfirmModal(app, destinationPath, onConfirm)`
- Produces review fields: `overwritesDestination`, `destinationOriginalBytes`

- [ ] **Step 1: Write failing view-model and command tests**

Assert a reviewed overwrite model contains:

```ts
expect(makeMigrationReviewModel(plan)).toMatchObject({
  overwritesDestination: true,
  destinationOriginalBytes: 8,
});
```

Update modal/controller mocks to verify the sixth planning argument is false by default and true only after the overwrite toggle changes. Add a DOM-free helper test proving overwrite plans route through a second confirmation callback while create-only plans execute directly.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npm test -- tests/migration-commands.test.ts tests/migration-planner.test.ts
```

Expected: missing review fields/helper and old controller call fail.

- [ ] **Step 3: Add UI state and review warning**

In `FileOperationModal`, initialize `private overwriteDestination = false;` and add:

```ts
new Setting(this.contentEl)
  .setName('Overwrite existing destination')
  .setDesc('Replace an existing destination note after a second confirmation.')
  .addToggle(toggle => toggle.setValue(false).onChange(value => {
    this.overwriteDestination = value;
  }));
```

Remove the direct `fs.existsSync` refusal. Planning now owns collision semantics. Pass the toggle into `planMoveCopy`.

When `overwritesDestination` is true, `MigrationReviewModal` renders a destructive warning with full destination path and original byte count. Its Confirm action opens `OverwriteConfirmModal`; only that modal invokes execution.

- [ ] **Step 4: Implement the dedicated confirmation modal**

Render exact warning text:

```ts
`Replace existing note at ${destinationPath}? This cannot preserve its current contents if rollback also fails.`
```

Provide **Cancel** and destructive **Overwrite note** buttons. Disable the destructive button while awaiting `onConfirm`, and re-enable it on error.

- [ ] **Step 5: Run focused tests and verify GREEN**

```bash
npm test -- tests/migration-commands.test.ts tests/migration-planner.test.ts
```

Expected: focused tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/modals/overwrite-confirm-modal.ts src/modals/file-operation-modal.ts src/modals/migration-review-modal.ts src/migration/migration-view-models.ts tests/migration-commands.test.ts tests/migration-planner.test.ts
git commit -m "feat: confirm destructive vault overwrite"
```

### Task 4: End-to-End Collision and Rollback Coverage

**Files:**
- Modify: `tests/cross-vault-migration.e2e.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: completed overwrite planner and transaction path
- Produces: disposable-vault proof for Move and Copy collisions

- [ ] **Step 1: Add failing disposable-vault scenarios**

Create source and destination `Notes/Same.md`. Exercise Move overwrite and assert destination source content, source removal, backlink conversion, and no sibling `.bak`, `.backup`, or `.tmp` file. Exercise Copy overwrite and assert source retention. Add one injected failure after replacement and assert exact destination restoration.

- [ ] **Step 2: Run E2E test and verify RED if any path is incomplete**

```bash
npm test -- tests/cross-vault-migration.e2e.test.ts
```

Expected before final wiring: at least one overwrite assertion fails. If all pass from prior tasks, temporarily set the expected destination to an incorrect sentinel, observe failure, restore it, and continue.

- [ ] **Step 3: Complete only missing E2E wiring**

Fix controller fixtures, I/O adapters, or mutation expectations exposed by the disposable scenario. Do not add production-vault paths.

- [ ] **Step 4: Document operation semantics**

Add README text stating overwrite is per-operation, defaults off, requires double confirmation, rejects stale destinations, and restores reviewed destination content on recoverable failure.

- [ ] **Step 5: Run E2E and full verification**

```bash
npm test -- tests/cross-vault-migration.e2e.test.ts
npm test
MVN_SKIP_DEPLOY=1 npm run build
npm audit
git diff --check
```

Expected: all tests pass, build skips deployment, audit reports zero vulnerabilities, and diff check is clean.

- [ ] **Step 6: Commit**

```bash
git add tests/cross-vault-migration.e2e.test.ts README.md
git commit -m "test: verify destination overwrite workflow"
```

### Task 5: Review and Release Gate

**Files:**
- Review only: all changes since this plan's base commit

**Interfaces:**
- Produces: verified branch ready for user-selected merge/deploy action

- [ ] **Step 1: Request code review**

Review destination ownership, stale-state handling, rollback ordering, absence of persistent overwrite defaults, and no full-index path.

- [ ] **Step 2: Apply accepted findings with focused red-green tests**

For each accepted finding, add a failing regression test, run it to observe failure, implement the fix, rerun focused tests, and commit using `fix: harden destination overwrite`.

- [ ] **Step 3: Run final verification**

```bash
npm ci
npm audit
npm test
MVN_SKIP_DEPLOY=1 npm run build
git diff --check
git status --short
```

Expected: zero vulnerabilities, full green suite, successful non-deploying build, clean diff, and clean working tree.

- [ ] **Step 4: Stop at release gate**

Do not version, merge, deploy, tag, or push until the user explicitly chooses the branch-finishing and deployment action.
