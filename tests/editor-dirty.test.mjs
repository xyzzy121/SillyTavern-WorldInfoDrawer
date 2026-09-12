import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

class Element {
  constructor(name = '', tagName = 'INPUT', type = 'text', value = '') {
    Object.assign(this, { name, tagName, type, value, checked: false, multiple: false, selectedOptions: [], children: [] });
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    };
    this.listeners = new Map();
  }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  removeEventListener(type, handler) {
    if (this.listeners.get(type) === handler) this.listeners.delete(type);
  }
  dispatchEvent(event) { this.listeners.get(event.type)?.(event); }
  setAttribute() {}
  append(...children) { this.children.push(...children); }
  contains(child) { return this.children.includes(child); }
  closest() { return this; }
  querySelector() { return null; }
  querySelectorAll(selector) { return selector.includes('input, textarea') ? this.children : []; }
}

const createEditor = async ({ fields = {}, controls = [] } = {}) => {
  const context = createContext({
    console,
    window: {},
    HTMLElement: Element,
    document: {
      contains: () => false,
      createElement: () => new Element(),
      createRange: () => ({ createContextualFragment: () => new Element() }),
    },
  });
  const module = new SourceTextModule(
    await readFile(new URL('../src/editor-panel/editor-panel.js', import.meta.url), 'utf8'),
    { context },
  );
  await module.link((specifier) => {
    if (specifier.endsWith('st-host.js')) {
      return new SyntheticModule(['splitKeywordsAndRegexes'], function () {
        this.setExport('splitKeywordsAndRegexes', (value) => {
          // The host owns tokenizing regex commas. This seam verifies the
          // editor delegates to that parser instead of splitting them itself.
          if (value === '/a,b/, tail') return ['/a,b/', 'tail'];
          return value.split(',').map((part) => part.trim()).filter(Boolean);
        });
      }, { context });
    }
    return new SyntheticModule(['applyMobileHeaderLayout', 'MOBILE_EDITOR_MEDIA_QUERY'], function () {
      this.setExport('applyMobileHeaderLayout', () => {});
      this.setExport('MOBILE_EDITOR_MEDIA_QUERY', '(max-width: 1000px)');
    }, { context });
  });
  await module.evaluate();
  const dom = {
    editor: new Element(),
    activationToggle: new Element(),
    order: { toggle: new Element() },
    drawer: { body: new Element() },
  };
  let currentEditor = null;
  let model = null;
  const api = module.namespace.initEditorPanel({
    dom,
    renderTemplateAsync: async () => '',
    getWorldEntry: async (_, __, entry) => {
      model = entry;
      const entryDom = new Element();
      entryDom.append(...controls);
      return [entryDom];
    },
    buildSavePayload: () => ({ entries: { 0: { uid: 0, ...fields }, 1: { uid: 1, ...fields } } }),
    setCurrentEditor: (value) => { currentEditor = value; },
    getSelectFrom: () => null,
    selectEnd: () => {},
  });
  return {
    api,
    dom,
    get model() { return model; },
    get currentEditor() { return currentEditor; },
    open: (name, uid) => api.openEntryEditor({
      name,
      entry: { uid },
      entryDom: new Element(),
      isTokenCurrent: () => true,
    }),
    edit: (target, type = 'input') => dom.editor.dispatchEvent({ type, target }),
  };
};

test('host updates keyed by string UID observe dirty numeric UID zero', async () => {
  const editor = await createEditor();
  await editor.open('Library', 0);
  assert.equal(editor.currentEditor.uid, 0);
  assert.equal(editor.api.isDirty('Library', '0'), false);
  editor.edit();
  assert.equal(editor.api.isDirty('Library', 0), true);
  assert.equal(editor.api.isDirty('Library', '0'), true);
  assert.equal(editor.api.isDirty('Library', 1), false);
  assert.equal(editor.api.isDirty('Other', '0'), false);
  assert.equal(editor.api.isDirty('Library', null), false);
  assert.equal(editor.api.isDirty('Library', undefined), false);
  editor.api.cleanup();
});

test('clean acknowledgements accept equivalent UIDs and ignore other editors or missing keys', async () => {
  const editor = await createEditor();
  await editor.open('Library', 0);
  editor.edit();
  for (const [name, uid] of [['Other', 0], ['Library', 1], ['Library', null], ['Library', undefined], ['', 0]]) {
    editor.api.markClean(name, uid);
    assert.equal(editor.api.isDirty('Library', '0'), true);
  }
  editor.api.markClean('Library', '0');
  assert.equal(editor.api.isDirty('Library', 0), false);

  await editor.open('Library', '1');
  editor.edit();
  assert.equal(editor.api.isDirty('Library', 1), true);
  editor.api.markClean('Library', 0);
  assert.equal(editor.api.isDirty('Library', 1), true);
  editor.api.markClean('Library', 1);
  assert.equal(editor.api.isDirty('Library', '1'), false);
  editor.api.cleanup();
});

test('clearing editor ownership and listener cleanup prevent stale dirty state', async () => {
  const editor = await createEditor();
  await editor.open('Library', 0);
  editor.edit();
  editor.api.clearEditor();
  editor.edit();
  assert.equal(editor.currentEditor, null);
  assert.equal(editor.api.isDirty('Library', '0'), false);
  await editor.open('Library', '1');
  editor.api.cleanup();
  editor.edit();
  assert.equal(editor.api.isDirty('Library', 1), false);
});

test('acknowledges saved content only when the mounted model and live draft both match', async () => {
  const content = new Element('content', 'TEXTAREA', 'textarea', 'Original');
  const editor = await createEditor({ fields: { content: 'Original' }, controls: [content] });
  await editor.open('Library', 0);
  content.value = 'First edit';
  editor.edit(content);
  editor.model.content = 'First edit';
  assert.equal(editor.api.markCleanIfSaved('Library', '0', { uid: 0, content: 'External edit' }), false);
  assert.equal(editor.api.isDirty('Library', 0), true);
  assert.equal(editor.api.markCleanIfSaved('Other', '0', structuredClone(editor.model)), false);
  assert.equal(editor.api.markCleanIfSaved('Library', 1, structuredClone(editor.model)), false);
  assert.equal(editor.api.markCleanIfSaved('Library', '0', structuredClone(editor.model)), true);
  assert.equal(editor.api.isDirty('Library', 0), false);

  content.value = 'Next edit';
  editor.edit(content);
  assert.equal(editor.api.markCleanIfSaved('Library', 0, structuredClone(editor.model)), false);
  editor.model.content = content.value;
  assert.equal(editor.api.markCleanIfSaved('Library', 0, structuredClone(editor.model)), true);
  editor.api.cleanup();
});

test('uncommitted keyword input survives unchanged updates and unrelated saves until async change commits', async () => {
  const key = new Element('key', 'TEXTAREA', 'textarea', 'original');
  const content = new Element('content', 'TEXTAREA', 'textarea', 'Old content');
  const editor = await createEditor({ fields: { key: ['original'], content: 'Old content' }, controls: [key, content] });
  await editor.open('Library', 0);
  key.value = '/a,b/, tail';
  editor.edit(key);
  assert.equal(editor.api.markCleanIfSaved('Library', '0', structuredClone(editor.model)), false);
  content.value = 'Other field saved';
  editor.edit(content);
  editor.model.content = content.value;
  assert.equal(editor.api.markCleanIfSaved('Library', 0, structuredClone(editor.model)), false);
  editor.edit(key, 'change');
  // The real host awaits resetScrollHeight before changing its keyword array.
  assert.equal(editor.api.markCleanIfSaved('Library', 0, structuredClone(editor.model)), false);
  await Promise.resolve();
  editor.model.key = ['/a,b/', 'tail'];
  assert.equal(editor.api.markCleanIfSaved('Library', '0', structuredClone(editor.model)), true);
  assert.equal(editor.api.isDirty('Library', 0), false);
  editor.api.cleanup();
});

test('a draft reverted to the original UI cannot acknowledge a newer saved model', async () => {
  const key = new Element('keysecondary', 'TEXTAREA', 'textarea', 'original');
  const editor = await createEditor({ fields: { keysecondary: ['original'] }, controls: [key] });
  await editor.open('Library', 0);
  key.value = 'committed';
  editor.edit(key, 'change');
  editor.model.keysecondary = ['committed'];
  key.value = 'original';
  editor.edit(key);
  assert.equal(editor.api.markCleanIfSaved('Library', '0', structuredClone(editor.model)), false);
  editor.model.keysecondary = ['original'];
  assert.equal(editor.api.markCleanIfSaved('Library', '0', structuredClone(editor.model)), true);
  editor.api.cleanup();
});

test('async title input remains dirty before the host model catches up', async () => {
  const comment = new Element('comment', 'TEXTAREA', 'textarea', 'Old title');
  const editor = await createEditor({ fields: { comment: 'Old title' }, controls: [comment] });
  await editor.open('Library', 0);
  comment.value = 'New title';
  editor.edit(comment);
  assert.equal(editor.api.markCleanIfSaved('Library', '0', structuredClone(editor.model)), false);
  await Promise.resolve();
  editor.model.comment = comment.value;
  assert.equal(editor.api.markCleanIfSaved('Library', '0', structuredClone(editor.model)), true);
  editor.api.cleanup();
});

test('select2 keyword drafts stay dirty until the draft is accepted and cleared', async () => {
  const draft = new Element('', 'TEXTAREA', 'textarea', '');
  draft.classList.add('select2-search__field');
  const editor = await createEditor({ fields: { key: [] }, controls: [draft] });
  await editor.open('Library', 0);
  draft.value = 'uncommitted';
  editor.edit(draft);
  assert.equal(editor.api.markCleanIfSaved('Library', 0, structuredClone(editor.model)), false);
  editor.model.key = ['uncommitted'];
  assert.equal(editor.api.markCleanIfSaved('Library', 0, structuredClone(editor.model)), false);
  draft.value = '';
  assert.equal(editor.api.markCleanIfSaved('Library', '0', structuredClone(editor.model)), true);
  editor.api.cleanup();
});

test('save acknowledgements handle standard host controls and field aliases', async (t) => {
  const cases = [
    { name: 'outletName', initial: { outletName: '' }, ui: { value: 'outlet' }, saved: { outletName: 'outlet' } },
    { name: 'group', initial: { group: '' }, ui: { value: ' group ' }, saved: { group: 'group' } },
    { name: 'order', type: 'number', initial: { order: 0 }, ui: { value: '42' }, saved: { order: 42 } },
    { name: 'scanDepth', type: 'number', initial: { scanDepth: 5 }, ui: { value: '' }, saved: { scanDepth: null } },
    { name: 'ignoreBudget', type: 'checkbox', initial: { ignoreBudget: false }, ui: { checked: true }, saved: { ignoreBudget: true } },
    { name: 'caseSensitive', tag: 'SELECT', initial: { caseSensitive: null }, ui: { value: 'true' }, saved: { caseSensitive: true } },
    { name: 'entryLogicType', tag: 'SELECT', initial: { selectiveLogic: 0 }, ui: { value: '1' }, saved: { selectiveLogic: 1 } },
    { name: 'entryStateSelector', tag: 'SELECT', initial: { constant: false, vectorized: false }, ui: { value: 'vectorized' }, saved: { constant: false, vectorized: true } },
    { name: 'position', tag: 'SELECT', initial: { position: 0, role: null }, ui: { value: '4', selectedOptions: [{ dataset: { role: '1' } }] }, saved: { position: 4, role: 1 } },
    { name: 'delay_until_recursion', type: 'checkbox', initial: { delayUntilRecursion: false }, ui: { checked: true }, saved: { delayUntilRecursion: true } },
    { name: 'delayUntilRecursionLevel', initial: { delayUntilRecursion: true }, ui: { value: '3' }, saved: { delayUntilRecursion: 3 } },
    { name: 'character_exclusion', type: 'checkbox', initial: {}, ui: { checked: true }, saved: { characterFilter: { isExclude: true, names: [], tags: [] } } },
    { name: 'characterFilter', tag: 'SELECT', initial: {}, ui: { multiple: true, selectedOptions: [{ dataset: { type: 'character' }, text: 'Ada', value: 'char-id' }, { dataset: { type: 'tag' }, text: 'Tag', value: 'tag-id' }] }, saved: { characterFilter: { isExclude: false, names: ['Ada'], tags: ['tag-id'] } } },
    { name: 'triggers', tag: 'SELECT', initial: { triggers: [] }, ui: { multiple: true, selectedOptions: [{ value: 'normal' }, { value: 'continue' }] }, saved: { triggers: ['normal', 'continue'] } },
    { name: 'key', tag: 'SELECT', initial: { key: [] }, ui: { multiple: true, selectedOptions: [{ value: 'encoded-id', text: '/a,b/' }] }, saved: { key: ['/a,b/'] } },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const control = new Element(scenario.name, scenario.tag ?? 'INPUT', scenario.type ?? 'text');
      const editor = await createEditor({ fields: scenario.initial, controls: [control] });
      await editor.open('Library', 0);
      Object.assign(control, scenario.ui);
      editor.edit(control, scenario.tag === 'SELECT' ? 'change' : 'input');
      Object.assign(editor.model, scenario.saved);
      assert.equal(editor.api.markCleanIfSaved('Library', '0', structuredClone(editor.model)), true);
      assert.equal(editor.api.isDirty('Library', 0), false);
      editor.api.cleanup();
    });
  }
});
