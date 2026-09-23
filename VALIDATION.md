# WorldInfoDrawer validation

## Version 2.3.5 — mobile bulk picker

Updated September 23, 2026. The bulk picker can scroll its whole form when a long
folder name or short viewport leaves insufficient room for the footer. Buttons,
search, and selectable rows have a minimum height of 44 pixels for touch input.
The regression scenario uses a 300-character folder name at 320 × 568 and
667 × 300, where the previous footer was clipped. All 94 regression tests passed,
and `git diff --check` found no whitespace errors. One earlier run intermittently
failed the existing request-admission timing assertion; that test file and the
subsequent full suite passed without changes.

The isolated SillyTavern 1.18.0 host passed Chromium touch-emulation checks at
320 × 568, 360 × 800, 390 × 844, 430 × 932, 844 × 390, 390 × 420, and 768 × 1024.
Long and unusual lorebook names and 300-character folder names remained readable;
touch filtering, selection, and clearing worked. Screenshots were visually
inspected, and no browser page errors were reported.

Actual emulated touch swipes scrolled the bulk form at 320 × 568, 844 × 390,
and 390 × 420. After scrolling, the footer was entirely inside the viewport,
the buttons received hits at their visible coordinates, and tapping Cancel
dismissed the dialog. Touch action buttons measured at least 44 pixels high.

These are browser-emulation results, not physical-device or Safari tests. The
390 × 420 case checks reduced available height; it does not reproduce a native
mobile keyboard or browser-toolbar behavior.

## Version 2.3.4

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
