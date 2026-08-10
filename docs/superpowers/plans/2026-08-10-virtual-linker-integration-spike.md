# Virtual Linker Cross-Vault Integration Spike Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that Virtual Linker can consume a safe Multi-Vault Navigator catalog, retain canonical duplicate identities, render and open opted-in external matches, and remain responsive before committing to whole-note conversion implementation.

**Architecture:** Multi-Vault Navigator publishes an immutable version-1 API through a global symbol. Virtual Linker replaces `TFile`-only trie identities with provider-owned local or external targets and optionally consumes that API. The spike ends with measured GO or NO-GO criteria; it does not modify production vaults or implement whole-note conversion.

**Tech Stack:** TypeScript, Obsidian plugin API, CodeMirror 6, Vitest, esbuild, Yarn 1

## Global Constraints

- Complete the Multi-Vault performance and canonical identity plan first.
- External target vaults are opt-in and disabled by default in every source vault.
- Virtual Linker must work normally when Multi-Vault Navigator is absent, disabled, or API-incompatible.
- Canonical identity is vault ID plus normalized relative path; duplicate basenames must never collapse.
- Ambiguous matches must open a searchable chooser labeled with vault and full relative path.
- Multi-Vault Navigator owns external opening and `[[vault::path|label]]` formatting.
- Do not use Obsidian private plugin-manager fields or another plugin's persisted index.
- Do not depend on Dataview, Omnisearch, or QuickAdd.
- Transfer 30,000 immutable external records in under 100 ms.
- Build the external trie for 30,000 records in under 2 s on the development machine.
- Keep 95th-percentile decoration time below 50 ms for a 10,000-character visible range with external matching enabled.
- Do not create disposable UI vaults until explicit approval.
- Do not deploy or release either plugin during the spike.

---

## Repository and File Structure

### Multi-Vault Navigator repository

Root: `C:\Users\joaop\git\ErraticPattern\Multi-Vault-Plugin-Obsidian`

Create:

- `src/api/virtual-link-api.ts`: public API types and implementation.
- `src/api/api-registry.ts`: versioned global-symbol publication lifecycle.
- `tests/virtual-link-api.test.ts`: immutable catalog, aliases, formatting, resolution, events, and cleanup.

Modify:

- `src/main.ts`: create and publish API after index initialization; unregister on unload.
- `src/indexer/indexer.ts`: expose catalog-change subscription after committed index updates.
- `src/types.ts`: no API-specific fields; retain index model as the source record.

### Virtual Linker repository

Root: `C:\Users\joaop\git\ErraticPattern\obsidian-virtual-linker`

Create:

- `vitest.config.ts`: Node test configuration and Obsidian alias.
- `tests/mocks/obsidian.ts`: minimal `TFile`, metadata, workspace, modal, and setting mocks.
- `tests/link-targets.test.ts`: local/external identity and duplicate preservation.
- `tests/multi-vault-provider.test.ts`: API discovery, opt-in filtering, events, and fallback.
- `tests/external-virtual-links.test.ts`: chooser and provider-owned opening behavior.
- `tests/integration-performance.test.ts`: 30,000-record catalog and trie benchmark harness.
- `integration/multiVaultApi.ts`: structural version-1 contract and symbol key.
- `linker/linkTarget.ts`: generic local/external target union and identity helpers.
- `linker/providers/localVaultProvider.ts`: current-vault target adapter.
- `linker/providers/multiVaultProvider.ts`: optional API adapter.
- `modals/virtual-target-suggest-modal.ts`: ambiguity chooser.

Modify:

- `package.json`, `yarn.lock`: add test tooling and scripts.
- `tsconfig.json`: include test-compatible modern library types without lowering production strictness.
- `main.ts`: provider lifecycle, opt-in settings, and external click routing.
- `linker/linkerCache.ts`: store generic targets rather than only `TFile`.
- `linker/liveLinker.ts`: operate on generic matches.
- `linker/readModeLinker.ts`: operate on generic matches.
- `linker/virtualLinkDom.ts`: target IDs, vault badges, and ambiguity metadata.
- `styles.css`: external vault badge and chooser styles.

### Spike report

Create in Multi-Vault Navigator:

- `docs/superpowers/specs/2026-08-10-cross-vault-virtual-linking-spike-results.md`

---

### Task 1: Add a Test Foundation to Virtual Linker

**Repository:** Virtual Linker

**Files:**
- Modify: `package.json`
- Modify: `yarn.lock`
- Modify: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `tests/mocks/obsidian.ts`
- Create: `tests/link-targets.test.ts`

**Interfaces:**
- Produces: `yarn test` and `yarn test:watch`.
- Produces: reusable Obsidian mocks for later tasks.

- [ ] **Step 1: Add test scripts and Vitest**

Update `package.json` scripts and development dependencies:

```json
{
  "scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "tsc -noEmit -skipLibCheck && node esbuild.config.mjs production",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "vitest": "^3.2.4"
  }
}
```

Retain every existing dependency and script not shown. Run `yarn install` so `yarn.lock`, not `package-lock.json`, records the change.

- [ ] **Step 2: Add the Vitest configuration**

```ts
import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  test: { environment: 'node' },
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL('./tests/mocks/obsidian.ts', import.meta.url)),
      main: fileURLToPath(new URL('./main.ts', import.meta.url)),
    },
  },
});
```

- [ ] **Step 3: Add minimal Obsidian mocks**

Implement `TFile` with `path`, `name`, `basename`, `extension`, `stat`, and `parent`. Export no-op `App`, `Modal`, `FuzzySuggestModal`, `Setting`, `Notice`, `MarkdownRenderChild`, and `Plugin` classes only as tests require them. Avoid reproducing unrelated Obsidian behavior.

- [ ] **Step 4: Write the first failing identity test**

```ts
import { describe, expect, it } from 'vitest';
import { externalTarget, localTarget } from '../linker/linkTarget';

it('keeps same-basename targets distinct by provider and canonical path', () => {
  const targets = [
    localTarget('README.md', 'README'),
    localTarget('Lab/README.md', 'README'),
    externalTarget({
      id: 'medicine:Notes/README.md', vaultId: 'medicine', vaultName: 'medicine',
      relativePath: 'Notes/README.md', basename: 'README', aliases: [],
    }),
  ];
  expect(new Set(targets.map((target) => target.id)).size).toBe(3);
});
```

- [ ] **Step 5: Run the test and verify red**

Run: `yarn test tests/link-targets.test.ts`

Expected: FAIL because `linker/linkTarget.ts` does not exist.

- [ ] **Step 6: Add only the identity constructors needed for green**

```ts
import type { TFile } from 'obsidian';

export interface ExternalTargetRecord {
  id: string;
  vaultId: string;
  vaultName: string;
  relativePath: string;
  basename: string;
  aliases: string[];
  color?: string;
}

export type LinkTarget =
  | { kind: 'local'; id: string; title: string; aliases: string[]; file: TFile }
  | ({ kind: 'external'; title: string } & ExternalTargetRecord);

export const localTarget = (path: string, basename: string, file?: TFile): LinkTarget => ({
  kind: 'local', id: `local:${path}`, title: basename, aliases: [], file: file ?? ({ path, basename } as TFile),
});

export const externalTarget = (record: ExternalTargetRecord): LinkTarget => ({
  kind: 'external', title: record.basename, ...record,
});
```

- [ ] **Step 7: Run test and build**

Run: `yarn test tests/link-targets.test.ts && yarn build`

Expected: test PASS and existing production build succeeds.

- [ ] **Step 8: Commit**

```bash
git add package.json yarn.lock tsconfig.json vitest.config.ts tests/mocks/obsidian.ts tests/link-targets.test.ts linker/linkTarget.ts
git commit -m "test: add virtual linker test foundation"
```

---

### Task 2: Publish the Multi-Vault Navigator API Contract

**Repository:** Multi-Vault Navigator

**Files:**
- Create: `src/api/virtual-link-api.ts`
- Create: `src/api/api-registry.ts`
- Create: `tests/virtual-link-api.test.ts`
- Modify: `src/main.ts`
- Modify: `src/indexer/indexer.ts`

**Interfaces:**
- Produces: `MULTI_VAULT_API_V1 = Symbol.for('multi-vault-navigator.api.v1')`.
- Produces: `MultiVaultNavigatorApiV1` exactly as approved in the design, including `listVaults()` for opt-in settings.
- Consumes: `resolveIndexedNote()` and canonical formatting from the completed Multi-Vault plan.

- [ ] **Step 1: Write API contract tests**

```ts
it('returns frozen opted-in targets with normalized aliases', () => {
  const api = createVirtualLinkApi(indexerFixture([
    indexed('medicine', 'Notes/AF.md', 'AF', { aliases: ['Atrial fibrillation', 'AFib'] }),
    indexed('ideas', 'Notes/EEG.md', 'EEG'),
  ]), registryFixture());

  const result = api.listVirtualTargets(['medicine']);
  expect(result).toEqual([expect.objectContaining({
    id: 'medicine:Notes/AF.md', aliases: ['Atrial fibrillation', 'AFib'],
  })]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result[0])).toBe(true);
});

it('publishes and removes only the object it owns', () => {
  const api = apiFixture();
  const dispose = publishVirtualLinkApi(api);
  expect(readVirtualLinkApi()).toBe(api);
  dispose();
  expect(readVirtualLinkApi()).toBeUndefined();
});
```

Also test `listVaults()` with `isCurrent` and optional colors, string aliases, absent aliases, duplicate path resolution, path-qualified formatting, catalog events after successful commits, and no event after failed commits.

- [ ] **Step 2: Run the API tests and verify red**

Run: `npm test -- tests/virtual-link-api.test.ts`

Expected: FAIL because API files do not exist.

- [ ] **Step 3: Implement the global registry lifecycle**

```ts
export const MULTI_VAULT_API_V1 = Symbol.for('multi-vault-navigator.api.v1');
type ApiHost = Record<PropertyKey, unknown>;

export function publishVirtualLinkApi(api: MultiVaultNavigatorApiV1): () => void {
  const host = globalThis as ApiHost;
  host[MULTI_VAULT_API_V1] = api;
  return () => {
    if (host[MULTI_VAULT_API_V1] === api) delete host[MULTI_VAULT_API_V1];
  };
}
```

Tests must prove that disposal does not delete a newer replacement object.

- [ ] **Step 4: Implement immutable catalog records**

`listVaults()` returns frozen `{ id, name, color, isCurrent }` records. Normalize aliases from `frontmatter.aliases` as string or string array, trim them, remove blanks, and deduplicate case-insensitively. `listVirtualTargets()` filters by vault ID before mapping, includes the optional vault color on targets, and freezes both records and result arrays.

- [ ] **Step 5: Implement provider-owned resolution, formatting, and opening**

Use canonical resolver results. `formatWikilink(targetId, label)` obtains the target by exact ID, asks existing path-disambiguation logic for basename versus path, and returns a literal wikilink. `openTarget(targetId)` delegates to `FileOpener` with the exact indexed record.

- [ ] **Step 6: Emit catalog events only after committed index state**

Add `Indexer.onCatalogChanged(callback): () => void`. Call listeners after successful `initialize`, incremental refresh, full rebuild, and mutation persistence. Do not emit before `IndexStore.saveIndex()` resolves.

- [ ] **Step 7: Publish after initialization and unregister on unload**

In `src/main.ts`, create the API after `indexer.initialize()`. Register the disposer with the plugin lifecycle so unloading removes exactly the published version-1 object.

- [ ] **Step 8: Add a 30,000-record transfer benchmark test**

Generate records in memory, call `listVirtualTargets()`, verify exact count and frozen identities. Record elapsed time for the spike report, but keep the CI assertion limited to correctness to avoid machine-dependent flakes.

- [ ] **Step 9: Run tests and build**

Run: `npm test -- tests/virtual-link-api.test.ts && npm test && MVN_SKIP_DEPLOY=1 npm run build && git diff --check`

Expected: all tests PASS and production build succeeds.

- [ ] **Step 10: Commit**

```bash
git add src/api/virtual-link-api.ts src/api/api-registry.ts src/indexer/indexer.ts src/main.ts tests/virtual-link-api.test.ts
git commit -m "feat: expose cross-vault target API"
```

---

### Task 3: Refactor Virtual Linker's Trie to Generic Targets

**Repository:** Virtual Linker

**Files:**
- Modify: `linker/linkTarget.ts`
- Create: `linker/providers/localVaultProvider.ts`
- Modify: `linker/linkerCache.ts`
- Modify: `linker/virtualLinkDom.ts`
- Modify: `linker/liveLinker.ts`
- Modify: `linker/readModeLinker.ts`
- Modify: `tests/link-targets.test.ts`

**Interfaces:**
- Produces: `LinkTargetProvider.listTargets(): readonly LinkTarget[]`.
- Produces: trie `PrefixNode.targets: Map<string, LinkTarget>` keyed by canonical ID.
- Preserves: all existing local title, alias, case, overlap, self-link, and only-once behavior.

- [ ] **Step 1: Extend tests for local aliases and duplicate IDs**

```ts
it('returns every same-name target without object-identity collapse', () => {
  const tree = treeWithTargets([
    localTarget('README.md', 'README'),
    localTarget('Lab/README.md', 'README'),
  ]);
  expect(match(tree, 'README').map((target) => target.id).sort()).toEqual([
    'local:Lab/README.md', 'local:README.md',
  ]);
});
```

Copy current matching cases into tests before refactoring: aliases, case sensitivity, longest overlap, self-link exclusion, and only-link-once.

- [ ] **Step 2: Run tests and verify the new generic cases fail**

Run: `yarn test tests/link-targets.test.ts`

Expected: new trie helpers or target storage assertions FAIL.

- [ ] **Step 3: Define the provider and target identity contract**

```ts
export interface LinkTargetProvider {
  readonly id: string;
  listTargets(): readonly LinkTarget[];
  open(target: LinkTarget): Promise<void>;
}

export const targetKey = (target: LinkTarget) => target.id;
```

`LocalVaultProvider` maps included `TFile` records and normalized aliases from metadata. Local `id` is `local:${file.path}`.

- [ ] **Step 4: Replace trie file sets with ID-keyed targets**

Change `PrefixNode.files: Set<TFile>` to `targets: Map<string, LinkTarget>`. Change `MatchNode.files` to `targets`. Replace comparisons based on object identity with `target.id`. Keep local mtime tracking in `LocalVaultProvider`, not in generic target matching.

- [ ] **Step 5: Adapt local cache updates without changing behavior**

The cache continues responding to active-file and settings changes. It asks `LocalVaultProvider` for changed local records and removes prior leaf-node entries by canonical ID. No external provider is added in this task.

- [ ] **Step 6: Adapt matches and rendering to generic targets**

Rename `VirtualMatch.files` to `targets`. Self-link checks compare local target file paths. Existing local anchors still use the local file path. Multiple-reference indicators retain every candidate.

- [ ] **Step 7: Run regression tests and build**

Run: `yarn test && yarn build`

Expected: all new tests PASS and the plugin builds with local-only behavior preserved.

- [ ] **Step 8: Commit**

```bash
git add linker/linkTarget.ts linker/providers/localVaultProvider.ts linker/linkerCache.ts linker/virtualLinkDom.ts linker/liveLinker.ts linker/readModeLinker.ts tests/link-targets.test.ts
git commit -m "refactor: generalize virtual link targets"
```

---

### Task 4: Add the Optional Multi-Vault Provider

**Repository:** Virtual Linker

**Files:**
- Create: `integration/multiVaultApi.ts`
- Create: `linker/providers/multiVaultProvider.ts`
- Create: `tests/multi-vault-provider.test.ts`
- Modify: `main.ts`
- Modify: `linker/linkerCache.ts`

**Interfaces:**
- Produces: `readMultiVaultApi(): MultiVaultNavigatorApiV1 | null`.
- Produces: `MultiVaultProvider` implementing `LinkTargetProvider`.
- Adds setting: `externalVaultIds: string[]`, default `[]`.

- [ ] **Step 1: Copy the structural contract and write fallback tests**

The contract file defines the approved version-1 methods and the exact symbol key. Tests cover:

```ts
it('returns no external targets when the API is absent', () => {
  expect(new MultiVaultProvider([], undefined).listTargets()).toEqual([]);
});

it('rejects an incompatible API version', () => {
  setRegistryValue({ version: 2 });
  expect(readMultiVaultApi()).toBeNull();
});

it('requests only opted-in vault IDs', () => {
  const api = apiSpy();
  new MultiVaultProvider(['medicine'], api).listTargets();
  expect(api.listVirtualTargets).toHaveBeenCalledWith(['medicine']);
});
```

- [ ] **Step 2: Run focused tests and verify red**

Run: `yarn test tests/multi-vault-provider.test.ts`

Expected: FAIL because provider and contract files do not exist.

- [ ] **Step 3: Implement safe API discovery**

Read `globalThis[Symbol.for('multi-vault-navigator.api.v1')]`, require an object with `version === 1` and every required function, and otherwise return `null`. Do not access `app.plugins`, plugin internals, or cache files.

- [ ] **Step 4: Map immutable external records into generic targets**

`MultiVaultProvider.listTargets()` calls `listVirtualTargets(externalVaultIds)` and maps each record to `externalTarget(record)`. Preserve exact IDs, paths, aliases, and vault names.

- [ ] **Step 5: Add settings with no targets enabled by default**

Add `externalVaultIds: []` to defaults. When a compatible API exists, render an **External vaults** settings section with one toggle per non-current vault. Persist selected IDs through existing `updateSettings()`.

- [ ] **Step 6: Subscribe and rebuild only the external trie portion**

Subscribe through `onCatalogChanged()`. Debounce updates by 100 ms and coalesce repeated notifications. Unsubscribe on plugin unload. Local trie update behavior remains independent.

- [ ] **Step 7: Run tests and build**

Run: `yarn test tests/multi-vault-provider.test.ts tests/link-targets.test.ts && yarn test && yarn build`

Expected: all tests PASS; local-only behavior works with no registry API.

- [ ] **Step 8: Commit**

```bash
git add integration/multiVaultApi.ts linker/providers/multiVaultProvider.ts linker/linkerCache.ts main.ts tests/multi-vault-provider.test.ts
git commit -m "feat: consume optional multi-vault catalog"
```

---

### Task 5: Render, Disambiguate, and Open External Matches

**Repository:** Virtual Linker

**Files:**
- Create: `modals/virtual-target-suggest-modal.ts`
- Create: `tests/external-virtual-links.test.ts`
- Modify: `linker/virtualLinkDom.ts`
- Modify: `linker/liveLinker.ts`
- Modify: `linker/readModeLinker.ts`
- Modify: `main.ts`
- Modify: `styles.css`

**Interfaces:**
- Produces: one click route for local and external `LinkTarget` records.
- Produces: ambiguity chooser callback returning one canonical target.
- Consumes: `MultiVaultNavigatorApiV1.openTarget()` for external targets.

- [ ] **Step 1: Write click-routing tests**

```ts
it('opens one external target through Multi-Vault Navigator', async () => {
  const api = apiSpy();
  await openVirtualTargets([externalTarget(record('medicine', 'Notes/AF.md'))], api, chooseSpy);
  expect(api.openTarget).toHaveBeenCalledWith('medicine:Notes/AF.md');
  expect(chooseSpy).not.toHaveBeenCalled();
});

it('shows every duplicate candidate instead of opening the first', async () => {
  const targets = [
    externalTarget(record('ideas', 'README.md')),
    externalTarget(record('ideas', 'Lab/README.md')),
  ];
  await openVirtualTargets(targets, apiSpy(), chooseSpy);
  expect(chooseSpy).toHaveBeenCalledWith(targets);
});
```

Also test mixed local/external candidates sorted local first and full-path labels.

- [ ] **Step 2: Run focused tests and verify red**

Run: `yarn test tests/external-virtual-links.test.ts`

Expected: FAIL because routing and chooser do not exist.

- [ ] **Step 3: Implement the chooser**

`VirtualTargetSuggestModal` item text includes provider kind, vault name, and relative path. Render the title on the first row and `${vaultName} · ${relativePath}` on the second. Return the exact target object.

- [ ] **Step 4: Implement provider-owned opening**

One local target opens through normal Obsidian link handling. One external target calls `api.openTarget(target.id)`. Multiple targets always open the chooser, then route the selected target by kind.

- [ ] **Step 5: Render target identity without unsafe external hrefs**

Virtual anchors carry `data-virtual-target-ids` containing JSON-encoded canonical IDs. Local-only single links may keep normal internal hrefs. External or ambiguous links use an event handler rather than pretending the external path exists locally.

- [ ] **Step 6: Add subtle external vault badges**

Display the external vault name after the matched term, using CSS variables supplied by the target record when available. Preserve the existing virtual-link suffix and local appearance.

- [ ] **Step 7: Verify Reading View and Live Preview use the same router**

Both renderers create `VirtualMatch` with identical candidate arrays and delegate click behavior to one routing function. No renderer silently chooses `targets[0]`.

- [ ] **Step 8: Run all Virtual Linker tests and build**

Run: `yarn test && yarn build && git diff --check`

Expected: all tests PASS and production build succeeds.

- [ ] **Step 9: Commit**

```bash
git add modals/virtual-target-suggest-modal.ts linker/virtualLinkDom.ts linker/liveLinker.ts linker/readModeLinker.ts main.ts styles.css tests/external-virtual-links.test.ts
git commit -m "feat: open ambiguous external virtual links"
```

---

### Task 6: Measure the Spike and Produce a GO or NO-GO Report

**Repositories:** Both

**Files:**
- Create: Virtual Linker `tests/integration-performance.test.ts`
- Create: Multi-Vault Navigator `docs/superpowers/specs/2026-08-10-cross-vault-virtual-linking-spike-results.md`

**Interfaces:**
- Produces: measured decision report.
- Does not proceed to whole-note conversion.

- [ ] **Step 1: Add deterministic 30,000-record correctness coverage**

Generate 30,000 records with unique canonical IDs, repeated basenames in different folders, and aliases. Assert catalog transfer count, trie target count, duplicate retention, and exact path resolution.

- [ ] **Step 2: Add a local benchmark mode**

Use `performance.now()` around API catalog mapping, external trie construction, and repeated decoration of a 10,000-character visible range. Print structured JSON:

```ts
console.log(JSON.stringify({
  records: 30000,
  catalogTransferMs,
  trieBuildMs,
  decorationP95Ms,
  duplicateCandidates,
}));
```

Keep CI assertions correctness-based. Apply the 100 ms catalog, 2 s trie, and 50 ms decoration-p95 budgets to the controlled development-machine run recorded in the report.

- [ ] **Step 3: Run complete automated verification in both repositories**

Multi-Vault Navigator:

```bash
npm ci
npm audit
npm test
MVN_SKIP_DEPLOY=1 npm run build
git diff --check
```

Virtual Linker:

```bash
yarn install --frozen-lockfile
yarn test
yarn build
git diff --check
```

Expected: all tests and builds PASS; Multi-Vault reports zero npm vulnerabilities.

- [ ] **Step 4: Request approval for the disposable two-vault UI sandbox**

State the exact temporary paths and fixtures before creating them. Do not use Ideas, Hobbies, Mathematics, or Medicine for conversion or plugin-discovery experiments.

- [ ] **Step 5: If approved, run the UI smoke matrix**

Verify:

1. Local-only Virtual Linker with Multi-Vault disabled.
2. Compatible API with no external vault opted in.
3. One opted-in target vault.
4. Duplicate `README` chooser with full paths.
5. Mixed local and external ambiguity with local sorted first.
6. External alias rendering and opening.
7. Reading View and Live Preview coexistence.
8. API unload and reload without stale global objects.
9. External catalog update after one incremental Multi-Vault commit.

Record observed UI latency and any console errors.

- [ ] **Step 6: Write the spike report with an explicit decision**

The report contains:

- commit hashes from both repositories
- automated test and build results
- catalog transfer and trie construction timings
- UI smoke matrix results
- memory observation before and after enabling one external vault
- API lifecycle and fallback result
- unresolved risks
- `Decision: GO` only if every approved correctness gate passes and performance budgets are met; otherwise `Decision: NO-GO` with the failing gate

- [ ] **Step 7: Request code review**

Use `superpowers:requesting-code-review` separately for the API boundary and Virtual Linker refactor. Resolve all contract, lifecycle, identity, DOM safety, and performance findings.

- [ ] **Step 8: Commit the evidence**

Virtual Linker:

```bash
git add tests/integration-performance.test.ts
git commit -m "test: benchmark external virtual targets"
```

Multi-Vault Navigator:

```bash
git add docs/superpowers/specs/2026-08-10-cross-vault-virtual-linking-spike-results.md
git commit -m "docs: report virtual linking spike"
```

- [ ] **Step 9: Stop at the feasibility gate**

Do not implement whole-note conversion, version either plugin, deploy to production vaults, push tags, or publish releases. Present the report and ask for approval. If the decision is GO, write a separate whole-note conversion implementation plan using the shared pure matcher direction from the approved design.
