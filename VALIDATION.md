# WorldInfoDrawer 2.3.4 validation

Validated on September 12, 2026. The bulk folder assignment update was checked with the existing Node test suite and an isolated SillyTavern 1.18.0 profile containing synthetic lorebooks.

## Automated regression tests

Run from this repository:

```powershell
node --experimental-vm-modules --test tests/*.test.mjs
```

**Result: 94 passed, 0 failed, 0 skipped.** The suite includes the previous 81 tests and 13 new bulk-assignment tests. The expected Node VM-module warning does not indicate a failure.

The new tests cover exact lorebook identities, search selection retention, selection controls, current-folder exclusion, sequential saves, duplicate-submit prevention, partial failures and explicit retry, dirty-editor protection, teardown while saving, and one final list refresh. They also exercise the real queued folder writer to verify that latest entries, unrelated metadata, and top-level fields survive assignment. Dialog cleanup and keyboard access to the folder menu are tested.

## Live SillyTavern checks

Three grouped browser checks passed in the isolated host:

- The checklist displayed exact Unicode, apostrophe-containing, and long lorebook names. Selections remained selected across searches; **Select visible** and **Clear selection** behaved as expected.
- A two-book batch saved the destination folder while preserving entries, custom metadata, and top-level fields. Reloading confirmed persistence, and books already in the destination were marked and disabled.
- Escape dismissed the dialog. Desktop and mobile screenshots were inspected after fixing toolbar button sizing: controls were readable, long names wrapped, and the dialog had no horizontal overflow.

The browser run reported **zero page errors**. Partial save failures, duplicate submissions, unsaved-editor guards, and interruption during saving were tested with controlled Node fixtures rather than induced in the live host.

The full suite is described in [tests/README.md](tests/README.md). Earlier performance checks are documented in [PERFORMANCE.md](PERFORMANCE.md).
