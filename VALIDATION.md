# WorldInfoDrawer validation

## October 15, 2026 — demand rendering and mobile interaction

Validation uses a separate SillyTavern 1.19.0 staging checkout and disposable
profiles on loopback ports 8001 and 8002. The running installation is unchanged.
Fixtures are synthetic, and the tests do not request generation or OpenRouter.

The Node regression suite passes **146/146 tests**, with no failures or skips.
Coverage includes cancellation and ownership of asynchronous navigation,
unmounted-entry reconciliation, selection and UID identity, deferred controls,
scroll-idle scheduling, pointer-target preservation, and repeated manager cleanup.

The final Playwright matrix passes **106/106 cases**, without retries or skips:
53 in Chromium and 53 in WebKit. It covers 320 × 568, 360 × 800, 390 × 844,
430 × 932, 844 × 390, 390 × 420, and 768 × 1024. The additional performance
regressions run at 390 × 844 in each engine. They cover unmounted rows, selection
pins, offscreen bulk edits, repeated cleanup, and first-action keyboard/pointer
behavior. With viewport hydration deliberately held, a middle-grip click leaves
ordering unchanged, while an immediate native drag saves the new order.

The combined console review has **zero unexpected events, zero HTTP 503
responses, and no missing diagnostic attachments**. Known upstream WebKit speech
synthesis errors, optional-plugin 404s, and deliberately injected save failures
remain recorded separately. All cases attach provider-metadata stub counts;
Horde boot metadata is fulfilled locally before navigation.

Representative narrow-screen, reduced-height, and landscape screenshots were
inspected. Picker actions remain reachable with long names, editor controls stay
readable, and numeric controls fit the mobile width. These are browser-emulation
results, not physical-device measurements or native-keyboard testing.

The final desktop compositor correction is a CSS-only addition above 1,000 px.
The mobile matrix and twelve mobile performance cases were completed before this
addition; the rule is inactive at every tested mobile width, and all other
production resources match byte for byte. The validation artifacts preserve both
source snapshots and check the exact CSS delta. All six desktop cases completed
on the final source with seven measured samples each and zero browser errors.
The full before/after comparison contains 36 completed core cases. Reconstruction
of the production patch matches all 70 runtime JavaScript/CSS files byte for
byte, and both cloned runtime copies match the final source. The desktop table
uses the theme tint's RGB channels with an
explicit opaque alpha, including when the surrounding theme is translucent.

The performance methodology and remaining costs are documented in
[PERFORMANCE.md](PERFORMANCE.md). Portable browser-test setup is in
[tests/mobile/README.md](tests/mobile/README.md).

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
