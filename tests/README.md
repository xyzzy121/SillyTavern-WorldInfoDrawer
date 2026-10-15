# Regression tests

Run from the extension directory with Node.js (verified with Node 26.2.0):

```powershell
node --experimental-vm-modules --test tests/*.test.mjs
```

The tests use Node's built-in runner. VM modules supply small SillyTavern/DOM
adapters for host-dependent code; no production or test packages are required.
The experimental VM-module warning is expected.

Deferred host operations and controlled work checkpoints exercise cancellation
at asynchronous boundaries rather than relying on timing assertions. The current
suite covers:

| Test file | Coverage |
| --- | --- |
| `folder-bulk-add.test.mjs` | Exact lorebook identities, search/selection retention, current-folder exclusion, sequential saves, duplicate-submit prevention, partial failure and explicit retry, dirty-editor and teardown guards, one refresh, full latest-book metadata/entry preservation, and dialog controls/cleanup. |
| `browser-loading.test.mjs` | Four-request concurrency, shared in-flight reads, yielding cached reads, failure and disposal, sorted rendering, collapse state, replacement rows, and refresh coalescing. |
| `search-performance.test.mjs` | The 10,000-entry cache bound, updates and pruning at capacity, UID zero, searches that avoid entry traversal, staged match evaluation, hiding only confirmed misses, restoring partially filtered rows, identity guards, cleanup, and one final folder update. |
| `entry-manager-performance.test.mjs` | Fused initial predicates, scoped unsorted filtering, unchanged DOM writes, sequential script execution, cancellation across script/render awaits, selection restoration, and closing while opening with dirty-editor protection. |
| `selection.test.mjs` | DOM range ordering, existing and overlapping selections, UID zero, avoiding repeated linear membership scans, and detached anchors. |
| `update-queue.test.mjs` | Latest payload per book, structural updates, immediate reconciliation, serialized batches, per-book and batch failures, disposal, elapsed-time/item-count budgets, and browser scheduler fallback. |
| `save-recovery.test.mjs` | Serialized saves and latest pending payloads, network rejection and recovery, host-cache invalidation before reads, missing/invalid books, intact metadata/extras, sequential reconciliation, one awaited table refresh, and explicit recovery failure reporting. |
| `editor-dirty.test.mjs` | Equivalent numeric/string UIDs, dirty UID zero, matching mounted model and live draft, asynchronous title/keyword input, reverted drafts, Select2 drafts, standard host controls and aliases, and ownership/listener cleanup. |
| `wi-reconciliation.test.mjs` | Stale reads and duplicate insertion, current insertion anchors, replacement book/entries/DOM guards, atomic field reconciliation before optimistic edits, dirty-editor preservation, post-commit acknowledgement, and superseded batches waiting for an authoritative refresh. |
| `entry-navigation.test.mjs` | Cross-book request ordering, direct-click supersession, Back/clear cancellation, and same-book navigation-pin ownership. |
| `manager-hydration.test.mjs` | Deferred cell values and controls, immediate pointer/keyboard activation, scrolling debounce, observer replacement/cleanup, bulk targets, UID remapping, selection counters, unchanged preview nodes, and real batch yields. |
| `multiselect-escape.test.mjs` | Capture-phase Escape handling, focus restoration, and releasing dropdown listeners when the owning editor closes. |

These tests use synthetic data and host adapters; they do not require a running
SillyTavern server. Browser validation and measurements are documented in
[PERFORMANCE.md](../PERFORMANCE.md).

The separate [mobile browser suite](mobile/README.md) runs against an isolated
SillyTavern profile. It uses Playwright dependencies installed under `tests/mobile`;
they are not extension runtime dependencies. Its synthetic fixtures cover seven
viewport sizes in Chromium and WebKit, plus deferred rendering, navigation,
selection, bulk edits, cleanup, and first pointer/keyboard interaction.

## Bulk folder assignment validation — 2026-09-12

The full Node suite passes 94 tests, including 13 new bulk-assignment cases.
An isolated SillyTavern profile also passed three grouped browser checks covering
search selection retention, selecting visible books and clearing selections,
two actual folder saves with entries/custom metadata/top-level fields preserved,
reload persistence, already-assigned books being unavailable, and Escape dismissal.
The browser run reported no page errors. The Node tests additionally cover
partial failures and explicit retry, duplicate submissions, unsaved editor
protection, teardown during a save, and the single final refresh.
Desktop and narrow-screen screenshots were inspected after correcting the host's
minimum-content button sizing: toolbar labels remain readable on one line, the
toolbar wraps as needed, long lorebook names wrap within the list, and the primary
actions remain visible.
