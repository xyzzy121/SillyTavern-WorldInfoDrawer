import { test, expect } from '@playwright/test';
import { seedFixtures, openDrawer, book, LONG_BOOK, LONG_FOLDER, assertRuntimeErrors } from './helpers.mjs';

test.beforeEach(async ({ page }) => { await seedFixtures(page); await openDrawer(page); });
test.afterEach(async ({ page }, info) => { await assertRuntimeErrors(page, info); });
const menu = page => page.locator('.stwid--context-menu');
const trigger = page => book(page, LONG_BOOK).getByRole('button', { name: 'Book menu', exact: true });
const folder = page => page.locator('.stwid--folder').filter({ has: page.locator('.stwid--folder-label', { hasText: LONG_FOLDER }) }).first();

async function assertBounds(page) {
  const rect = await menu(page).boundingBox();
  const { width, height } = page.viewportSize();
  expect(rect.x).toBeGreaterThanOrEqual(7);
  expect(rect.y).toBeGreaterThanOrEqual(7);
  expect(rect.x + rect.width).toBeLessThanOrEqual(width - 7);
  expect(rect.y + rect.height).toBeLessThanOrEqual(height - 7);
  expect(await menu(page).evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
}

test('lorebook menu opens once, scrolls, keeps padding and sort interaction open, and dismisses safely', async ({ page }, info) => {
  const button = trigger(page);
  const bounds = await button.boundingBox();
  expect(bounds.width).toBeGreaterThanOrEqual(44);
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  await button.tap();
  await expect(menu(page)).toHaveCount(1);
  await expect(menu(page)).toHaveAttribute('role', 'dialog');
  await expect(menu(page)).toBeFocused();
  await assertBounds(page);
  for (const height of await menu(page).locator('button, select').evaluateAll(els => els.map(el => el.getBoundingClientRect().height))) expect(height).toBeGreaterThanOrEqual(44);
  await menu(page).tap({ position: { x: 3, y: 3 } });
  await expect(menu(page)).toHaveCount(1);
  const select = menu(page).getByLabel('Book Sort', { exact: true });
  await select.focus();
  await expect(menu(page)).toHaveCount(1);
  await select.selectOption({ index: 1 });
  await expect(menu(page)).toHaveCount(0);
  await button.tap();
  await menu(page).evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(menu(page).getByRole('button', { name: 'Delete Book', exact: true })).toBeInViewport();
  await assertBounds(page);
  await page.screenshot({ path: info.outputPath('lorebook-menu.png') });
  // The backdrop consumes the tap, without closing the drawer underneath.
  await page.locator('.stwid--context-blocker').tap({ position: { x: 1, y: 1 } });
  await expect(menu(page)).toHaveCount(0);
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).toBeFocused();
  await expect(page.locator('.stwid--body[data-extension-src]')).toBeVisible();
});

test('keyboard menu activation, focus containment, Escape, and destination focus', async ({ page }) => {
  const button = trigger(page);
  await button.focus();
  await page.keyboard.press('Enter');
  const rename = menu(page).getByRole('button', { name: 'Rename Book', exact: true });
  await expect(rename).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(menu(page).locator('button').last()).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(rename).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await expect(button).toBeFocused();
  await page.keyboard.press('Space');
  await expect(menu(page)).toHaveCount(1);
  await page.keyboard.press('Enter');
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toBeVisible();
  await expect(menu(page)).toHaveCount(0);
  await expect.poll(() => dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await dialog.locator('.popup-button-cancel').click();
});

test('folder menu keeps its folder state, opens Add Lorebooks, and shares cleanup', async ({ page }) => {
  const root = folder(page);
  const button = root.getByRole('button', { name: 'Folder menu', exact: true });
  const before = await root.locator('.stwid--folder-books').getAttribute('class');
  await button.tap();
  await expect(root.locator('.stwid--folder-books')).toHaveAttribute('class', before);
  await assertBounds(page);
  await menu(page).getByRole('button', { name: 'Add Lorebooks…', exact: true }).tap();
  await expect(menu(page)).toHaveCount(0);
  await expect(page.locator('.stwid--add-lorebooks-dialog')).toBeVisible();
  await page.locator('.stwid--add-lorebooks-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await button.focus();
  await page.keyboard.press('Space');
  await expect(menu(page).locator('button').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
});

test('menu follows rotation, enlarged text, viewport edges and translated body', async ({ page, browserName }, info) => {
  await trigger(page).tap();
  await menu(page).evaluate(el => { el.style.fontSize = '28px'; });
  await page.setViewportSize({ width: 320, height: 300 });
  await expect(async () => { await assertBounds(page); }).toPass();
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    const box = await menu(page).boundingBox();
    const x = box.x + box.width / 2;
    const startY = box.y + box.height - 35;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] });
    for (let step = 1; step <= 8; step++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: startY - step * 18 }] });
      await page.waitForTimeout(20);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => menu(page).evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await cdp.detach();
  }
  await page.evaluate(() => { document.body.style.transform = 'translate(3px, 5px)'; });
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(async () => { await assertBounds(page); }).toPass();
  await menu(page).getByRole('button', { name: 'Delete Book', exact: true }).scrollIntoViewIfNeeded();
  await expect(menu(page).getByRole('button', { name: 'Delete Book', exact: true })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('enlarged-menu.png') });
  await page.keyboard.press('Escape');
  await page.evaluate(() => { document.body.style.transform = ''; });
});

test('refresh, drawer close, removed owner and repeated opens release the popup', async ({ page }) => {
  const button = trigger(page);
  for (let i = 0; i < 4; i++) {
    await button.tap();
    await expect(menu(page)).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(menu(page)).toHaveCount(0);
  }
  await button.tap();
  await page.evaluate(async () => {
    const root = document.querySelector('.stwid--body[data-extension-src]').dataset.extensionSrc.split('/src/')[0];
    await (await import(`${root}/src/book-browser/book-browser.js`)).refreshList();
  });
  await expect(menu(page)).toHaveCount(0);
  await button.tap();
  await page.evaluate(() => document.querySelector('#WI-SP-button .drawer-toggle').click());
  await expect(menu(page)).toHaveCount(0);
  await expect(page.locator('.stwid--body[data-extension-src]')).toBeHidden();
  await openDrawer(page);
  await button.tap();
  await button.evaluate(el => el.remove());
  await expect(menu(page)).toHaveCount(0);
  await expect(page.locator('.stwid--blocker')).toHaveCount(0);
});
