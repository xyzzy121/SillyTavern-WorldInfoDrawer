import { test, expect } from '@playwright/test';
import { MAIN_BOOK, LONG_FOLDER, book, seedFixtures, openDrawer, readBook, assertRuntimeErrors } from './helpers.mjs';

const manager = page => page.locator('.stwid--editor > .stwid--entry-manager');
const rows = page => manager(page).locator('.stwid--order-table tbody > tr');
const folder = page => page.locator('.stwid--folder').filter({ has: page.locator('.stwid--folder-header', { hasText: LONG_FOLDER }) }).first();
const tab = (page, id) => manager(page).locator(`[role="tab"][data-tab-id="${id}"]`);

async function openBookManager(page) {
  if (!await book(page).isVisible()) await folder(page).getByLabel('Collapse or expand this folder', { exact: true }).tap();
  await book(page).getByLabel('Book menu', { exact: true }).tap();
  await page.locator('.stwid--blocker .stwid--entry-manager').tap();
  await expect(manager(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(32);
}

async function columnMenu(page) {
  const control = manager(page).locator('.stwid--column-visibility');
  await control.getByLabel('Choose which columns are visible', { exact: true }).tap();
  const menu = control.locator('.stwid--multiselect-dropdown__menu');
  await expect(menu).toBeVisible();
  return menu;
}

test.beforeEach(async ({ page }) => {
  await seedFixtures(page);
  await openDrawer(page);
});

test.afterEach(async ({ page }, info) => {
  const screenshot = info.outputPath('entry-manager-final.png');
  await page.screenshot({path:screenshot, fullPage:true});
  await info.attach('entry-manager-final', { path:screenshot, contentType:'image/png' });
  await assertRuntimeErrors(page, info);
});

test('Entry Manager display controls filter rows, toggle columns, and retain both scroll axes', async ({ page, browserName }, testInfo) => {
  await openBookManager(page);
  const displayTab = tab(page, 'display');
  const bulkTab = tab(page, 'bulk-editor');
  await expect.soft(displayTab).toHaveAccessibleName('Display');
  await expect.soft(bulkTab).toHaveAccessibleName('Bulk Editor');
  await expect(displayTab).toHaveAttribute('aria-selected', 'true');
  await bulkTab.tap();
  await expect(bulkTab).toHaveAttribute('aria-selected', 'true');
  await expect(manager(page).locator('[data-field="select"]')).toBeVisible();
  await displayTab.tap();
  await expect(displayTab).toHaveAttribute('aria-selected', 'true');

  let menu = await columnMenu(page);
  await menu.getByText('SELECT ALL', { exact: true }).tap();
  await expect(manager(page).locator('th[data-col="characterFilter"]')).toBeVisible();
  menu = await columnMenu(page);
  await menu.locator('label').filter({ hasText: /^Strategy$/ }).tap();
  await expect(manager(page).locator('th[data-col="strategy"]')).toBeHidden();
  await menu.locator('label').filter({ hasText: /^Strategy$/ }).tap();
  await expect(manager(page).locator('th[data-col="strategy"]')).toBeVisible();
  await manager(page).locator('.stwid--column-visibility').getByLabel('Choose which columns are visible', { exact: true }).tap();

  const strategyFilter = manager(page).getByLabel('Filter by Strategy', { exact: true });
  await strategyFilter.tap();
  const strategyMenu = manager(page).locator('th[data-col="strategy"] .stwid--multiselect-dropdown__menu');
  const constantLabel = await rows(page).first().locator('select[name="entryStateSelector"] option[value="constant"]').textContent();
  await strategyMenu.locator('label').filter({ hasText: constantLabel.trim() }).tap();
  await expect(manager(page).locator('tbody > tr:not(.stwid--state-filtered)')).toHaveCount(21);
  await expect(strategyFilter).toHaveClass(/stwid--state-active/);
  await strategyMenu.locator('label').filter({ hasText: constantLabel.trim() }).tap();
  await expect(manager(page).locator('tbody > tr:not(.stwid--state-filtered)')).toHaveCount(32);
  await strategyFilter.tap();

  // Programmatic scroll measurements complement the tap checks. They do not
  // claim to emulate a physical finger swipe or an on-screen keyboard.
  const scrolling = await manager(page).evaluate(root => {
    const table = root.querySelector('.stwid--order-table-wrap');
    table.scrollLeft = 450;
    root.scrollTop = 450;
    return {
      root: { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth, clientHeight: root.clientHeight, scrollHeight: root.scrollHeight, scrollTop: root.scrollTop, touchAction: getComputedStyle(root).touchAction },
      table: { clientWidth: table.clientWidth, scrollWidth: table.scrollWidth, scrollLeft: table.scrollLeft, touchAction: getComputedStyle(table).touchAction },
      document: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
    };
  });
  await testInfo.attach('entry-manager-scroll-metrics', { body: JSON.stringify(scrolling, null, 2), contentType: 'application/json' });
  expect(scrolling.table.scrollWidth).toBeGreaterThan(scrolling.table.clientWidth);
  expect(scrolling.table.scrollLeft).toBeGreaterThan(0);
  expect(scrolling.root.scrollTop).toBeGreaterThan(0);
  expect(scrolling.document.scrollWidth).toBeLessThanOrEqual(page.mobileQaDocumentWidth + 1);
  if (browserName === 'chromium') {
    const table = manager(page).locator('.stwid--order-table-wrap');
    await table.evaluate(node => { node.scrollLeft = 0; });
    const box = await table.boundingBox();
    const viewport = page.viewportSize();
    const x = Math.min(box.x + box.width - 25, viewport.width - 25);
    const y = Math.max(150, Math.min(box.y + box.height / 2, viewport.height - 100));
    const session = await page.context().newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 8; step++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - step * 22, y }] });
      await page.waitForTimeout(30);
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach();
    await expect.poll(async () => table.evaluate(node => node.scrollLeft), { message: 'A horizontal touch gesture must pan the table' }).toBeGreaterThan(0);
  }
  await expect(displayTab).toBeVisible();
});

test('Entry Manager bulk changes target selected rows and reorder buttons persist their result', async ({ page }, info) => {
  await openBookManager(page);
  await tab(page, 'bulk-editor').tap();
  const orderStart = manager(page).locator('[data-field="order"] input[type="number"]').first();
  await orderStart.fill('10000');
  const numberGeometry = await orderStart.evaluate(input => {
    const style = getComputedStyle(input);
    const context = document.createElement('canvas').getContext('2d');
    context.font = style.font;
    return { width: input.clientWidth, required: context.measureText(input.value).width
      + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 20 };
  });
  expect(numberGeometry.width).toBeGreaterThanOrEqual(numberGeometry.required);
  await manager(page).locator('[data-field="order"]').scrollIntoViewIfNeeded();
  const numberScreenshot = info.outputPath('bulk-numeric-fields.png');
  await page.screenshot({ path: numberScreenshot });
  await info.attach('bulk-numeric-fields', { path: numberScreenshot, contentType: 'image/png' });
  const bulkGeometry = await manager(page).locator('.stwid--bulk-edit-row').evaluate(element => ({
    width: element.clientWidth, scroll: element.scrollWidth,
  }));
  expect(bulkGeometry.scroll).toBeLessThanOrEqual(bulkGeometry.width + 1);
  await orderStart.fill('100');
  await orderStart.press('Tab');
  await manager(page).getByLabel('Select/deselect all entries to be edited by Apply Order', { exact: true }).tap();
  await expect(manager(page).locator('[data-field="select"]')).toContainText('Selected 0 out of 32 entries');
  const firstRow = rows(page).filter({ has: page.locator('[data-col="entry"] .stwid--comment', { hasText: 'Entry 00 — Main' }) });
  await firstRow.getByLabel('Include/exclude this row from Apply Order', { exact: true }).tap();
  await expect(firstRow).toHaveAttribute('aria-selected', 'true');
  await expect(manager(page).locator('[data-field="select"]')).toContainText('Selected 1 out of 32 entries');

  const probability = manager(page).locator('[data-field="probability"]');
  await probability.locator('input[type="number"]').fill('37');
  await probability.getByLabel('Apply this probability to all selected entries', { exact: true }).tap();
  await expect.poll(async () => (await readBook(page)).entries['0'].probability).toBe(37);
  const saved = await readBook(page);
  expect(saved.entries['1'].probability).not.toBe(37);
  expect(saved.metadata.mobileQaMarker).toBe('preserve-me');

  // The non-drag controls remain usable with touch or keyboard input.
  const before = await rows(page).evaluateAll(nodes => nodes.map(node => node.dataset.uid));
  const down = rows(page).first().getByRole('button', { name: /^Move down\./ });
  await down.tap();
  await expect.poll(async () => rows(page).first().getAttribute('data-uid')).toBe(before[1]);
  await expect.poll(async () => (await readBook(page)).entries[before[0]].extensions.display_index).toBe(1);
  const moved = rows(page).filter({ has: page.locator('[data-col="entry"] .stwid--comment', { hasText: `Entry ${before[0].padStart(2, '0')} — Main` }) });
  const up = moved.getByRole('button', { name: /^Move up\./ });
  await up.focus();
  await expect(up).toBeFocused();
  await up.press('Enter');
  await expect.poll(async () => rows(page).first().getAttribute('data-uid')).toBe(before[0]);
  await expect.poll(async () => (await readBook(page)).entries[before[0]].extensions.display_index).toBe(0);
});

test('folder Entry Manager limits scope to its books and exposes usable tab and menu controls', async ({ page }) => {
  const trigger = folder(page).getByRole('button', { name: 'Folder menu', exact: true });
  await trigger.focus();
  await trigger.press('Enter');
  const action = page.locator('.stwid--blocker').getByRole('button', { name: /Entry Manager \(Folder\)$/ });
  await expect(action).toBeVisible();
  await action.tap();
  await expect(rows(page)).toHaveCount(34);
  const books = await rows(page).evaluateAll(nodes => [...new Set(nodes.map(node => node.dataset.book))].sort());
  expect(books).toEqual([MAIN_BOOK, 'Mobile QA — Book 01'].sort());
  await tab(page, 'bulk-editor').tap();
  await expect(manager(page).locator('[data-field="select"]')).toContainText('Selected 34 out of 34 entries');
  await tab(page, 'display').tap();
  const columns = manager(page).locator('.stwid--column-visibility').getByLabel('Choose which columns are visible', { exact: true });
  await columns.focus();
  await columns.press('Enter');
  await expect(columns).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(columns).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.stwid--body[data-extension-src]')).toBeVisible();
  await expect(columns).toBeFocused();
});
