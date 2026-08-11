# Virtual Linker Integration Design

**Status:** Approved design

## Purpose

Allow Virtual Linker to decorate and convert opt-in cross-vault matches while preserving duplicate-note correctness, synchronized vault colors, plugin independence, and local-only fallback behavior.

## Plugin boundary

Multi-Vault Navigator owns external note identity, catalog scope, aliases from indexed metadata, vault appearance, duplicate-safe resolution, canonical cross-vault link formatting, and external note opening.

Virtual Linker owns text matching, overlap suppression, live/reading-view decoration, interaction with matched terms, and conversion into real links.

Neither plugin imports the other's source or package. Virtual Linker discovers a runtime API exposed by Multi-Vault Navigator. Missing, disabled, incompatible, loading, or unloaded Multi-Vault Navigator leaves Virtual Linker fully functional in local-only mode.

## Versioned API

Multi-Vault Navigator exposes a capability-checked API with `apiVersion: 1`. The v1 surface provides methods equivalent to:

```ts
interface MultiVaultPublicApiV1 {
  apiVersion: 1;
  getCurrentVault(): VaultIdentity | null;
  getVirtualLinkSettings(): VirtualLinkIntegrationSettings;
  listVirtualLinkTargets(): VirtualLinkTarget[];
  resolveTarget(reference: TargetReference): TargetResolution;
  formatWikilink(target: VaultIdentity, alias?: string): string;
  openTarget(target: VaultIdentity): Promise<void>;
  subscribe(listener: (event: MultiVaultApiEvent) => void): () => void;
}
```

Multi-Vault keeps exact provider types in a small contract module with no Obsidian implementation dependencies. Virtual Linker defines only the minimal structural consumer types it needs at runtime; it does not import the provider package. Contract fixtures verify both structural views against the same API v1 behavior. Consumers check the version and required capabilities before use.

`VirtualLinkTarget` contains canonical `{ vaultId, relativePath }` identity, title, aliases, vault name, and validated vault color. It contains no note content. API results include only vaults explicitly selected for the current source vault and only files already admitted to Multi-Vault's index.

Events distinguish target-catalog changes from appearance-only changes. Virtual Linker batches catalog updates and only restyles on appearance changes.

## Matching model

Virtual Linker's trie is refactored to store a generic target reference rather than requiring every target to be an Obsidian `TFile`. Two adapters populate it:

- Local adapter for current-vault `TFile` targets.
- Optional Multi-Vault adapter for external API targets.

Existing local filters, tags, folders, aliases, case sensitivity, subword behavior, overlap suppression, and own-note exclusion remain unchanged. External targets use the Multi-Vault index's title and alias metadata and the explicit per-source target-vault scope.

Target lists are deduplicated by canonical identity. Basename never serves as identity.

## Resolution and opening

A unique local target opens through Obsidian as today. A unique external target opens through the Multi-Vault API.

When a term has multiple local or external candidates, its main decoration remains neutral. Activating it opens one searchable chooser showing vault and full relative path. Candidate rows use their vault colors. No code path may silently select the first basename match.

Generated external links use basename shorthand only when unique. Duplicates use an extensionless relative path, including explicit root syntax such as `[[medicine::/README|README]]`.

## Styling

Synchronized integration settings provide four modes:

1. Off.
2. Muted text tint.
3. Colored underline.
4. Soft color pill.

One intensity value controls all colored modes and defaults to 55 percent. Unique local and external targets use the target vault's synchronized color. CSS uses `color-mix()` against theme text/background variables, with readable static fallbacks for older Electron versions. Hover and focus states retain accessible contrast and keyboard visibility.

Ambiguous terms remain theme-neutral. Their chooser/reference candidates carry individual vault colors. Color conveys provenance but is never the only identity signal because chooser labels include vault name and full path.

Styling mode `off` disables vault coloring without disabling virtual links or external matching.

## Enablement and independent operation

External integration defaults off in shared Multi-Vault settings. Enabling it requires explicit target-vault selection for each source vault. A source vault can be excluded even while integration is globally enabled.

Virtual Linker continues to load and operate without Multi-Vault Navigator. Multi-Vault Navigator continues to load and operate without Virtual Linker. Unloading either plugin releases subscriptions and returns Virtual Linker to local-only targets without stale external click handlers.

Virtual Linker's existing activation/deactivation setting still controls all decoration. Shared color mode independently controls provenance styling.

## Reviewed current-note conversion

Virtual Linker adds **Review and convert virtual links in current note**. Matching is DOM-independent and runs against editor source text. It excludes frontmatter, fenced and inline code, existing Markdown and wikilinks, embeds, HTML, and other ranges that must not be rewritten.

The command:

1. Collects matches from the same local and external matching service used for decoration.
2. Groups occurrences by normalized matched term.
3. Defaults to selecting only the first occurrence in each group.
4. Requests one target choice for each ambiguous group.
5. Shows one grouped review with occurrence counts, chosen targets, and exact link previews.
6. Applies approved replacements in one offset-safe editor transaction from highest offset to lowest.

Local targets produce normal internal wikilinks. External targets use the API formatter, preserving matched text as an alias when needed. Existing selected-rendered-link conversion remains available and unchanged.

If targets or editor content change after review, conversion aborts and requests a fresh review.

## Lifecycle and failure handling

Virtual Linker probes for the API after workspace layout readiness and when plugin enablement changes. API calls are guarded by capability and version checks. Errors are bounded to the external adapter, logged once per state transition, and do not stop local matching.

Catalog updates are coalesced. Appearance updates restyle without rebuilding the trie. If the API disappears, external targets and handlers are removed in one refresh. If shared configuration is invalid, Multi-Vault exposes the last valid configuration or reports integration disabled.

No network service, Dataview, Omnisearch, or QuickAdd is required.

## Performance budgets

Disposable-vault benchmarks use approximately 28,000 indexed targets and realistic duplicate/alias density. Goals:

- Initial external-target adaptation must not block the editor for more than 100 ms in one task; work is chunked or deferred when needed.
- Appearance-only changes avoid trie rebuilds.
- Incremental catalog events update affected identities or perform one coalesced rebuild, never overlapping rebuilds.
- Opening an ambiguity chooser remains interactive without reading note contents.
- Current-note conversion scans only the active editor text.

## Verification

Multi-Vault contract tests cover API versioning, target scope, identities, aliases, colors, duplicate resolution, formatting, opening, subscriptions, and disabled behavior.

Virtual Linker tests cover:

- Unchanged local-only behavior with no API.
- Disabled, incompatible, late-loading, and unloaded API states.
- External titles and aliases.
- Local/external duplicate terms and neutral ambiguity.
- All four style modes, intensity limits, dark/light themes, and fallback CSS.
- Keyboard and mouse activation.
- Current-note exclusions, grouping, default first occurrence, ambiguous target selection, stale review, and one atomic transaction.
- Canonical path-qualified and root-duplicate output.
- Large-catalog performance and coalesced updates.

Combined disposable-vault smoke tests run both built plugins without touching production vault notes or configurations.
