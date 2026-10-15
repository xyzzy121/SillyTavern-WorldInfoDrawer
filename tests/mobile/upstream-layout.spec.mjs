import { test, expect } from '@playwright/test';
import {
  MAIN_BOOK, LONG_FOLDER, book, seedFixtures, openDrawer, openEntry, readBook, assertRuntimeErrors,
} from './helpers.mjs';

const manager = page => page.locator('.stwid--editor > .stwid--entry-manager');
const folder = page => page.locator('.stwid--folder').filter({
  has: page.locator('.stwid--folder-label', { hasText: LONG_FOLDER }),
}).first();

async function revealMainBook(page) {
  if (!await book(page).isVisible()) {
    await folder(page).getByLabel('Collapse or expand this folder', { exact: true }).tap();
  }
  await expect(book(page)).toBeVisible();
}

test.beforeEach(async ({ page }) => { await seedFixtures(page); await openDrawer(page); });
test.afterEach(async ({ page }, info) => { await assertRuntimeErrors(page, info); });

test('mobile drawer fits the viewport and Moonlit compensation follows its active stylesheet', async ({ page }) => {
  await openEntry(page);
  const drawer = await page.locator('#WorldInfo').boundingBox();
  expect(drawer.y).toBeGreaterThanOrEqual(-1);
  expect(drawer.y).toBeLessThanOrEqual(1);
  expect(drawer.y + drawer.height).toBeLessThanOrEqual(page.viewportSize().height + 1);

  // A synthetic theme rule avoids loading another extension or a remote URL.
  // Keep it after disabling the link to verify the compatibility gate releases.
  await page.evaluate(() => {
    const remainingStyle = document.createElement('style');
    remainingStyle.id = 'moonlit-modern-styles';
    remainingStyle.textContent = '.stwid--editor .world_entry_form.wi-card-entry { margin-inline: 2px; }';
    document.head.append(remainingStyle);
  });
  const card = page.locator('.stwid--editor .world_entry > .world_entry_form.wi-card-entry');
  await expect(page.locator('body')).not.toHaveClass(/stwid--host-moonlit/);
  await expect(card).toHaveCSS('margin-left', '2px');
  await page.evaluate(() => {
    const themeLink = document.createElement('link');
    themeLink.id = 'MoonlitEchosTheme-style';
    themeLink.rel = 'stylesheet';
    themeLink.href = 'data:text/css,';
    document.head.append(themeLink);
  });
  await expect(page.locator('body')).toHaveClass(/stwid--host-moonlit/);
  await expect(card).toHaveCSS('margin-left', '0px');
  await expect(card).toHaveCSS('margin-right', '0px');
  await page.evaluate(() => document.querySelector('#MoonlitEchosTheme-style').remove());
  await expect(page.locator('body')).not.toHaveClass(/stwid--host-moonlit/);
  await expect(card).toHaveCSS('margin-left', '2px');
});

test('editor keeps labels attached on desktop and focus mode usable on mobile', async ({ page }) => {
  await openEntry(page);
  const editor = page.locator('.stwid--editor');
  const mobileViewport = page.viewportSize();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(editor.locator('.stwid--editor-header-context-row')).toHaveCount(0);
  await expect(editor.locator('textarea[name="comment"]')).toBeVisible();
  await expect(editor.locator('#WIEntryHeaderTitlesPC')).toBeHidden();
  await expect(editor.locator('label.WIEntryHeaderTitleMobile[for="position"]')).toBeVisible();
  await expect(editor.locator('input[name="depth"]')).toBeDisabled();
  await expect(editor.locator('label.WIEntryHeaderTitleMobile[for="depth"]')).toBeHidden();
  const orderGeometry = await editor.locator('input[name="order"]').evaluate(input => {
    const label = input.parentElement.querySelector('label');
    const field = input.getBoundingClientRect();
    const heading = label.getBoundingClientRect();
    return { labelWidth: heading.width, labelBottom: heading.bottom, fieldTop: field.top,
      horizontalOverlap: Math.min(field.right, heading.right) - Math.max(field.left, heading.left) };
  });
  expect(orderGeometry.labelWidth).toBeGreaterThan(0);
  expect(orderGeometry.labelBottom).toBeLessThanOrEqual(orderGeometry.fieldTop + 1);
  expect(orderGeometry.horizontalOverlap).toBeGreaterThan(0);

  await page.setViewportSize(mobileViewport);
  await expect(editor.locator('.stwid--editor-header-context-row')).toBeVisible();
  const focus = editor.getByRole('button', { name: 'Focus', exact: true });
  await expect(focus).not.toHaveClass(/menu_button/);
  await focus.tap();
  await expect(editor).toHaveClass(/stwid--focus/);
  await expect(editor.locator('textarea[name="content"]')).toBeVisible();
  await expect(editor.locator('textarea[name="comment"]')).toBeHidden();
  const unfocus = editor.getByRole('button', { name: 'Unfocus', exact: true });
  await expect(unfocus).toHaveClass(/menu_button/);
  await unfocus.tap();
  await expect(editor).not.toHaveClass(/stwid--focus/);
  await expect(editor.locator('textarea[name="comment"]')).toBeVisible();
});

test('sticky manager tabs stay reachable above table cells after scrolling', async ({ page }, info) => {
  await revealMainBook(page);
  await book(page).getByRole('button', { name: 'Book menu', exact: true }).tap();
  await page.locator('.stwid--context-menu').getByRole('button', { name: 'Entry Manager', exact: true }).tap();
  await expect(manager(page).locator('tbody > tr')).toHaveCount(32);
  const dock = manager(page).locator(':scope > .stwid--icon-tab__dock');
  await expect(dock).toBeVisible();
  const bulkTab = dock.getByRole('tab', { name: 'Bulk Editor', exact: true });
  const displayTab = dock.getByRole('tab', { name: 'Display', exact: true });
  await manager(page).evaluate(root => { root.scrollTop = root.scrollHeight; });
  await expect.poll(() => manager(page).evaluate(root => root.scrollTop)).toBeGreaterThan(0);
  await expect.poll(() => bulkTab.evaluate(button => {
    const rect = button.getBoundingClientRect();
    const manager = button.closest('.stwid--entry-manager').getBoundingClientRect();
    return rect.top >= manager.top - 1 && rect.bottom <= manager.bottom + 1
      && button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
  // Check hit-testing before Playwright can scroll the target into view.
  await bulkTab.tap();
  await expect(bulkTab).toHaveAttribute('aria-selected', 'true');
  await expect(manager(page).locator('[data-tab-id="bulk-editor"][role="tabpanel"]')).toBeVisible();
  await manager(page).evaluate(root => { root.scrollTop = root.scrollHeight; });
  await displayTab.tap();
  await expect(displayTab).toHaveAttribute('aria-selected', 'true');
  if (await page.evaluate(() => CSS.supports('overscroll-behavior-y', 'contain'))) {
    await expect(manager(page)).toHaveCSS('overscroll-behavior-y', 'contain');
    await expect(manager(page).locator('.stwid--order-table-wrap')).toHaveCSS('overscroll-behavior-x', 'contain');
  }
  await page.screenshot({ path: info.outputPath('sticky-manager-tabs.png') });
});

test('entry enabled switches activate once from the keyboard and deletion refreshes Collapse All', async ({ page }) => {
  await page.locator('.stwid--list [role="tab"][data-tab-id="lorebooks"]').tap();
  const collapseAll = page.locator('.stwid--collapseAllToggle');
  if (await collapseAll.getAttribute('aria-pressed') === 'true') await collapseAll.tap();
  await expect(collapseAll).toHaveAccessibleName('Expand All Books');
  await revealMainBook(page);
  await book(page).locator('.stwid--head > .stwid--title').tap();
  const enabled = book(page).locator('.stwid--entry[data-uid="0"] .stwid--enabled');
  await expect(enabled).toHaveAttribute('role', 'switch');
  await expect(enabled).toHaveAttribute('aria-checked', 'true');
  await enabled.focus();
  await enabled.press('Enter');
  await expect(enabled).toHaveAttribute('aria-checked', 'false');
  await expect.poll(async () => (await readBook(page)).entries[0].disable).toBe(true);
  await expect.poll(() => enabled.evaluate(node => Boolean(node.disabled))).toBe(false);
  await enabled.press('Space');
  await expect(enabled).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await readBook(page)).entries[0].disable).toBe(false);

  await openEntry(page);
  const editorSwitch = page.locator('.stwid--editor [name="entryKillSwitch"]');
  await expect(editorSwitch).toHaveAttribute('role', 'switch');
  await expect(editorSwitch).toHaveAttribute('aria-checked', 'true');
  await editorSwitch.focus();
  await editorSwitch.press('Enter');
  await expect(editorSwitch).toHaveAttribute('aria-checked', 'false');
  await expect.poll(async () => (await readBook(page)).entries[0].disable).toBe(true);
  await expect(async () => {
    await page.locator('.stwid--mobile-back-btn').tap();
    await expect(page.locator('.stwid--list')).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 8000 });
  await expect(collapseAll).toHaveAccessibleName('Collapse All Books');
  expect(await page.evaluate(async name => {
    const wi = await import('/scripts/world-info.js');
    return wi.deleteWorldInfo(name);
  }, MAIN_BOOK)).toBe(true);
  await expect(book(page)).toHaveCount(0);
  await expect(collapseAll).toHaveAccessibleName('Expand All Books');
  await expect(collapseAll).toHaveAttribute('aria-pressed', 'false');
});
