import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/book-browser/book-list/book-list.world-entry.js', import.meta.url), 'utf8');
const module = new vm.SourceTextModule(source);
await module.link(() => new vm.SyntheticModule(['mirrorEntryFieldsToOriginalData', 'beginEntryNavigation'], function () {
  this.setExport('mirrorEntryFieldsToOriginalData', () => {});
  this.setExport('beginEntryNavigation', () => ({ isCurrent: () => true }));
}));
await module.evaluate();
const { selectEntryRange, setWorldEntryContext } = module.namespace;

test('range selection preserves DOM order, existing selections, UID zero, and overlap', () => {
  const rows = Array.from({ length: 6 }, (_, uid) => ({ dataset: { uid: String(uid) } }));
  const selectedRows = [];
  const context = { selectList: ['5'], selectAdd: (row) => selectedRows.push(row) };
  setWorldEntryContext(context);
  selectEntryRange(rows[3], rows[0], { children: rows });
  selectEntryRange(rows[2], rows[5], { children: rows });
  assert.deepEqual(context.selectList, ['5', '0', '1', '2', '3', '4']);
  assert.deepEqual(selectedRows, [rows[0], rows[1], rows[2], rows[3], rows[4]]);
});

test('large range avoids repeated linear membership checks', () => {
  const rows = Array.from({ length: 10000 }, (_, uid) => ({ dataset: { uid: String(uid) } }));
  const selectList = ['0'];
  selectList.includes = () => { throw new Error('linear membership check'); };
  let added = 0;
  setWorldEntryContext({ selectList, selectAdd: () => { added += 1; } });
  selectEntryRange(rows[0], rows.at(-1), { children: rows });
  assert.equal(selectList.length, 10000);
  assert.equal(added, 9999);
  assert.equal(selectList.at(-1), '9999');
});

test('a detached range anchor leaves the selection untouched', () => {
  const row = { dataset: { uid: '1' } };
  const context = { selectList: [], selectAdd: () => assert.fail('must not select') };
  setWorldEntryContext(context);
  selectEntryRange({}, row, { children: [row] });
  assert.deepEqual(context.selectList, []);
});

test('rendered row selection and dragging follow a committed UID remap', async () => {
  class Element {
    children = [];
    dataset = {};
    listeners = new Map();
    attributes = new Map();
    classList = { add() {}, remove() {} };
    append(...nodes) { this.children.push(...nodes); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    setAttribute(name, value) { this.attributes.set(name, value); }
  }
  const realm = vm.createContext({ document: { createElement: () => new Element(), querySelector: () => null } });
  const rowsModule = new vm.SourceTextModule(source, { context: realm });
  await rowsModule.link(() => new vm.SyntheticModule(['mirrorEntryFieldsToOriginalData', 'beginEntryNavigation'], function () {
    this.setExport('mirrorEntryFieldsToOriginalData', () => {});
    this.setExport('beginEntryNavigation', () => ({ isCurrent: () => true }));
  }, { context: realm }));
  await rowsModule.evaluate();
  const entry = { uid: 0, comment: 'Renumber', key: [] };
  const world = { entries: { 0: entry }, dom: { entry: {}, entryList: new Element() } };
  const selected = [];
  const context = {
    cache: { A: world }, dom: { books: new Element() },
    selectFrom: 'A', selectList: [], selectAdd: (row) => selected.push(row),
  };
  rowsModule.namespace.setWorldEntryContext(context);
  const row = await rowsModule.namespace.renderEntry(entry, 'A');
  entry.uid = 77;
  row.dataset.uid = '77';
  world.entries = { 77: entry };
  world.dom.entry = { 77: world.dom.entry[0] };
  row.children[0].listeners.get('click')({ preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(context.selectList, ['77']);
  assert.equal(selected[0], row);
  row.listeners.get('pointerdown')({ button: 0 });
  assert.equal(row.attributes.get('draggable'), 'true');
  row.listeners.get('dragstart')({ preventDefault: () => assert.fail('remapped selected row must drag'), dataTransfer: { setData() {} } });
  assert.equal(context.dom.books.stwidDragEntryBook, 'A');
  row.listeners.get('dragend')();
  assert.equal(context.dom.books.stwidDragEntryBook, null);
});

test('mounted row actions resolve replacement data and a later remapped UID at event time', async () => {
  class Element {
    children = [];
    dataset = {};
    listeners = new Map();
    classList = { add() {}, remove() {}, toggle() {} };
    append(...nodes) { this.children.push(...nodes); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    setAttribute() {}
    cloneNode() { return new Element(); }
  }
  const realm = vm.createContext({ document: { createElement: () => new Element(), querySelector: () => new Element() } });
  const rowsModule = new vm.SourceTextModule(source, { context: realm });
  const mirrored = [];
  await rowsModule.link(() => new vm.SyntheticModule(['mirrorEntryFieldsToOriginalData', 'beginEntryNavigation'], function () {
    this.setExport('mirrorEntryFieldsToOriginalData', (_, entry) => mirrored.push(entry));
    this.setExport('beginEntryNavigation', () => ({ isCurrent: () => true, finish() {} }));
  }, { context: realm }));
  await rowsModule.evaluate();
  const original = { uid: 0, comment: 'Original object', key: [], disable: false, constant: false, vectorized: false };
  const world = { entries: { 0: original }, dom: { entry: {}, entryList: new Element() } };
  const opened = [];
  const saved = [];
  rowsModule.namespace.setWorldEntryContext({
    cache: { A: world }, dom: { books: new Element() },
    editorPanel: { openEntryEditor: async (options) => { opened.push(options.entry); return true; } },
    enqueueEntryStateSave: async (name) => { saved.push(name); },
  });
  const row = await rowsModule.namespace.renderEntry(original, 'A');
  // A host update replaces cache objects while retaining this mounted row.
  const current = { ...original, comment: 'Replacement object' };
  world.entries = { 0: current };
  // A later UID commit remaps current data and the row. The old captured object
  // retains UID 0, which now belongs to another entry and must remain unchanged.
  current.uid = 77;
  const unrelated = { ...original, comment: 'Different entry at old UID' };
  world.entries = { 0: unrelated, 77: current };
  world.dom.entry = { 77: world.dom.entry[0] };
  row.dataset.uid = '77';
  assert.equal(await row.stwidOpenEntry(), true);
  assert.equal(opened[0], current);
  const controls = world.dom.entry[77];
  await controls.isEnabled.listeners.get('click')();
  assert.equal(current.disable, true);
  assert.equal(unrelated.disable, false);
  controls.strategy.value = 'vectorized';
  await controls.strategy.listeners.get('change')();
  assert.equal(current.vectorized, true);
  assert.equal(current.constant, false);
  assert.equal(unrelated.vectorized, false);
  assert.equal(original.uid, 0);
  assert.equal(original.disable, false);
  assert.equal(original.vectorized, false);
  assert.deepEqual(saved, ['A', 'A']);
  assert.deepEqual(mirrored, [current, current]);
  delete world.entries[77];
  assert.equal(await row.stwidOpenEntry(), false);
  await controls.isEnabled.listeners.get('click')();
  await controls.strategy.listeners.get('change')();
  assert.equal(saved.length, 2, 'removed entries must not act on the old UID or save');
});
