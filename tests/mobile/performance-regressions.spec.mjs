import { test, expect } from '@playwright/test';
import { seedFixtures, openDrawer, book, readBook, assertRuntimeErrors } from './helpers.mjs';

// These fixtures belong to the isolated mobile profile. No live lorebooks or
// model providers are used. Run this file separately from the small-screen matrix.
const NAME = 'Performance QA — deferred rows';
const COUNT = 1000;
const manager = page => page.locator('.stwid--editor > .stwid--entry-manager');
const rows = page => manager(page).locator('.stwid--order-table tbody > tr');
async function extensionRoot(page) {
  return page.evaluate(() => {
    const root = document.querySelector('.stwid--body[data-extension-src]').dataset.extensionSrc.split('/src/')[0];
    return root;
  });
}

async function jump(page, uid) {
  const root = await extensionRoot(page);
  return page.evaluate(async ({ root, name, uid }) => (await import(`${root}/index.js`)).jumpToEntry(name, uid), { root, name: NAME, uid });
}

async function openManager(page) {
  await book(page, NAME).getByLabel('Book menu', { exact: true }).click();
  await page.locator('.stwid--blocker .stwid--entry-manager').click();
  await expect(manager(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(COUNT);
}

test.beforeEach(async ({ page }, info) => {
  await page.addInitScript(() => {
    const NativeObserver = window.IntersectionObserver;
    window.stwidActiveHydrationObservers = 0;
    window.IntersectionObserver = class extends NativeObserver {
      constructor(callback, options) {
        super(callback, options);
        this.stwidTracked = options?.rootMargin === '600px 0px';
        if (this.stwidTracked) window.stwidActiveHydrationObservers++;
      }
      disconnect() {
        if (this.stwidTracked) window.stwidActiveHydrationObservers--;
        this.stwidTracked = false;
        super.disconnect();
      }
    };
  });
  if (info.title.includes('first interaction')) {
    // Hold only this extension's viewport callback. Real click/focus/keyboard
    // events must still edit a cell before scheduled hydration has happened.
    await page.addInitScript(() => {
      const NativeObserver = window.IntersectionObserver;
      const held = [];
      window.stwidDeliverHeldObservers = () => { for (const deliver of held.splice(0)) deliver(); };
      window.IntersectionObserver = class extends NativeObserver {
        constructor(callback, options) {
          super((records, observer) => {
            if (options?.rootMargin === '600px 0px') {
              window.stwidSuppressedObserver = true;
              held.push(() => callback(records, observer));
              return;
            }
            callback(records, observer);
          }, options);
        }
      };
    });
  }
  await seedFixtures(page);
  await page.evaluate(async ({ name, count }) => {
    const wi = await import('/scripts/world-info.js');
    const entries = Object.fromEntries(Array.from({ length: count }, (_, uid) => [uid, {
      ...structuredClone(wi.newWorldInfoEntryTemplate), uid,
      comment: `Deferred ${String(uid).padStart(4, '0')}`,
      key: [`deferred-key-${uid}`], content: `Synthetic entry ${uid}.`,
      order: uid, probability: 100,
      extensions: { display_index: uid },
    }]));
    const response = await fetch('/api/worldinfo/edit', { method: 'POST', headers: SillyTavern.getContext().getRequestHeaders(),
      body: JSON.stringify({ name, data: { entries, metadata: { performanceQaMarker: 'preserve' } } }) });
    if (!response.ok) throw new Error(`Synthetic fixture save failed: ${response.status}`);
  }, { name: NAME, count: COUNT });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.stwid--body[data-extension-src]').waitFor({ state: 'attached' });
  await openDrawer(page);
});

test.afterEach(async ({ page }, info) => { await assertRuntimeErrors(page, info); });

test('collapsed books search cached data, accept updates, and navigate to UID zero', async ({ page }) => {
  const entryRows = book(page, NAME).locator('.stwid--entry[data-uid]');
  await expect(entryRows).toHaveCount(0);
  await page.locator('.stwid--icon-tab__button[data-tab-id="search"]').click();
  await page.locator('.stwid--search-entries input').check();
  await page.getByRole('searchbox', { name: 'Search books', exact: true }).fill('deferred-key-999');
  await expect(book(page, NAME)).toBeVisible();
  await expect(entryRows).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search books', exact: true }).fill('');
  await page.evaluate(async name => {
    const wi = await import('/scripts/world-info.js');
    const data = await wi.loadWorldInfo(name);
    data.entries[0].comment = 'Updated while no rows existed';
    await wi.saveWorldInfo(name, data, true);
  }, NAME);
  expect(await jump(page, 0)).toBe(true);
  await expect(page.locator('.stwid--editor textarea[name="comment"]')).toHaveValue('Updated while no rows existed');
  await page.locator('.stwid--mobile-back-btn').click();
  await book(page, NAME).locator('.stwid--head > .stwid--title').click();
  await expect(entryRows).toHaveCount(0);
  expect(await jump(page, 'missing')).toBe(false);
});

test('selection pins a collapsed book until selection ends', async ({ page }) => {
  const root = book(page, NAME);
  const title = root.locator('.stwid--head > .stwid--title');
  await title.click();
  await expect(root.locator('.stwid--entry[data-uid]')).toHaveCount(COUNT);
  const first = root.locator('.stwid--entry[data-uid="0"]');
  await first.locator('.stwid--selector').click();
  await root.locator('.stwid--entry[data-uid="3"] .stwid--selector').click({ modifiers: ['Shift'] });
  await expect(root.locator('.stwid--entry.stwid--state-selected')).toHaveCount(4);
  await title.click();
  await expect(root.locator('.stwid--entry[data-uid]')).toHaveCount(COUNT);
  await expect(first).toHaveClass(/stwid--state-selected/);
  await title.click();
  for (let uid = 0; uid < 4; uid++) {
    await root.locator(`.stwid--entry[data-uid="${uid}"] .stwid--selector`).click();
  }
  await title.click();
  await expect(root.locator('.stwid--entry[data-uid]')).toHaveCount(0);
});

test('manager controls scale with viewport while bulk actions include untouched offscreen rows', async ({ page }, info) => {
  await openManager(page);
  const controls = manager(page).locator('tbody input, tbody select, tbody textarea');
  await expect.poll(() => controls.count()).toBeGreaterThan(0);
  const initialControls = await controls.count();
  expect(initialControls).toBeLessThan(COUNT);
  await expect(manager(page).locator('tbody [data-col="characterFilter"] input')).toHaveCount(0);
  await manager(page).locator('[role="tab"][data-tab-id="bulk-editor"]').click();
  const probability = manager(page).locator('[data-field="probability"]');
  await probability.locator('input[type="number"]').fill('37');
  await probability.getByLabel('Apply this probability to all selected entries', { exact: true }).click();
  await expect.poll(async () => (await readBook(page, NAME)).entries[COUNT - 1].probability).toBe(37);
  const beforeScroll = await readBook(page, NAME);
  expect(Object.values(beforeScroll.entries).every(entry => entry.probability === 37)).toBe(true);
  expect(beforeScroll.metadata.performanceQaMarker).toBe('preserve');
  const position = manager(page).locator('[data-field="position"]');
  await position.locator('select').selectOption('1');
  const positionLabel = await position.locator('option[value="1"]').textContent();
  await position.getByLabel('Apply selected position to all selected entries', { exact: true }).click();
  await expect.poll(async () => (await readBook(page, NAME)).entries[COUNT - 1].position).toBe(1);
  await expect(rows(page).last().locator('[data-col="position"]')).toHaveText(positionLabel);
  await rows(page).last().scrollIntoViewIfNeeded();
  await expect.poll(() => rows(page).last().locator('input, select').count()).toBeGreaterThan(0);
  await expect(rows(page).last().locator('select[name="position"]')).toHaveValue('1');
  await manager(page).evaluate(root => { root.scrollTop = 0; });
  await probability.locator('input[type="number"]').fill('43');
  await probability.getByLabel('Apply this probability to all selected entries', { exact: true }).click();
  await expect.poll(async () => (await readBook(page, NAME)).entries[COUNT - 1].probability).toBe(43);
  const afterScroll = await readBook(page, NAME);
  expect(Object.values(afterScroll.entries).every(entry => entry.probability === 43)).toBe(true);
  await info.attach('deferred-control-counts', { body: JSON.stringify({ entries: COUNT, initialControls, afterScrollControls: await controls.count() }), contentType: 'application/json' });
  await page.locator('.stwid--mobile-back-btn').click();
  await expect(manager(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.stwidActiveHydrationObservers)).toBe(0);
  await expect(book(page, NAME).locator('.stwid--entry[data-uid]')).toHaveCount(0);
  await openManager(page);
  await expect.poll(() => controls.count()).toBeGreaterThan(0);
  expect(await controls.count()).toBeLessThan(COUNT);
  expect(await page.evaluate(() => window.stwidActiveHydrationObservers)).toBe(1);
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.locator('.stwid--mobile-back-btn').click();
    await expect(manager(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.stwidActiveHydrationObservers)).toBe(0);
    await openManager(page);
    await expect.poll(() => controls.count()).toBeGreaterThan(0);
    expect(await controls.count()).toBeLessThan(COUNT);
    expect(await page.evaluate(() => window.stwidActiveHydrationObservers)).toBe(1);
  }
  await rows(page).first().locator('.stwid--comment-link').click();
  await expect(page.locator('.stwid--editor textarea[name="comment"]')).toHaveValue('Deferred 0000');
  await expect(manager(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.stwidActiveHydrationObservers)).toBe(0);
  await page.locator('.stwid--mobile-back-btn').click();
  await expect(page.locator('.stwid--list')).toBeVisible();
});

test('manager first interaction hydrates controls without losing a click or keyboard edit', async ({ page }) => {
  await openManager(page);
  await expect.poll(() => page.evaluate(() => window.stwidSuppressedObserver)).toBe(true);
  const last = rows(page).filter({ has: page.locator('[data-col="entry"] .stwid--comment', { hasText: 'Deferred 0999' }) });
  await expect(last.locator('[data-col="order"]')).toHaveAttribute('data-stwid-pending', '');
  await last.locator('[data-col="order"]').focus();
  const order = last.locator('input[name="order"]');
  await expect(order).toBeFocused();
  await order.press('ArrowUp');
  await order.press('Tab');
  await expect.poll(async () => (await readBook(page, NAME)).entries[999].order).toBe(1000);
  const dragRow = manager(page).locator('tbody > tr[data-uid="996"]');
  const neighbor = manager(page).locator('tbody > tr[data-uid="995"]');
  const pendingDrag = dragRow.locator('[data-col="drag"]');
  const grip = pendingDrag;
  await expect(pendingDrag).toHaveAttribute('data-stwid-pending', '');
  await expect(grip).toHaveClass(/stwid--sortable-handle/);
  const beforeDrag = await rows(page).evaluateAll(nodes => nodes.map(node => node.dataset.uid));
  await grip.click();
  // The grip is a drag target. A click must not replay a deferred up/down button.
  await page.waitForTimeout(300);
  expect(await rows(page).evaluateAll(nodes => nodes.map(node => node.dataset.uid))).toEqual(beforeDrag);
  await expect(pendingDrag).toHaveAttribute('data-stwid-pending', '');
  await neighbor.locator('[data-col="drag"]').scrollIntoViewIfNeeded();
  const gripBox = await grip.boundingBox();
  const neighborBox = await neighbor.boundingBox();
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await page.mouse.down();
  // SillyTavern intentionally requires a 750ms press on mobile before sorting.
  await page.waitForTimeout(800);
  await page.mouse.move(gripBox.x + gripBox.width / 2, neighborBox.y + neighborBox.height / 4, { steps: 10 });
  await page.mouse.up();
  const reorderConfirmation = page.locator('dialog[open]').filter({ hasText: 'Save this row order?' });
  await expect(reorderConfirmation).toContainText('not in ascending Custom order');
  await reorderConfirmation.locator('.popup-button-ok').click();
  const afterDrag = beforeDrag.filter(uid => uid !== '996');
  afterDrag.splice(afterDrag.indexOf('995'), 0, '996');
  await expect.poll(async () => rows(page).evaluateAll(nodes => nodes.map(node => node.dataset.uid))).toEqual(afterDrag);
  await expect.poll(async () => (await readBook(page, NAME)).entries[996].extensions.display_index).toBe(afterDrag.indexOf('996'));
  const keyboardRow = rows(page).filter({ has: page.locator('[data-col="entry"] .stwid--comment', { hasText: 'Deferred 0998' }) });
  await expect(keyboardRow.locator('[data-col="enabled"]')).toHaveAttribute('data-stwid-pending', '');
  await keyboardRow.evaluate((row) => {
    row.dataset.keyboardToggleClicks = '0';
    row.addEventListener('click', (event) => {
      if (event.target.closest('.stwid--enabled')) row.dataset.keyboardToggleClicks = String(Number(row.dataset.keyboardToggleClicks) + 1);
    }, true);
  });
  // The title link immediately follows Enabled in the table's focus order.
  // Shift+Tab must hydrate that pending cell and preserve keyboard focus.
  await keyboardRow.locator('[data-col="entry"] .stwid--comment').focus();
  await page.keyboard.press('Shift+Tab');
  const keyboardEnabled = keyboardRow.locator('.stwid--enabled');
  await expect(keyboardEnabled).toBeFocused();
  await expect(keyboardEnabled).toHaveAttribute('role', 'button');
  await keyboardEnabled.press('Enter');
  await expect.poll(async () => (await readBook(page, NAME)).entries[998].disable).toBe(true);
  await expect(keyboardEnabled).toHaveAttribute('aria-pressed', 'false');
  await expect(keyboardRow).toHaveAttribute('data-keyboard-toggle-clicks', '1');
  await keyboardEnabled.press('Space');
  await expect.poll(async () => (await readBook(page, NAME)).entries[998].disable).toBe(false);
  await expect(keyboardEnabled).toHaveAttribute('aria-pressed', 'true');
  await expect(keyboardRow).toHaveAttribute('data-keyboard-toggle-clicks', '2');
  await expect(last.locator('[data-col="enabled"]')).toHaveAttribute('data-stwid-pending', '');
  const enabledCell = last.locator('[data-col="enabled"]');
  await enabledCell.scrollIntoViewIfNeeded();
  const box = await enabledCell.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(() => window.stwidDeliverHeldObservers());
  await page.waitForTimeout(100);
  await expect(enabledCell).toHaveAttribute('data-stwid-pending', '');
  await page.mouse.up();
  await expect.poll(async () => (await readBook(page, NAME)).entries[999].disable).toBe(true);
  await expect(last.locator('[data-col="enabled"]')).not.toHaveAttribute('data-stwid-pending', '');
});
