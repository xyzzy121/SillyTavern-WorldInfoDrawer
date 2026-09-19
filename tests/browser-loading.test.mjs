import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createBookLoader } from '../src/book-browser/book-list/book-list.loading.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = () => new Promise((resolve) => setImmediate(resolve));

test('book reads share a four-request limit and return original order', async () => {
  const requests = new Map();
  let active = 0;
  let maximum = 0;
  const loader = createBookLoader((name) => {
    active += 1;
    maximum = Math.max(maximum, active);
    const request = deferred();
    requests.set(name, request);
    return request.promise.finally(() => { active -= 1; });
  });
  const result = loader.loadMany(['A', 'B', 'C', 'D', 'E', 'F']);
  await turn();
  assert.deepEqual([...requests.keys()], ['A', 'B', 'C', 'D']);
  requests.get('D').resolve({ entries: {} });
  await turn();
  assert.ok(requests.has('E'));
  requests.get('C').resolve({ entries: {} });
  await turn();
  for (const request of requests.values()) request.resolve({ entries: {} });
  assert.deepEqual((await result).map((book) => book.name), ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.equal(maximum, 4);
});

test('overlapping reads of one name share only the in-flight request', async () => {
  let count = 0;
  let request = deferred();
  const loader = createBookLoader(() => { count += 1; return request.promise; });
  const first = loader.load('A');
  const overlapping = loader.load('A');
  assert.equal(first, overlapping);
  request.resolve({ entries: {} });
  await first;
  request = deferred();
  const fresh = loader.load('A');
  request.resolve({ entries: { 0: {} } });
  assert.notEqual(fresh, first);
  assert.deepEqual(await fresh, { entries: { 0: {} } });
  assert.equal(count, 2);
});

test('superseded loading settles active reads without admitting more', async () => {
  const requests = [];
  let current = true;
  const loader = createBookLoader(() => {
    const request = deferred();
    requests.push(request);
    return request.promise;
  });
  const result = loader.loadMany(Array.from({ length: 20 }, (_, i) => String(i)), () => current);
  await turn();
  current = false;
  for (const request of requests) request.resolve({});
  assert.equal(await result, null);
  assert.equal(requests.length, 4);
});

test('warm cached reads yield to input and stop after that input supersedes the load', async () => {
  let current = true;
  let reads = 0;
  const loader = createBookLoader(() => { reads += 1; return { entries: {} }; });
  setTimeout(() => { current = false; }, 0);
  const result = await loader.loadMany(Array.from({ length: 1000 }, (_, i) => String(i)), () => current);
  assert.equal(result, null);
  assert.ok(reads > 0 && reads < 1000, `${reads} reads started before input was handled`);
});

test('load failure waits for all active reads and prevents additional reads', async () => {
  const requests = [];
  const loader = createBookLoader(() => {
    const request = deferred();
    requests.push(request);
    return request.promise;
  });
  const result = loader.loadMany(['A', 'B', 'C', 'D', 'E']);
  const rejection = assert.rejects(result, /read failed/);
  await turn();
  requests[0].reject(new Error('read failed'));
  await turn();
  for (const request of requests.slice(1)) request.resolve({});
  await rejection;
  assert.equal(requests.length, 4);
});

test('invalid book payloads are skipped, and disposing settles queued reads', async () => {
  const loader = createBookLoader((name) => name === 'bad' ? null : { entries: {} });
  assert.deepEqual((await loader.loadMany(['good', 'bad'])).map((book) => book.name), ['good']);
  const active = deferred();
  const limited = createBookLoader(() => active.promise, 1);
  const first = limited.load('active');
  const queued = limited.load('queued');
  limited.dispose();
  assert.equal(await queued, null);
  assert.equal(await limited.load('after disposal'), null);
  active.resolve({ entries: {} });
  await first;
});

// A minimal DOM exercises actual book assembly, cache ownership, and commit
// order without loading SillyTavern or a browser-specific testing dependency.
class Element {
  children = [];
  parentElement = null;
  dataset = {};
  classes = new Set();
  classList = {
    add: (...names) => names.forEach((name) => this.classes.add(name)),
    remove: (...names) => names.forEach((name) => this.classes.delete(name)),
    contains: (name) => this.classes.has(name),
    toggle: (name, value = !this.classes.has(name)) => value ? this.classes.add(name) : this.classes.delete(name),
  };
  get isConnected() { return this.connected || Boolean(this.parentElement?.isConnected); }
  set innerHTML(value) {
    assert.equal(value, '');
    for (const child of this.children) child.parentElement = null;
    this.children = [];
  }
  append(...children) {
    for (const child of children) {
      child.remove();
      child.parentElement = this;
      this.children.push(child);
    }
  }
  remove() {
    if (this.parentElement) {
      const children = this.parentElement.children;
      children.splice(children.indexOf(this), 1);
      this.parentElement = null;
    }
  }
  addEventListener() {}
  removeEventListener() {}
  setAttribute() {}
}

const booksSource = await readFile(new URL('../src/book-browser/book-list/book-list.books-view.js', import.meta.url), 'utf8');
const makeBooksView = async ({ load = () => ({}), checkpoint = () => null } = {}) => {
  const context = vm.createContext({ console, structuredClone, document: { createElement: () => new Element() } });
  const module = new vm.SourceTextModule(booksSource, { context });
  const stubs = {
    '../../shared/sort-helpers.js': { cloneMetadata: (metadata) => structuredClone(metadata ?? {}) },
    '../../shared/utils.js': { createWorkBudget: () => checkpoint },
    './book-list.loading.js': { createBookLoader },
  };
  await module.link((specifier) => {
    const values = stubs[specifier];
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  const root = new Element();
  root.connected = true;
  let aggregateUpdates = 0;
  const collapsed = new Map();
  const runtime = {
    Settings: { instance: { featureFolderGrouping: false } },
    cache: {},
    dom: { books: root },
    selected_world_info: [],
    world_names: ['Z', 'A'],
    loadWorldInfo: load,
    getSortFromMetadata: () => null,
    sortEntries: (entries) => entries,
    safeToSorted: (values, compare) => [...values].sort(compare),
    renderEntry(entry, name) {
      const row = new Element();
      row.dataset.uid = String(entry.uid);
      runtime.cache[name].dom.entry[entry.uid] = { root: row };
      runtime.cache[name].dom.entryList.append(row);
    },
  };
  const slice = module.namespace.createBooksViewSlice({
    runtime,
    listPanelState: {
      getCollapseState: (name) => collapsed.get(name),
      pruneCollapseStatesStaleBooks() {},
      pruneFolderCollapseStatesStaleFolders: () => 0,
    },
    coreUiSelectors: {},
    foldersViewSlice: { resetFolderDoms() {}, updateCollapseAllFoldersToggle() {} },
    selectionDnDSlice: () => null,
    bookMenuSlice: () => null,
    getFolderFromMetadata: () => null,
    getFolderRegistry: () => [],
    registerFolderName() {},
    getBookSortChoice: () => ({}),
    setCacheMetadata(name, metadata) { runtime.cache[name].metadata = metadata ?? {}; },
    updateBookSourceLinks() {},
    updateCollapseAllToggle: () => { aggregateUpdates += 1; },
    persistFolderCollapseStates() {},
    setBookCollapsed(name, value, { updateToggle }) {
      assert.ok(runtime.cache[name].dom.root.isConnected, 'collapse state applies only to committed rows');
      runtime.cache[name].dom.entryList.classList.toggle('stwid--state-collapsed', value);
      collapsed.set(name, value);
      if (updateToggle) aggregateUpdates += 1;
    },
  });
  return { slice, runtime, collapsed, getAggregateUpdates: () => aggregateUpdates };
};

test('full list renders in sorted order, retains expansion, and batches collapse summary', async () => {
  const { slice, runtime, collapsed, getAggregateUpdates } = await makeBooksView({
    load: () => ({ entries: { 0: { uid: 0, key: [] } } }),
  });
  collapsed.set('A', false);
  assert.equal(await slice.loadList(), true);
  assert.deepEqual(runtime.dom.books.children, [runtime.cache.A.dom.root, runtime.cache.Z.dom.root]);
  assert.equal(runtime.cache.A.dom.entryList.classList.contains('stwid--state-collapsed'), false);
  assert.equal(runtime.cache.Z.dom.entryList.classList.contains('stwid--state-collapsed'), true);
  assert.equal(getAggregateUpdates(), 1);
});

test('teardown while host reads are pending cannot populate cache or DOM', async () => {
  const request = deferred();
  const { slice, runtime } = await makeBooksView({ load: () => request.promise });
  const loading = slice.loadList();
  await turn();
  slice.cleanup();
  request.resolve({ entries: { 0: { uid: 0 } } });
  assert.equal(await loading, false);
  assert.equal(Object.keys(runtime.cache).length, 0);
  assert.equal(runtime.dom.books.children.length, 0);
});

test('a render superseded during a yield preserves and replaces the last committed row once', async () => {
  const pause = deferred();
  let checkpoints = 0;
  const { slice, runtime } = await makeBooksView({ checkpoint: () => ++checkpoints === 1 ? pause.promise : null });
  const original = await slice.renderBook('A', null, { entries: {} });
  const stale = slice.renderBook('A', null, { entries: { 0: { uid: 0 } } });
  await turn();
  assert.equal(original.isConnected, true);
  const latest = await slice.renderBook('A', null, { entries: {} });
  pause.resolve();
  assert.equal(await stale, null);
  assert.deepEqual(runtime.dom.books.children, [latest]);
  assert.equal(original.isConnected, false);
});

test('refresh worker coalesces startup calls and replaces obsolete work with one current pass', async () => {
  const source = await readFile(new URL('../src/book-browser/book-browser.js', import.meta.url), 'utf8');
  const listPanelState = {};
  const loads = [];
  let searches = 0;
  const noop = () => {};
  const context = vm.createContext({ console, document: { createElement: () => new Element() }, toastr: { error: assert.fail } });
  const module = new vm.SourceTextModule(source, { context });
  const valuesByFile = {
    'sort-helpers.js': { cloneMetadata: structuredClone },
    'book-folders.lorebook-folders.js': Object.fromEntries(['getFolderFromMetadata', 'getFolderRegistry', 'registerFolderName', 'sanitizeFolderMetadata', 'setFolderInMetadata'].map((key) => [key, noop])),
    'book-folders.folder-actions.js': { createBookInFolder: noop, setFolderBooksActive: noop },
    'book-folders.add-lorebooks.js': { closeAddLorebooksDialog: noop },
    'book-browser.state.js': {
      listPanelState,
      captureBookCollapseStatesFromDom: noop,
      clearCacheBooks: (cache) => Object.keys(cache).forEach((key) => delete cache[key]),
      clearEntrySearchCache: noop,
      hydrateFolderCollapseStates: noop,
      persistFolderCollapseStates: noop,
      resetBookVisibilityState: noop,
    },
    'book-browser.core-bridge.js': { CORE_UI_ACTION_SELECTORS: {}, clickCoreUiAction: noop, setSelectedBookInCoreUi: noop },
    'browser-tabs.js': {
      createFilterBarSlice: () => ({
        setupFilter: noop,
        cleanup: noop,
        invalidateSearchFilter: noop,
        refreshSearchFilter: async () => { searches += 1; },
      }),
    },
    'browser-tabs.visibility-tab.js': { BOOK_VISIBILITY_MODES: {} },
    'book-list.selection-dnd.js': { createSelectionDnDSlice: () => ({ getSelectionState: noop }) },
    'book-list.book-menu.js': { createBookMenuSlice: () => ({}) },
    'book-folders.folders-view.js': { createFoldersViewSlice: () => ({ resetFolderDoms: noop }) },
    'book-list.books-view.js': {
      createBooksViewSlice: () => ({
        invalidate: noop,
        cleanup: noop,
        loadList: ({ isCurrent }) => {
          const pending = deferred();
          loads.push({ pending, isCurrent });
          return pending.promise;
        },
      }),
    },
  };
  await module.link((specifier) => {
    const values = valuesByFile[specifier.split('/').at(-1)];
    assert.ok(values, specifier);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  const api = module.namespace.initBookBrowser({
    list: new Element(), cache: {}, dom: { drawer: { body: new Element() } },
  });
  const first = api.refreshList();
  const second = api.refreshList();
  await turn();
  assert.equal(loads.length, 1);
  const third = api.refreshList();
  assert.equal(loads[0].isCurrent(), false);
  loads[0].pending.resolve(false);
  await turn();
  assert.equal(loads.length, 2);
  assert.equal(loads[1].isCurrent(), true);
  loads[1].pending.resolve(true);
  await Promise.all([first, second, third]);
  assert.equal(searches, 1);
  const scheduled = api.refreshList();
  api.destroyListPanel();
  await scheduled;
  assert.equal(loads.length, 2, 'teardown cancels a refresh that has not started');
});
