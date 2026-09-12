# Performance regression tests

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
| `browser-loading.test.mjs` | Four-request concurrency, shared in-flight reads, yielding cached reads, failure and disposal, sorted rendering, collapse state, replacement rows, and refresh coalescing. |
| `search-performance.test.mjs` | The 10,000-entry cache bound, updates and pruning at capacity, UID zero, searches that avoid entry traversal, staged match evaluation, hiding only confirmed misses, restoring partially filtered rows, identity guards, cleanup, and one final folder update. |
| `entry-manager-performance.test.mjs` | Fused initial predicates, scoped unsorted filtering, unchanged DOM writes, sequential script execution, cancellation across script/render awaits, selection restoration, and closing while opening with dirty-editor protection. |
| `selection.test.mjs` | DOM range ordering, existing and overlapping selections, UID zero, avoiding repeated linear membership scans, and detached anchors. |
| `update-queue.test.mjs` | Latest payload per book, structural updates, immediate reconciliation, serialized batches, per-book and batch failures, disposal, elapsed-time/item-count budgets, and browser scheduler fallback. |
| `save-recovery.test.mjs` | Serialized saves and latest pending payloads, network rejection and recovery, host-cache invalidation before reads, missing/invalid books, intact metadata/extras, sequential reconciliation, one awaited table refresh, and explicit recovery failure reporting. |
| `editor-dirty.test.mjs` | Equivalent numeric/string UIDs, dirty UID zero, matching mounted model and live draft, asynchronous title/keyword input, reverted drafts, Select2 drafts, standard host controls and aliases, and ownership/listener cleanup. |
| `wi-reconciliation.test.mjs` | Stale reads and duplicate insertion, current insertion anchors, replacement book/entries/DOM guards, atomic field reconciliation before optimistic edits, dirty-editor preservation, post-commit acknowledgement, and superseded batches waiting for an authoritative refresh. |

These tests use synthetic data and host adapters; they do not require a running
SillyTavern server. Browser validation and measurements are documented in
[PERFORMANCE.md](../PERFORMANCE.md).
