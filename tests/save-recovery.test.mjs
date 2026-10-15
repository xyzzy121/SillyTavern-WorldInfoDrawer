import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

const turn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

async function loadModule(path, imports, globals = {}) {
  const context = createContext(globals);
  const module = new SourceTextModule(await readFile(new URL(path, import.meta.url), 'utf8'), { context });
  await module.link((specifier) => {
    assert.ok(imports[specifier], `Unexpected dependency: ${specifier}`);
    const exports = imports[specifier];
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}

async function serializerHarness() {
  const errors = [];
  const toasts = [];
  const api = await loadModule('../src/entry-manager/table/table.body.js', {
    '../../shared/utils.js': { createWorkBudget() { assert.fail('Saving must not build rows'); } },
    './table.body.row-sorting.js': { setupEntryManagerSorting() {} },
    './table.body.cells.js': { buildEntryManagerRow() {} },
    './table.hydration.js': { createTableHydration: () => ({ start() {}, dispose() {} }) },
    '../entry-manager.utils.js': { createCharacterFilterIndex: () => ({}) },
    './table.body.character-filter.js': { resetCharacterFilterCells() {} },
    './table.selection.js': { createSelectionCounter: () => ({}) },
  }, {
    console: { error: (...args) => errors.push(args) },
    toastr: { error: (message) => toasts.push(message) },
  });
  return { ...api, errors, toasts };
}

test('overlapping saves serialize per book, coalesce edits to the latest payload, and settle after the final write', async () => {
  const { createBookSaveSerializer, errors, toasts } = await serializerHarness();
  const values = { A: 1, B: 10 };
  const writes = [];
  const active = new Map();
  const settled = [];
  const enqueue = createBookSaveSerializer((name, payload, immediately) => {
    assert.equal(immediately, true);
    assert.equal(active.get(name) ?? 0, 0, `Concurrent save for ${name}`);
    active.set(name, 1);
    const gate = deferred();
    writes.push({ name, payload, gate });
    return gate.promise.finally(() => active.set(name, 0));
  }, (name) => ({ entries: { 0: { uid: 0, content: String(values[name]) } }, metadata: { book: name } }));

  const first = enqueue('A').then(() => settled.push('first'));
  values.A = 2;
  const second = enqueue('A').then(() => settled.push('second'));
  values.A = 3;
  const third = enqueue('A').then(() => settled.push('third'));
  const independent = enqueue('B');
  assert.deepEqual(writes.map(({ name }) => name), ['A', 'B']);
  assert.equal(writes[0].payload.entries[0].content, '1');
  writes[1].gate.resolve();
  await independent;
  assert.equal(active.get('A'), 1, 'Another book may finish while A is still saving');
  writes[0].gate.resolve();
  await turn();
  assert.deepEqual(writes.map(({ name, payload }) => [name, payload.entries[0].content]), [
    ['A', '1'], ['B', '10'], ['A', '3'],
  ]);
  assert.deepEqual(settled, [], 'All overlapping callers wait for the latest write');
  writes[2].gate.resolve();
  await Promise.all([first, second, third]);
  assert.equal(settled.length, 3);
  assert.deepEqual(errors, []);
  assert.deepEqual(toasts, []);
});

test('an asynchronous save rejection is reported, does not discard a queued edit, and permits future saves', async () => {
  const { createBookSaveSerializer, errors, toasts } = await serializerHarness();
  const firstWrite = deferred();
  const followupWrite = deferred();
  let revision = 1;
  const payloads = [];
  const failure = new Error('network disconnected');
  const enqueue = createBookSaveSerializer((_name, payload) => {
    payloads.push(payload.revision);
    if (payloads.length === 1) return firstWrite.promise;
    if (payloads.length === 2) return followupWrite.promise;
    return Promise.resolve();
  }, () => ({ revision }));
  const first = enqueue('A');
  revision = 2;
  const queued = enqueue('A');
  firstWrite.reject(failure);
  await turn();
  assert.deepEqual(payloads, [1, 2]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].at(-1), failure);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /Failed to save "A"/);
  followupWrite.resolve();
  await Promise.all([first, queued]);
  revision = 3;
  await enqueue('A');
  assert.deepEqual(payloads, [1, 2, 3]);
});

async function reloadHarness({ loadWorldInfo, worldInfoCache, world_names }) {
  const errors = [];
  const notifications = [];
  const api = await loadModule('../src/shared/book-reload.js', {
    './st-host.js': { loadWorldInfo, worldInfoCache, world_names },
  }, {
    console: { error: (...args) => errors.push(args) },
    toastr: { success: (...args) => notifications.push(args) },
  });
  return { ...api, errors, notifications };
}

test('failed-save reload invalidates before reads, skips failures, and preserves complete payloads through sequential reconciliation', async () => {
  const requested = ['A', 'read-failure', 'missing', 'invalid', 'reconcile-failure', 'B', 'empty'];
  const hostNames = requested.filter((name) => name !== 'missing');
  const optimisticCache = new Map(requested.map((name) => [name, { optimistic: true }]));
  const events = [];
  const reconciled = [];
  const firstReconciliation = deferred();
  const tableRefresh = deferred();
  let refreshes = 0;
  let finished = false;
  const payloadA = {
    entries: { 0: { uid: 0, content: 'saved truth', extensions: { retained: true } } },
    metadata: { folder: 'Folder/A', extension: { nested: [1, 2] } },
    originalData: { preserved: ['legacy', 'field'] },
    customExtra: { enabled: false },
  };
  const payloadB = { entries: { 7: { uid: 7, content: 'B truth' } }, metadata: { label: 'B' }, extra: 42 };
  const payloads = { A: payloadA, B: payloadB, empty: { entries: {}, metadata: { empty: true }, extra: 'retained' } };
  const snapshots = structuredClone(payloads);
  const h = await reloadHarness({
    world_names: hostNames,
    worldInfoCache: {
      delete(name) { events.push(`delete:${name}`); return optimisticCache.delete(name); },
      set() { assert.fail('An extension reload must not repopulate the host cache itself'); },
    },
    loadWorldInfo: async (name) => {
      assert.equal(optimisticCache.has(name), false, `Read ${name} before invalidating optimistic cache`);
      events.push(`read:${name}`);
      if (name === 'read-failure') throw new Error('disk unavailable');
      if (name === 'invalid') return { metadata: {} };
      return payloads[name] ?? { entries: {} };
    },
  });
  h.registerBookReloadHooks({ reconcileBook: async (name, data) => {
    events.push(`reconcile:${name}`);
    if (name === 'reconcile-failure') throw new Error('DOM reconciliation failed');
    reconciled.push({ name, data });
    if (name === 'A') await firstReconciliation.promise;
    events.push(`reconciled:${name}`);
  } });
  // Registering the second owner must preserve the first owner's hook.
  h.registerBookReloadHooks({ refreshEntryManager: async () => {
    refreshes += 1;
    events.push('refresh:table');
    await tableRefresh.promise;
  } });
  const reloading = h.reloadBooksFromDisk(requested).then((names) => { finished = true; return names; });
  await turn();
  assert.deepEqual(events, ['delete:A', 'read:A', 'reconcile:A']);
  assert.equal(refreshes, 0);
  firstReconciliation.resolve();
  await turn();
  assert.equal(refreshes, 1);
  assert.equal(finished, false, 'Reload completion waits for the final table refresh');
  assert.deepEqual(events.filter((event) => event.startsWith('read:')), requested.map((name) => `read:${name}`));
  assert.ok(events.indexOf('reconciled:A') < events.indexOf('read:read-failure'));
  assert.ok(events.indexOf('reconciled:B') < events.indexOf('read:empty'));
  assert.equal(events.at(-1), 'refresh:table');
  assert.deepEqual(reconciled.map(({ name }) => name), ['A', 'B', 'empty']);
  assert.equal(reconciled[0].data, payloadA, 'Metadata and extras are handed off intact');
  assert.equal(reconciled[1].data, payloadB);
  assert.deepEqual(payloads, snapshots);
  tableRefresh.resolve();
  assert.deepEqual(Array.from(await reloading), ['A', 'B', 'empty']);
  assert.equal(h.errors.length, 4);
  const messages = h.errors.map((args) => args.join(' ')).join('\n');
  assert.match(messages, /Failed to reload "read-failure"/);
  assert.match(messages, /"missing" is no longer in the host's book list/);
  assert.match(messages, /Could not reload "invalid"/);
  assert.match(messages, /Failed to apply the reloaded data for "reconcile-failure"/);
  assert.deepEqual(h.notifications, []);
});

test('reload attempts with no reconciled book do not refresh the table or report success', async () => {
  let refreshes = 0;
  const h = await reloadHarness({
    world_names: ['A'], worldInfoCache: { delete() {} },
    loadWorldInfo: async () => ({ entries: {} }),
  });
  h.registerBookReloadHooks({
    reconcileBook: async () => { throw new Error('reconciliation failed'); },
    refreshEntryManager: () => { refreshes += 1; },
  });
  assert.deepEqual(Array.from(await h.reloadBooksFromDisk(['missing', 'A'])), []);
  assert.equal(refreshes, 0);
  assert.equal(h.errors.length, 2);
  assert.deepEqual(h.notifications, []);
});

test('a failed final table refresh is explicitly logged without claiming UI recovery', async () => {
  const refreshFailure = new Error('table rebuild failed');
  let reconciled = false;
  const h = await reloadHarness({
    world_names: ['A'], worldInfoCache: { delete() {} },
    loadWorldInfo: async () => ({ entries: {}, metadata: { source: 'disk' } }),
  });
  h.registerBookReloadHooks({
    reconcileBook: async () => { reconciled = true; },
    refreshEntryManager: async () => { throw refreshFailure; },
  });
  const restoredData = await h.reloadBooksFromDisk(['A']);
  // The return contract names successful data reloads. A later table failure is
  // reported separately; it must neither disappear nor generate a success toast.
  assert.deepEqual(Array.from(restoredData), ['A']);
  assert.equal(reconciled, true);
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0][1], /Failed to refresh the Entry Manager after a reload/);
  assert.equal(h.errors[0].at(-1), refreshFailure);
  assert.deepEqual(h.notifications, []);
});
