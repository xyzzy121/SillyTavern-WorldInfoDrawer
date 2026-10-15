import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createContext, SourceTextModule } from 'node:vm';

const loadCompatibility = async () => {
  const links = new Set();
  const classes = new Set();
  const unloadListeners = new Set();
  const observers = [];
  let queries = 0;
  const doc = {
    head: {
      querySelector(selector) { queries += 1; return links.has(selector) ? {} : null; },
    },
    body: {
      classList: {
        toggle(name, value) { value ? classes.add(name) : classes.delete(name); },
      },
    },
    defaultView: {
      addEventListener(type, listener) { assert.equal(type, 'beforeunload'); unloadListeners.add(listener); },
      removeEventListener(type, listener) { assert.equal(type, 'beforeunload'); unloadListeners.delete(listener); },
    },
  };
  class MutationObserver {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target, options) { this.target = target; this.options = options; this.connected = true; }
    disconnect() { this.connected = false; }
  }
  const context = createContext({ document: doc, MutationObserver });
  const module = new SourceTextModule(
    await readFile(new URL('../src/shared/host-compat.js', import.meta.url), 'utf8'), { context },
  );
  await module.link(() => { throw new Error('Unexpected host-compat dependency'); });
  await module.evaluate();
  return { api: module.namespace, doc, links, classes, unloadListeners, observers, queries: () => queries };
};

test('Moonlit compatibility follows the active theme link, including live enable and disable', async () => {
  const { api, links, classes, observers, queries } = await loadCompatibility();
  // Moonlit can leave these unrelated styles mounted while its theme is disabled.
  links.add('style#moonlit-modern-styles');
  links.add('link#MoonlitEchoesTheme-style');
  api.initHostCompatibility();
  assert.equal(classes.has(api.MOONLIT_HOST_CLASS), false);

  links.add('link#MoonlitEchosTheme-style');
  const beforeQueries = queries();
  observers[0].callback([{ type: 'childList' }, { type: 'childList' }]);
  assert.equal(classes.has(api.MOONLIT_HOST_CLASS), true);
  assert.equal(queries() - beforeQueries, 1, 'one lookup per mutation batch');

  links.delete('link#MoonlitEchosTheme-style');
  observers[0].callback([{ type: 'childList' }]);
  assert.equal(classes.has(api.MOONLIT_HOST_CLASS), false);
});

test('host compatibility owns only one shallow head observer and releases it on teardown', async () => {
  const { api, doc, observers, unloadListeners } = await loadCompatibility();
  const first = api.initHostCompatibility();
  assert.equal(api.initHostCompatibility(), first);
  assert.equal(observers.length, 1);
  assert.equal(observers[0].target, doc.head);
  assert.deepEqual({ ...observers[0].options }, { childList: true });
  assert.equal(unloadListeners.size, 1);

  first.disconnect();
  first.disconnect();
  assert.equal(observers[0].connected, false);
  assert.equal(unloadListeners.size, 0);

  assert.notEqual(api.initHostCompatibility(), first);
  assert.equal(observers.length, 2);
  for (const listener of [...unloadListeners]) listener();
  assert.equal(observers[1].connected, false);
  assert.equal(unloadListeners.size, 0);
});
