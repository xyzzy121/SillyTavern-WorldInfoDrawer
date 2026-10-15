import { test, expect } from '@playwright/test';
import { seedFixtures, openDrawer, openEntry, book, MAIN_BOOK, readBook, assertRuntimeErrors } from './helpers.mjs';

test.beforeEach(async ({ page }) => { await seedFixtures(page); await openDrawer(page); });
test.afterEach(async ({ page }, info) => { await assertRuntimeErrors(page, info); });

test('browse tabs, search, edit and persist, back and close', async ({ page }, info) => {
  const failed = [];
  page.on('response', r => { if (r.status() >= 400 && !r.url().includes('SillyTavern-FilesPluginApi')) failed.push(`${r.status()} ${r.url()}`); });
  for (const tab of ['lorebooks', 'folders', 'visibility', 'sorting', 'search', 'settings']) {
    await expect(page.locator(`.stwid--icon-tab__button[data-tab-id="${tab}"]`)).toHaveAccessibleName(tab[0].toUpperCase() + tab.slice(1));
    await page.locator(`.stwid--icon-tab__button[data-tab-id="${tab}"]`).tap();
    await expect(page.locator(`.stwid--icon-tab__content[data-tab-id="${tab}"]`)).toBeVisible();
  }
  await page.locator('.stwid--icon-tab__button[data-tab-id="search"]').tap();
  await page.getByRole('searchbox', { name:'Search books', exact:true }).fill('Book 12');
  await expect(book(page, 'Mobile QA — Book 12')).toBeVisible();
  await expect(book(page, 'Mobile QA — Book 02')).toBeHidden();
  await page.getByRole('searchbox', { name:'Search books', exact:true }).fill('');
  await page.locator('.stwid--icon-tab__button[data-tab-id="settings"]').tap();
  await openEntry(page);
  const title = page.locator('.stwid--editor textarea[name="comment"]');
  const content = page.locator('.stwid--editor textarea[name="content"]');
  await title.fill('Mobile edited title');
  await content.fill('Mobile content persisted after touch editing.');
  await page.locator('.stwid--editor textarea[name="key"]').fill('mobile, regression');
  await title.tap();
  await expect.poll(async () => (await readBook(page)).entries[0].key).toEqual(['mobile', 'regression']);
  await expect.poll(async () => (await readBook(page)).entries[0].comment).toBe('Mobile edited title');
  await page.screenshot({path:info.outputPath('editor.png')});
  const overflow = await page.locator('.stwid--editor').evaluate(e => ({ width:e.clientWidth, scroll:e.scrollWidth }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.width + 2);
  await page.locator('.stwid--mobile-back-btn').tap();
  await expect(page.locator('.stwid--list')).toBeVisible();
  await page.getByRole('button', { name: 'Close World Info', exact: true }).tap();
  await expect(page.locator('.stwid--body[data-extension-src]')).toBeHidden();
  await openDrawer(page); await openEntry(page);
  await expect(title).toHaveValue('Mobile edited title');
  await expect(content).toHaveValue('Mobile content persisted after touch editing.');
  expect(failed).toEqual([]);
});

test('failed save preserves draft on Back, close, rotation and guarded navigation', async ({ page }, info) => {
  await openEntry(page);
  let blockedSaves = 0;
  await page.route('**/api/worldinfo/edit', route => { blockedSaves++; return route.abort('failed'); });
  const title=page.locator('.stwid--editor textarea[name="comment"]');
  await title.fill('Unsaved mobile draft');
  await expect.poll(()=>blockedSaves).toBeGreaterThan(0);
  const didNavigate = await page.evaluate(async name => {
    const root = document.querySelector('.stwid--body[data-extension-src]').dataset.extensionSrc.split('/src/')[0];
    return (await import(`${root}/index.js`)).jumpToEntry(name, 1);
  }, MAIN_BOOK);
  expect(didNavigate).toBe(false);
  await expect(title).toHaveValue('Unsaved mobile draft');
  await page.locator('.stwid--mobile-back-btn').tap();
  await expect(title).toHaveValue('Unsaved mobile draft');
  await expect(title).toBeVisible();
  await expect(page.locator('#toast-container')).toContainText('Unsaved edits');
  await page.getByRole('button', { name: 'Close World Info', exact: true }).tap();
  await openDrawer(page);
  await expect(title).toHaveValue('Unsaved mobile draft');
  for (const width of [767, 769, 1001, 999]) {
    await page.setViewportSize({width, height:600});
    await expect(title).toHaveValue('Unsaved mobile draft');
  }
  await page.setViewportSize({width:1100,height:800});
  await openDrawer(page);
  await page.locator('.stwid--icon-tab__button[data-tab-id="settings"]').tap();
  await page.getByLabel('Global Activation Settings',{exact:true}).tap();
  await expect(title).toHaveValue('Unsaved mobile draft');
  await page.getByLabel('Open Entry Manager for current Book Visibility scope',{exact:true}).tap();
  await expect(title).toHaveValue('Unsaved mobile draft');
  await page.getByLabel('Refresh',{exact:true}).tap();
  await expect(title).toHaveValue('Unsaved mobile draft');
  await page.setViewportSize(info.project.use.viewport);
  await page.screenshot({path:info.outputPath('draft-preserved.png')});
  // The host stacks guard warnings over Back on some viewports. Dismiss them
  // through their normal tap-to-close behavior before exercising recovery.
  const warnings = page.locator('#toast-container .toast');
  while (true) {
    const count = await warnings.count();
    if (!count) break;
    try { await warnings.first().tap({ timeout: 2000 }); }
    catch (error) {
      // A toast may expire during the actionability check. Only accept that
      // race when the visible notification count actually declined.
      if (await warnings.count() >= count) throw error;
    }
    await expect.poll(() => warnings.count()).toBeLessThan(count);
  }
  await page.unroute('**/api/worldinfo/edit');
  await title.fill('Recovered mobile draft');
  await expect.poll(async()=>(await readBook(page,MAIN_BOOK)).entries[0].comment).toBe('Recovered mobile draft');
  // Persistence precedes the extension's asynchronous save acknowledgement.
  await expect(async () => {
    await page.locator('.stwid--mobile-back-btn').tap();
    await expect(page.locator('.stwid--list')).toBeVisible({timeout:500});
  }).toPass({timeout:8000});
});
