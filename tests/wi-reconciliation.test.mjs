import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createDeferred, createWorkBudget } from '../src/shared/utils.js';
import { createUpdateQueue } from '../src/shared/update-queue.js';
import { syncEntryToggleChecked } from '../src/shared/entry-toggle-a11y.js';

const source = await readFile(new URL('../src/shared/wi-update-handler.js', import.meta.url), 'utf8');
const turn = () => new Promise((resolve) => setImmediate(resolve));
const makeHandler = async ({ load = async () => ({}), names = [], budget = createWorkBudget, hooks = {} } = {}) => {
  const context = vm.createContext({
    console, structuredClone, document: { querySelector: () => null },
    SillyTavern: { getContext: () => ({}) },
  });
  const module = new vm.SourceTextModule(source, { context });
  const stubs = {
    './st-host.js': { delay: async () => {}, loadWorldInfo: load, saveWorldInfo: async () => {}, selected_world_info: [], world_names: names },
    './settings.js': { Settings: { instance: { sortLogic: 'uid', sortDirection: 'ascending' } } },
    './original-data.js': { mirrorRawBookFieldsToOriginalData() {} },
    './book-reload.js': { registerBookReloadHooks() {} },
    './sort-helpers.js': {
      cloneMetadata: (metadata) => structuredClone(metadata ?? {}),
      getSortFromMetadata: () => null,
      sortEntries: (entries) => [...entries].sort((a, b) => a.uid - b.uid),
    },
    './utils.js': { createDeferred, createWorkBudget: budget },
    './update-queue.js': { createUpdateQueue },
    './entry-toggle-a11y.js': { syncEntryToggleChecked },
  };
  await module.link((specifier) => {
    const values = stubs[specifier];
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  module.namespace.registerUiRefreshHooks({
    waitForListRefreshIdle: async () => {}, refreshSearchFilter: async () => {}, invalidateSearchFilter() {},
    renderEntry: async () => {}, entryState: () => 'normal', ...hooks,
  });
  return module.namespace;
};

const makeBook = (entries = { 0: { uid: 0, comment: 'old', key: [] } }) => ({
  entries: structuredClone(entries), metadata: {}, extras: { version: 'original' },
  dom: {
    root: { remove() {} },
    entry: Object.fromEntries(Object.entries(entries).map(([uid, entry]) => [uid, {
      root: { remove() {}, click: () => assert.fail('editor must not reopen') },
      comment: { textContent: entry.comment }, key: { textContent: '' },
    }])),
  },
});
const syncOptions = (cache, data) => ({
  bookName: 'A', cache, data,
  listPanelApi: {
    setCacheMetadata(name, metadata) { cache[name].metadata = metadata; },
    sortEntriesIfNeeded() {},
  },
  editorPanelApi: { markClean: () => assert.fail('reconciliation must not mark an unsaved editor clean') },
  getCurrentEditor: () => ({ name: 'A', uid: '0' }), setCurrentEditor() {},
  shouldAutoRefreshEditor: () => false,
});

test('missing book reads that settle after teardown cannot render or start another read', async () => {
  const { renderMissingBooks } = await makeHandler();
  const read = createDeferred();
  let current = true;
  let reads = 0;
  const result = renderMissingBooks({
    cache: {}, worldNames: ['A', 'B'], isCurrent: () => current,
    loadWorldInfoForBook: () => { reads += 1; return read.promise; },
    listPanelApi: { renderBook: () => assert.fail('stale book rendered') },
  });
  current = false;
  read.resolve({ entries: {} });
  assert.equal(await result, false);
  assert.equal(reads, 1);
});

test('missing book anchor is resolved from current cache after the host read', async () => {
  const { renderMissingBooks } = await makeHandler();
  const read = createDeferred();
  const cache = { Z: makeBook() };
  const freshRoot = {};
  let args;
  const result = renderMissingBooks({
    cache, worldNames: ['A'], loadWorldInfoForBook: () => read.promise,
    listPanelApi: { renderBook: (...values) => { args = values; } },
  });
  delete cache.Z;
  cache.B = { dom: { root: freshRoot } };
  read.resolve({ entries: {} });
  assert.equal(await result, true);
  assert.equal(args[1], freshRoot);
  assert.equal(args[4].refreshSearch, false);
  assert.equal(args[4].isCurrent(), true);
});

test('another render completing during a missing-book read prevents duplicate insertion', async () => {
  const { renderMissingBooks } = await makeHandler();
  const read = createDeferred();
  const cache = {};
  const result = renderMissingBooks({
    cache, worldNames: ['A'], loadWorldInfoForBook: () => read.promise,
    listPanelApi: { renderBook: () => assert.fail('duplicate book rendered') },
  });
  cache.A = makeBook();
  read.resolve({ entries: {} });
  assert.equal(await result, true);
});

for (const replace of ['book', 'entries', 'dom']) {
  test(`entry reconciliation cannot overwrite replacement ${replace} after an awaited row render`, async () => {
    const gate = createDeferred();
    const { syncBookEntriesAndDom } = await makeHandler({ hooks: { renderEntry: () => gate.promise } });
    const cache = { A: makeBook() };
    const options = syncOptions(cache, { entries: { 0: { uid: 0, comment: 'stale' }, 1: { uid: 1 } }, metadata: { stale: true } });
    const result = syncBookEntriesAndDom(options);
    await turn();
    const replacement = makeBook({ 9: { uid: 9, comment: 'fresh' } });
    if (replace === 'book') cache.A = replacement;
    else if (replace === 'entries') cache.A.entries = replacement.entries;
    else cache.A.dom = replacement.dom;
    const snapshot = { entries: cache.A.entries, dom: cache.A.dom, metadata: cache.A.metadata };
    gate.resolve();
    assert.equal(await result, false);
    assert.equal(cache.A.entries, snapshot.entries);
    assert.equal(cache.A.dom, snapshot.dom);
    assert.equal(cache.A.metadata, snapshot.metadata);
  });
}

test('field reconciliation commits before a scheduled optimistic edit and preserves its queued save', async () => {
  const { syncBookEntriesAndDom } = await makeHandler({
    budget: () => assert.fail('mutable reconciliation must not schedule UI-task checkpoints'),
  });
  const entries = Object.fromEntries(Array.from({ length: 500 }, (_, uid) => [uid, { uid, comment: 'old', key: [] }]));
  const cache = { A: makeBook(entries) };
  const incoming = structuredClone(entries);
  for (const entry of Object.values(incoming)) entry.comment = 'host update';
  const priorSave = createDeferred();
  let queuedSave;
  const uiTask = new Promise((resolve) => setImmediate(() => {
    assert.equal(cache.A.entries[0].comment, 'host update');
    cache.A.entries[0].comment = 'new optimistic edit';
    queuedSave = priorSave.promise.then(() => structuredClone(cache.A.entries));
    resolve();
  }));
  const reconciliation = syncBookEntriesAndDom(syncOptions(cache, { entries: incoming }));
  // No entry was added, so the cache is published in the calling task.
  assert.equal(cache.A.entries[0].comment, 'host update');
  assert.equal(await reconciliation, true);
  await uiTask;
  priorSave.resolve();
  assert.equal((await queuedSave)[0].comment, 'new optimistic edit');
  assert.equal(cache.A.entries[0].comment, 'new optimistic edit');
});

test('unchanged and externally changed entries both preserve a dirty editor', async () => {
  const { syncBookEntriesAndDom } = await makeHandler();
  const cache = { A: makeBook() };
  assert.equal(await syncBookEntriesAndDom(syncOptions(cache, { entries: { 0: { uid: 0, comment: 'old', key: [] } } })), true);
  assert.equal(await syncBookEntriesAndDom(syncOptions(cache, { entries: { 0: { uid: 0, comment: 'external', key: [] } } })), true);
  assert.equal(cache.A.dom.entry[0].comment.textContent, 'external');
  assert.equal(cache.A.entries[0].comment, 'external');
});

test('updates to unmounted books reconcile all data without creating rows', async () => {
  const handler = await makeHandler({ hooks: { renderEntry: () => assert.fail('unmounted book must not create rows') } });
  const book = makeBook();
  book.dom.entry = {};
  book.rowRender = { status: 'unmounted', revision: 0 };
  const cache = { A: book };
  const entries = {
    0: { uid: 0, comment: 'changed', key: ['new'], disable: true, constant: true, vectorized: false },
    1: { uid: 1, comment: 'added', key: [] },
  };
  const changes = [];
  handler.registerEntryChangeHook((name, uid, entry) => changes.push([name, uid, entry]));
  assert.equal(await handler.syncBookEntriesAndDom(syncOptions(cache, { entries })), true);
  assert.deepEqual(structuredClone(cache.A.entries), entries);
  assert.equal(Object.keys(cache.A.dom.entry).length, 0);
  assert.equal(book.searchChanged, true);
  assert.equal(changes.length, 2);
  assert.equal(changes[0][2], cache.A.entries[changes[0][1]], 'view hooks receive committed data');
});

test('external enabled updates and save recovery synchronize the mounted switch state', async () => {
  const handler = await makeHandler();
  const cache = { A: makeBook({ 0: { uid: 0, disable: false, key: [] } }) };
  const classes = new Set(['fa-toggle-on']);
  const attributes = new Map([['aria-checked', 'true']]);
  cache.A.dom.entry[0].isEnabled = {
    classList: {
      contains: (name) => classes.has(name),
      toggle: (name, force) => force ? classes.add(name) : classes.delete(name),
    },
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
  };
  for (const disable of [true, false]) {
    const options = syncOptions(cache, { entries: { 0: { uid: 0, disable, key: [] } } });
    assert.equal(await handler.syncBookEntriesAndDom(options), true);
    assert.equal(classes.has('fa-toggle-on'), !disable);
    assert.equal(attributes.get('aria-checked'), String(!disable));
  }
});

test('deleting the final expanded book updates collapse-all once after structural reconciliation', async () => {
  const handler = await makeHandler({ names: ['A'] });
  const cache = { A: makeBook(), deleted: makeBook() };
  let updates = 0;
  const api = handler.initWIUpdateHandler({
    cache, getCurrentEditor: () => null, setCurrentEditor() {},
    getEditorPanelApi: () => null, getRefreshBookSourceLinks: () => null,
    getListPanelApi: () => ({
      updateCollapseAllToggle() {
        updates++;
        assert.deepEqual(Object.keys(cache), ['A']);
      },
    }),
  });
  await api.updateWIChange();
  assert.equal(updates, 1);
  await api.updateWIChange();
  assert.equal(updates, 1, 'Data-only reconciliation does not redo the structural control update');
  api.cleanup();
});

test('content-only updates skip title sorting and search but still affect length sort', async () => {
  const { syncBookEntriesAndDom, affectsEntrySort } = await makeHandler();
  const cache = { A: makeBook() };
  const options = syncOptions(cache, { entries: { 0: { ...cache.A.entries[0], content: 'new words' } } });
  options.listPanelApi.getBookSortChoice = () => ({ sort: 'title' });
  options.listPanelApi.sortEntriesIfNeeded = () => assert.fail('content does not affect title order');
  await syncBookEntriesAndDom(options);
  assert.equal(cache.A.searchChanged, false);
  assert.equal(affectsEntrySort(new Set(['content']), 'length'), true);
  assert.equal(affectsEntrySort(new Set(['comment']), 'uid'), true, 'fallback title participates in every sort');
  assert.equal(affectsEntrySort(new Set(['order']), 'prompt'), true);
  assert.equal(affectsEntrySort(new Set(['extensions']), 'custom'), true);
});

test('successful reconciliation offers exactly one matching open-entry acknowledgement after commit', async () => {
  const { syncBookEntriesAndDom } = await makeHandler();
  const cache = { A: makeBook() };
  const options = syncOptions(cache, { entries: { 0: { uid: 0, comment: 'saved', key: [] } }, metadata: { committed: true } });
  let acknowledgements = 0;
  options.editorPanelApi.markCleanIfSaved = (name, uid, savedEntry) => {
    acknowledgements += 1;
    assert.equal(name, 'A');
    assert.equal(uid, '0');
    assert.equal(savedEntry, cache.A.entries[0]);
    assert.equal(savedEntry.comment, 'saved');
    assert.equal(cache.A.metadata.committed, true);
  };
  assert.equal(await syncBookEntriesAndDom(options), true);
  assert.equal(acknowledgements, 1);
  options.getCurrentEditor = () => ({ name: 'another book', uid: '0' });
  await syncBookEntriesAndDom(options);
  assert.equal(acknowledgements, 1);
});

test('a superseded batch waits for the authoritative list rebuild without rendering its stale read', async () => {
  const read = createDeferred();
  const refreshed = createDeferred();
  let current = true;
  let waits = 0;
  const handler = await makeHandler({
    names: ['A'], load: () => read.promise,
    hooks: { waitForListRefreshIdle: () => ++waits === 1 ? Promise.resolve() : refreshed.promise },
  });
  const api = handler.initWIUpdateHandler({
    cache: {}, getCurrentEditor: () => null, setCurrentEditor() {},
    getEditorPanelApi: () => null, getRefreshBookSourceLinks: () => null,
    getListPanelApi: () => ({
      captureRefreshGuard: () => () => current,
      renderBook: () => assert.fail('stale render'),
      updateCollapseAllToggle: () => assert.fail('stale batch must not update collapse-all'),
    }),
  });
  let finished = false;
  const result = api.updateWIChange().then(() => { finished = true; });
  await turn();
  current = false;
  read.resolve({ entries: {} });
  await turn();
  assert.equal(waits, 2);
  assert.equal(finished, false);
  refreshed.resolve();
  await result;
  api.cleanup();
});
