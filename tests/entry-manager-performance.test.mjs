import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { createEntryManagerFilters } from '../src/entry-manager/logic/logic.filters.js';
import { createWorkBudget } from '../src/shared/utils.js';

const turn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.dataset = {};
    this.value = '';
    this.style = { setProperty() {} };
    this.isConnected = true;
    this.classUpdates = 0;
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, enabled = !classes.has(name)) => {
        this.classUpdates += 1;
        if (enabled) classes.add(name); else classes.delete(name);
        return enabled;
      },
    };
  }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  dispatch(name) { this.listeners.get(name)?.({ type: name, target: this }); }
  contains(target) { return this === target || this.children.some((child) => child.contains?.(target)); }
  find(predicate) {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const result = child.find?.(predicate);
      if (result) return result;
    }
  }
}

async function loadModule(path, imports, globals = {}) {
  const context = createContext({ console, ...globals });
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

function filterHarness() {
  const state = {
    book: 'A',
    strategyValues: ['normal', 'constant'], positionValues: ['0', '4'],
    recursionValues: ['excludeRecursion', 'preventRecursion', 'delayUntilRecursion'],
    outletValues: ['', 'port'], automationIdValues: ['', 'auto'], groupValues: ['', 'red', 'blue'],
    filters: {
      strategy: ['constant'], position: ['4'], recursion: ['excludeRecursion'],
      outlet: ['port'], automationId: ['auto'], group: ['red'],
      characterFilterPresence: ['has'], characterFilterValue: ['character:Alice'],
    },
  };
  const baseline = {
    uid: 1, strategy: 'constant', position: 4, excludeRecursion: true,
    outletName: 'port', automationId: 'auto', group: 'blue,red',
    characterFilter: { names: ['Alice'], tags: [], isExclude: true },
  };
  const entries = [
    { book: 'A', data: baseline },
    { book: 'A', data: { ...baseline, uid: 2, position: 0 } },
    { book: 'B', data: { ...baseline, uid: 3 } },
    { book: 'A', data: { ...baseline, uid: 4, group: '', characterFilter: undefined } },
  ];
  const dom = { order: { entries: { A: {}, B: {} }, filter: {} } };
  for (const { book, data } of entries) dom.order.entries[book][data.uid] = new Element('tr');
  let sourceReads = 0;
  const api = createEntryManagerFilters({
    dom, entryManagerState: state, entryState: (entry) => entry.strategy,
    getEntryManagerEntries: () => assert.fail('Filtering must not request sorted entries'),
    getEntryManagerSourceEntries: (book) => {
      sourceReads += 1;
      return entries.filter((entry) => !book || entry.book === book);
    },
    getStrategyValues: () => state.strategyValues, getPositionValues: () => state.positionValues,
    getOutletValues: () => state.outletValues, getOutletValue: (entry) => entry.outletName ?? '',
    getAutomationIdValues: () => state.automationIdValues,
    getAutomationIdValue: (entry) => entry.automationId ?? '',
    getGroupValues: () => state.groupValues, getGroupValue: (entry) => entry.group.split(','),
    getCharacterFilterValueKeys: () => ['character:Alice'],
  });
  return { state, baseline, entries, dom, api, sourceReads: () => sourceReads };
}

test('initial filters are fused, respect every predicate, and leave scripts independent', () => {
  const { api, baseline, sourceReads } = filterHarness();
  const apply = api.createEntryManagerRowFilter();
  const mutations = [
    ['strategy', { strategy: 'normal' }], ['position', { position: 0 }],
    ['recursion', { excludeRecursion: false }], ['outlet', { outletName: '' }],
    ['automationId', { automationId: '' }], ['group', { group: '' }],
    ['characterFilterPresence', { characterFilter: undefined }],
    ['characterFilterValue', { characterFilter: { names: ['Bob'], tags: [] } }],
  ];
  const passing = new Element('tr');
  apply(passing, baseline);
  assert.equal(passing.classList.contains('stwid--state-filtered'), false);
  assert.equal(passing.classUpdates, 1);
  for (const [key, changes] of mutations) {
    const row = new Element('tr');
    apply(row, { ...baseline, ...changes });
    const datasetKey = `stwidFilter${key[0].toUpperCase()}${key.slice(1)}`;
    assert.equal(row.dataset[datasetKey], 'true', key);
    assert.equal(row.classList.contains('stwid--state-filtered'), true, key);
    assert.equal(row.classUpdates, 1);
  }
  const scripted = new Element('tr');
  scripted.dataset.stwidFilterScript = 'true';
  apply(scripted, baseline);
  assert.equal(scripted.classList.contains('stwid--state-filtered'), true);
  assert.equal(sourceReads(), 0, 'Initial predicates reuse the row builder entries');
});

test('column filters walk scoped unsorted entries, skip absent rows, and avoid unchanged writes', () => {
  const { api, dom, state, baseline } = filterHarness();
  delete dom.order.entries.A[4];
  api.applyEntryManagerPositionFilters();
  assert.equal(dom.order.entries.A[1].dataset.stwidFilterPosition, 'false');
  assert.equal(dom.order.entries.A[2].dataset.stwidFilterPosition, 'true');
  assert.equal(dom.order.entries.B[3].dataset.stwidFilterPosition, undefined);
  const before = dom.order.entries.A[2].classUpdates;
  api.applyEntryManagerPositionFilters();
  assert.equal(dom.order.entries.A[2].classUpdates, before);
  state.filters.characterFilterPresence = ['has', 'hasnt'];
  state.filters.characterFilterValue = [];
  const row = new Element('tr');
  api.createEntryManagerRowFilter()(row, { ...baseline, characterFilter: undefined });
  assert.equal(row.dataset.stwidFilterCharacterFilterPresence, 'false');
  assert.equal(row.dataset.stwidFilterCharacterFilterValue, 'false');
});

async function scriptHarness({ getScope, count = 3, yieldTask = () => Promise.resolve() } = {}) {
  const entries = Array.from({ length: count }, (_, uid) => ({ book: 'A', data: { uid } })).reverse();
  const dom = { order: { tbody: new Element('tbody'), entries: { A: {} }, filter: {} } };
  for (const entry of entries) dom.order.entries.A[entry.data.uid] = new Element('tr');
  const timers = new Map();
  const writes = [];
  const executed = [];
  class Scope {
    scope = { setVariable: (_name, value) => { this.entry = JSON.parse(value); } };
    async compile() {}
    async execute() { executed.push(this.entry.uid); return { pipe: true }; }
  }
  const { buildFilterPanel } = await loadModule('../src/entry-manager/table/table.filter-panel.js', {
    '../../shared/utils.js': {
      createWorkBudget: (options) => createWorkBudget({ ...options, now: () => 0, yieldTask }),
    },
    './table.body.character-filter.js': { closeOpenCharacterFilterDropdown() {} },
  }, {
    document: { createElement: (tag) => new Element(tag) },
    DOMPurify: { sanitize: (text) => text },
    localStorage: { getItem: () => '', setItem() {} },
  });
  const panel = buildFilterPanel({
    dom, entryManagerState: { book: 'A' }, SlashCommandParser: { getScope: getScope ?? (async () => Scope) },
    getEntryManagerEntries: (book, includeDom) => {
      assert.equal(book, 'A'); assert.equal(includeDom, true); return entries;
    },
    setEntryManagerRowFilterState: (row, key, value) => { writes.push({ row, value }); row.dataset[key] = value; },
    debounce: (callback, milliseconds) => (...args) => {
      timers.set(milliseconds, () => callback(...args));
    },
    hljs: { highlight: (value) => ({ value }) }, isTrueBoolean: (value) => value === true,
  });
  panel.classList.add('stwid--state-active');
  const input = panel.find((element) => element.tagName === 'textarea');
  const error = panel.find((element) => element.classList.contains('stwid--orderFilterError'));
  const inputOnly = (value = 'return true;') => { input.value = value; input.dispatch('input'); };
  const start = (value) => {
    inputOnly(value);
    assert.ok(timers.has(250), 'Script debounce should be 250 ms');
    const callback = timers.get(250);
    timers.delete(250);
    return callback();
  };
  return { dom, panel, entries, writes, executed, error, inputOnly, start, timers, Scope };
}

test('scripts preserve sequential sort order and yield during reset and execution', async () => {
  let yields = 0;
  const h = await scriptHarness({ count: 201, yieldTask: () => { yields += 1; return Promise.resolve(); } });
  await h.start();
  assert.deepEqual(h.executed, h.entries.map((entry) => entry.data.uid));
  assert.equal(h.writes.length, 402);
  assert.equal(yields, 4);
  assert.equal(h.error.hidden, true);
});

test('input immediately cancels an executing script before the replacement debounce runs', async () => {
  const execution = deferred();
  let calls = 0;
  const h = await scriptHarness({ getScope: async () => class {
    scope = { setVariable() {} };
    async compile() {}
    execute() { calls += 1; return execution.promise; }
  } });
  const first = h.start('old script');
  await turn();
  assert.equal(calls, 1);
  const before = h.writes.length;
  h.inputOnly('new script');
  execution.resolve({ pipe: false });
  await first;
  assert.equal(h.writes.length, before);
  assert.equal(calls, 1, 'No further entries should execute');
});

test('a delayed acquisition or compilation cannot become current after a newer run completes', async () => {
  for (const boundary of ['acquisition', 'compilation']) {
    const pending = deferred();
    let acquisitions = 0;
    let oldExecutions = 0;
    let OldScope;
    const h = await scriptHarness({ getScope: () => {
      acquisitions += 1;
      if (acquisitions > 1) return Promise.resolve(h.Scope);
      return boundary === 'acquisition' ? pending.promise : Promise.resolve(OldScope);
    } });
    OldScope = class {
      scope = { setVariable() {} };
      compile() { return boundary === 'compilation' ? pending.promise : Promise.resolve(); }
      async execute() { oldExecutions += 1; return { pipe: false }; }
    };
    const old = h.start('old script');
    await turn();
    await h.start('new script');
    const before = h.writes.length;
    pending.resolve(boundary === 'acquisition' ? OldScope : undefined);
    await old;
    assert.equal(h.writes.length, before, boundary);
    assert.equal(oldExecutions, 0, boundary);
    assert.equal(h.error.hidden, true);
  }
});

test('obsolete execution results and errors cannot affect a closed or replacement table', async () => {
  for (const action of ['close', 'replace', 'reject']) {
    const pending = deferred();
    const h = await scriptHarness({ getScope: async () => class {
      scope = { setVariable() {} };
      async compile() {}
      execute() { return pending.promise; }
    } });
    const running = h.start();
    await turn();
    const before = h.writes.length;
    if (action === 'replace') h.dom.order.tbody = new Element('tbody');
    else {
      h.dom.order.filter.cancel();
      h.panel.classList.remove('stwid--state-active');
      h.panel.classList.add('stwid--state-active');
    }
    if (action === 'reject') pending.reject(new Error('obsolete failure'));
    else pending.resolve({ pipe: false });
    await running;
    assert.equal(h.writes.length, before, action);
    assert.equal(h.error.hidden, true, action);
  }
});

test('cancelled pending debounce and reset yields do not restart obsolete work', async () => {
  const gate = deferred();
  const h = await scriptHarness({ count: 201, yieldTask: () => gate.promise });
  const first = h.start();
  await turn();
  assert.equal(h.writes.length, 100);
  h.inputOnly('new script');
  h.dom.order.filter.cancel();
  gate.resolve();
  await first;
  await h.timers.get(250)();
  assert.equal(h.writes.length, 100);
  assert.deepEqual(h.executed, []);
});

test('an active script failure still reports its error', async () => {
  const h = await scriptHarness({ getScope: async () => { throw new Error('scope unavailable'); } });
  await h.start();
  assert.equal(h.error.hidden, false);
  assert.match(h.error.textContent, /scope unavailable/);
});

async function renderHarness({ saveWorldInfo = async () => {}, ensureCustomDisplayIndex = () => [], yieldTask = () => Promise.resolve() } = {}) {
  const dom = { editor: new Element(), order: { entries: {}, filter: {}, toggle: new Element() } };
  dom.order.toggle.classList.add('stwid--state-active');
  const built = [];
  const state = { sort: 'custom' };
  const sections = {
    buildEntryManagerRootEl: () => new Element(),
    buildEntryManagerTopRows: () => ({ refreshDisplayToolbar() {}, refreshSelectionCount() {} }),
    buildEntryManagerTabs: () => new Element(), buildEntryManagerFilterPanel: () => new Element(),
    buildEntryManagerTable: async ({ entries }) => {
      built.push(entries[0].book);
      const wrap = new Element();
      const tbody = new Element('tbody');
      dom.order.tbody = tbody;
      for (let uid = 0; uid < 401; uid++) {
        const row = new Element('tr');
        row.setAttribute('data-book', entries[0].book); row.setAttribute('data-uid', uid);
        tbody.append(row);
      }
      wrap.append(tbody);
      return wrap;
    },
  };
  const { createEntryManagerRenderer } = await loadModule('../src/entry-manager/bulk-editor-tab/bulk-editor-tab.js', {
    './bulk-editor-tab.sections.js': sections,
    '../../shared/book-reload.js': { registerBookReloadHooks() {} },
    '../table/table.body.character-filter.js': { registerCharacterFilterUpdateHook() {}, resetCharacterFilterCells() {} },
    '../../shared/utils.js': { createWorkBudget: (options) => createWorkBudget({ ...options, now: () => 0, yieldTask }) },
    './bulk-edit-row.helpers.js': { BULK_APPLY_BATCH_SIZE: 200 },
  }, { toastr: { error: assert.fail } });
  const noOp = () => {};
  const api = createEntryManagerRenderer({
    dom, entryManagerState: state, SORT: { CUSTOM: 'custom' }, saveWorldInfo, ensureCustomDisplayIndex,
    buildSavePayload: (book) => ({ book }), getEntryManagerEntries: (book) => [{ book, data: { uid: 0 } }],
    getEditorPanelApi: () => ({ resetEditorState: () => { dom.editor.children = []; } }),
    syncEntryManagerStrategyFilters: noOp, syncEntryManagerPositionFilters: noOp,
    syncEntryManagerOutletFilters: noOp, syncEntryManagerAutomationIdFilters: noOp,
    syncEntryManagerGroupFilters: noOp, syncEntryManagerCharacterFilterValueFilters: noOp,
    getEntryManagerRows: () => dom.order.tbody.children,
    setEntryManagerRowSelected: (row, selected) => { row.selected = selected; },
    updateEntryManagerSelectAllButton: noOp,
  });
  return { ...api, dom, built };
}

test('a render superseded during custom-order saving cannot build or append a table', async () => {
  const save = deferred();
  const h = await renderHarness({
    saveWorldInfo: (book) => book === 'A' ? save.promise : Promise.resolve(),
    ensureCustomDisplayIndex: (book) => [book],
  });
  const first = h.renderEntryManager('A');
  await turn();
  await h.renderEntryManager('B');
  save.resolve();
  await first;
  assert.deepEqual(h.built, ['B']);
  assert.equal(h.dom.editor.children.length, 1);
});

test('closing during preparation and superseding selection restoration abandon old renders', async () => {
  const save = deferred();
  const closing = await renderHarness({ saveWorldInfo: () => save.promise, ensureCustomDisplayIndex: () => ['A'] });
  const open = closing.renderEntryManager('A');
  closing.dom.order.toggle.classList.remove('stwid--state-active');
  save.resolve();
  await open;
  assert.deepEqual(closing.built, []);

  const gate = deferred();
  const restoring = await renderHarness({ yieldTask: () => gate.promise });
  const first = restoring.renderEntryManager('A', { selectedRowKeys: new Set() });
  await turn();
  const oldRows = restoring.dom.order.tbody.children;
  assert.equal(oldRows.filter((row) => row.selected === false).length, 200);
  await restoring.renderEntryManager('B');
  gate.resolve();
  await first;
  assert.equal(oldRows.filter((row) => row.selected === false).length, 200);
  assert.equal(restoring.dom.editor.children.length, 1);
});

test('row construction filters within each budget and stops at the first obsolete yield', async () => {
  const gate = deferred();
  let current = true;
  let filtered = 0;
  const dom = { order: {} };
  const { buildTableBody } = await loadModule('../src/entry-manager/table/table.body.js', {
    '../../shared/utils.js': {
      createWorkBudget: (options) => createWorkBudget({ ...options, now: () => 0, yieldTask: () => gate.promise }),
    },
    './table.body.row-sorting.js': { setupEntryManagerSorting: () => ({}) },
    './table.body.cells.js': { buildEntryManagerRow: () => new Element('tr') },
  }, {
    document: {
      createElement: (tag) => new Element(tag),
      querySelector: () => ({ querySelector: () => new Element() }),
    },
  });
  const running = buildTableBody({
    dom, entries: Array.from({ length: 1000 }, (_, uid) => ({ book: 'A', data: { uid } })),
    isRenderCurrent: () => current,
    createEntryManagerRowFilter: () => () => { filtered += 1; },
    updateEntryManagerSelectAllButton: () => assert.fail('Obsolete builds must not publish selection state'),
  });
  await turn();
  assert.equal(filtered, 50);
  assert.equal(dom.order.tbody.children.length, 50);
  current = false;
  gate.resolve();
  await running;
  assert.equal(filtered, 50);
});

test('the manager toggle can close pending rendering while preserving dirty guards and open locking', async () => {
  const gate = deferred();
  const dom = { order: {}, drawer: { body: new Element() } };
  let opens = 0;
  let clears = 0;
  let warnings = 0;
  let dirty = false;
  const { createSettingsTabContent } = await loadModule(
    '../src/book-browser/browser-tabs/browser-tabs.settings-tab.js', {}, {
      document: { createElement: (tag) => new Element(tag) },
      toastr: { warning: () => { warnings += 1; } },
    },
  );
  createSettingsTabContent({
    dom,
    openEntryManager: async () => {
      opens += 1;
      dom.order.toggle.classList.add('stwid--state-active');
      await gate.promise;
    },
    getListPanelApi: () => ({ getBookVisibilityScope: () => ['A'] }),
    getEditorPanelApi: () => ({ isDirty: () => dirty, clearEditor: () => { clears += 1; } }),
    getCurrentEditor: () => ({ name: 'A', uid: 0 }),
  });
  const click = dom.order.toggle.listeners.get('click');
  const opening = click();
  dirty = true;
  await click();
  assert.equal(warnings, 1);
  assert.equal(clears, 0);
  dirty = false;
  await click();
  assert.equal(clears, 1);
  assert.equal(dom.order.toggle.classList.contains('stwid--state-active'), false);
  await click();
  assert.equal(opens, 1, 'A cancelled open must settle before this button opens again');
  gate.resolve();
  await opening;
  await click();
  assert.equal(opens, 2);
});
