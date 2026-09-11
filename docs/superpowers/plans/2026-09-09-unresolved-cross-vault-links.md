# Unresolved Cross-Vault Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a review dashboard that converts selected unresolved current-vault wikilinks and embeds into correct MVN cross-vault links.

**Architecture:** Parse current-vault Markdown into exact editable occurrences, use Obsidian resolution facts plus MVN's external-vault index to create grouped proposals, and execute selected edits transactionally with stale checks and rollback. A dedicated workspace view owns selection and candidate choice while pure planner/view-model units remain independently tested.

**Tech Stack:** TypeScript 5, Obsidian API, Vitest 3, existing MVN index/migration utilities

**Spec:** `docs/superpowers/specs/2026-09-09-unresolved-cross-vault-links-design.md`

## Global Constraints

- Analyze and modify only the currently open vault.
- Support normal wikilinks and embeds.
- Never create target notes.
- Require explicit candidate choice for ambiguity.
- Preserve aliases, heading/block suffixes, and configured output format.
- Exclude code, escaped links, resolved local links, and existing cross-vault links.
- Verify source content before writes and roll back completed writes after failure.

---

### Task 1: Exact unresolved-link parsing

**Files:** Create `src/unresolved-links/unresolved-link-parser.ts`, `tests/unresolved-link-parser.test.ts`.

- [x] Write RED tests for links, embeds, aliases, subpaths, repeated occurrences, fenced/inline code, and escapes.
- [x] Implement `parseWikilinkOccurrences(content): WikilinkOccurrence[]` with exact offsets and source text.
- [x] Run focused tests/build and commit `feat: parse unresolved wikilink occurrences`.

### Task 2: Candidate resolution and grouped planning

**Files:** Create `src/unresolved-links/unresolved-link-resolver.ts`, `src/unresolved-links/unresolved-link-planner.ts`, tests.

- [x] Write RED tests for metadata-confirmed unresolved targets, current-vault exclusion, unavailable vaults, exact paths, basenames, ambiguity, duplicate destination basenames, and both MVN formats.
- [x] Implement `resolveExternalCandidates`, `buildUnresolvedLinkPlan`, grouped proposals, and exact `TextEdit` generation using existing syntax/link helpers.
- [x] Run focused tests/build and commit `feat: plan unresolved cross-vault links`.

### Task 3: Transaction and incremental refresh

**Files:** Create `src/unresolved-links/unresolved-link-transaction.ts`, tests.

- [x] Write RED tests for selected groups, stale notes, successful multi-note edits, write failure rollback, and rollback failure reporting.
- [x] Implement injected read/write transaction boundaries and return changed paths/counts.
- [x] Map changed paths to existing index upsert mutations after success.
- [x] Run focused/full tests/build and commit `feat: apply unresolved link conversions safely`.

### Task 4: Dashboard view and command

**Files:** Create `src/unresolved-links/unresolved-links-view-model.ts`, `src/views/unresolved-links-view.ts`, `src/unresolved-links/unresolved-links-command.ts`; modify `src/main.ts`, `styles.css`, mocks and tests.

- [x] Write RED view-model/command tests for grouping, default selection, candidate choice, select-all-unambiguous, clear, rescan, and execution summary.
- [x] Implement a workspace view with responsive rows, candidate dropdowns, expandable affected notes, controls, loading/empty/error states, and keyboard-accessible native controls.
- [x] Register `Find unresolved links in other vaults` and activate/reveal the view.
- [x] Run focused/full tests/build and commit `feat: add unresolved link dashboard`.

### Task 5: E2E and deployment

**Files:** Create `tests/unresolved-links.e2e.test.ts`; modify `README.md`.

- [x] Write E2E fixture with repeated links/embeds, unique and ambiguous external candidates, missing targets, and unchanged target vaults.
- [x] Verify selected exact conversions, no creation, untouched unselected links, incremental refresh, and empty second scan.
- [x] Document command and safety behavior.
- [x] Run `npm test && npm run build && git diff --check`.
- [x] Review full diff, fix critical/important findings, rerun verification, commit documentation/tests.
- [x] Push the feature branch, build from the worktree, deploy matching assets to all four vaults, and report checksums while leaving the worktree unmerged.
