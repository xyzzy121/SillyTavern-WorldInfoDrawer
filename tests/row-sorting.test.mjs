import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

const turn = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    const classes = new Set();
    this.classList = { add: (...values) => values.forEach((value) => classes.add(value)), contains: (value) => classes.has(value) };
  }
  append(...children) {
    for (const child of children) {
      if (child.parentElement) child.parentElement.children.splice(child.parentElement.children.indexOf(child), 1);
      this.children.push(child);
      child.parentElement = this;
    }
  }
  insertBefore(child, reference) {
    if (child.parentElement) child.parentElement.children.splice(child.parentElement.children.indexOf(child), 1);
    this.children.splice(this.children.indexOf(reference), 0, child);
    child.parentElement = this;
  }
  insertAdjacentElement(position, child) {
    assert.equal(position, 'afterend');
    if (child.parentElement) child.parentElement.children.splice(child.parentElement.children.indexOf(child), 1);
    this.parentElement.children.splice(this.parentElement.children.indexOf(this) + 1, 0, child);
    child.parentElement = this.parentElement;
  }
  querySelectorAll(selector) { assert.equal(selector, 'tr'); return this.children.filter((child) => child.tagName === 'tr'); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  fire(name) { this.listeners.get(name)?.({ preventDefault() {}, stopPropagation() {} }); }
}

async function harness({ sort = 'title', direction = 'ascending', confirm = async () => 1, popupAvailable = true } = {}) {
  const calls = { saves: [], mirrors: [], prompts: [], errors: [], destroy: 0 };
  let current = true;
  let sortableOptions;
  const timerCallbacks = new Map();
  let timerId = 0;
  const context = createContext({
    console: { warn() {}, error() {} },
    document: { createElement: (tag) => new Element(tag) },
    window: {
      setTimeout(callback) { timerCallbacks.set(++timerId, callback); return timerId; },
      clearTimeout(id) { timerCallbacks.delete(id); },
    },
    toastr: { error: (message) => calls.errors.push(message) },
    SillyTavern: { getContext: () => popupAvailable ? {
      POPUP_RESULT: { AFFIRMATIVE: 1 },
      Popup: { show: { confirm: async (...args) => { calls.prompts.push(args); return confirm(); } } },
    } : {} },
  });
  const imports = {
    '../entry-manager.utils.js': { setTooltip() {} },
    '../../shared/original-data.js': { mirrorEntryFieldsToOriginalData: (book, entry, fields) => calls.mirrors.push({ book, entry, fields: [...fields] }) },
  };
  const module = new SourceTextModule(await readFile(new URL('../src/entry-manager/table/table.body.row-sorting.js', import.meta.url), 'utf8'), { context });
  await module.link((name) => {
    const values = imports[name];
    assert.ok(values, name);
    return new SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  const tbody = new Element('tbody');
  const rows = [0, 1, 2, 3].map((uid) => {
    const row = new Element('tr');
    row.setAttribute('data-book', 'Book');
    row.setAttribute('data-uid', uid);
    return row;
  });
  tbody.append(...rows);
  const cache = { Book: { entries: Object.fromEntries(rows.map((row, uid) => [uid, { uid, extensions: { display_index: uid } }])) } };
  const dom = { order: { tbody } };
  const state = { sort, direction };
  const sortable = { sortable(option) {
    if (typeof option === 'object') sortableOptions = option;
    else if (option === 'instance') return calls.destroy ? null : {};
    else if (option === 'destroy') calls.destroy++;
    return sortable;
  } };
  const api = module.namespace.setupEntryManagerSorting({
    tbody, dom, cache, entryManagerState: state,
    isRenderCurrent: () => current,
    enqueueSave: async (book) => calls.saves.push(book),
    setEntryManagerSort: (sort, direction) => Object.assign(state, { sort, direction }),
    SORT: { CUSTOM: 'custom' }, SORT_DIRECTION: { ASCENDING: 'ascending' },
    getSortableDelay: () => 750, $: () => sortable,
  });
  return {
    api, tbody, rows, dom, cache, state, calls, sortable: sortableOptions,
    invalidate() { current = false; },
    order: () => tbody.children.map((row) => row.getAttribute('data-uid')),
    indices: () => Object.values(cache.Book.entries).map((entry) => entry.extensions.display_index),
    button(row, direction = 'down') {
      return module.namespace.createMoveButton({ row, direction, iconClass: 'fa-arrow', title: 'Move', jumpTitle: 'end', dom, ...api });
    },
    async flush() {
      const callbacks = [...timerCallbacks.values()];
      timerCallbacks.clear();
      callbacks.forEach((callback) => callback());
      await turn();
    },
    async drag() {
      assert.notEqual(sortableOptions.start(), false);
      tbody.append(rows[0]);
      const result = sortableOptions.update();
      sortableOptions.stop();
      return result;
    },
  };
}

test('ascending Custom reorder saves UID zero and mirrors every changed index without a popup', async () => {
  const h = await harness({ sort: 'custom' });
  h.button(h.rows[0]).fire('click');
  await h.flush();
  assert.deepEqual(h.order(), ['1', '0', '2', '3']);
  assert.deepEqual(h.indices(), [1, 0, 2, 3]);
  assert.deepEqual(h.calls.saves, ['Book']);
  assert.deepEqual(h.calls.mirrors.map(({ entry }) => entry.uid), [1, 0]);
  assert.deepEqual(h.calls.mirrors.map(({ fields }) => fields), [['displayIndex'], ['displayIndex']]);
  assert.equal(h.calls.prompts.length, 0);
});

for (const gesture of ['arrow', 'jump', 'drag']) {
  for (const accepted of [false, true]) {
    test(`${gesture} in a column-sorted view ${accepted ? 'saves only after acceptance' : 'cancels without writes'}`, async () => {
      const gate = deferred();
      const h = await harness({ confirm: () => gate.promise });
      let drag;
      if (gesture === 'drag') drag = h.drag();
      else {
        const button = h.button(h.rows[0]);
        button.fire('click');
        if (gesture === 'jump') button.fire('dblclick');
        await h.flush();
      }
      assert.equal(h.calls.prompts.length, 1);
      assert.match(h.calls.prompts[0][1], /not in ascending Custom order/);
      assert.deepEqual(h.indices(), [0, 1, 2, 3]);
      assert.deepEqual(h.calls.saves, []);
      if (gesture !== 'drag') assert.deepEqual(h.order(), ['0', '1', '2', '3']);
      gate.resolve(accepted ? 1 : 0);
      await drag;
      await turn();
      const expected = accepted ? gesture === 'arrow' ? ['1', '0', '2', '3'] : ['1', '2', '3', '0'] : ['0', '1', '2', '3'];
      assert.deepEqual(h.order(), expected);
      assert.equal(h.calls.saves.length, accepted ? 1 : 0);
      if (!accepted) assert.deepEqual(h.indices(), [0, 1, 2, 3]);
    });
  }
}

test('filtered Custom and descending Custom views require confirmation', async () => {
  const filtered = await harness({ sort: 'custom' });
  filtered.rows[1].classList.add('stwid--state-filtered');
  filtered.button(filtered.rows[0]).fire('click');
  await filtered.flush();
  assert.match(filtered.calls.prompts[0][1], /1 entry is hidden/);
  assert.deepEqual(filtered.order(), ['1', '2', '0', '3']);
  const descending = await harness({ sort: 'custom', direction: 'descending' });
  await descending.drag();
  assert.match(descending.calls.prompts[0][1], /not in ascending Custom order/);
  assert.equal(descending.state.direction, 'ascending');
});

test('pending confirmation excludes other arrows and drags until it settles', async () => {
  const gate = deferred();
  const h = await harness({ confirm: () => gate.promise });
  h.button(h.rows[0]).fire('click');
  await h.flush();
  h.button(h.rows[1]).fire('dblclick');
  assert.equal(h.sortable.start(), false);
  assert.equal(h.calls.prompts.length, 1);
  gate.resolve(0);
  await turn();
  assert.notEqual(h.sortable.start(), false);
  h.sortable.stop();
  h.button(h.rows[0]).fire('click');
  await h.flush();
  assert.equal(h.calls.prompts.length, 2, 'A no-op drag must release its operation');
});

for (const change of ['replace tbody', 'dispose', 'invalidate render', 'add row', 'replace row', 'change filters', 'change sort', 'replace entry', 'remap UID']) {
  test(`pending drag cannot save after ${change}`, async () => {
    const gate = deferred();
    const h = await harness({ confirm: () => gate.promise });
    const pending = h.drag();
    const replacement = new Element('tbody');
    if (change === 'replace tbody') h.dom.order.tbody = replacement;
    if (change === 'dispose') h.api.disposeSorting();
    if (change === 'invalidate render') h.invalidate();
    if (change === 'add row' || change === 'replace row') {
      const row = new Element('tr');
      row.setAttribute('data-book', 'Book'); row.setAttribute('data-uid', 20);
      if (change === 'replace row') replacement.append(h.rows[2]);
      h.tbody.append(row);
    }
    if (change === 'change filters') h.rows[2].classList.add('stwid--state-filtered');
    if (change === 'change sort') h.state.sort = 'order';
    if (change === 'replace entry') h.cache.Book.entries[2] = { uid: 2, extensions: { display_index: 2 } };
    if (change === 'remap UID') h.rows[2].setAttribute('data-uid', 20);
    gate.resolve(1);
    await pending;
    assert.deepEqual(h.calls.saves, []);
    assert.deepEqual(h.indices(), [0, 1, 2, 3]);
    if (change === 'replace tbody') assert.equal(replacement.children.length, 0, 'An obsolete render must never move its nodes into a new tbody');
    if (change === 'change filters') assert.deepEqual(h.order(), ['0', '1', '2', '3'], 'A changed filter aborts the save and safely restores the original order');
  });
}

test('missing or rejected host confirmation safely restores a drag', async () => {
  for (const options of [{ popupAvailable: false }, { confirm: () => Promise.reject(new Error('popup closed')) }]) {
    const h = await harness(options);
    await h.drag();
    assert.deepEqual(h.order(), ['0', '1', '2', '3']);
    assert.deepEqual(h.calls.saves, []);
    assert.equal(h.calls.errors.length, 1);
  }
});

test('dispose destroys sortable once and deferred button clicks cannot affect a replacement render', async () => {
  const h = await harness({ sort: 'custom' });
  h.button(h.rows[0]).fire('click');
  h.api.disposeSorting();
  h.api.disposeSorting();
  h.dom.order.tbody = new Element('tbody');
  await h.flush();
  assert.equal(h.calls.destroy, 1);
  assert.deepEqual(h.calls.saves, []);
  assert.deepEqual(h.order(), ['0', '1', '2', '3']);
});
