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
  set innerHTML(value) { if (value === '') this.children = []; }
  contains(child) { return this.children.includes(child); }
  closest() { return this; }
  querySelector() { return null; }
  querySelectorAll(selector) { return selector.includes('input, textarea') ? this.children : []; }
}

const navigationSource = await readFile(new URL('../src/shared/entry-navigation.js', import.meta.url), 'utf8');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const createEditor = async ({ fields = {}, controls = [], onCloseMenus = () => {}, renderHeader = async () => '', beforeBuild = async () => {}, mobile } = {}) => {
  const media = {
    matches: Boolean(mobile),
    addEventListener: (_, callback) => { media.listener = callback; },
    removeEventListener: () => { media.listener = null; },
  };
  const context = createContext({
    console,
    window: { matchMedia: mobile === undefined ? undefined : () => media },
    requestAnimationFrame: () => {},
    HTMLElement: Element,
    document: {
      contains: (element) => mobile !== undefined && dom.editor.children.includes(element),
      createElement: () => new Element(),
      createRange: () => ({ createContextualFragment: () => new Element() }),
    },
  });
  const module = new SourceTextModule(
    await readFile(new URL('../src/editor-panel/editor-panel.js', import.meta.url), 'utf8'),
    { context },
  );
  await module.link((specifier) => {
    if (specifier.endsWith('entry-navigation.js')) return new SourceTextModule(navigationSource, { context });
    if (specifier.endsWith('multiselect-dropdown.js')) {
      return new SyntheticModule(['closeOpenMultiselectDropdownMenus'], function () {
        this.setExport('closeOpenMultiselectDropdownMenus', onCloseMenus);
      }, { context });
    }
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
    renderTemplateAsync: renderHeader,
    getWorldEntry: async (name, __, entry) => {
      await beforeBuild(name, entry);
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
    changeLayout: async (mobileLayout) => {
      media.matches = mobileLayout;
      media.listener?.();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
};

test('programmatic editor clearing closes only its owned dropdowns before detaching the tree', async () => {
  const events = [];
  const calls = [];
  const editor = await createEditor({ onCloseMenus: (...args) => { events.push('close menus'); calls.push(args); } });
  Object.defineProperty(editor.dom.editor, 'innerHTML', { set: () => events.push('detach tree') });
  editor.api.clearEditor();
  assert.deepEqual(events, ['close menus', 'detach tree']);
  assert.equal(calls[0][0], null);
  assert.equal(calls[0][1], editor.dom.editor);
});

test('closing a manager releases every view reference and preserves the containers and cleanup hook for reopening', async () => {
  const events = [];
  const editor = await createEditor();
  const order = editor.dom.order;
  const toggle = order.toggle;
  const direction = order.direction = { up: undefined, down: undefined };
  const filter = order.filter = { root: undefined, preview: undefined, cancel: undefined };
  const uid = order.uid = { start: undefined };
  const bulkCleanup = { current: null };
  const cleanup = order.cleanup = () => {
    bulkCleanup.current?.();
    bulkCleanup.current = null;
  };
  const directViewFields = ['tbody', 'sortSelect', 'selectAll', 'start', 'step'];

  for (let cycle = 0; cycle < 2; cycle++) {
    // These are the assignments made by the real manager builders on each
    // render. Each retained child would keep the same detached parent alive.
    const managerRoot = new Element();
    const child = () => {
      const node = new Element();
      node.parentElement = managerRoot;
      managerRoot.append(node);
      return node;
    };
    for (const field of directViewFields) order[field] = child();
    order.entries = { Book: { 0: child() } };
    order.selection = { tbody: order.tbody, counter: {} };
    order.refreshSelectionCount = () => managerRoot;
    direction.up = child();
    direction.down = child();
    uid.start = child();
    filter.root = child();
    filter.preview = child();
    filter.cancel = () => { events.push(`cancel ${cycle}`); return managerRoot; };
    order.hydration = { dispose: () => { events.push(`dispose ${cycle}`); return managerRoot; } };
    bulkCleanup.current = () => { events.push(`bulk cleanup ${cycle}`); return managerRoot; };
    editor.dom.editor.append(managerRoot);
    editor.api.clearEditor();

    assert.deepEqual(events.slice(cycle * 3), [`dispose ${cycle}`, `bulk cleanup ${cycle}`, `cancel ${cycle}`]);
    assert.equal(editor.dom.editor.children.length, 0);
    for (const field of [...directViewFields, 'selection', 'hydration', 'refreshSelectionCount']) {
      assert.equal(order[field], undefined, `${field} must not retain the closed manager`);
    }
    assert.equal(Object.keys(order.entries).length, 0);
    assert.equal(order.direction, direction);
    assert.equal(order.uid, uid);
    assert.equal(order.filter, filter);
    for (const container of [direction, uid, filter]) {
      assert.ok(Object.values(container).every((value) => value === undefined));
    }
    assert.equal(order.toggle, toggle);
    assert.equal(order.cleanup, cleanup, 'The permanent cleanup hook must work again on the next render');
    assert.equal(bulkCleanup.current, null, 'The permanent hook releases its per-view closure');
  }

  // The editor can also replace the closed manager and still track its data.
  assert.equal(await editor.open('Book', 0), true);
  assert.equal(editor.currentEditor.uid, 0);
  editor.api.clearEditor();
  editor.api.cleanup();
});

const createMobileBackButton = async (editor) => {
  const source = await readFile(new URL('../src/drawer.js', import.meta.url), 'utf8');
  const warnings = [];
  const context = createContext({ console, toastr: { warning(message) { warnings.push(message); } } });
  // Expose the real private wiring in this VM only; production exports stay
  // unchanged. Unrelated drawer dependencies are not exercised by a back tap.
  const module = new SourceTextModule(`${source}\nexport { wireMobileBackButton };`, { context });
  const importNames = new Map([...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)]
    .map(([, names, specifier]) => [specifier, names.split(',').map((name) => name.trim()).filter(Boolean)]));
  await module.link((specifier) => {
    const names = importNames.get(specifier);
    return new SyntheticModule(names, function () {
      for (const name of names) this.setExport(name, undefined);
    }, { context });
  });
  await module.evaluate();
  const button = new Element('', 'BUTTON');
  module.namespace.wireMobileBackButton({
    dom: editor.dom,
    editorPanelApi: editor.api,
    getCurrentEditor: () => editor.currentEditor,
    mobileBackBtn: button,
  });
  return { button, warnings };
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

test('mobile back navigation preserves an uncommitted title draft', async () => {
  const title = new Element('comment', 'TEXTAREA', 'textarea', 'Original title');
  const editor = await createEditor({ fields: { comment: 'Original title' }, controls: [title] });
  try {
    await editor.open('Library', 0);
    title.value = 'Unsaved mobile title';
    editor.edit(title);
    assert.equal(editor.api.isDirty('Library', 0), true);
    assert.equal(editor.model.comment, 'Original title', 'the host has not committed the input yet');

    const { button, warnings } = await createMobileBackButton(editor);
    button.dispatchEvent({ type: 'click' });

    assert.equal(editor.currentEditor?.uid, 0, 'navigation must retain the dirty editor');
    assert.equal(editor.api.isDirty('Library', 0), true);
    assert.equal(title.value, 'Unsaved mobile title');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /unsaved edits/i);
  } finally {
    editor.api.cleanup();
  }
});

test('mobile back navigation still closes a clean editor', async () => {
  const editor = await createEditor();
  try {
    await editor.open('Library', 0);
    const { button, warnings } = await createMobileBackButton(editor);
    button.dispatchEvent({ type: 'click' });

    assert.equal(editor.currentEditor, null);
    assert.equal(editor.dom.drawer.body.classList.contains('stwid--mobile-panel-open'), false);
    assert.deepEqual(warnings, []);
  } finally {
    editor.api.cleanup();
  }
});

test('a later cross-book editor request cancels an older asynchronous build', async () => {
  const pending = deferred();
  const started = deferred();
  const editor = await createEditor({ beforeBuild: async (name) => {
    if (name === 'Slow') { started.resolve(); await pending.promise; }
  } });
  const oldRequest = editor.open('Slow', 0);
  await started.promise;
  assert.equal(await editor.open('Latest', 1), true);
  pending.resolve();
  assert.equal(await oldRequest, false);
  assert.equal(editor.currentEditor.name, 'Latest');
  editor.api.cleanup();
});

test('clearing an editor cancels a header request before any editor build', async () => {
  const pending = deferred();
  let builds = 0;
  const editor = await createEditor({ renderHeader: () => pending.promise, beforeBuild: () => { builds += 1; } });
  const request = editor.open('Slow', 0);
  editor.api.clearEditor();
  pending.resolve('');
  assert.equal(await request, false);
  assert.equal(builds, 0);
  assert.equal(editor.currentEditor, null);
  editor.api.cleanup();
});

test('mobile Back cancels a pending editor build and cannot be reopened by its completion', async () => {
  const pending = deferred();
  const started = deferred();
  const editor = await createEditor({ beforeBuild: async (name) => {
    if (name === 'Slow') { started.resolve(); await pending.promise; }
  } });
  await editor.open('Initial', 0);
  const request = editor.open('Slow', 1);
  await started.promise;
  const { button } = await createMobileBackButton(editor);
  button.dispatchEvent({ type: 'click' });
  pending.resolve();
  assert.equal(await request, false);
  assert.equal(editor.currentEditor, null);
  editor.api.cleanup();
});

test('typing into the existing editor during navigation preserves that draft', async () => {
  const pending = deferred();
  const started = deferred();
  const editor = await createEditor({ beforeBuild: async (name) => {
    if (name === 'Slow') { started.resolve(); await pending.promise; }
  } });
  await editor.open('Initial', 0);
  const request = editor.open('Slow', 1);
  await started.promise;
  editor.edit();
  pending.resolve();
  assert.equal(await request, false);
  assert.equal(editor.currentEditor.name, 'Initial');
  assert.equal(editor.api.isDirty('Initial', 0), true);
  editor.api.cleanup();
});

test('closing a competing manager during accepted navigation preserves its ownership token', async () => {
  const editor = await createEditor();
  editor.dom.order.toggle.classList.add('stwid--state-active');
  editor.dom.order.toggle.click = () => {
    editor.api.clearEditor();
    editor.dom.order.toggle.classList.remove('stwid--state-active');
  };
  assert.equal(await editor.open('Library', 0), true);
  assert.equal(editor.currentEditor.name, 'Library');
  editor.api.cleanup();
});

test('a clean mounted editor can restore desktop layout after a dirty-draft navigation abort', async () => {
  const pending = deferred();
  const started = deferred();
  const builds = [];
  const editor = await createEditor({ mobile: true, beforeBuild: async (name) => {
    builds.push(name);
    if (name === 'Slow') { started.resolve(); await pending.promise; }
  } });
  await editor.open('Initial', 0);
  const request = editor.open('Slow', 1);
  await started.promise;
  editor.edit();
  pending.resolve();
  assert.equal(await request, false);
  editor.api.markClean('Initial', 0);
  await editor.changeLayout(false);
  assert.deepEqual(builds, ['Initial', 'Slow', 'Initial']);
  assert.equal(editor.currentEditor.name, 'Initial');
  editor.api.cleanup();
});

test('an unavailable entry does not permanently invalidate the mounted editor layout callback', async () => {
  let builds = 0;
  const editor = await createEditor({ mobile: true, beforeBuild: () => { builds += 1; } });
  await editor.open('Initial', 0);
  assert.equal(await editor.open('Missing', 999), false);
  await editor.changeLayout(false);
  assert.equal(builds, 2);
  assert.equal(editor.currentEditor.name, 'Initial');
  editor.api.cleanup();
});

test('a breakpoint change cannot supersede an explicit navigation still building its editor', async () => {
  const pending = deferred();
  const started = deferred();
  const builds = [];
  const editor = await createEditor({ mobile: true, beforeBuild: async (name) => {
    builds.push(name);
    if (name === 'Slow') { started.resolve(); await pending.promise; }
  } });
  await editor.open('Initial', 0);
  const request = editor.open('Slow', 1);
  await started.promise;
  await editor.changeLayout(false);
  assert.deepEqual(builds, ['Initial', 'Slow']);
  pending.resolve();
  assert.equal(await request, true);
  assert.equal(editor.currentEditor.name, 'Slow');
  editor.api.cleanup();
});

test('title blur after a successful save does not block mobile Back again', async () => {
  const title = new Element('comment', 'TEXTAREA', 'textarea', 'Original title');
  const editor = await createEditor({ fields: { comment: 'Original title' }, controls: [title] });
  try {
    await editor.open('Library', 0);
    title.value = 'Saved title';
    editor.edit(title);
    editor.model.comment = title.value;
    assert.equal(editor.api.markCleanIfSaved('Library', 0, structuredClone(editor.model)), true);

    // The host saves titles on input. Blurring for Back later emits change,
    // with no new value and therefore no later host save acknowledgement.
    editor.edit(title, 'change');
    assert.equal(editor.api.isDirty('Library', 0), false);
    const { button, warnings } = await createMobileBackButton(editor);
    button.dispatchEvent({ type: 'click' });
    assert.equal(editor.currentEditor, null);
    assert.deepEqual(warnings, []);
  } finally {
    editor.api.cleanup();
  }
});

test('change events still protect new control values and model changes without acknowledgement', async () => {
  for (const changedPart of ['control', 'model']) {
    const title = new Element('comment', 'TEXTAREA', 'textarea', 'Original title');
    const editor = await createEditor({ fields: { comment: 'Original title' }, controls: [title] });
    try {
      await editor.open('Library', 0);
      if (changedPart === 'control') title.value = 'New draft';
      else editor.model.comment = 'Unacknowledged model change';
      editor.edit(title, 'change');
      assert.equal(editor.api.isDirty('Library', 0), true, changedPart);
    } finally {
      editor.api.cleanup();
    }
  }
});

test('mobile back navigation delegates to the active Entry Manager close action', async () => {
  const editor = await createEditor();
  try {
    await editor.open('Library', 0);
    editor.edit();
    editor.dom.order.toggle.classList.add('stwid--state-active');
    let managerCloseCalls = 0;
    editor.dom.order.toggle.click = () => { managerCloseCalls += 1; };
    const { button, warnings } = await createMobileBackButton(editor);
    button.dispatchEvent({ type: 'click' });

    assert.equal(managerCloseCalls, 1);
    assert.equal(editor.currentEditor?.uid, 0, 'the manager action owns its own editor reset');
    assert.equal(editor.api.isDirty('Library', 0), true);
    assert.deepEqual(warnings, []);
  } finally {
    editor.api.cleanup();
  }
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
