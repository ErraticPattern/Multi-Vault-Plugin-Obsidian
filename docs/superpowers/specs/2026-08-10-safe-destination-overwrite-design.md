# Safe Destination Overwrite Design

**Status:** Approved design

## Purpose

Add an explicit overwrite option to **Move / Copy File to Another Vault** without weakening existing collision protection, freshness checks, transactional rollback, or index correctness.

## User experience

The operation modal adds **Overwrite existing destination**. It is false whenever the modal opens and is never remembered as a default.

With overwrite disabled, existing behavior remains unchanged: planning or review refuses a destination collision and recommends standalone backlink relinking when appropriate.

With overwrite enabled and a collision present, review prominently states that an existing note will be replaced and identifies its full target-vault path. Confirming review opens a second destructive confirmation naming the destination. No overwrite occurs without both the toggle and second confirmation.

If no collision exists, the option has no effect and the destination is created normally.

## Plan model and freshness

A Move/Copy plan records the overwrite policy. When the destination exists, it also records its exact original content and a content fingerprint. Existing destination content is held only in memory during planning and execution. No backup note is created.

Execution validates, before any write:

1. Source content is unchanged.
2. Every planned backlink source is unchanged.
3. The target catalog fingerprint is current.
4. Destination existence still matches the reviewed plan.
5. For overwrite, destination content still matches the reviewed content fingerprint.

A destination created, removed, or changed after review makes the plan stale and requires a new review.

## Transaction order

Execution performs these steps:

1. Complete every freshness check.
2. Create or replace the destination with rewritten source content.
3. Apply source-vault backlink edits.
4. For Move only, trash the source note last.
5. Apply existing incremental index mutations after the committed migration.

Copy leaves the source untouched. Move preserves the current rule that destination writing and backlink edits happen before source trashing.

## Rollback

Rollback retains existing in-memory originals. If destination creation was attempted, rollback removes only the destination owned by this transaction. If overwrite was attempted, rollback restores the reviewed destination content. Backlink edits are restored in reverse order. If Move may have trashed the source, rollback restores it before restoring backlinks and destination state.

Ownership checks prevent rollback from deleting or replacing a destination that another process changed after this transaction wrote it. Rollback errors remain attached to `MigrationExecutionError` and are shown separately.

## Index behavior

A successful overwrite produces an upsert mutation for the destination identity. Move also removes the source identity; Copy retains it. No full index rebuild is triggered. A post-commit index failure reports that migration succeeded and asks the user to refresh the index.

## Non-goals

- No global or persistent always-overwrite preference.
- No merge of source and destination Markdown.
- No automatic deletion of a duplicate source during standalone relink.
- No overwrite of non-Markdown destinations through this command.

## Verification

Tests must cover:

- Overwrite defaults off.
- Existing destination refusal while off.
- Create behavior when overwrite is on but no destination exists.
- Move and Copy overwrite success.
- Destination creation, removal, or modification after review.
- Destination write failure and partial-attempt recovery.
- Backlink-write failure after destination replacement.
- Source-trash failure after replacement and backlink edits.
- Destination ownership races during rollback.
- Correct incremental index mutations.
- Disposable-vault end-to-end review and confirmation behavior.
