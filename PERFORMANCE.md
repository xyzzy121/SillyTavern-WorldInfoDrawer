# Performance and responsiveness validation

## October 15, 2026: selective upstream adoption

This comparison uses the clean fork at `60f62f5` as its baseline and the final
upstream-adoption/mobile-menu source as its after snapshot. It is separate from
the demand-rendering comparison below. Both use the same isolated SillyTavern
1.19.0 host, Node 26.2.0, Playwright 1.64.0, and Chromium 156.0.8078.4.
No other browser test workloads ran during these measurements.

The fixture is one book containing 4,000 short entries. Mobile uses 390 × 844
with 4× CPU throttling; desktop uses 1440 × 1000 at native speed. Each batch
discards one warmup. Synthetic book reads include serialization and parsing,
but exclude disk/network latency. Saves and provider metadata are intercepted
locally; no model generation is requested.

| Manager opening batch | Measured samples per version | Before median | After median | Change |
| --- | ---: | ---: | ---: | ---: |
| Mobile, initial comparison | 3 | 7,987 ms | 9,204 ms | +15.2% |
| Mobile, focused repeat | 5 | 8,684 ms | 7,322 ms | −15.7% |
| Desktop, initial comparison | 3 | 1,897 ms | 1,418 ms | −25.2% |

The initial mobile slowdown did not reproduce in the focused repeat. The
five-sample ranges were 7,108–9,065 ms before and 6,751–9,135 ms after. These
small, variable batches do not establish a speedup or a repeatable opening
regression. Keep both batches when interpreting the result; do not select only
the favorable run. A 4,000-row manager still has a substantial opening cost on
the throttled mobile profile.

All cases retained 4,000 logical rows with roughly 197 mobile or 213 desktop
controls when the manager opened, rather than controls for every row. Closing
released all manager and entry rows. The benchmark recorded no browser errors.
Static review found no added per-row query or focus polling in manager opening;
reorder snapshots run only when a reorder is requested, and context-menu
observers/listeners exist only while their popup is open.

Scrolling and settlement are supplemental single observations per batch, not
repeated distributions. The after samples hydrated 232 more intermediate
controls than the before samples, so first-scroll times compare different
amounts of work. The existing 120 ms scroll-idle scheduler can resume between
the benchmark's two-frame scroll steps when frames are long. The report keeps
these control counts beside the timings. Warm-scroll observations were lower
on mobile and similar on desktop, but likewise do not establish a repeatable
speed change. The new sticky mobile tab dock includes theme blur; no specific
regression from that rendering cost was established by these measurements.

Workspace artifacts are in `upstream-validation`: `report.html` and
`comparison.json` preserve the initial pair; `confirmation-report.html` and
`confirmation.json` preserve the focused mobile repeat. Each links its raw
results, actual sample counts, ranges, lifecycle counters, and request counts.
Source hashes cover the exact files served by each benchmark; both after
snapshots and the functional-test runtime copies match the final production
source. See [VALIDATION.md](VALIDATION.md) for the functional results and retained
host-startup diagnostics.

## October 2026: demand rendering and mobile responsiveness

Collapsed books now retain their headers and cached data without constructing
entry rows. Expanding a book creates its rows with cancellation checks and a work
budget. Collapsing or hiding it releases rows unless an editor, selection, drag,
or navigation request still needs them. Search operates on cached data, and
entry updates invalidate only the affected search and sort work.

The Entry Manager retains every logical table row. It creates editing controls
only for enabled columns near the viewport, or immediately when a cell receives
click or keyboard interaction. Automatic control creation pauses during scrolling
and resumes after 120 ms of idle time. This avoids repeatedly laying out the
entire table while the viewport moves. Control creation after scrolling is still
work and is included separately in the measurements. A lightweight native drag
handle remains available before the row's editing controls are created.

Bulk edits skip unchanged preview text and attributes, yield after real batches,
and use maintained selection counts. UID renumbering updates canonical identities
for both mounted and deferred views. Closing a view releases its observer,
pending work, scroll listener, dropdown listeners, and table references.
Navigation ownership spans row loading and editor construction so an older
request cannot replace a newer selection or reopen a cleared editor.

On desktop, the table uses an opaque background with the theme tint's RGB
channels. This gives Chromium a continuous painted surface for accelerated
scrolling. A transparent table of deferred cells produced tens of thousands of
fragmented touch/wheel regions under the host's document-level input handlers.
In a 1,000-row diagnostic, the background reduced Layerize processing from about
2.85 seconds to 8 milliseconds. The table is intentionally opaque even when the
surrounding theme is translucent; this rule applies only above 1,000 px.

The current comparison uses an isolated SillyTavern 1.19.0 staging checkout,
Node 26.2.0, and Playwright 1.64.0. Its baseline is this repository's `cd761ee`
checkout plus the completed mobile fixes, before the demand-rendering changes.
The older measurements below use a different baseline and must not be pooled
with this comparison.

The six synthetic fixtures are 1,000 entries across ten books; 20,544 entries
across 96 books with short or large content; and single-book managers with
1,000 entries, 4,000 short entries, or 4,000 large entries. The largest library
is approximately 150 MB of JSON. Browser profiles are mobile Chromium at
390 × 844 with 4× CPU throttling, mobile WebKit at 390 × 844 at native speed,
and desktop Chromium at 1440 × 1000 at native speed.

The final comparison retains the twelve completed mobile fixture/profile cases
and repeats all six desktop cases after the desktop-only background correction.
The mobile measurements and 106-case functional matrix precede that last CSS
addition. Every other production resource is byte-identical, and the added
media query is inactive at all measured mobile widths. Separate source hashes
and an exact CSS-delta check preserve that provenance; samples from different
source revisions are not pooled within a profile.

Core timings use one discarded warmup and seven repetitions. They include
two animation frames after the operation. Cold loading includes in-memory JSON
serialization and parsing, excluding disk/network latency. Search excludes its
typing debounce. Supplemental interactions use a single measured sample and
include first expansion, scrolling, filtering, sorting, and individual/bulk saves.
The updated scrolling diagnostic also waits for the final viewport's deferred
controls, so work moved until after scrolling is not omitted.

Final measured examples below use mobile Chromium at 390 × 844 with 4× CPU
throttling. Core timings and element counts are medians of seven repetitions.

| Workload | Before | Updated |
| --- | ---: | ---: |
| Reopen a collapsed 20,544-entry library | 13,901.6 ms | 1,060.5 ms |
| Search the collapsed 20,544-entry library | 16,643.6 ms | 26.1 ms |
| Elements in the collapsed 20,544-entry drawer | 268,174 | 1,102 |
| Open the 4,000-entry short-content manager | 30,670.1 ms | 8,264.8 ms |
| Initial controls in the 4,000-entry manager | 80,061 | 197 |
| Elements in the 4,000-entry manager | 360,428 | 108,887 |

Final desktop Chromium manager-opening medians, also with seven repetitions:

| Manager fixture | Before | Updated |
| --- | ---: | ---: |
| 1,000 short entries | 1,440.8 ms | 484.7 ms |
| 4,000 short entries | 7,599.6 ms | 1,650.4 ms |
| 4,000 large entries | 7,757.1 ms | 1,543.9 ms |

All eighteen updated fixture/profile cases completed, including their planned
supplemental interactions. No browser errors were recorded in the final desktop
run. The complete before/after comparison contains 36 core cases with seven
measured samples each.

Supplemental interactions have only one sample each. In the same 4,000-entry
manager, sorting took 719.1 ms versus 35,811.8 ms, and a bulk strategy edit took
5,654.9 ms versus 9,017.0 ms. These figures are diagnostics, not seven-run medians.

The deferred work has observable costs. Expanding the entire 4,000-entry book
took 11,805.8 ms versus 3,502.5 ms; the corresponding cold library load fell from
1,635.8 ms to 203.7 ms. This fixture therefore costs more to load and fully expand,
even though collapsed loading and manager opening improve. The twelve-jump scroll
sample took 2,341.1 ms versus 1,570.8 ms, followed by another 1,295.1 ms to settle
and create controls in the final viewport. A warm repeat took about 764 ms.
The baseline already created all controls before scrolling and has no separate
warm-repeat measurement. Faster initial rendering does not eliminate this work.
The desktop 4,000-entry short book also shows this first-expansion tradeoff:
2,323.4 ms versus 630.1 ms in its single supplemental sample.

The 4,000-entry short manager's Chromium lifecycle check opens and closes eight
times, including warmup. After garbage collection, browser-wide DOM nodes were
34,837 before and 34,842 after, with zero connected manager rows after closing.
These counters include the host and cached fixture data; they demonstrate release
of the large detached table, rather than an extension-only memory measurement.

The baseline's two 4,000-entry WebKit bulk operations exceeded their 180-second
watchdogs. Those failures were retained; their seven core opening/rebuild samples
were collected separately. Missing supplemental values are not zero-duration
results. Both updated bulk operations completed: about 4.56 seconds for short
content and 5.09 seconds for large content, with one sample each. Browser emulation
does not establish physical-device performance, and
repetitive synthetic content can have different memory behavior from real books.

Large managers still pay layout and paint costs for their complete logical table.
Expanding a large book incurs row construction that was deferred from opening the
drawer. The approximately 8 ms JavaScript work budget is not an upper bound on
host code, browser layout, or total interaction time.

Run the unit suite with the command below. The independently installed mobile
suite and its 106-case matrix are described in [tests/mobile/README.md](tests/mobile/README.md).

## Earlier performance baseline (version 2.3.3)

The comparison baseline is commit `72af626df2cdbc3dd801740bb756fd4d4abcd28a`
(extension version 2.3.3). Before editing, all 66 files in the prepared baseline
snapshot matched the checkout by SHA-256.

## Implementation

- Four concurrent book reads share an in-flight lookup; completed data is not
  retained in an additional persistent loading cache. Rendering preserves book,
  folder, and entry order.
- Refreshes, searches, and table/script renders have generation and ownership
  checks. Obsolete work cannot publish into a replacement view.
- Rendering uses an approximately 8 ms work budget, capped at 50 rows; search
  checks at most 200 entries per slice. `scheduler.yield()` is used when present,
  with a real timer-task fallback for other browsers.
- Search bookkeeping is constant-time per admission and retains at most 10,000
  cached entries. Larger libraries remain searchable without clearing the useful
  cache on every overflow. Name-only searches restore only previously hidden rows.
  Entry search determines each book's matches before updating its rows, hiding
  confirmed nonmatching books before row writes. Books that match are never
  temporarily hidden during their scan, preserving their visible position.
- Initial Entry Manager filters are prepared once and applied during row builds.
  Order-independent filter passes use unsorted source traversal. Script execution
  retains its original ordering, with a 250 ms replacement debounce.
- World Info events coalesce for 100 ms by book and reconcile serially. Direct
  recovery joins the same queue and awaits its result. Entry-only reconciliation
  remains atomic with respect to input because inline edits share its cache.
- Range selection uses a local membership set; bulk collapse controls update
  their aggregate state once. Save acknowledgement checks the mounted editor
  model and live dirty controls before clearing dirty state.

The implementation retains all entry rows and existing integration selectors.
Memory and layout work still grow with the number of entries and visible table
controls. Host cloning, sorting, and final browser layout can exceed the work
budget; it is a cooperative-loop target, not a guaranteed maximum task duration.

## Reproduce the automated regression tests

```powershell
node --experimental-vm-modules --test tests/*.test.mjs
```

Tests use the built-in Node runner and small VM adapters for host-dependent code;
they add no runtime dependencies. See `tests/README.md` for coverage.

## Browser measurement setup

Measurements use the supplied SillyTavern 1.18.0 checkout, Node 26.2.0, bundled
Playwright 1.62.1, and Edge 152.0.4191.66 in headless mode at 1440 × 1000.
Baseline and candidate run serially, using fresh browser contexts with the same
synthetic data and settings. No personal lorebooks are included.

The task-specific harness and raw results are in `E:\DELETE\temp\stwid-perf`.
`benchmark.mjs` intercepts only the extension source, settings, and World Info
fixture routes. It adds observation markers without changing production files.
The baseline source remains in that directory's `baseline` subdirectory.

Start the isolated test host from `E:\DELETE\SillyTavern`:

```powershell
node server.js --configPath E:\DELETE\temp\stwid-perf\host-config.yaml --dataRoot E:\DELETE\temp\stwid-perf\host-data --port 8017 --listen false --browserLaunchEnabled false
```

Run `benchmark.mjs` with `STWID_VARIANTS` set to `baseline` or `candidate` and
`STWID_OUTPUT` set to a distinct JSON filename. The default workload set is:

| Workload | Books | Entries |
| --- | ---: | ---: |
| control-10x20 | 10 | 200 |
| medium-20x500 | 20 | 10,000 |
| distributed-100x500 | 100 | 50,000 |
| single-1x50000 | 1 | 50,000 |
| many-1000x50 | 1,000 | 50,000 |

The medium workload takes the first 20 sorted books from the distributed fixture.
Completed comparisons use one warmup plus five measured cold loads and warm
searches. The control and medium workloads also repeat table construction five
times after warmup. The 50,000-entry table is a single bounded stress attempt.
Loading has a 180-second limit; complete table/filter and search sequences have
120-second wall-time limits for the control and medium workloads. Each
50,000-entry table/filter stress attempt has a 30-second wall-time limit; its
cold-load and search limits remain 180 and 120 seconds. The harness persists
completed samples before teardown. Cleanup obtains the exact owned process IDs through CDP
`SystemInfo.getProcessInfo`, terminates child processes before the parent, and
checks that no owned orphan renderers remain after a timeout.
Timeouts are reported as limits, not successful timing samples.

The [local artifact manifest](E:/DELETE/temp/stwid-perf/README.md) describes the
harnesses and retained diagnostics. Only baseline search records from
`search-index-results.json` are used below; final candidate search records are
from `search-index-final-candidate-results.json`. Earlier candidate query
series predate the final search refinement and are diagnostic only.
`candidate-stress-results.json` supplies only distributed cold-loading and
table-timeout evidence: its later single-book and many-book cases were
contaminated by orphan renderers from the earlier cleanup implementation and
are excluded. `remaining-stress-results.json` replaces those cases after the
cleanup correction.

Recorded metrics include extension initialization time, query-to-result time,
table construction time, long-task counts/durations, event-loop delay, row/node
counts, and World Info read counts. The original harness measures correct DOM
state, not guaranteed completion of the subsequent browser paint. Query timing
includes the retained 125 ms debounce. Event-loop delay is a timer-lag proxy, not
a direct physical-input latency measurement. Long Task observer delivery can lag
the DOM completion marker, so these original samples must not be interpreted as
upper bounds on later layout/paint work.

The `columnFilter` series measures reapplying the current strategy filter to
isolate traversal/computation from a changed table's layout. Actual filter
selection and expected visibility are checked by `integration.mjs` and the
regression tests. An additional 10,000-row filter-change attempt is retained in
`candidate-results.json`; it reached the 120-second complete-interaction limit
after table construction and the first changed-filter sample.

`search-index-benchmark.mjs` uses fresh contexts to measure the first entry query
including index population, followed by a populated-index query. It also records
a presentation opportunity after two animation frames. This marker is called
`paintedElapsedMs` in the raw data; it is not a measurement of compositor pixels.
A trusted Shift keydown/up is requested 130 ms after the first input signal.
Event Timing input delays are reported only for observed events; missing
modifier-key events are censored/unreported, not measured zero latency. The
16 ms Event Timing reporting threshold applies to event duration and does not
establish a precise upper bound on the input delay of omitted modifier events.

## Completed control and 10,000-entry comparisons

Every value below is a median excluding records marked `warmup: true`. The
percentage is `(candidate / baseline - 1) × 100`; negative elapsed-time changes
mean faster completion. Cold loading and table construction each
have five measured samples per variant and workload. Filter reapplication has
25 measured samples per variant and workload: five applications on each of five
measured table builds, excluding the first application on each build.

The 200-entry loading/table/filter comparison comes from
`control-final-results.json`, which contains both variants in the same completed
run. The 10,000-entry cold comparison uses `baseline-results.json` and
`candidate-results.json`; the completed candidate table/filter series is in
`candidate-medium-table-results.json`. Results from these separate series are
not pooled. In particular, the medium candidate table warmup and changed-filter
sample in `candidate-results.json` are not included in the completed table or
filter medians. Loading, table, and filter code did not change in the final
search refinement, so these completed measurements remain applicable. Final
entry-query comparisons are reported in the next section. No final control or
medium name-only-query rerun is claimed from the earlier query series.

| Workload | Metric | Baseline median | Candidate median | Change |
| --- | --- | ---: | ---: | ---: |
| 200 entries | Cold initialization to ready DOM | 828.4 ms | 147.1 ms | −82.2% |
| 200 entries | Entry Manager table construction | 396.6 ms | 332.9 ms | −16.1% |
| 200 entries | Strategy filter reapplication | 0.8 ms | 0.2 ms | −75.0% |
| 10,000 entries | Cold initialization to ready DOM | 7,846.4 ms | 1,262.4 ms | −83.9% |
| 10,000 entries | Entry Manager table construction | 43,571.9 ms | 46,739.1 ms | +7.3% |
| 10,000 entries | Strategy filter reapplication | 32.6 ms | 8.7 ms | −73.3% |

Cold time starts at the extension initialization marker and ends when the
expected books are present and loading has cleared. Table time starts
at the real Entry Manager toggle and ends after the expected table rows are
observed. Filter time measures the synchronous call to reapply the current
strategy predicate, before querying the visible row count; it does not include
the layout cost of changing the selected strategy.

Both variants retained exactly 200 rows and 2,831 drawer nodes in the control
and 10,000 rows and 130,331 drawer nodes in the medium fixture. Cold reads were
exactly 10 and 20 books respectively. Filter reapplications retained 200 and
10,000 visible entry rows. These counts support equivalent results for the
measured operations, rather than reduced data or DOM coverage.

The gains are strongest in loading and redundant filter work. They do not make
every interaction faster: the final entry queries below regressed, and the
10,000-row table still took 46.7 seconds versus 43.6 seconds for baseline. The
candidate's 25 measured medium filter reapplications ranged from 6.1 to
1,875.7 ms, versus 29.4 to
50.1 ms for baseline. The improved 8.7 ms median does not rule out a slow outlier.

The original timing series also shows remaining responsiveness limits. The
median of each run's maximum timer delay during medium table construction fell
from 34,724.9 to 4,334.1 ms, while its median reported longest task rose from
2,552 to 2,844 ms. During medium cold loading, maximum timer delay increased
from 344.2 to 670.7 ms despite the much shorter total load. These are diagnostic
timer and observer measurements, not physical keyboard latency. In particular,
the original Long Task observer may not have delivered the final layout task
when the DOM marker is sampled; zero reported tasks does not prove that an
interaction avoided blocking or finished painting.

## First search, presentation, and keyboard responsiveness

The baseline records in `search-index-results.json` and final candidate records
in `search-index-final-candidate-results.json` each contain one excluded warmup
and five completed measured trials per workload: 20 measured trials in total.
The earlier candidate records in `search-index-results.json` are not included.
Every trial starts with a fresh context, waits for host startup
to settle, then searches entry contents for `__no_synthetic_match__` to populate
the search index and hide all results. The second query, `entry 00001`, uses the
populated index and returns one entry per book. Both searches issue zero new
World Info reads and retain all 200 or 10,000 drawer rows in the DOM. All measured
trials completed with their expected counts and no uncaught browser errors.

| Workload | Search and completion marker | Baseline median | Candidate median | Change |
| --- | --- | ---: | ---: | ---: |
| 200 entries | First query, DOM complete | 132.9 ms | 140.4 ms | +5.6% |
| 200 entries | First query, presentation opportunity | 149.4 ms | 164.2 ms | +9.9% |
| 200 entries | Second query, DOM complete | 127.8 ms | 136.6 ms | +6.9% |
| 200 entries | Second query, presentation opportunity | 138.4 ms | 145.7 ms | +5.3% |
| 10,000 entries | First query, DOM complete | 472.3 ms | 1,178.0 ms | +149.4% |
| 10,000 entries | First query, presentation opportunity | 1,136.5 ms | 1,283.8 ms | +13.0% |
| 10,000 entries | Second query, DOM complete | 138.2 ms | 230.3 ms | +66.6% |
| 10,000 entries | Second query, presentation opportunity | 253.3 ms | 308.6 ms | +21.8% |

The first-query Long Task statistics are read again after the presentation and
keyboard observers have had time to deliver, while retaining the original
input-to-DOM-completion interval for task admission. A task whose start is in
that interval contributes its full duration even if it ends later. That is why
a reported task can exceed the DOM-completion duration. Second-query task
statistics retain the original immediate sampling behavior; the added
presentation marker does not retroactively complete their observer delivery.

For the medium first query, the median reported longest task was 930 ms for
baseline and 69 ms for candidate, and median total reported long-task time was
930 and 69 ms. The median per-run maximum timer delay was still 983.1 versus
1,083.0 ms. These mixed diagnostics make the trusted keyboard probe useful as a
separate check of whether input can be handled during the scan.

| 10,000-entry first-query keyboard probe | Baseline | Candidate |
| --- | ---: | ---: |
| Trials with trusted key start after debounce and before query completion | 5 / 5 | 5 / 5 |
| Trials with Event Timing observations | 4 / 5 | 5 / 5 |
| Median maximum input delay per observed trial | 1,033.6 ms | 70.3 ms |
| Observed per-trial maximum input-delay range | 912.9–1,164.7 ms | 0.3–75.0 ms |
| Median Playwright keydown/up round trip, all five trials | 997.6 ms | 78.7 ms |

Input delay is `processingStart - startTime` for observed trusted keyboard
events. The Event Timing medians use four baseline observations and five
candidate observations; the missing baseline observation is not assigned zero.
The keydown/up round trip includes automation transport and both key events, so
it is not interchangeable with Event Timing input delay. In this medium fixture,
input was handled much sooner by the candidate, while the search itself reached
its presentation opportunity 13.0% later. This is a measured responsiveness
tradeoff, not an overall search-speed improvement.

The 200-entry scan was too short for a comparable during-scan keyboard test:
trusted keys overlapped zero of five baseline scans and two of five candidate
scans. Event Timing reported only one trial for each variant.
Those control keyboard samples do not support a responsiveness comparison.

## 50,000-entry stress results

The clean single-book and many-book results come from
`remaining-stress-results.json`. The distributed baseline readiness timeout is
in `baseline-results.json`; distributed candidate cold samples and its table
timeout are the valid first scenario in `candidate-stress-results.json`.
Each reported cold median excludes one warmup and uses five completed measured
loads. A timeout is not entered into a median, and a phase not reached after a
timeout has no measured result.

| 50,000-entry distribution | Baseline cold result | Candidate cold result | Retained drawer nodes / book reads per completed load |
| --- | ---: | ---: | ---: |
| 100 books × 500 entries | Readiness timed out at 180 s; no completed sample | 6,438.9 ms, n = 5 | 651,131 / 100 |
| 1 book × 50,000 entries | 23,408.3 ms, n = 5 | 8,119.3 ms, n = 5 | 650,141 / 1, both variants |
| 1,000 books × 50 entries | Cold load timed out at 180 s; no completed sample | 10,511.9 ms, n = 5 | 660,131 / 1,000 |

Every completed cold sample retained all 50,000 entry rows. The completed
single-book comparison improved cold time by 65.3%. The two baseline loading
timeouts preclude a numerical speedup comparison for their distributions. They
also prevented those baseline runs from reaching the search and table phases.

| Distribution and variant | Entry query | Name-only query restoring all rows | Entry Manager table/filter stress attempt |
| --- | --- | --- | --- |
| 100 books, candidate | 1,243.3 ms median, n = 5; 100 results | 11,301.5 ms median, n = 5; 50,000 rows restored | Timed out at 30 s; no completed table sample |
| 1 book, baseline | Complete search sequence timed out at 120 s; no completed query sample | Not completed | Not reached after search timeout |
| 1 book, candidate | Complete search sequence timed out at 120 s; no completed query sample | Not completed | Not reached after search timeout |
| 1,000 books, candidate | 1,929.1 ms median, n = 5; 1,000 results | 9,216.5 ms median, n = 5; 50,000 rows restored | Timed out at 30 s; no completed table sample |

Both completed candidate search series exclude one warmup and use five
measured queries of each type. The final distributed search-only rerun is in
`candidate-distributed-final-search-results.json`; it has no errors and replaces
the prior query series that predates the final refinement. That rerun's single
cold sample is a warmup and is not substituted for the five-sample cold median.
The entry query is `entry 00001`; the following name-only query is `STWID Perf`.
These warm-query times include the normal debounce and use DOM completion
markers, not the presentation-opportunity or keyboard protocol used for the
normal-workload search comparison above.

The distributed candidate's median per-run maximum timer delay was 1,109.9 ms
for entry search and 10,988.7 ms for name-only restoration; the many-book
candidate's values were 1,785.8 and 8,875.2 ms. The cold-load maximum timer-delay
medians were 3,605.1 ms for the distributed candidate, 2,769.3 versus 4,930.2 ms
for the single-book comparison, and 5,575.0 ms for the many-book candidate.
Faster loading does not eliminate these large-DOM blocking periods. No completed
50,000-row Entry Manager table is claimed, and the single-book search timeout
remains an unresolved stress limit.

## Functional regression validation

Run `integration.mjs` after benchmarks finish to exercise the actual drawer,
editor, search, update batching, selection, drag transfer, and Entry Manager
controls. All 11 cases passed with no uncaught browser errors, including real host
save acknowledgement, dirty-editor protection, public `jumpToEntry` navigation
to UID zero and refusal to navigate away from dirty edits, latest-payload update
batching, query reconciliation, table cancellation, range selection, drag-copy, and
drag-move. Drag events exercise the installed browser listeners with
`DragEvent`/`DataTransfer`, rather than operating-system pointer trajectories.

The final built-in Node suite passed all 81 tests with no failures. Syntax
checks passed for all 72
JavaScript files under `src`, `tests`, and the extension entry point, and
`git diff --check` passed. Failed-save recovery is covered with rejecting host
operations in the isolated tests: the supplied host does not reject an HTTP 500
response from `saveWorldInfo`, so returning HTTP 500 from a fixture route would
not test that failure contract correctly.
