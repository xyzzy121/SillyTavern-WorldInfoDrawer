import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/book-browser/book-list/book-list.world-entry.js', import.meta.url), 'utf8');
const module = new vm.SourceTextModule(source);
await module.link(() => new vm.SyntheticModule(['mirrorEntryFieldsToOriginalData'], function () {
  this.setExport('mirrorEntryFieldsToOriginalData', () => {});
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
