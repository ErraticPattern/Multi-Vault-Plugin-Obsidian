# Virtual Linker Multi-Vault Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Virtual Linker with optional Multi-Vault targets, synchronized provenance styling, duplicate-safe opening, and reviewed current-note conversion while preserving local-only behavior.

**Architecture:** Refactor matching around a generic target identity with separate local and optional Multi-Vault adapters. Discover API v1 structurally at runtime and isolate it behind one adapter. Keep decoration and source conversion on one matching service, with a pure protected-range scanner and one atomic editor transaction.

**Tech Stack:** TypeScript, Obsidian Plugin API, CodeMirror 6, DOM/CSS, Vitest, jsdom, existing interval tree trie.

## Global Constraints

- Virtual Linker must remain fully usable without Multi-Vault Navigator.
- Neither repository imports the other's source or package.
- External integration defaults off in Multi-Vault shared settings.
- External targets are opt-in per source vault.
- Canonical target identity is `{ vaultId, relativePath }`; basename is never identity.
- Ambiguous main decorations remain neutral and never open the first candidate silently.
- Color modes are off, muted text, colored underline, and soft pill; intensity defaults to 55 percent.
- Current-note conversion defaults to the first occurrence per grouped term and uses one choice per ambiguous group.
- Conversion excludes frontmatter, code, existing links, embeds, and HTML.
- Missing/incompatible/unloaded provider removes external behavior without stopping local matching.
- No network, Dataview, Omnisearch, or QuickAdd dependency.
- Combined tests use disposable fixtures and never production vaults.

---

### Task 1: Add Test Harness and Freeze Local Behavior

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `tests/mocks/obsidian.ts`
- Create: `tests/local-linker-regression.test.ts`

**Interfaces:**
- Produces: `npm test` using Vitest with an Obsidian mock
- Produces: baseline assertions for local title/alias matching and rendering

- [ ] **Step 1: Add test dependencies and script**

Add compatible pinned development dependencies for Vitest and jsdom, plus:

```json
"scripts": {
  "test": "vitest run",
  "build": "tsc -noEmit -skipLibCheck && node esbuild.config.mjs production"
}
```

Configure the `obsidian` alias to `tests/mocks/obsidian.ts` and default test environment to Node; individual DOM tests use `// @vitest-environment jsdom`.

- [ ] **Step 2: Write baseline local-only tests**

Mock `TFile`, metadata aliases, and vault files. Assert the current trie matches a title and alias, excludes the active note, preserves case rules, suppresses overlaps, and renders an internal path:

```ts
const tree = new PrefixTree(app, settings);
tree.resetSearch();
const matches: MatchNode[] = [];
for (const [index, char] of [...'Read about ZeroTier today.'].entries()) {
  tree.pushChar(char);
  matches.push(...tree.getCurrentMatchNodes(index + 1, activeFile));
}
expect(matches.flatMap(match => [...match.files]).map(file => file.path))
  .toContain('Notes/ZeroTier.md');
```

Reset `LinkerCache.instance` between tests so fixtures cannot leak indexed files.

- [ ] **Step 3: Run test and verify baseline GREEN**

```bash
npm ci
npm test -- tests/local-linker-regression.test.ts
npm run build
```

Expected: baseline tests and existing production build pass before refactoring.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts tests
git commit -m "test: add virtual linker regression harness"
```

### Task 2: Refactor Trie and Matches to Generic Targets

**Files:**
- Create: `linker/linkTarget.ts`
- Modify: `linker/linkerCache.ts`
- Modify: `linker/virtualLinkDom.ts`
- Modify: `linker/liveLinker.ts`
- Modify: `linker/readModeLinker.ts`
- Modify: `main.ts`
- Create: `tests/link-target.test.ts`
- Modify: `tests/local-linker-regression.test.ts`

**Interfaces:**
- Produces: `LinkTarget`, `LocalLinkTarget`, `ExternalLinkTarget`, `targetKey()`
- Changes: `PrefixNode.files` and `MatchNode.files` to `targets: Map<string, LinkTarget>`
- Changes: `VirtualMatch.files` to `targets: LinkTarget[]`

- [ ] **Step 1: Write failing target-abstraction tests**

Define expected local and external values:

```ts
const local: LocalLinkTarget = {
  kind: 'local', key: 'local:Notes/EEG.md', title: 'EEG', aliases: [],
  relativePath: 'Notes/EEG.md', file,
};
const external: ExternalLinkTarget = {
  kind: 'external', key: 'medicine:Notes/EEG.md', title: 'EEG', aliases: ['Electroencephalography'],
  relativePath: 'Notes/EEG.md', vaultId: 'medicine', vaultName: 'medicine', color: '#ac20df',
};
expect(targetKey(external)).toBe('medicine:Notes/EEG.md');
```

Assert duplicate objects with the same key collapse, while same basenames with different vault/path keys remain distinct.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npm test -- tests/link-target.test.ts tests/local-linker-regression.test.ts
```

Expected: missing target module and old `TFile` collection shape.

- [ ] **Step 3: Define exact target union**

```ts
interface LinkTargetBase {
  key: string;
  title: string;
  aliases: string[];
  relativePath: string;
  vaultId?: string;
  vaultName?: string;
  color?: string;
}
export interface LocalLinkTarget extends LinkTargetBase {
  kind: 'local';
  file: TFile;
}
export interface ExternalLinkTarget extends LinkTargetBase {
  kind: 'external';
  vaultId: string;
  vaultName: string;
  color?: string;
}
export type LinkTarget = LocalLinkTarget | ExternalLinkTarget;
```

Add adapter helpers from local `TFile` and metadata. Do not add Multi-Vault runtime discovery in this task.

- [ ] **Step 4: Refactor trie storage without behavior changes**

Replace `Set<TFile>` with key-deduplicated targets. Preserve local indexing timestamps by local file path. Update own-note and already-linked filters to compare target keys. Keep existing sorting, case, folder, tag, alias, word-boundary, and overlap logic.

Update `VirtualMatch` to expose `targets`. For this task, DOM href for a local target remains `target.file.path`; external rendering branches throw a bounded `Unsupported external target` error until Task 4.

- [ ] **Step 5: Run focused and full tests**

```bash
npm test
npm run build
```

Expected: all baseline behavior remains green and production build succeeds.

- [ ] **Step 6: Commit**

```bash
git add linker main.ts tests
git commit -m "refactor: match generic link targets"
```

### Task 3: Add Optional Multi-Vault API Adapter

**Files:**
- Create: `integration/multiVaultApi.ts`
- Create: `integration/multiVaultTargetAdapter.ts`
- Modify: `linker/linkerCache.ts`
- Create: `tests/multi-vault-adapter.test.ts`

**Interfaces:**
- Consumes structurally: provider API v1 from the Multi-Vault plan
- Produces: `MultiVaultTargetAdapter.start()`, `getTargets()`, `getCurrentVault()`, `openTarget()`, `formatWikilink()`, `dispose()`
- Produces: local-only state when API is absent or disabled

- [ ] **Step 1: Write failing adapter lifecycle tests**

Use a fake plugin manager and API. Cover absent provider, incompatible `apiVersion`, disabled settings, opt-in targets, late provider load, catalog event, appearance event, unsubscribe, provider unload, and thrown API call.

```ts
expect(adapter.getTargets()).toEqual([]);
plugins.set('multi-vault-navigator', { publicApi: fakeApiV1 });
await adapter.refreshProvider();
expect(adapter.getTargets()[0]).toMatchObject({
  kind: 'external', vaultId: 'medicine', relativePath: 'Notes/ZeroTier.md', color: '#ac20df',
});
```

A provider error must call `onTargetsChanged([])` once and leave local matching untouched.

- [ ] **Step 2: Run focused test and verify RED**

```bash
npm test -- tests/multi-vault-adapter.test.ts
```

Expected: missing adapter failure.

- [ ] **Step 3: Define consumer-side structural API**

Define only required runtime fields, including `apiVersion: 1`, current-vault descriptor, settings, target listing, resolution, formatter, opener, and subscription. Guard every method with `typeof` checks. Access Obsidian's plugin manager through one narrow `PluginManagerLike` interface rather than spreading `any` through the plugin.

- [ ] **Step 4: Implement discovery and event handling**

`start()` probes after layout readiness and on one low-frequency registered interval. Once subscribed, catalog events refresh external targets through one coalesced promise; appearance events update target metadata without rebuilding term membership. Provider loss clears external targets and unsubscribes.

Map API targets to `ExternalLinkTarget` and deduplicate by `${vaultId}:${relativePath}`. Apply `getCurrentVault()` name/color metadata to local targets for provenance styling. Never retain note content.

- [ ] **Step 5: Connect external targets to the trie**

Add adapter target insertion/removal methods to `LinkerCache` or `PrefixTree`. Index each title and alias with existing case rules. Coalesce a full external replacement and preserve local nodes. Ensure two overlapping refreshes share one promise.

- [ ] **Step 6: Run focused and full tests**

```bash
npm test -- tests/multi-vault-adapter.test.ts tests/local-linker-regression.test.ts
npm test
npm run build
```

Expected: adapter and local-only regression tests pass; build succeeds.

- [ ] **Step 7: Commit**

```bash
git add integration linker/linkerCache.ts tests/multi-vault-adapter.test.ts
git commit -m "feat: consume optional multi-vault targets"
```

### Task 4: Implement Duplicate-Safe Interaction and Four Color Modes

**Files:**
- Modify: `linker/virtualLinkDom.ts`
- Modify: `linker/liveLinker.ts`
- Modify: `linker/readModeLinker.ts`
- Create: `modals/linkTargetSuggestModal.ts`
- Modify: `styles.css`
- Create: `tests/virtual-link-interaction.test.ts`
- Create: `tests/virtual-link-styles.test.ts`

**Interfaces:**
- Consumes: Task 3 adapter chooser/opener and shared style settings
- Produces: target-aware DOM attributes and neutral ambiguity behavior

- [ ] **Step 1: Write failing jsdom interaction tests**

Cover unique local, unique external, same-term ambiguity, candidate labels, click routing, keyboard Enter/Space, and provider disappearance. Assert the ambiguous anchor has no vault color variable and never invokes `openTarget` directly.

```ts
expect(unique.style.getPropertyValue('--vl-vault-color')).toBe('#ac20df');
expect(ambiguous.style.getPropertyValue('--vl-vault-color')).toBe('');
ambiguous.dispatchEvent(new MouseEvent('click', { bubbles: true }));
expect(openTargetChooser).toHaveBeenCalledWith(expect.arrayContaining([
  expect.objectContaining({ vaultName: 'ideas' }),
  expect.objectContaining({ vaultName: 'medicine' }),
]));
```

- [ ] **Step 2: Write failing style-mode tests**

For each mode, assert one exact class and intensity variable. `off` sets no provenance class. Invalid colors produce no variable. Clamp intensity to 10 through 90.

- [ ] **Step 3: Run focused tests and verify RED**

```bash
npm test -- tests/virtual-link-interaction.test.ts tests/virtual-link-styles.test.ts
```

Expected: external interaction and mode assertions fail.

- [ ] **Step 4: Render target-aware anchors**

Store target key, kind, vault name, relative path, and source offsets in `dataset`, not custom unnamespaced attributes. Unique external activation calls adapter `openTarget`. Ambiguous activation opens `LinkTargetSuggestModal` with every generic candidate, then routes the selected local target through Obsidian or external target through the adapter. Candidate rows show vault name and full path and expose the same text through accessible labels.

Use one event handler path in live and reading modes. Keep local href behavior for unique local targets.

- [ ] **Step 5: Add exact style classes and CSS**

Use:

```css
.virtual-link-vault-muted-text { color: var(--text-accent); color: color-mix(in srgb, var(--vl-vault-color) var(--vl-vault-intensity), var(--text-normal)); }
.virtual-link-vault-underline { text-decoration-color: var(--vl-vault-color); text-decoration-style: dotted; text-underline-offset: 3px; }
.virtual-link-vault-soft-pill { background: color-mix(in srgb, var(--vl-vault-color) var(--vl-vault-background-intensity), transparent); border-radius: 4px; padding-inline: 0.18em; }
```

Set `--vl-vault-background-intensity` in TypeScript to `${Math.round(intensity * 0.3)}%`, avoiding unsupported CSS percentage arithmetic. Provide theme-variable fallbacks before each `color-mix()` declaration. Preserve visible focus outlines and sufficient hover contrast.

- [ ] **Step 6: Run focused tests and verify GREEN**

```bash
npm test -- tests/virtual-link-interaction.test.ts tests/virtual-link-styles.test.ts
```

Expected: all interaction/style modes pass.

- [ ] **Step 7: Commit**

```bash
git add linker modals/linkTargetSuggestModal.ts styles.css tests/virtual-link-interaction.test.ts tests/virtual-link-styles.test.ts
git commit -m "feat: style vault-aware virtual links"
```

### Task 5: Build DOM-Independent Source Matching

**Files:**
- Create: `conversion/markdownProtectedRanges.ts`
- Create: `conversion/currentNoteMatches.ts`
- Create: `conversion/conversionTypes.ts`
- Create: `tests/markdown-protected-ranges.test.ts`
- Create: `tests/current-note-matches.test.ts`

**Interfaces:**
- Consumes: generic trie matching from Task 2
- Produces: `findProtectedMarkdownRanges(source): TextRange[]`
- Produces: `collectCurrentNoteMatches(source, matcher): ConversionGroup[]`

- [ ] **Step 1: Write failing protected-range table tests**

Use complete source strings covering YAML only at file start, backtick fences with variable fence lengths, inline code, wikilinks, embeds, Markdown links/images, autolinks, HTML tags/blocks, escaped delimiters, and ordinary prose adjacent to each protected range. Assert exact `[from, to)` offsets and that prose remains matchable.

- [ ] **Step 2: Write failing grouping tests**

Given repeated `EEG` and ambiguous `README`, assert groups normalize terms without losing original casing, include all exact offsets, default only the first occurrence to selected, and retain candidate identities:

```ts
expect(groups.find(group => group.normalizedTerm === 'eeg')?.occurrences)
  .toMatchObject([{ selected: true }, { selected: false }, { selected: false }]);
```

- [ ] **Step 3: Run focused tests and verify RED**

```bash
npm test -- tests/markdown-protected-ranges.test.ts tests/current-note-matches.test.ts
```

Expected: module-not-found failures.

- [ ] **Step 4: Implement offset-safe protected scanner**

Scan once left-to-right, recognizing frontmatter only at source offset zero, then fenced blocks, HTML, inline code, embeds/wikilinks, and Markdown links/images. Represent ranges as sorted non-overlapping half-open intervals and use the existing interval tree to reject trie matches intersecting them. Respect backslash escaping and matching fence/backtick length.

- [ ] **Step 5: Implement source grouping**

Run the same trie matcher used by decoration against source text, filter protected/overlapping ranges, group by normalized matched term, sort groups by first offset, sort candidates by vault name/path, and mark only occurrence index zero selected. Do not read any note content beyond the active source string.

- [ ] **Step 6: Run focused tests and verify GREEN**

```bash
npm test -- tests/markdown-protected-ranges.test.ts tests/current-note-matches.test.ts
```

Expected: all range and grouping tests pass.

- [ ] **Step 7: Commit**

```bash
git add conversion tests/markdown-protected-ranges.test.ts tests/current-note-matches.test.ts
git commit -m "feat: match virtual links from source text"
```

### Task 6: Add Grouped Review and Atomic Current-Note Conversion

**Files:**
- Create: `conversion/buildReplacements.ts`
- Create: `modals/currentNoteConversionModal.ts`
- Modify: `modals/linkTargetSuggestModal.ts`
- Modify: `main.ts`
- Create: `tests/current-note-conversion.test.ts`

**Interfaces:**
- Consumes: Task 5 groups and Task 3 formatter/chooser
- Produces command: `review-convert-current-note-virtual-links`
- Produces: `buildConversionReplacements(groups, sourcePath, formatter): Replacement[]`

- [ ] **Step 1: Write failing replacement tests**

Cover local shortest link, local alias, external canonical link, path-qualified duplicate, explicit root duplicate, original matched-case alias, descending offset application, and stale source rejection.

```ts
expect(replacements).toContainEqual({
  from: 10, to: 18, replacement: '[[medicine::Notes/ZeroTier|ZeroTier]]',
});
```

Assert all replacements apply through one editor transaction and one ambiguous group invokes target selection once regardless of occurrence count.

- [ ] **Step 2: Run focused test and verify RED**

```bash
npm test -- tests/current-note-conversion.test.ts
```

Expected: missing builder/modal failure.

- [ ] **Step 3: Implement replacement builder**

For local targets, use Obsidian `metadataCache.fileToLinktext` and preserve the matched term as alias when it differs. For external targets, call API `formatWikilink(identity, matchedText)`. Sort selected occurrences descending by `from` and reject overlaps.

Capture source text and target-catalog revision when opening review. Before applying, compare current editor text and adapter revision; throw `StaleConversionReviewError` on mismatch.

- [ ] **Step 4: Implement grouped review modal**

Show each term, occurrence count, selected count, target vault/path, and exact replacement preview. Provide controls for first only, all, none, and individual occurrences. Ambiguous groups open one searchable target modal and reuse that choice for every selected occurrence in the group.

Confirm calls one CodeMirror/editor transaction containing every change. It does not loop through `replaceRange` calls that create separate undo entries.

- [ ] **Step 5: Register command**

Enable command only for an active Markdown editor with at least one unprotected match. If integration is unavailable, local matches still work. If no matches exist, show a concise Notice.

Leave existing selected-rendered-link conversion unchanged.

- [ ] **Step 6: Run focused and full tests**

```bash
npm test -- tests/current-note-conversion.test.ts tests/current-note-matches.test.ts
npm test
npm run build
```

Expected: conversion and all local regressions pass; build succeeds.

- [ ] **Step 7: Commit**

```bash
git add conversion modals main.ts tests/current-note-conversion.test.ts
git commit -m "feat: review current-note link conversion"
```

### Task 7: Lifecycle, Status UI, and Combined Verification

**Files:**
- Modify: `main.ts`
- Modify: `README.md`
- Create: `tests/integration-lifecycle.test.ts`
- Create: `tests/large-catalog-performance.test.ts`
- Modify in provider repository if contract mismatch is found: `tests/public-api.test.ts` only after adding a failing provider contract test

**Interfaces:**
- Consumes: all prior tasks and Multi-Vault API v1
- Produces: production-ready independent and combined builds

- [ ] **Step 1: Add failing lifecycle tests**

Simulate provider absent at startup, appearing after layout readiness, disabling integration, changing appearance, changing catalog, throwing, and unloading. Assert subscriptions are released, external nodes disappear, local nodes remain, and repeated failures log only once per state transition.

- [ ] **Step 2: Add large-catalog benchmark test**

Generate 28,000 external targets with 464 duplicate-basename groups and representative aliases. Assert initialization is chunked so no synchronous chunk exceeds 100 ms, overlapping refreshes coalesce, appearance-only events avoid trie rebuild, and chooser opening reads no note contents.

- [ ] **Step 3: Run lifecycle/performance tests and verify RED if budgets are unmet**

```bash
npm test -- tests/integration-lifecycle.test.ts tests/large-catalog-performance.test.ts
```

Expected before final scheduling: at least one lifecycle or chunking assertion fails. Record actual timing in test output.

- [ ] **Step 4: Complete lifecycle registration and scheduling**

Register adapter start after `workspace.onLayoutReady`, all intervals through plugin cleanup helpers, and adapter disposal in `onunload`. Chunk external insertion with bounded batches and yield using `window.setTimeout(..., 0)` or `requestIdleCallback` with a timeout fallback. Coalesce refresh requests behind one promise.

- [ ] **Step 5: Document independent and integrated behavior**

Update README with optional dependency behavior, enablement location, opt-in vault scope, duplicate chooser, four style modes, intensity, local-only fallback, reviewed conversion, command name, and canonical external link examples.

- [ ] **Step 6: Run both repositories independently**

Virtual Linker:

```bash
npm ci
npm audit
npm test
npm run build
git diff --check
```

Multi-Vault Navigator provider:

```bash
npm ci
npm audit
npm test
MVN_SKIP_DEPLOY=1 npm run build
git diff --check
```

Expected: both independent suites/builds pass and both audits report zero vulnerabilities.

- [ ] **Step 7: Run disposable combined smoke test**

Load both built plugins in disposable vault fixtures. Verify one local match, one unique external alias, one ambiguous cross-vault name, every color mode in dark/light themes, provider disable fallback, and reviewed external conversion. Do not copy builds into production vaults.

- [ ] **Step 8: Commit**

```bash
git add main.ts README.md tests/integration-lifecycle.test.ts tests/large-catalog-performance.test.ts
git commit -m "test: verify multi-vault linker integration"
```

### Task 8: Review and Release Gate

**Files:**
- Review only: Virtual Linker integration and provider contract changes

**Interfaces:**
- Produces: two verified branches ready for user-selected version/deployment actions

- [ ] **Step 1: Request separate and combined code reviews**

Review local-regression risk, optional API isolation, duplicate handling, DOM/source offset correctness, Markdown exclusions, accessibility, color fallbacks, event cleanup, stale conversion protection, and large-catalog scheduling.

- [ ] **Step 2: Fix accepted findings through red-green tests**

Add one failing test per accepted finding in the owning repository, observe failure, implement the smallest correction, rerun both affected suites, and commit with an exact `fix:` subject.

- [ ] **Step 3: Run final fresh verification in both repositories**

Repeat clean install, audit, full test, build, diff check, and status check. Confirm no production plugin asset hash or production vault configuration changed during development.

- [ ] **Step 4: Stop at release gate**

Do not version, merge, deploy, activate shared settings, tag, or push either plugin until the user explicitly selects those actions.
