import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createFolderBookSelection, createFolderAssignmentBatch } from '../src/book-browser/book-list/book-folders/book-folders.bulk-selection.js';
import { addLorebooksToFolderAction, closeAddLorebooksDialog } from '../src/book-browser/book-list/book-folders/book-folders.add-lorebooks.js';
import * as folders from '../src/book-browser/book-list/book-folders/book-folders.lorebook-folders.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
const harness = (names = ['Alpha', 'Beta']) => {
  const cache = Object.fromEntries(names.map((name) => [name, { metadata: {} }]));
  const writes = [];
  let refreshes = 0;
  let dirty = false;
  let current = true;
  const options = {
    folderName: 'Target', cache, getWorldNames: () => names,
    isDirtyCheck: () => dirty, isCurrent: () => current,
    setBookFolder: async (name, folder) => {
      writes.push([name, folder]);
      cache[name].metadata.folder = folder;
      return { ok: true };
    },
    refreshList: async () => { refreshes += 1; },
  };
  const selection = createFolderBookSelection(options);
  return {
    names, cache, writes, options, selection,
    get refreshes() { return refreshes; },
    setDirty(value) { dirty = value; },
    dispose() { current = false; },
    batch(overrides = {}) { return createFolderAssignmentBatch({ ...options, selection, ...overrides }); },
  };
};

test('selection preserves exact names and filtered selections, searches book/folder, and excludes destination books', () => {
  const unusual = ['__proto__', "  O'Brien: [雨] 😀\n e\u0301  ", '<b>literal</b>', 'Alpha', 'Already', 'Unavailable'];
  const h = harness(unusual);
  h.cache.Alpha.metadata.folder = 'Previous';
  h.cache.Already.metadata.folder = 'tArGeT';
  delete h.cache.Unavailable;
  h.selection.selectVisible('previous');
  h.selection.select(unusual[1], true);
  assert.deepEqual([...h.selection.selected], ['Alpha', unusual[1]]);
  assert.deepEqual(h.selection.entries('ALP').map((entry) => entry.name), ['Alpha']);
  assert.equal(h.selection.selected.has(unusual[1]), true);
  h.selection.selectVisible('');
  assert.equal(h.selection.selected.size, 4);
  assert.equal(h.selection.selected.has('__proto__'), true);
  h.selection.select('Already', true);
  h.selection.select('Unavailable', true);
  assert.equal(h.selection.selected.size, 4);
  h.selection.clear();
  assert.equal(h.selection.selected.size, 0);
});

test('batch serializes saves, prevents duplicate submissions, and refreshes once', async () => {
  const h = harness();
  h.selection.selectVisible('');
  const gates = [];
  const batch = h.batch({ setBookFolder: (name, folder) => {
    const gate = deferred();
    gates.push(gate);
    h.writes.push([name, folder]);
    return gate.promise;
  } });
  const first = batch.submit();
  assert.equal(batch.busy, true);
  assert.equal(await batch.submit(), null);
  assert.deepEqual(h.writes, [['Alpha', 'Target']]);
  gates[0].resolve({ ok: true });
  await turn();
  assert.deepEqual(h.writes, [['Alpha', 'Target'], ['Beta', 'Target']]);
  assert.equal(h.refreshes, 0);
  gates[1].resolve({ ok: true });
  const result = await first;
  assert.deepEqual(result.moved, ['Alpha', 'Beta']);
  assert.equal(h.refreshes, 1);
  assert.equal(h.selection.selected.size, 0);
  assert.equal(batch.busy, false);
});

test('partial failures retain only failed names and explicit retry does not repeat successful moves', async () => {
  const h = harness(['Good', 'Reject', 'False']);
  h.selection.selectVisible('');
  const result = await h.batch({ setBookFolder: async (name) => {
    if (name === 'Reject') throw new Error('Save rejected');
    return name === 'False' ? { ok: false } : { ok: true };
  } }).submit();
  assert.deepEqual(result.moved, ['Good']);
  assert.deepEqual(new Set(result.failed), new Set(['Reject', 'False']));
  assert.deepEqual(h.selection.selected, new Set(['Reject', 'False']));
  assert.equal(h.refreshes, 1);
  await h.batch().submit();
  assert.deepEqual(new Set(h.writes.map(([name]) => name)), new Set(['Reject', 'False']));
  assert.equal(h.refreshes, 2);
});

test('books moved or removed since selection are skipped without writes', async () => {
  const h = harness(['Moved', 'Deleted', 'Keep']);
  h.selection.selectVisible('');
  h.cache.Moved.metadata.folder = 'TARGET';
  h.names.splice(h.names.indexOf('Deleted'), 1);
  const result = await h.batch().submit();
  assert.deepEqual(new Set(result.skipped), new Set(['Deleted', 'Moved']));
  assert.deepEqual(h.writes, [['Keep', 'Target']]);
  assert.equal(h.refreshes, 1);
});

test('dirty editor blocks writes and refresh without losing selections', async () => {
  const h = harness();
  h.selection.selectVisible('');
  h.setDirty(true);
  const result = await h.batch().submit();
  assert.equal(result.blocked, true);
  assert.equal(h.writes.length, 0);
  assert.equal(h.refreshes, 0);
  assert.equal(h.selection.selected.size, 2);
});

test('drafts created during a save stop remaining moves and defer the destructive list refresh', async () => {
  const h = harness();
  h.selection.selectVisible('');
  const result = await h.batch({ setBookFolder: async () => {
    h.setDirty(true);
    return { ok: true };
  } }).submit();
  assert.deepEqual(result.moved, ['Alpha']);
  assert.equal(result.blocked, true);
  assert.equal(result.refreshDeferred, true);
  assert.equal(h.refreshes, 0);
  assert.deepEqual([...h.selection.selected], ['Beta']);
});

test('teardown during a save stops remaining writes and refresh', async () => {
  const h = harness();
  h.selection.selectVisible('');
  const result = await h.batch({ setBookFolder: async () => {
    h.dispose();
    return { ok: true };
  } }).submit();
  assert.deepEqual(result.moved, ['Alpha']);
  assert.equal(h.refreshes, 0);
  assert.deepEqual([...h.selection.selected], ['Beta']);
});

test('refresh failure preserves the saved result and is reported separately from move failures', async () => {
  const h = harness();
  h.selection.selectVisible('');
  const failure = new Error('Refresh failed');
  const result = await h.batch({ refreshList: async () => { throw failure; } }).submit();
  assert.equal(result.refreshError, failure);
  assert.deepEqual(result.moved, ['Alpha', 'Beta']);
  assert.deepEqual(result.failed, []);
  assert.equal(h.selection.selected.size, 0);
});

test('bulk moves reuse the real queued folder writer and preserve entries, extras, metadata, and exact names', async () => {
  const source = await readFile(new URL('../src/book-browser/book-browser.js', import.meta.url), 'utf8');
  const context = vm.createContext({ structuredClone, console, toastr: { error: assert.fail } });
  const module = new vm.SourceTextModule(`${source}\nexport const configureTest = (value) => { state = value; }; export { setBookFolder };`, { context });
  const imports = new Map([...source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*'([^']+)'/g)].map((match) => [match[2], match[1]]));
  await module.link((specifier) => {
    const exports = Object.fromEntries(imports.get(specifier).split(',').map((item) => item.trim()).filter(Boolean)
      .map((item) => [item.split(/\s+as\s+/)[0], () => {}]));
    if (specifier.endsWith('lorebook-folders.js')) Object.assign(exports, folders);
    if (specifier.endsWith('sort-helpers.js')) exports.cloneMetadata = structuredClone;
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  const h = harness([" O'Brien [雨] 😀 ", '__proto__']);
  const books = new Map(h.names.map((name) => [name, {
    entries: { 0: { uid: 0, content: 'Original', custom: [1, 2] } },
    metadata: { folder: 'Old', custom: { nested: ['preserve'] }, sort: 'priority' },
    extensions: { arbitrary: true }, name,
  }]));
  const original = structuredClone(books);
  let queued = 0;
  module.namespace.configureTest({
    cache: h.cache,
    enqueueBookSave: async (name, operation) => {
      queued += 1;
      // An entry saved after opening the checklist must survive folder assignment.
      books.get(name).entries[0].content = 'Latest saved entry';
      return operation();
    },
    loadWorldInfo: async (name) => books.get(name),
    saveWorldInfo: async (name, payload, immediate) => {
      assert.equal(immediate, true);
      books.set(name, payload);
    },
    getSortFromMetadata: () => null,
  });
  h.selection.selectVisible('');
  const result = await h.batch({ setBookFolder: module.namespace.setBookFolder }).submit();
  assert.equal(queued, 2);
  assert.deepEqual(new Set(result.moved), new Set(h.names));
  for (const name of h.names) {
    const expected = original.get(name);
    expected.entries[0].content = 'Latest saved entry';
    expected.metadata.folder = 'Target';
    assert.deepEqual(JSON.parse(JSON.stringify(books.get(name))), expected);
  }
});

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.classList = { add: (...names) => { this.className = [...new Set([...(this.className ?? '').split(' '), ...names])].join(' '); } };
    this.value = '';
  }
  append(...nodes) { for (const node of nodes) { this.children.push(node); node.parent = this; } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  async emit(type, event = {}) { for (const fn of this.listeners.get(type) ?? []) await fn({ target: this, ...event }); }
  all() { return this.children.flatMap((child) => [child, ...child.all()]); }
  querySelectorAll(selector) { return this.all().filter((element) => selector.startsWith('.')
    ? (element.className ?? '').split(' ').includes(selector.slice(1)) : element.tagName === selector); }
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
  click() { void this.emit('click', { preventDefault() {}, stopPropagation() {} }); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  close() { this.open = false; void this.emit('close'); }
  showModal() { this.open = true; }
  focus() { this.focused = true; }
}

function uiHarness() {
  const h = harness(['Alpha', 'Beta', 'Already']);
  h.cache.Already.metadata.folder = 'Target';
  const body = new Element('body');
  const warnings = [];
  globalThis.document = { body, createElement: (tag) => new Element(tag) };
  globalThis.toastr = { success() {}, warning: (text) => warnings.push(text) };
  const open = () => addLorebooksToFolderAction({ folderName: 'Target', menuActions: h.options });
  const button = (label) => body.all().find((el) => el.tagName === 'button' && el.textContent === label);
  const search = () => body.all().find((el) => el.type === 'search');
  const checkboxes = () => body.all().filter((el) => el.type === 'checkbox');
  return { ...h, h, body, warnings, open, button, search, checkboxes };
}

test('dialog retains selections while filtering, marks destination books, and cancels without saving', async () => {
  const ui = uiHarness();
  ui.open();
  assert.equal(ui.body.children[0].attributes['aria-label'], 'Add lorebooks to Target');
  assert.equal(ui.checkboxes().filter((el) => el.disabled).length, 1);
  await ui.button('Select visible').emit('click');
  ui.search().value = 'beta';
  await ui.search().emit('input');
  assert.equal(ui.checkboxes().length, 1);
  assert.equal(ui.checkboxes()[0].checked, true);
  assert.equal(ui.body.all().find((el) => el.textContent === '2 selected')?.attributes.role, 'status');
  await ui.button('Clear selection').emit('click');
  ui.search().value = '';
  await ui.search().emit('input');
  assert.equal(ui.checkboxes().filter((el) => el.checked).length, 0);
  await ui.button('Cancel').emit('click');
  assert.equal(ui.body.children.length, 0);
  assert.equal(ui.writes.length, 0);
});

test('dialog blocks dirty open/save and cleans up without duplicate instances', async () => {
  const ui = uiHarness();
  ui.h.setDirty(true);
  ui.open();
  assert.equal(ui.body.children.length, 0);
  assert.equal(ui.warnings.length, 1);
  ui.h.setDirty(false);
  ui.open();
  ui.open();
  assert.equal(ui.body.children.length, 1);
  await ui.button('Select visible').emit('click');
  ui.h.setDirty(true);
  await ui.button('Add selected').emit('click');
  assert.equal(ui.writes.length, 0);
  assert.ok(ui.body.all().some((el) => el.textContent?.includes('Save or discard changes')));
  closeAddLorebooksDialog(ui.options);
  assert.equal(ui.body.children.length, 0);
  ui.h.setDirty(false);
  ui.open();
  assert.equal(ui.body.children.length, 1);
  closeAddLorebooksDialog(ui.options);
});

test('dialog disables controls during submission and keeps failures selected for retry', async () => {
  const ui = uiHarness();
  const gate = deferred();
  ui.options.setBookFolder = (name) => name === 'Alpha' ? gate.promise : Promise.resolve({ ok: false });
  ui.open();
  await ui.button('Select visible').emit('click');
  const pending = ui.button('Add selected').emit('click');
  assert.equal(ui.search().disabled, true);
  assert.equal(ui.button('Cancel').disabled, true);
  let prevented = false;
  await ui.body.children[0].emit('cancel', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  gate.resolve({ ok: true });
  await pending;
  assert.equal(ui.button('Retry selected').disabled, false);
  assert.equal(ui.checkboxes().filter((el) => el.checked).length, 1);
  assert.ok(ui.body.all().some((el) => el.textContent?.startsWith('1 added, 0 skipped, 1 failed.')));
  assert.equal(ui.h.refreshes, 1);
  closeAddLorebooksDialog(ui.options);
});

test('folder menu keyboard activation reaches Add Lorebooks and Escape restores focus', async () => {
  const body = new Element('body');
  const context = vm.createContext({ document: { body, createElement: (tag) => new Element(tag) } });
  const source = await readFile(new URL('../src/book-browser/book-list/book-folders/book-folders.folder-dom.js', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(`${source}\nexport { createFolderActionsDom };`, { context });
  const imports = new Map([...source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*'([^']+)'/g)].map((match) => [match[2], match[1]]));
  let opened = 0;
  await module.link((specifier) => {
    const exports = Object.fromEntries(imports.get(specifier).split(',').map((item) => item.trim()).filter(Boolean).map((name) => [name, () => {}]));
    if (Object.hasOwn(exports, 'addLorebooksToFolderAction')) exports.addLorebooksToFolderAction = () => { opened += 1; };
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  const actions = module.namespace.createFolderActionsDom({ folderName: 'Target', header: new Element('header'), menuActions: {} });
  const trigger = actions.querySelector('.stwid--folder-menu');
  assert.equal(trigger.tabIndex, 0);
  await trigger.emit('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} });
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  const add = body.querySelector('.stwid--add-lorebooks');
  assert.equal(add.focused, true);
  await add.emit('keydown', { key: ' ', preventDefault() {} });
  await turn();
  assert.equal(opened, 1);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  await trigger.emit('keydown', { key: ' ', preventDefault() {}, stopPropagation() {} });
  await body.children[0].emit('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(body.children.length, 0);
  assert.equal(trigger.focused, true);
});
