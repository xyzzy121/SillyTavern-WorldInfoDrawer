import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { createWorkBudget } from '../src/shared/utils.js';

const filterClass = 'stwid--filter-query';

class Element {
  constructor() {
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    };
    this.listeners = new Map();
    this.children = [];
    this.value = '';
    this.checked = false;
  }
  setAttribute() {}
  append(...children) { this.children.push(...children); }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  removeEventListener(name, handler) {
    if (this.listeners.get(name) === handler) this.listeners.delete(name);
  }
  dispatchEvent(event) { this.listeners.get(event.type)?.(event); }
}

const makeBook = (count, comment = 'Needle') => {
  const entries = Object.create(null);
  const entryDoms = Object.create(null);
  for (let uid = 0; uid < count; uid += 1) {
    entries[uid] = { uid, comment: `${comment} ${uid}`, key: [`key-${uid}`] };
    entryDoms[uid] = { root: new Element() };
  }
  return { entries, dom: { root: new Element(), entry: entryDoms } };
};

const makeHarness = async (cache = { Library: makeBook(3) }) => {
  const timers = new Map();
  const budgets = [];
  let timerId = 0;
  let yieldsUntilBlocked = 0;
  let releaseYield;
  let folderUpdates = 0;
  const context = createContext({
    console,
    Set,
    document: { createElement: () => new Element() },
    setTimeout: (callback, milliseconds) => {
      timers.set(++timerId, { callback, milliseconds });
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  const stateModule = new SourceTextModule(
    await readFile(new URL('../src/book-browser/book-browser.state.js', import.meta.url), 'utf8'),
    { context },
  );
  await stateModule.link(() => new SyntheticModule(['setFolderCollapsed'], function () {
    this.setExport('setFolderCollapsed', () => {});
  }, { context }));
  await stateModule.evaluate();

  const searchModule = new SourceTextModule(
    await readFile(new URL('../src/book-browser/browser-tabs/browser-tabs.search-tab.js', import.meta.url), 'utf8'),
    { context },
  );
  await searchModule.link(() => new SyntheticModule(['createWorkBudget'], function () {
    this.setExport('createWorkBudget', (options) => {
      budgets.push(options);
      return createWorkBudget({
        ...options,
        now: () => 0,
        yieldTask: () => {
          if (!yieldsUntilBlocked || --yieldsUntilBlocked > 0) return Promise.resolve();
          return new Promise((resolve) => { releaseYield = resolve; });
        },
      });
    });
  }, { context }));
  await searchModule.evaluate();
  const state = stateModule.namespace.listPanelState;
  const runtime = { cache };
  const controls = searchModule.namespace.createSearchRow(state, runtime, () => { folderUpdates += 1; });
  return {
    state,
    runtime,
    controls,
    timers,
    budgets,
    clearCache: stateModule.namespace.clearEntrySearchCache,
    get folderUpdates() { return folderUpdates; },
    blockNextYield() { yieldsUntilBlocked = 1; },
    blockYield(number) { yieldsUntilBlocked = number; },
    releaseYield() { assert.equal(typeof releaseYield, 'function'); releaseYield(); },
    fireTimers() {
      for (const [id, { callback }] of [...timers]) {
        timers.delete(id);
        callback();
      }
    },
  };
};

test('cache admits at most 10,000 entries, updates at capacity, and reclaims pruned space', async () => {
  const { state, clearCache } = await makeHarness();
  for (let uid = 0; uid < 10_500; uid += 1) {
    state.setEntrySearchCacheValue('Library', uid, { signature: String(uid), text: String(uid) });
  }
  assert.equal(state.entrySearchCacheEntryCount, 10_000);
  assert.equal(Object.keys(state.entrySearchCache.Library).length, 10_000);
  assert.equal(state.getEntrySearchCacheValue('Library', 0).text, '0');
  assert.equal(state.getEntrySearchCacheValue('Library', 10_000), undefined);
  assert.equal(state.setEntrySearchCacheValue('Library', 0, { text: 'edited' }), true);
  assert.equal(state.getEntrySearchCacheValue('Library', 0).text, 'edited');
  assert.equal(state.setEntrySearchCacheValue('Other', 0, {}), false);
  assert.equal(state.entrySearchCache.Other, undefined);

  state.pruneEntrySearchCacheStaleEntries('Library', new Set(['0', '9999']));
  assert.equal(state.entrySearchCacheEntryCount, 2);
  assert.equal(state.setEntrySearchCacheValue('Other', 0, {}), true);
  state.pruneEntrySearchCacheStaleBooks(['Other']);
  assert.equal(state.entrySearchCacheEntryCount, 1);
  clearCache();
  assert.equal(state.entrySearchCacheEntryCount, 0);
  assert.equal(Object.keys(state.entrySearchCache).length, 0);
});

test('UID zero matches, signatures detect edits at capacity, and removed UIDs are pruned', async () => {
  const book = makeBook(2);
  const harness = await makeHarness({ Library: book });
  const { controls, state } = harness;
  state.setEntrySearchCacheValue('Library', 0, { signature: 'Old memo\nold-key', text: 'old memo\nold-key' });
  for (let uid = 1; uid < 10_000; uid += 1) state.setEntrySearchCacheValue('Library', uid, {});
  controls.searchEntriesCheckbox.checked = true;
  controls.search.value = 'needle 0';
  assert.equal(await controls.refreshSearchFilter(), true);
  assert.equal(book.dom.entry[0].root.classList.contains(filterClass), false);
  assert.equal(book.dom.entry[1].root.classList.contains(filterClass), true);
  assert.equal(state.getEntrySearchCacheValue('Library', 0).text, 'needle 0\nkey-0');
  assert.equal(state.entrySearchCacheEntryCount, 2);
  book.entries[0].comment = 'Changed memo';
  book.entries[0].key = ['changed-key'];
  controls.search.value = 'changed-key';
  await controls.refreshSearchFilter();
  assert.equal(book.dom.entry[0].root.classList.contains(filterClass), false);
  assert.equal(state.getEntrySearchCacheValue('Library', 0).text, 'changed memo\nchanged-key');
  delete book.entries[1];
  await controls.refreshSearchFilter();
  assert.equal(state.entrySearchCacheEntryCount, 1);
});

test('unmounted books search canonical data and stop after the first match', async () => {
  const book = makeBook(500);
  book.dom.entry = {};
  book.rowRender = { status: 'unmounted' };
  let reads = 0;
  Object.defineProperty(book.entries[1], 'comment', { get() { reads += 1; return 'later'; } });
  const { controls } = await makeHarness({ Library: book });
  controls.searchEntriesCheckbox.checked = true;
  controls.search.value = 'needle 0';
  assert.equal(await controls.refreshSearchFilter(), true);
  assert.equal(book.dom.root.classList.contains(filterClass), false);
  assert.equal(reads, 0, 'visibility needs only the first match');
  controls.search.value = 'missing';
  assert.equal(await controls.refreshSearchFilter(), true);
  assert.equal(book.dom.root.classList.contains(filterClass), true);
  assert.equal(Object.keys(book.dom.entry).length, 0);
});

test('scoped save refresh avoids reading unchanged books after a completed query', async () => {
  const first = makeBook(1);
  const untouched = makeBook(1);
  first.dom.entry = {};
  untouched.dom.entry = {};
  first.rowRender = untouched.rowRender = { status: 'unmounted' };
  const { controls } = await makeHarness({ First: first, Untouched: untouched });
  controls.searchEntriesCheckbox.checked = true;
  controls.search.value = 'needle';
  await controls.refreshSearchFilter();
  Object.defineProperty(untouched, 'entries', { get() { assert.fail('unaffected books must not be scanned'); } });
  first.entries[0].comment = 'changed';
  assert.equal(await controls.refreshSearchFilter(new Set(['First'])), true);
  assert.equal(first.dom.root.classList.contains(filterClass), true);
  assert.equal(untouched.dom.root.classList.contains(filterClass), false);
});

test('name-only, short queries, and clearing restore filtered rows without enumerating entries', async () => {
  const book = makeBook(3);
  const { controls } = await makeHarness({ Library: book });
  controls.searchEntriesCheckbox.checked = true;
  controls.search.value = 'needle 0';
  await controls.refreshSearchFilter();
  assert.equal(book.dom.entry[1].root.classList.contains(filterClass), true);
  book.entries = new Proxy(book.entries, { ownKeys() { throw new Error('Name-only search scanned entries'); } });
  controls.search.value = 'Library';
  await controls.refreshSearchFilter();
  assert.equal(book.dom.entry[1].root.classList.contains(filterClass), false);
  controls.search.value = 'x';
  await controls.refreshSearchFilter();
  assert.equal(book.dom.root.classList.contains(filterClass), true);
  controls.search.value = '';
  await controls.refreshSearchFilter();
  assert.equal(book.dom.root.classList.contains(filterClass), false);
  controls.searchEntriesCheckbox.checked = false;
  controls.search.value = 'missing';
  await controls.refreshSearchFilter();
  assert.equal(book.dom.root.classList.contains(filterClass), true);
});

test('new input immediately cancels a staged scan before it changes row or book visibility', async () => {
  const book = makeBook(450);
  const harness = await makeHarness({ Library: book });
  const { controls } = harness;
  controls.searchEntriesCheckbox.checked = true;
  controls.search.value = 'absent';
  harness.blockNextYield();
  const previousRun = controls.refreshSearchFilter();
  assert.equal(book.dom.entry[199].root.classList.contains(filterClass), false);
  assert.equal(book.dom.entry[200].root.classList.contains(filterClass), false);
  assert.equal(book.dom.root.classList.contains(filterClass), false);
  controls.search.value = '';
  controls.search.dispatchEvent({ type: 'input' });
  assert.equal(harness.timers.size, 1);
  assert.equal([...harness.timers.values()][0].milliseconds, 125);
  harness.releaseYield();
  assert.equal(await previousRun, false);
  assert.equal(book.dom.entry[200].root.classList.contains(filterClass), false);
  assert.equal(harness.folderUpdates, 0);
  await controls.refreshSearchFilter();
  assert.equal(harness.timers.size, 0);
  for (const { root } of Object.values(book.dom.entry)) assert.equal(root.classList.contains(filterClass), false);
  assert.equal(harness.folderUpdates, 1);
  assert.equal(harness.budgets[0].maxItems, 200);
  assert.equal(harness.budgets[0].budgetMs, 8);
});

test('confirmed misses are hidden before row writes and cancellation restores partially applied filters', async () => {
  const book = makeBook(450);
  const harness = await makeHarness({ Library: book });
  const { controls } = harness;
  controls.searchEntriesCheckbox.checked = true;
  controls.search.value = 'absent';
  // The first two checkpoints scan entries. The third occurs after scanning
  // finishes and 150 row updates consume the remainder of the shared budget.
  const addRowClass = book.dom.entry[0].root.classList.add;
  book.dom.entry[0].root.classList.add = (...names) => {
    if (names.includes(filterClass)) assert.equal(book.dom.root.classList.contains(filterClass), true);
    addRowClass(...names);
  };
  harness.blockYield(3);
  const pending = controls.refreshSearchFilter();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(book.dom.root.classList.contains(filterClass), true);
  assert.equal(book.dom.entry[149].root.classList.contains(filterClass), true);
  assert.equal(book.dom.entry[150].root.classList.contains(filterClass), false);
  controls.search.value = '';
  controls.search.dispatchEvent({ type: 'input' });
  harness.releaseYield();
  assert.equal(await pending, false);
  assert.equal(harness.folderUpdates, 0);
  assert.equal(await controls.refreshSearchFilter(), true);
  assert.equal(book.dom.root.classList.contains(filterClass), false);
  for (const { root } of Object.values(book.dom.entry)) assert.equal(root.classList.contains(filterClass), false);
  assert.equal(harness.folderUpdates, 1);
});

test('matching books stay visible during both staged scanning and row application', async () => {
  const book = makeBook(450);
  const harness = await makeHarness({ Library: book });
  const { controls } = harness;
  const addClass = book.dom.root.classList.add;
  book.dom.root.classList.add = (...names) => {
    assert.equal(names.includes(filterClass), false, 'a matching book must never be temporarily hidden');
    addClass(...names);
  };
  controls.searchEntriesCheckbox.checked = true;
  controls.search.value = 'needle 449';
  harness.blockYield(3);
  const pending = controls.refreshSearchFilter();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(book.dom.root.classList.contains(filterClass), false);
  assert.equal(book.dom.entry[149].root.classList.contains(filterClass), true);
  harness.releaseYield();
  assert.equal(await pending, true);
  assert.equal(book.dom.entry[449].root.classList.contains(filterClass), false);
  assert.equal(book.dom.root.classList.contains(filterClass), false);
  assert.equal(harness.folderUpdates, 1);
});

test('replaced books stop pending searches before further DOM writes', async () => {
  const oldBook = makeBook(450);
  const harness = await makeHarness({ Library: oldBook });
  harness.controls.searchEntriesCheckbox.checked = true;
  harness.controls.search.value = 'absent';
  harness.blockNextYield();
  const pending = harness.controls.refreshSearchFilter();
  const replacement = makeBook(3, 'Replacement');
  harness.runtime.cache.Library = replacement;
  harness.releaseYield();
  assert.equal(await pending, false);
  assert.equal(oldBook.dom.entry[200].root.classList.contains(filterClass), false);
  assert.equal(harness.folderUpdates, 0);
  harness.controls.search.value = 'replacement';
  assert.equal(await harness.controls.refreshSearchFilter(), true);
  assert.equal(replacement.dom.root.classList.contains(filterClass), false);
  assert.equal(harness.folderUpdates, 1);
});

test('checkbox changes cancel active searches and cleanup cancels timers and pending work', async () => {
  const book = makeBook(450);
  const harness = await makeHarness({ Library: book });
  const { controls } = harness;
  controls.searchEntriesCheckbox.checked = true;
  controls.search.value = 'absent';
  harness.blockNextYield();
  const pending = controls.refreshSearchFilter();
  controls.searchEntriesCheckbox.checked = false;
  controls.searchEntriesCheckbox.dispatchEvent({ type: 'click' });
  harness.releaseYield();
  assert.equal(await pending, false);
  assert.equal(harness.timers.size, 1);
  controls.cleanup();
  assert.equal(harness.timers.size, 0);
  harness.fireTimers();
  assert.equal(await controls.refreshSearchFilter(), false);
  assert.equal(harness.folderUpdates, 0);

  const active = await makeHarness({ Library: makeBook(450) });
  active.controls.searchEntriesCheckbox.checked = true;
  active.controls.search.value = 'absent';
  active.blockNextYield();
  const activeRun = active.controls.refreshSearchFilter();
  active.controls.cleanup();
  active.releaseYield();
  assert.equal(await activeRun, false);
  assert.equal(active.folderUpdates, 0);
});

test('a completed multi-book entry search aggregates folder state exactly once', async () => {
  const harness = await makeHarness({ Alpha: makeBook(250), Beta: makeBook(250) });
  harness.controls.searchEntriesCheckbox.checked = true;
  harness.controls.search.value = 'needle';
  assert.equal(await harness.controls.refreshSearchFilter(), true);
  assert.equal(harness.folderUpdates, 1);
  assert.equal(harness.state.entrySearchCacheEntryCount, 500);
});
