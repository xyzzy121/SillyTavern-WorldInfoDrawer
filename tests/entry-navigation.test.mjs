import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, SourceTextModule, SyntheticModule } from 'node:vm';

const source = await readFile(new URL('../src/book-browser/book-browser.js', import.meta.url), 'utf8');
const navigationSource = await readFile(new URL('../src/shared/entry-navigation.js', import.meta.url), 'utf8');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const turn = () => new Promise((resolve) => setImmediate(resolve));

async function browser({ ensureRows = async () => true, openRow = async () => true } = {}) {
  const context = createContext({ console });
  const navigation = new SourceTextModule(navigationSource, { context });
  const module = new SourceTextModule(`${source}\nexport const configureTest = (options, slice) => { state = options; booksViewSlice = slice; };`, { context });
  const imports = new Map([...source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g)]
    .map(([, names, path]) => [path, names.split(',').map((name) => name.trim().split(/\s+as\s+/)[0]).filter(Boolean)]));
  await module.link((specifier) => {
    if (specifier.endsWith('entry-navigation.js')) return navigation;
    const names = imports.get(specifier);
    return new SyntheticModule(names, function () {
      for (const name of names) this.setExport(name, name === 'listPanelState'
        ? { setCollapseState() {}, getCollapseState: () => false }
        : () => {});
    }, { context });
  });
  await module.evaluate();
  const opened = [];
  const state = { cache: {}, navigationBooks: new Map(), dom: {}, isDirtyCheck: () => state.dirty };
  for (const name of ['A', 'B']) {
    const row = { stwidOpenEntry: async (token) => { opened.push(name); return openRow(name, token); } };
    state.cache[name] = {
      entries: { 0: { uid: 0 } },
      dom: { entry: { 0: { root: row } }, entryList: { classList: { contains: () => true } } },
    };
  }
  module.namespace.configureTest(state, { ensureBookRows: ensureRows, updateEntryDemand: async () => {} });
  return { state, opened, open: module.namespace.openEntry, navigation: navigation.namespace };
}

test('a later cross-book jump wins over a slower unmounted-book jump', async () => {
  const pending = deferred();
  const fixture = await browser({ ensureRows: (name) => name === 'A' ? pending.promise : true });
  const first = fixture.open('A', 0);
  assert.equal(await fixture.open('B', 0), true);
  pending.resolve(true);
  assert.equal(await first, false);
  assert.deepEqual(fixture.opened, ['B']);
  assert.equal(fixture.state.navigationBooks.size, 0);
});

test('a direct entry click also supersedes a jump awaiting lazy rows', async () => {
  const pending = deferred();
  const fixture = await browser({ ensureRows: () => pending.promise });
  const first = fixture.open('A', 0);
  // The direct row handler and editor constructor share this exact module.
  const directNavigation = fixture.navigation.beginEntryNavigation();
  pending.resolve(true);
  assert.equal(await first, false);
  assert.equal(directNavigation.isCurrent(), true);
  assert.deepEqual(fixture.opened, []);
});

test('Back or clear cancellation prevents a lazy jump from opening later', async () => {
  const pending = deferred();
  const fixture = await browser({ ensureRows: () => pending.promise });
  const first = fixture.open('A', 0);
  fixture.navigation.cancelEntryNavigation();
  pending.resolve(true);
  assert.equal(await first, false);
  assert.deepEqual(fixture.opened, []);
  assert.equal(fixture.state.navigationBooks.size, 0);
});

test('an older same-book request cannot release the newer request pin', async () => {
  const rows = deferred();
  const editor = deferred();
  const fixture = await browser({ ensureRows: () => rows.promise, openRow: () => editor.promise });
  const first = fixture.open('A', 0);
  const latest = fixture.open('A', 0);
  rows.resolve(true);
  await turn();
  assert.equal(await first, false);
  assert.equal(fixture.state.navigationBooks.has('A'), true);
  assert.equal(fixture.navigation.hasPendingEntryNavigation(), true);
  assert.deepEqual(fixture.opened, ['A']);
  editor.resolve(true);
  assert.equal(await latest, true);
  assert.equal(fixture.state.navigationBooks.size, 0);
  assert.equal(fixture.navigation.hasPendingEntryNavigation(), false);
});

test('dirty guards refuse before loading and again after row materialization', async () => {
  let reads = 0;
  const pending = deferred();
  const fixture = await browser({ ensureRows: () => { reads += 1; return pending.promise; } });
  fixture.state.dirty = true;
  assert.equal(await fixture.open('A', 0), false);
  assert.equal(reads, 0);
  fixture.state.dirty = false;
  const first = fixture.open('A', 0);
  fixture.state.dirty = true;
  pending.resolve(true);
  assert.equal(await first, false);
  assert.equal(reads, 1);
  assert.deepEqual(fixture.opened, []);
});
