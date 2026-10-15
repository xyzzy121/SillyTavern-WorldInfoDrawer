import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import { createWorkBudget } from '../src/shared/utils.js';
import * as utils from '../src/entry-manager/entry-manager.utils.js';
import { ENTRY_MANAGER_RECURSION_OPTIONS } from '../src/shared/constants.js';
import { createSelectionCounter } from '../src/entry-manager/table/table.selection.js';
import { syncEntryToggleChecked } from '../src/shared/entry-toggle-a11y.js';

const turn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

async function loadModule(path, imports, globals = {}) {
  const context = createContext({ console, ...globals });
  const module = new SourceTextModule(await readFile(new URL(path, import.meta.url), 'utf8'), { context });
  await module.link((name) => {
    assert.ok(imports[name], `Unexpected dependency: ${name}`);
    const exports = imports[name];
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.attributeWrites = new Map();
    Object.defineProperty(this, 'textContent', {
      get: () => this.textNode?.value ?? '',
      set: (value) => { this.textNode = { value }; },
    });
    this.listeners = new Map();
    this.listenerOptions = new Map();
    this.isConnected = true;
    const classes = new Set();
    this.classList = {
      add: (...values) => values.forEach((value) => classes.add(value)),
      remove: (...values) => values.forEach((value) => classes.delete(value)),
      contains: (value) => classes.has(value),
      toggle: (value, force = !classes.has(value)) => force ? classes.add(value) : classes.delete(value),
    };
  }
  get firstElementChild() { return this.children[0] ?? null; }
  append(...children) { for (const child of children) { if (typeof child !== 'object') continue; this.children.push(child); child.parentElement = this; } }
  setAttribute(key, value) { this.attributeWrites.set(key, (this.attributeWrites.get(key) ?? 0) + 1); this.attributes.set(key, String(value)); if (key === 'data-col') this.dataset.col = value; }
  getAttribute(key) { return this.attributes.get(key); }
  hasAttribute(key) { return this.attributes.has(key); }
  replaceWith(next) { const children = this.parentElement.children; children.splice(children.indexOf(this), 1, next); next.parentElement = this.parentElement; }
  addEventListener(name, callback, options) { this.listeners.set(name, callback); this.listenerOptions.set(name, options); }
  removeEventListener(name) { this.listeners.delete(name); this.listenerOptions.delete(name); }
  cloneNode() { const clone = new Element(this.tagName); clone.name = this.name; return clone; }
  contains(target) { return this === target || this.children.some((child) => child.contains(target)); }
  querySelector(selector) {
    for (const child of this.children) {
      if (selector.startsWith('[name=') && child.name === selector.match(/"([^"]+)"/)[1]) return child;
      if (['input', 'button'].includes(selector) && child.tagName === selector.toUpperCase()) return child;
      if (selector.startsWith('.') && child.classList.contains(selector.slice(1))) return child;
      const found = child.querySelector(selector); if (found) return found;
    }
    return null;
  }
}

function controlledTimers() {
  let id = 0;
  const pending = new Map();
  return {
    pending,
    setTimeout(callback, delay) { const timer = ++id; pending.set(timer, { callback, delay }); return timer; },
    clearTimeout(timer) { pending.delete(timer); },
    flush() { const ready = [...pending.values()]; pending.clear(); for (const { callback } of ready) callback(); },
  };
}

async function hydrationHarness({ count = 100, yieldTask = () => Promise.resolve(), timers = { setTimeout, clearTimeout } } = {}) {
  let observer;
  let current = true;
  let disposed = 0;
  let hydrated = 0;
  const wrapper = new Element();
  const manager = new Element();
  manager.clientHeight = 400; manager.scrollHeight = 10000; manager.overflowY = 'auto';
  wrapper.clientHeight = 10000; wrapper.scrollHeight = 10000; wrapper.overflowY = 'auto';
  wrapper.parentElement = manager;
  wrapper.closest = () => manager;
  const tbody = new Element('tbody');
  const windowListeners = new Map();
  const rows = Array.from({ length: count }, () => {
    const row = new Element('tr');
    row.stwidHydrate = () => { hydrated++; };
    return row;
  });
  tbody.append(...rows);
  const { createTableHydration } = await loadModule('../src/entry-manager/table/table.hydration.js', {
    '../../shared/utils.js': { createWorkBudget: (options) => createWorkBudget({ ...options, now: () => 0, yieldTask }) },
  }, {
    getComputedStyle: (element) => ({ overflowY: element.overflowY }),
    window: {
      addEventListener: (name, callback) => windowListeners.set(name, callback),
      removeEventListener: (name) => windowListeners.delete(name),
      setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    },
    IntersectionObserver: class {
      constructor(callback, options) { Object.assign(this, { callback, options, targets: [], disconnected: false }); observer = this; }
      observe(target) { this.targets.push(target); }
      unobserve(target) { this.targets = this.targets.filter((item) => item !== target); }
      disconnect() { this.disconnected = true; }
    },
  });
  const controller = createTableHydration({ tbody, isRenderCurrent: () => current, onDispose: () => { disposed++; } });
  controller.start(wrapper);
  return { controller, get observer() { return observer; }, manager, wrapper, rows, tbody, windowListeners,
    hydrated: () => hydrated, disposed: () => disposed, close: () => { current = false; } };
}

test('viewport hydration uses the actual mobile scroll root and one budget across an observer delivery', async () => {
  const gate = deferred();
  const h = await hydrationHarness({ yieldTask: () => gate.promise });
  assert.equal(h.observer.options.root, h.manager);
  assert.equal(h.observer.options.rootMargin, '600px 0px');
  h.observer.callback(h.rows.map((target) => ({ target, isIntersecting: true })));
  assert.equal(h.hydrated(), 12, 'One callback must not reset the budget for each row');
  h.controller.dispose();
  gate.resolve();
  await turn();
  assert.equal(h.hydrated(), 12, 'Closing cancels work suspended at a yield');
  assert.equal(h.observer.disconnected, true);
  assert.equal(h.disposed(), 1);
  assert.equal(h.tbody.listeners.size, 0);
  h.controller.dispose();
  assert.equal(h.disposed(), 1);
});

test('rows that leave overscan and obsolete render callbacks cannot hydrate', async () => {
  const gate = deferred();
  const h = await hydrationHarness({ count: 14, yieldTask: () => gate.promise });
  h.observer.callback(h.rows.map((target) => ({ target, isIntersecting: true })));
  h.observer.callback([{ target: h.rows[12], isIntersecting: false }]);
  h.rows[13].classList.add('stwid--state-filtered');
  gate.resolve();
  await turn();
  assert.equal(h.hydrated(), 12);
  h.close();
  h.observer.callback([{ target: h.rows[12], isIntersecting: true }]);
  assert.equal(h.hydrated(), 12);
  h.controller.dispose();
});

test('pointer targets survive an observer delivery between pointerdown and click', async () => {
  const h = await hydrationHarness({ count: 1 });
  const row = h.rows[0];
  const cell = new Element('td');
  cell.dataset.col = 'enabled';
  cell.closest = (selector) => selector === 'tr' ? row : cell;
  row.append(cell);
  let clicked = 0;
  const control = { tagName: 'DIV', focus() {}, click() { clicked++; } };
  row.stwidHydrateCell = () => ({ querySelector: () => control });
  h.tbody.listeners.get('pointerdown')({ type: 'pointerdown', target: cell });
  h.observer.callback([{ target: row, isIntersecting: true }]);
  assert.equal(h.hydrated(), 0, 'Queued hydration must preserve the initiating pointer target');
  h.tbody.listeners.get('focusin')({ type: 'focusin', target: cell });
  assert.equal(clicked, 0);
  h.tbody.listeners.get('click')({ type: 'click', target: cell, preventDefault() {}, stopPropagation() {} });
  assert.equal(clicked, 1);
  assert.equal(h.hydrated(), 1);
  h.controller.dispose();
});

test('a pending native drag grip survives pointer focus and observer delivery without dispatching a move-button click', async () => {
  const timers = controlledTimers();
  const h = await hydrationHarness({ count: 1, timers });
  const row = h.rows[0];
  const cell = new Element('td');
  cell.dataset.col = 'drag';
  cell.classList.add('stwid--sortable-handle');
  cell.closest = (selector) => selector === 'tr' ? row : cell;
  cell.getBoundingClientRect = () => ({ top: 10, height: 90 });
  row.append(cell);
  let replacements = 0;
  let moves = 0;
  row.stwidHydrateCell = () => {
    replacements++;
    return { querySelector: () => ({ tagName: 'BUTTON', focus() {}, click() { moves++; } }) };
  };
  h.tbody.listeners.get('pointerdown')({ type: 'pointerdown', target: cell });
  h.tbody.listeners.get('focusin')({ type: 'focusin', target: cell });
  h.observer.callback([{ target: row, isIntersecting: true }]);
  assert.equal(replacements, 0);
  assert.equal(h.hydrated(), 0);
  h.windowListeners.get('pointerup')();
  h.tbody.listeners.get('click')({ type: 'click', target: cell, clientY: 55,
    preventDefault() { assert.fail('The native grip event must remain available to Sortable'); }, stopPropagation() {} });
  assert.equal(replacements, 0, 'The native mouseup/update finishes before its handle can be replaced');
  assert.equal(moves, 0, 'A grip click is never an up/down move');
  assert.equal(h.hydrated(), 0);
  timers.flush();
  assert.equal(h.hydrated(), 1, 'Automatic work can resume after the complete pointer event task');
  h.controller.dispose();
});

test('pending move previews activate the arrow in the upper or lower third', async () => {
  const h = await hydrationHarness({ count: 1 });
  const row = h.rows[0];
  const cell = new Element('td');
  cell.dataset.col = 'drag';
  cell.closest = (selector) => selector === 'tr' ? row : cell;
  cell.getBoundingClientRect = () => ({ top: 10, height: 90 });
  row.append(cell);
  const clicks = [];
  row.stwidHydrateCell = () => ({ querySelector: (selector) => ({ tagName: 'BUTTON', focus() {},
    click() { clicks.push(selector === 'button:last-child' ? 'down' : 'up'); } }) });
  for (const clientY of [25, 85]) {
    h.tbody.listeners.get('pointerdown')({ type: 'pointerdown', target: cell });
    h.tbody.listeners.get('click')({ type: 'click', target: cell, clientY, preventDefault() {}, stopPropagation() {} });
  }
  assert.deepEqual(clicks, ['up', 'down']);
  h.controller.dispose();
});

test('keyboard focus on the pending native drag cell hydrates the move buttons immediately', async () => {
  const h = await hydrationHarness({ count: 1 });
  const row = h.rows[0];
  const cell = new Element('td');
  cell.dataset.col = 'drag';
  cell.classList.add('stwid--sortable-handle');
  cell.closest = (selector) => selector === 'tr' ? row : cell;
  row.append(cell);
  let hydrated = 0;
  let focused = 0;
  row.stwidHydrateCell = () => {
    hydrated++;
    return { querySelector: () => ({ tagName: 'BUTTON', focus() { focused++; } }) };
  };
  h.tbody.listeners.get('focusin')({ type: 'focusin', target: cell });
  assert.equal(hydrated, 1);
  assert.equal(focused, 1);
  h.controller.dispose();
});

test('scrolling postpones automatic hydration until 120 ms of idle and only keeps the latest visible rows', async () => {
  const timers = controlledTimers();
  const h = await hydrationHarness({ count: 3, timers });
  assert.equal(h.manager.listenerOptions.get('scroll').passive, true);
  const scroll = h.manager.listeners.get('scroll');
  scroll();
  const firstTimer = [...timers.pending.keys()][0];
  assert.equal(timers.pending.get(firstTimer).delay, 120);
  h.observer.callback([{ target: h.rows[0], isIntersecting: true }]);
  assert.equal(h.hydrated(), 0);
  scroll();
  assert.equal(timers.pending.has(firstTimer), false, 'Each scroll event restarts the idle deadline');
  assert.equal(timers.pending.size, 1);
  h.observer.callback([
    { target: h.rows[0], isIntersecting: false },
    { target: h.rows[2], isIntersecting: true },
  ]);
  assert.equal(h.hydrated(), 0);
  timers.flush();
  assert.equal(h.hydrated(), 1, 'Rows passed during scrolling do not create controls after settling');
  h.controller.dispose();
});

test('scrolling interrupts an existing hydration drain at its next work-budget yield', async () => {
  const timers = controlledTimers();
  const gate = deferred();
  const h = await hydrationHarness({ count: 14, timers, yieldTask: () => gate.promise });
  h.observer.callback(h.rows.map((target) => ({ target, isIntersecting: true })));
  assert.equal(h.hydrated(), 12, 'Initial opening hydrates immediately');
  h.manager.listeners.get('scroll')();
  gate.resolve();
  await turn();
  assert.equal(h.hydrated(), 12, 'A resumed drain must stop while the root is scrolling');
  timers.flush();
  assert.equal(h.hydrated(), 14);
  h.controller.dispose();
});

test('click, focus and keyboard activation hydrate their cell immediately while automatic work waits for scroll idle', async () => {
  const timers = controlledTimers();
  const h = await hydrationHarness({ count: 3, timers });
  h.manager.listeners.get('scroll')();
  h.observer.callback(h.rows.map((target) => ({ target, isIntersecting: true })));
  let activated = 0;
  let clicks = 0;
  let focuses = 0;
  for (const [index, type] of ['click', 'focusin', 'keydown'].entries()) {
    const row = h.rows[index];
    const cell = new Element('td');
    cell.dataset.col = 'enabled';
    cell.closest = (selector) => selector === 'tr' ? row : cell;
    row.append(cell);
    row.stwidHydrateCell = () => {
      activated++;
      return { querySelector: () => ({ tagName: 'DIV', focus() { focuses++; }, click() { clicks++; } }) };
    };
    if (type === 'click') h.tbody.listeners.get('pointerdown')({ type: 'pointerdown', target: cell });
    h.tbody.listeners.get(type)({ type, target: cell, key: 'Enter', preventDefault() {}, stopPropagation() {} });
  }
  assert.equal(activated, 3);
  assert.equal(focuses, 3);
  assert.equal(clicks, 2);
  assert.equal(h.hydrated(), 0, 'Direct activation must not drain unrelated rows during scrolling');
  timers.flush();
  assert.equal(h.hydrated(), 3);
  h.controller.dispose();
});

test('scroll-root changes and disposal cancel timers, listeners and obsolete observer callbacks', async () => {
  const timers = controlledTimers();
  const h = await hydrationHarness({ count: 1, timers });
  const previousObserver = h.observer;
  h.manager.listeners.get('scroll')();
  assert.equal(timers.pending.size, 1);
  h.wrapper.clientHeight = 400;
  h.windowListeners.get('resize')();
  assert.equal(previousObserver.disconnected, true);
  assert.equal(h.observer.options.root, h.wrapper);
  assert.equal(h.manager.listeners.has('scroll'), false);
  assert.equal(h.wrapper.listeners.has('scroll'), true);
  assert.equal(timers.pending.size, 0);
  previousObserver.callback([{ target: h.rows[0], isIntersecting: true }]);
  assert.equal(h.hydrated(), 0, 'A disconnected observer cannot enqueue rows into its replacement');
  h.wrapper.listeners.get('scroll')();
  h.observer.callback([{ target: h.rows[0], isIntersecting: true }]);
  assert.equal(h.hydrated(), 0);
  h.controller.dispose();
  assert.equal(timers.pending.size, 0);
  assert.equal(h.wrapper.listeners.has('scroll'), false);
  assert.equal(h.windowListeners.size, 0);
  timers.flush();
  h.observer.callback([{ target: h.rows[0], isIntersecting: true }]);
  assert.equal(h.hydrated(), 0);
});

test('selection counts stay correct across filtering, bulk selection, deletion and independent table renders', () => {
  const counter = createSelectionCounter();
  const rows = Array.from({ length: 1000 }, () => ({}));
  for (const row of rows) counter.setSelected(row, true);
  for (const row of rows.slice(0, 200)) counter.setFiltered(row, true);
  for (const row of rows.slice(100, 300)) counter.setSelected(row, false);
  assert.deepEqual(counter.snapshot(), { total: 1000, selected: 800, visible: 800, visibleSelected: 700 });
  for (const row of rows) counter.setSelected(row, false);
  assert.deepEqual(counter.snapshot(), { total: 1000, selected: 0, visible: 800, visibleSelected: 0 });
  counter.remove(rows[0]); counter.remove(rows[999]); counter.remove(rows[999]);
  assert.deepEqual(counter.snapshot(), { total: 998, selected: 0, visible: 799, visibleSelected: 0 });
  const next = createSelectionCounter();
  next.setSelected(rows[500], true);
  assert.deepEqual(next.snapshot(), { total: 1, selected: 1, visible: 1, visibleSelected: 1 });
  assert.equal(counter.snapshot().selected, 0);
});

async function rowHarness({ visibleColumns = {} } = {}) {
  const document = { createElement: (tag) => new Element(tag), activeElement: null };
  const api = await loadModule('../src/entry-manager/table/table.body.cells.js', {
    '../entry-manager.utils.js': utils,
    '../../shared/constants.js': { ENTRY_MANAGER_RECURSION_OPTIONS },
    './table.body.row-sorting.js': { createMoveButton: () => new Element('button') },
    '../../shared/original-data.js': { mirrorEntryFieldsToOriginalData() {} },
    '../../shared/entry-toggle-a11y.js': { syncEntryToggleChecked },
    './table.body.character-filter.js': { buildCharacterFilterCell() { assert.fail('Hidden character controls must not be built'); } },
  }, { document });
  const entry = { uid: 0, key: ['key'], comment: 'Entry zero', depth: 4, order: 100, position: 0 };
  const dom = { order: { entries: {} } };
  const cache = { A: { entries: { 0: entry }, dom: { entry: {} } } };
  const columns = Object.fromEntries(api.ENTRY_MANAGER_CELL_ORDER.map((col) => [col, false]));
  Object.assign(columns, { select: true, entry: true, enabled: true, strategy: true, position: true, depth: true });
  Object.assign(columns, visibleColumns);
  let saves = 0;
  const options = {
    entryRow: { book: 'A', data: entry }, dom, cache, entryManagerState: { columns },
    entryState: (data) => data.constant ? 'constant' : data.vectorized ? 'vectorized' : 'normal',
    isOutletPosition: (position) => position === 7,
    setEntryManagerRowSelected: (row, selected) => { row.selected = selected; },
    enabledToggleTemplate: new Element(), strategyTemplate: new Element('select'), positionTemplate: new Element('select'),
    applyEntryManagerStrategyFilterToRow() {}, applyEntryManagerPositionFilterToRow() {},
    enqueueSave: async () => { saves++; },
  };
  const row = api.buildEntryManagerRow(options);
  return { row, dom, cache, entry, options, saves: () => saves };
}

test('pending drag cells expose a stable real Sortable grip without eagerly building move buttons', async () => {
  const h = await rowHarness({ visibleColumns: { drag: true } });
  const cell = h.row.children.find((element) => element.dataset.col === 'drag');
  const textNode = cell.textNode;
  assert.ok(cell.classList.contains('stwid--sortable-handle'), 'Sortable must find the cell on the initial pointerdown');
  assert.equal(cell.querySelector('button'), null, 'Offscreen rows retain lightweight arrow previews');
  assert.equal(cell.children.length, 0, 'The native handle must not add elements to every table row');
  assert.equal(cell.textContent, '▴\n☰\n▾');
  h.row.stwidRefreshPending();
  assert.equal(h.row.children.find((element) => element.dataset.col === 'drag'), cell);
  assert.equal(cell.textNode, textNode, 'Bulk updates preserve the active native drag target and its text');
  const hydrated = h.row.stwidHydrateCell('drag');
  assert.ok(hydrated.querySelector('.stwid--sortable-handle'));
  assert.equal(hydrated.firstElementChild.children.filter((element) => element.tagName === 'BUTTON').length, 2);
});

test('all logical rows and UID zero remain available while controls are deferred and hidden columns stay empty', async () => {
  const h = await rowHarness();
  assert.equal(h.dom.order.entries.A[0], h.row);
  assert.equal(h.row.selected, true);
  assert.equal(h.row.querySelector('input'), null);
  const depth = () => h.row.children.find((cell) => cell.getAttribute('data-col') === 'depth');
  assert.equal(depth().textContent, '4');
  h.cache.A.entries[0] = { ...h.entry, depth: 9 };
  h.row.stwidHydrate();
  assert.equal(depth().querySelector('input').value, 9, 'Hydration reads canonical data at activation');
  const hidden = h.row.children.find((cell) => cell.getAttribute('data-col') === 'characterFilter');
  assert.equal(hidden.hasAttribute('data-stwid-pending'), true);
  assert.equal(hidden.textContent, '');
});

test('strategy and position edits succeed without a mounted Book Browser row or shared control references', async () => {
  const h = await rowHarness();
  const strategyCell = h.row.stwidHydrateCell('strategy');
  const strategy = strategyCell.children[0];
  strategy.value = 'constant';
  await strategy.listeners.get('change')();
  assert.equal(h.cache.A.entries[0].constant, true);
  const position = h.row.stwidHydrateCell('position').children[0];
  position.value = '7';
  await position.listeners.get('change')();
  assert.equal(h.cache.A.entries[0].position, 7);
  assert.deepEqual(h.cache.A.dom.entry, {});
  assert.equal(h.saves(), 2);
});

test('the hydrated enabled control remains keyboard reachable and toggles once for Enter and Space', async () => {
  const h = await rowHarness();
  const browserToggle = new Element();
  h.cache.A.dom.entry[0] = { isEnabled: browserToggle };
  const control = h.row.stwidHydrateCell('enabled').children[0];
  assert.equal(control.tabIndex, 0, 'Focus must transfer from the deferred cell to a keyboard reachable control');
  assert.equal(control.getAttribute('role'), 'button');
  assert.equal(control.getAttribute('aria-pressed'), 'true');
  let clicks = 0;
  control.click = () => { clicks++; return control.listeners.get('click')(); };
  for (const [index, key] of ['Enter', ' '].entries()) {
    let prevented = 0;
    let stopped = 0;
    control.listeners.get('keydown')({ key, preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
    await turn();
    assert.equal(prevented, 1, 'Space must not scroll the table');
    assert.equal(stopped, 1, 'Host keyboard handlers must not activate the control twice');
    assert.equal(clicks, index + 1);
    assert.equal(h.saves(), index + 1);
    assert.equal(h.entry.disable, index === 0);
    assert.equal(control.getAttribute('aria-pressed'), String(index !== 0));
    assert.equal(browserToggle.getAttribute('aria-checked'), String(index !== 0));
  }
  control.listeners.get('keydown')({ key: 'Enter', ctrlKey: true });
  control.listeners.get('keydown')({ key: 'ArrowDown' });
  assert.equal(clicks, 2, 'Navigation and modified shortcuts must keep their usual behavior');
  delete h.cache.A.dom.entry[0];
  await control.click();
  assert.equal(h.saves(), 3, 'The same control must still work after the Browser row is unmounted');
});

test('refreshing pending values preserves unchanged text nodes and accessibility attributes', async () => {
  const h = await rowHarness();
  const pending = h.row.children.filter((cell) => cell.hasAttribute('data-stwid-pending'));
  const before = pending.map((cell) => ({ cell, textNode: cell.textNode, labelWrites: cell.attributeWrites.get('aria-label') }));
  h.row.stwidRefreshPending();
  for (const { cell, textNode, labelWrites } of before) {
    assert.equal(cell.textNode, textNode);
    assert.equal(cell.attributeWrites.get('aria-label'), labelWrites);
  }
  h.cache.A.entries[0].depth = 12345;
  h.row.stwidRefreshPending();
  for (const { cell, textNode, labelWrites } of before) {
    if (cell.getAttribute('data-col') === 'depth') {
      assert.notEqual(cell.textNode, textNode);
      assert.equal(cell.textContent, '12345');
      assert.equal(cell.attributeWrites.get('aria-label'), labelWrites + 1);
    } else {
      assert.equal(cell.textNode, textNode);
      assert.equal(cell.attributeWrites.get('aria-label'), labelWrites);
    }
  }
});

test('one character index preserves duplicate names, stale values, unloaded lists and legacy numeric tags', () => {
  const host = { characters: [{ avatar: 'one.png', name: 'Ada' }, { avatar: 'two.png', name: 'Ada' }], tags: [{ id: '7', name: 'Seven' }] };
  const index = utils.createCharacterFilterIndex(host);
  assert.equal(utils.createCharacterFilterIndex(index), index);
  const entry = { characterFilter: { names: ['one', 'missing'], tags: [7], isExclude: false } };
  const lines = utils.formatCharacterFilter(entry, index);
  assert.deepEqual(lines.map(({ label }) => label), ['Ada (one)', 'missing', 'Seven']);
  assert.deepEqual(lines.map(({ stale }) => stale), [false, true, false]);
  assert.equal(utils.formatCharacterFilter(entry, utils.createCharacterFilterIndex({ characters: [], tags: [] }))[1].stale, false);
});

test('overlapping UID remaps preserve row identities and subsequent bulk targets with or without controls', async () => {
  const helpers = await loadModule('../src/entry-manager/bulk-editor-tab/bulk-edit-row.helpers.js', {
    '../entry-manager.utils.js': utils,
    '../../shared/constants.js': { ENTRY_MANAGER_RECURSION_OPTIONS },
    '../../shared/utils.js': { maybeYieldToEventLoop: async () => {} },
    '../../shared/original-data.js': { mirrorEntryFieldsToOriginalData() {} },
    '../../shared/book-reload.js': { reloadBooksFromDisk() {} },
  }, { HTMLElement: Element });
  const uid = await loadModule('../src/entry-manager/bulk-editor-tab/bulk-edit-row.uid.js', {
    '../../shared/utils.js': { maybeYieldToEventLoop: async () => {} },
    './bulk-edit-row.helpers.js': helpers,
    '../../shared/original-data.js': { remapEntryUidsInOriginalData() {} },
    '../table/table.body.character-filter.js': { remapCharacterFilterCells() {} },
    '../../shared/wi-update-handler.js': { notifyEntryUidsRemapped: async () => {} },
  });
  const first = { uid: 0, comment: 'first', order: 10 };
  const second = { uid: 1, comment: 'second', order: 20 };
  const untouched = { uid: 5, comment: 'untouched', order: 30 };
  const entries = { 0: first, 1: second, 5: untouched };
  const rows = [first, second, untouched].map((entry) => {
    const row = new Element('tr');
    row.setAttribute('data-book', 'A'); row.setAttribute('data-uid', entry.uid);
    row.selected = entry !== untouched;
    row.stwidRemapUid = (value) => row.setAttribute('data-uid', value);
    return row;
  });
  const input = new Element('input'); input.name = 'order'; rows[0].append(input);
  const tbody = new Element('tbody'); tbody.append(...rows);
  const dom = { order: { tbody, entries: { A: { 0: rows[0], 1: rows[1], 5: rows[2] } } } };
  const cache = { A: { entries, dom: { entry: { 0: { root: new Element() }, 1: { root: new Element() } } } } };
  const targets = helpers.getBulkTargets(rows, cache, (row) => row.selected);
  await uid.rebuildBookUids(uid.groupTargetsByBook(targets), cache, 1, dom);
  assert.equal(dom.order.entries.A[1], rows[0]);
  assert.equal(dom.order.entries.A[2], rows[1]);
  assert.equal(dom.order.entries.A[5], rows[2]);
  assert.equal(cache.A.dom.entry[1].root.getAttribute('data-uid'), '1');
  assert.equal(cache.A.dom.entry[2].root.getAttribute('data-uid'), '2');
  const nextTargets = helpers.getBulkTargets(rows, cache, (row) => row.selected);
  assert.deepEqual(Array.from(nextTargets, ({ uid, entryData }) => [uid, entryData.comment]), [['1', 'first'], ['2', 'second']]);
  const saves = [];
  await helpers.runBulkNumericFieldApply({
    resolveValue: (_target, index) => 70 + index, entryField: 'order', rowInputName: 'order',
    dom, cache, isEntryManagerRowSelected: (row) => row.selected,
    saveWorldInfo: async (book, payload) => saves.push([book, payload]),
    buildSavePayload: () => ({ entries: cache.A.entries }), applyButton: new Element(),
  });
  assert.equal(first.order, 70);
  assert.equal(second.order, 71);
  assert.equal(untouched.order, 30);
  assert.equal(input.value, '70');
  assert.equal(saves.length, 1);
});

test('synchronous bulk writes stay together until real 200-row yields while async targets remain sequential', async () => {
  const gates = [deferred(), deferred()];
  const yields = [];
  const helpers = await loadModule('../src/entry-manager/bulk-editor-tab/bulk-edit-row.helpers.js', {
    '../entry-manager.utils.js': utils,
    '../../shared/constants.js': { ENTRY_MANAGER_RECURSION_OPTIONS },
    '../../shared/utils.js': { maybeYieldToEventLoop: (index) => {
      yields.push(index);
      return gates[yields.length - 1]?.promise ?? Promise.resolve();
    } },
    '../../shared/original-data.js': { mirrorEntryFieldsToOriginalData() {} },
    '../../shared/book-reload.js': { reloadBooksFromDisk() {} },
  }, { HTMLElement: Element });
  const cache = { A: { entries: {} } };
  const tbody = new Element('tbody');
  for (let uid = 0; uid < 401; uid++) {
    cache.A.entries[uid] = { uid };
    const row = new Element('tr');
    row.setAttribute('data-book', 'A'); row.setAttribute('data-uid', uid);
    tbody.append(row);
  }
  const common = {
    dom: { order: { tbody } }, cache, isEntryManagerRowSelected: () => true,
    saveWorldInfo: async () => {}, buildSavePayload: () => ({ entries: cache.A.entries }),
  };
  const applied = [];
  const run = helpers.runBulkTargetsApply({ ...common, applyButton: new Element(),
    applyToTarget: ({ uid }) => { applied.push(uid); },
  });
  assert.equal(applied.length, 200, 'Synchronous targets must not await a microtask per row');
  assert.deepEqual(yields, [199]);
  gates[0].resolve();
  await turn();
  assert.equal(applied.length, 400);
  assert.deepEqual(yields, [199, 399]);
  gates[1].resolve();
  await run;
  assert.equal(applied.length, 401);
  const pending = deferred();
  const asynchronous = [];
  const secondRun = helpers.runBulkTargetsApply({ ...common, applyButton: new Element(),
    applyToTarget: ({ uid }) => {
      asynchronous.push(uid);
      return uid === '0' ? pending.promise : undefined;
    },
  });
  assert.deepEqual(asynchronous, ['0'], 'A real asynchronous target must settle before the next one');
  pending.resolve();
  await secondRun;
  assert.equal(asynchronous.length, 401);
});
