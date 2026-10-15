import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';
import * as toggleA11y from '../src/shared/entry-toggle-a11y.js';

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.writes = 0;
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force = !classes.has(name)) => force ? classes.add(name) : classes.delete(name),
    };
  }
  append(...children) { this.children.push(...children); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.writes++; this.attributes.set(name, String(value)); }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }
  dispatch(type, props = {}) {
    const event = { type, preventDefault() {}, stopPropagation() {}, ...props };
    return Promise.all((this.listeners.get(type) ?? []).map((handler) => handler(event)));
  }
  click() { return this.dispatch('click'); }
  cloneNode() { return new Element(this.tagName); }
}

async function loadModule(path, imports, globals = {}) {
  const context = createContext(globals);
  const module = new SourceTextModule(await readFile(new URL(path, import.meta.url), 'utf8'), { context });
  await module.link((specifier) => {
    const exports = imports[specifier];
    assert.ok(exports, `Missing dependency: ${specifier}`);
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}

test('host toggle retains translated label and tab order, with exactly one activation and post-click state', async () => {
  const toggle = new Element();
  toggle.title = 'Translated host label';
  toggle.setAttribute('tabindex', '3');
  let clicks = 0;
  toggle.addEventListener('click', () => {
    clicks++;
    toggle.classList.toggle('fa-toggle-on');
  });
  assert.equal(toggleA11y.applyEntryToggleA11y(toggle), true);
  assert.equal(toggleA11y.applyEntryToggleA11y(toggle), false);
  assert.equal(toggle.getAttribute('role'), 'switch');
  assert.equal(toggle.getAttribute('tabindex'), '3');
  assert.equal(toggle.getAttribute('aria-label'), 'Translated host label');
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  for (const [index, key] of ['Enter', ' '].entries()) {
    let prevented = 0, stopped = 0;
    await toggle.dispatch('keydown', { key, preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
    assert.equal(clicks, index + 1);
    assert.equal(prevented, 1);
    assert.equal(stopped, 1);
    assert.equal(toggle.getAttribute('aria-checked'), String(index === 0));
  }
  const writes = toggle.writes;
  toggleA11y.syncEntryToggleChecked(toggle);
  assert.equal(toggle.writes, writes, 'Unchanged state must not trigger another DOM mutation');
  await toggle.dispatch('keydown', { key: 'Enter', ctrlKey: true });
  await toggle.dispatch('keydown', { key: ' ', repeat: true });
  toggle.disabled = true;
  await toggle.dispatch('keydown', { key: 'Enter' });
  assert.equal(clicks, 2);
});

test('native button keeps its own keyboard activation, and absent lazy controls are safe', () => {
  const toggle = new Element('button');
  toggleA11y.applyEntryToggleA11y(toggle);
  assert.equal(toggle.listeners.has('keydown'), false);
  assert.equal(toggle.getAttribute('aria-label'), "Toggle entry's active state");
  assert.equal(toggle.getAttribute('tabindex'), '0');
  assert.equal(toggleA11y.applyEntryToggleA11y(null), false);
  assert.doesNotThrow(() => toggleA11y.syncEntryToggleChecked(undefined));
});

for (const fails of [false, true]) {
  test(`Browser keyboard activation keeps accessible state aligned through save ${fails ? 'rollback' : 'success'}`, async () => {
    let resolveSave, rejectSave;
    const save = new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; });
    let saves = 0, errors = 0;
    const api = await loadModule('../src/book-browser/book-list/book-list.world-entry.js', {
      '../../shared/original-data.js': { mirrorEntryFieldsToOriginalData() {} },
      '../../shared/entry-navigation.js': { beginEntryNavigation() {} },
      '../../shared/entry-toggle-a11y.js': toggleA11y,
    }, {
      document: { createElement: (tag) => new Element(tag), querySelector: () => new Element() },
      toastr: { error() { errors++; } },
    });
    const entry = { uid: 0, comment: 'Entry zero', key: [], disable: false };
    const world = { entries: { 0: entry }, dom: { entry: {}, entryList: new Element() } };
    api.setWorldEntryContext({
      cache: { A: world },
      enqueueEntryStateSave: () => { saves++; return save; },
    });
    await api.renderEntry(entry, 'A');
    const toggle = world.dom.entry[0].isEnabled;
    assert.equal(toggle.getAttribute('role'), 'switch');
    assert.equal(toggle.getAttribute('aria-label'), 'Enable or disable this entry');
    assert.equal(toggle.getAttribute('aria-checked'), 'true');
    let activation;
    const nativeClick = toggle.click.bind(toggle);
    toggle.click = () => { activation = nativeClick(); return activation; };
    await toggle.dispatch('keydown', { key: ' ' });
    assert.equal(saves, 1);
    assert.equal(entry.disable, true);
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
    await toggle.dispatch('keydown', { key: 'Enter' });
    assert.equal(saves, 1, 'Pending saves prevent another toggle');
    if (fails) rejectSave(new Error('save failed')); else resolveSave();
    await activation;
    assert.equal(entry.disable, !fails);
    assert.equal(toggle.getAttribute('aria-checked'), String(fails));
    assert.equal(toggle.disabled, false);
    assert.equal(errors, Number(fails));
  });
}

test('bulk enabled changes synchronize mounted Browser switches while leaving lazy rows unmounted', async () => {
  let runApply;
  const entry = { uid: 0, disable: false };
  const lazyEntry = { uid: 1, disable: false };
  const browserToggle = new Element();
  browserToggle.classList.add('fa-toggle-on');
  toggleA11y.applyEntryToggleA11y(browserToggle);
  const rowToggle = new Element();
  const cache = { A: { entries: { 0: entry, 1: lazyEntry }, dom: { entry: { 0: { isEnabled: browserToggle } } } } };
  const targets = [
    { tr: { querySelector: () => rowToggle }, bookName: 'A', uid: 0, entryData: entry },
    { tr: { querySelector: () => null }, bookName: 'A', uid: 1, entryData: lazyEntry },
  ];
  const unused = () => assert.fail('Unrelated bulk operation invoked');
  const api = await loadModule('../src/entry-manager/bulk-editor-tab/bulk-edit-row.sections.js', {
    '../entry-manager.utils.js': { setTooltip() {} },
    '../../shared/constants.js': { ENTRY_MANAGER_RECURSION_OPTIONS: [] },
    '../../shared/utils.js': { maybeYieldToEventLoop() {} },
    '../../shared/original-data.js': { mirrorEntryFieldsToOriginalData() {} },
    '../../shared/entry-toggle-a11y.js': toggleA11y,
    './bulk-edit-row.helpers.js': {
      BULK_APPLY_BATCH_SIZE: 100, APPLY_DIRTY_CLASS: 'dirty', NON_NEGATIVE_PLACEHOLDER: '', RECURSION_ENTRY_FIELDS: [],
      createLabeledBulkContainer: () => new Element(),
      createApplyButton: (_, apply) => { runApply = apply; return new Element(); },
      runBulkTargetsApply: async ({ prepare, applyToTarget }) => { prepare(); targets.forEach(applyToTarget); },
      withApplyButtonLock: unused, createPersistedBulkNumberInput: unused, runBulkNumericFieldApply: unused,
      buildRecursionCheckboxRow: unused, applyRecursionFlagsToRowInputs: unused,
    },
  }, { document: { createElement: (tag) => new Element(tag) }, localStorage: { getItem: () => 'false' } });
  api.buildBulkStateSection({ cache });
  await runApply();
  assert.equal(entry.disable, true);
  assert.equal(lazyEntry.disable, true);
  assert.equal(rowToggle.getAttribute('aria-pressed'), 'false');
  assert.equal(browserToggle.getAttribute('aria-checked'), 'false');
  assert.equal(cache.A.dom.entry[1], undefined);
});
