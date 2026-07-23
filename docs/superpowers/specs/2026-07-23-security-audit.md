# Security Audit — Multi-Vault Navigator fork, 2026-07-23

Scope: every file under `src/`, `esbuild.config.mjs`, npm dependency audit.
Method: pattern sweep (HTML injection, eval/dynamic code, child_process,
network, clipboard, localStorage, `window.open`, fs/path handling) followed by
manual review of all five fs-touching modules and both link-handling paths.

## Findings and fixes

| Location | Issue | Severity | Resolution |
|---|---|---|---|
| `esbuild` devDependency (<=0.24.2) | GHSA-67mh-4wv8-2f99: dev server responds to any origin; relevant because `npm run dev` uses watch mode | Moderate (dev-only) | Bumped to `^0.28.1`; `npm audit` now clean |
| `src/indexer/markdown-parser.ts` `parseSimpleYaml` | Frontmatter keys from note content assigned into a `{}` object; a `__proto__` array value could reparent the result object (contained to that object; no global prototype pollution path found) | Low | Result object now `Object.create(null)` |
| `src/views/external-file-view.ts` image resolver | Vault-boundary prefix check was case-sensitive; Windows paths are not | Low | Prefix comparison now case-insensitive |
| `src/indexer/file-scanner.ts` | `.obsidian` exclude was obfuscated via `String.fromCharCode(...)` — no vulnerability, but opaque code in a scanner is a trust smell | Info | Replaced with the literal string |

## Verified safe (no change needed)

- **No HTML injection surface**: zero `innerHTML`/`outerHTML`/`insertAdjacentHTML`/`document.write` in `src/`; all rendering uses Obsidian `createEl`/`createDiv`/`setText`/`MarkdownRenderer.render`.
- **No dynamic code**: no `eval`, `new Function`, `child_process`, or dynamic `require`.
- **No network**: no `fetch`/`XMLHttpRequest`/`WebSocket`; plugin is fully local.
- **`window.open` calls** (3 sites): all use the `obsidian://` scheme with `encodeURIComponent`-escaped vault/file parameters.
- **`mvn-open` protocol handler** (`src/main.ts`): params are only matched against the in-memory index; no filesystem path is derived from handler input.
- **Cross-vault file access** (`file-scanner.ts`, `file-operation-modal.ts`, `vault-registry.ts`): all absolute paths originate from user-registered vault configs or Obsidian's own global `obsidian.json`; `validateVaultPath` requires an existing directory containing an Obsidian config folder. Move = copy + `trashFile` (recoverable), with existing-file collision check.
- **External note rendering** (`external-file-view.ts`): content rendered via `MarkdownRenderer.render`; image `src` resolution normalizes the path and enforces the vault-root prefix before mapping to `app://local/`.
- **Clipboard**: write-only (`navigator.clipboard.writeText`).
- **Index cache privacy**: `storeSnippetsInCache=false` strips `contentPreview` before writing `index-cache.json` (verified at `indexer.ts:81`); settings UI warns about the leak vector.
- **Regexes** (`markdown-parser.ts`, `cross-vault-links.ts`): linear patterns, no nested quantifiers → no catastrophic backtracking.
- **CI workflow**: default `GITHUB_TOKEN` with `contents: write` only; no third-party actions beyond `actions/checkout`/`setup-node`.
