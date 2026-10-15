import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, SourceTextModule } from 'node:vm';

class Target {
  listeners = [];
  addEventListener(type, handler, capture = false) {
    this.listeners.push({ type, handler, capture: Boolean(capture) });
  }
  removeEventListener(type, handler, capture = false) {
    this.listeners = this.listeners.filter((listener) =>
      listener.type !== type || listener.handler !== handler || listener.capture !== Boolean(capture));
  }
  emitPhase(event, capture) {
    for (const listener of [...this.listeners]) {
      if (listener.type === event.type && listener.capture === capture) listener.handler(event);
    }
  }
}

const createDropdown = async () => {
  const document = new Target();
  const allElements = [];
  class Element extends Target {
    constructor(tagName) {
      super();
      this.tagName = tagName.toUpperCase();
      this.isConnected = true;
      this.children = [];
      this.attributes = new Map();
      const classes = new Set();
      this.classList = {
        contains: (name) => classes.has(name),
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        toggle(name, enabled = !classes.has(name)) {
          enabled ? classes.add(name) : classes.delete(name);
        },
      };
      allElements.push(this);
    }
    append(child) { this.children.push(child); child.parentElement = this; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    querySelector() { return null; }
    querySelectorAll() { return this.children; }
    contains(target) { return target === this || this.children.some((child) => child.contains(target)); }
    focus() { document.activeElement = this; }
  }
  document.querySelectorAll = (selector) => selector.includes('stwid--blocker') ? [] :
    allElements.filter((element) => element.classList.contains('stwid--multiselect-dropdown__menu') &&
      element.classList.contains('stwid--state-active'));

  // Model the relevant DOM order: document capture -> target/bubbling parents
  // -> document bubble. The host's document listener is installed first.
  const dispatch = (target, type, key) => {
    const event = {
      type, target, key, stopped: false, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
    };
    document.emitPhase(event, true);
    if (!event.stopped) {
      for (let node = target; node && !event.stopped; node = node.parentElement) node.emitPhase(event, false);
    }
    if (!event.stopped) document.emitPhase(event, false);
    return event;
  };
  let hostEscapeCount = 0;
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hostEscapeCount += 1;
  });
  const context = createContext({ document });
  const module = new SourceTextModule(
    await readFile(new URL('../src/shared/multiselect-dropdown.js', import.meta.url), 'utf8'),
    { context },
  );
  await module.link(() => { throw new Error('Unexpected dropdown dependency'); });
  await module.evaluate();
  const wrap = new Element('div');
  const trigger = new Element('button');
  const menu = new Element('div');
  const option = new Element('button');
  menu.classList.add('stwid--multiselect-dropdown__menu');
  menu.append(option);
  wrap.append(trigger);
  wrap.append(menu);
  const close = module.namespace.wireMultiselectDropdown(menu, trigger, wrap);
  return {
    document, wrap, trigger, menu, option, close, dispatch,
    get hostEscapeCount() { return hostEscapeCount; },
    open() { dispatch(trigger, 'keydown', 'Enter'); },
    closeOwned(root) { module.namespace.closeOpenMultiselectDropdownMenus(null, root); },
  };
};

test('Escape closes the dropdown before the host drawer handler and restores trigger focus', async () => {
  const ui = await createDropdown();
  ui.open();
  assert.equal(ui.document.activeElement, ui.option);
  assert.equal(ui.trigger.getAttribute('aria-expanded'), 'true');

  const escape = ui.dispatch(ui.option, 'keydown', 'Escape');

  assert.equal(ui.hostEscapeCount, 0, 'the enclosing host drawer must stay open');
  assert.equal(escape.defaultPrevented, true);
  assert.equal(ui.menu.classList.contains('stwid--state-active'), false);
  assert.equal(ui.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(ui.document.activeElement, ui.trigger);

  ui.dispatch(ui.trigger, 'keydown', 'Escape');
  assert.equal(ui.hostEscapeCount, 1, 'a later Escape reaches the host after dropdown cleanup');
});

test('unrelated keys remain available and explicit dropdown closure removes the Escape listener', async () => {
  const ui = await createDropdown();
  ui.open();
  const unhandled = ui.dispatch(ui.option, 'keydown', 'F2');
  assert.equal(unhandled.defaultPrevented, false);
  assert.equal(ui.trigger.getAttribute('aria-expanded'), 'true');
  ui.close();
  ui.dispatch(ui.trigger, 'keydown', 'Escape');
  assert.equal(ui.hostEscapeCount, 1);
});

test('a detached dropdown does not consume host Escape or restore focus to its removed trigger', async () => {
  const ui = await createDropdown();
  ui.open();
  ui.wrap.isConnected = false;
  // Removing an ancestor can bypass the immediate-parent childList observer.
  // Browser focus then leaves the removed subtree before the next key event.
  const outsideTarget = new Target();
  ui.document.activeElement = outsideTarget;
  const escape = ui.dispatch(outsideTarget, 'keydown', 'Escape');

  assert.equal(ui.hostEscapeCount, 1);
  assert.equal(escape.defaultPrevented, false);
  assert.equal(ui.document.activeElement, outsideTarget);
  assert.equal(ui.document.listeners.filter((listener) => listener.capture).length, 0);
});

test('scoped programmatic closure releases capture listeners before an ancestor is removed', async () => {
  const ui = await createDropdown();
  ui.open();
  assert.equal(ui.document.listeners.filter((listener) => listener.capture).length, 2);
  const visited = [];
  const root = {
    querySelectorAll(selector) {
      visited.push(selector);
      return selector.includes('stwid--multiselect-dropdown__menu') ? [ui.menu] : [];
    },
  };
  ui.closeOwned(root);
  assert.equal(visited.length, 2, 'Both menu and blocker lookup stay inside the supplied editor root');
  assert.equal(ui.document.listeners.filter((listener) => listener.capture).length, 0);
  ui.wrap.isConnected = false;
  assert.equal(ui.menu.classList.contains('stwid--state-active'), false);
});
