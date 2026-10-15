# Mobile browser regression tests

These Playwright tests exercise WorldInfo Drawer inside a separate SillyTavern
installation. Start that installation with a dedicated data directory on
`http://127.0.0.1:8001` or another loopback port above 8000, with this extension
installed. Set `ST_BASE_URL` explicitly; the test configuration rejects other
hosts and protocols.

The suite writes synthetic lorebooks named `Mobile QA — …` and
`Performance QA — deferred rows`, changes folder metadata and browser settings,
and uses a fresh browser context per test. Use a disposable profile with no
personal lorebooks, configured providers, or API credentials. The tests do not
request model generation. The host's startup Horde status, model-list, and
worker-list requests are fulfilled locally before navigation so those endpoints
do not proxy provider metadata requests. Per-test attachments count these stubs.

From this directory, install the pinned packages and browser binaries:

```powershell
npm ci
npx playwright install chromium webkit
$env:ST_BASE_URL = 'http://127.0.0.1:8001'
```

Run the original mobile cases across both engines and seven viewport sizes,
then the additional performance regressions at 390 × 844:

```powershell
npm test -- drawer.spec.mjs entry-manager.spec.mjs bulk-picker.spec.mjs
npm test -- performance-regressions.spec.mjs --project=chromium-390x844 --project=webkit-390x844
```

Together these commands run 106 cases. For a focused check of deferred controls
and keyboard interaction:

```powershell
npm test -- performance-regressions.spec.mjs --project=chromium-390x844 --project=webkit-390x844 --grep 'manager first interaction'
```

The context-menu and upstream compatibility cases cover native three-dot and
collapse buttons, scrollable popup placement, enlarged text and rotation,
keyboard focus, backdrop/refresh/close cleanup, optional integration contracts,
enabled switches, Moonlit styling, attached editor labels, and sticky manager
tabs. Optional plugins are replaced by local test callbacks; the External Editor
request is fulfilled locally. Chromium also exercises an emulated touch swipe
inside a tall menu. WebKit checks the same scrollable geometry and reachability.

```powershell
npm test -- context-menu.spec.mjs context-menu-integrations.spec.mjs upstream-layout.spec.mjs --project=chromium-320x568 --project=chromium-390x844 --project=chromium-844x390 --project=webkit-320x568 --project=webkit-390x844 --project=webkit-844x390
```

This focused addition runs 78 cases. The mobile drawer's visible **Close World
Info** button uses the host close path; the top-bar toggle is covered while the
full-height drawer is open. Reorder cases explicitly accept the new confirmation
when replacing an order displayed with a different sort.

Results, screenshots, traces, and the HTML report default to the ignored
`test-results/` directory here. Set `ST_MOBILE_OUTPUT` to an absolute path for a
separate results directory. Do not run multiple suites against the same data
directory concurrently: tests deliberately overwrite their shared synthetic
fixtures. Use separate host ports and data directories for concurrent runs.

The suite checks runtime errors as well as behavior. Browser-event attachments
retain expected injected save failures and the specific upstream WebKit speech
synthesis error separately from extension errors. Browser emulation checks
layout, touch input where supported, and keyboard behavior; it does not replace
testing on physical mobile devices. Run performance measurements separately
from other browser workloads.
