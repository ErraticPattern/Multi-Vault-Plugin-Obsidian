# Multi-Vault Navigator fork v2.3.0 — Cross-vault link fix, 1.12.7 compat, build hygiene

Date: 2026-07-23
Status: Approved by owner (chat, 2026-07-23)

## Problem

1. `[[vault::note]]` cross-vault links do not work. The current implementation
   (`registerMarkdownPostProcessor` + raw text-node walker, `src/main.ts:192`)
   never fires: Obsidian core parses `[[...]]` into
   `<a class="internal-link" data-href="vault::note">` before postprocessors
   run, in Reading View and Live Preview alike. Clicking triggers core's
   "create new note" behavior for an unresolved link.
2. Settings tab crashes on Obsidian 1.12.7 (`e.display is not a function`):
   fork uses the 1.13+ declarative settings API only; 1.12.x requires a
   `display()` method. Obsidian 1.13 is Catalyst early-access only (as of
   2026-07), so owner's machines run 1.12.7.
3. Build config auto-copies output to a hardcoded stranger's path
   (`C:\hermes-memory\...`, `esbuild.config.mjs`).
4. Repo hygiene: built `multi-vault-navigator.zip` committed; no release
   automation; `minAppVersion` claims 1.13.0.

## Decisions (owner-approved)

- Scope: behavior fix + CSS polish. No CM6 decoration rewrite of Live Preview
  text (future idea).
- Compatibility: support both Obsidian 1.12.7 and 1.13+ via settings shim.
- Mechanism: DOM-level interception (no monkey-patching of
  `Workspace.openLinkText`).
- Additional owner requests: security audit of the whole codebase with fixes
  for anything unsafe; add Claude as contributor.

## Design

### 1. Cross-vault link engine — new `src/cross-vault-links.ts`

- Pure helper `parseCrossVaultHref(href)` → `{ vaultName, noteName } | null`.
  Matches `^([^:\[\]#^|]+)::(.+)$`. Used by both render paths.
- Shared resolver: case-insensitive match on indexed `vaultName` + `basename`
  via existing `indexer.getIndexedFiles()`; open via existing `fileOpener`.
  Not-found keeps current `Notice`.
- Reading View: postprocessor selects `a.internal-link` whose `data-href`
  parses as cross-vault. Rewrites each anchor: displayed text = note name (or
  the alias core already placed as anchor text), prepend small vault badge
  element, add `mvn-cross-vault-link` class, remove unresolved styling,
  attach click (open via fileOpener) and contextmenu (existing
  `obsidian://open` fallback) handlers. Delete the dead text-node walker.
- Live Preview: capture-phase click listener registered with
  `registerDomEvent` on the workspace container. On click inside a CM editor,
  resolve the clickable token at the click position (Obsidian
  `editor.getClickableTokenAt` / CM6 `posAtCoords`); if token is an
  internal link whose target parses as cross-vault → `preventDefault` +
  `stopPropagation`, open via fileOpener. Ctrl/middle click treated the same
  (single open behavior for now).
- `[[vault::note|alias]]` works for free: core keeps the target in
  `data-href`/token text and shows alias.
- CSS (`styles.css`): `.mvn-cross-vault-link` styled as resolved link with
  vault badge; Live Preview raw text colored as valid link (best-effort
  selector on `data-href*="::"` equivalents; cosmetic only).

### 2. Settings compat shim — `src/settings-tab.ts`

- Keep the declarative schema as source of truth.
- Add `display()` that renders the schema manually: iterate sections/items,
  `new Setting(containerEl)`, invoke each item's `render(setting)` callback,
  preserving existing try/catch-per-item robustness.
- Feature-gate: if `requireApiVersion("1.13.0")`, let the native declarative
  path handle rendering (display() no-ops or defers) to avoid double render;
  otherwise display() renders. Exact detection verified during
  implementation against both versions' behavior.

### 3. Build & dev workflow — `esbuild.config.mjs`

- Remove hardcoded copy path. Read optional gitignored `deploy-targets.json`
  (array of absolute plugin-folder paths). Present → copy `main.js`,
  `manifest.json`, `styles.css` to each after build/rebuild. Absent → build
  only, no copy, no error.
- Commit `deploy-targets.example.json` documenting the format.
- Owner's real file lists the four vault plugin dirs
  (`<vaults-root>\<vault>\.obsidian\plugins\multi-vault-navigator`); kept
  local, never committed.
- Copy also runs on watch rebuilds in dev mode.

### 4. Release pipeline & versioning

- `.github/workflows/release.yml`: on tag push matching `[0-9]+.[0-9]+.[0-9]+`
  → `npm ci`, `npm run build`, create GitHub release with `main.js`,
  `manifest.json`, `styles.css` attached.
- `manifest.json` + `package.json`: version `2.3.0`; `minAppVersion`
  `1.12.7`. `versions.json` gains `"2.3.0": "1.12.7"`.

### 5. Repo hygiene

- Delete `multi-vault-navigator.zip`; add it, `main.js`, and
  `deploy-targets.json` to `.gitignore`.

### 6. Security audit (owner request)

- Full-source review for: HTML injection (`innerHTML`/`outerHTML` with
  user/vault-derived strings), path traversal in cross-vault file access
  (indexer/scanner/opener use absolute paths from settings + Node fs),
  unsafe protocol-handler input (`mvn-open` params), command/child_process
  usage, network calls, eval/Function, clipboard misuse.
- Findings fixed in-repo where real; documented in the implementation notes.
  No detection-evasion or offensive tooling — defensive hardening only.

### 7. Testing & verification

- `npm run build` (tsc type-check + esbuild) must pass clean.
- Manual checklist on Obsidian 1.12.7, `ideas` vault:
  1. Settings tab opens, all sections render, toggles persist.
  2. Reading View: `[[hobbies::Portugal]]` in `ideas/README.md` shows badge +
     "Portugal", click opens the note from the hobbies vault.
  3. Live Preview: same link clickable, opens same target.
  4. `[[hobbies::Portugal|Lisbon trip]]` alias renders/opens.
  5. `[[hobbies::Nonexistent]]` click → Notice, no note created.
  6. Regression: normal `[[wikilinks]]` unaffected; search modal, sidebar,
     recent files still work.
- No unit-test framework added (owner accepted; href-parser kept pure so
  vitest can be added later).

### 8. Contributor credit

- README gains a Contributors/Credits line for Claude (Anthropic); commits
  carry `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Out of scope / future

- Hover preview from cached index snippets; `[[vault::` autocomplete;
  CM6 decorations for Live Preview text; heading/block subpaths
  (`vault::note#heading`); upstream PR of the fixes.
