import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { MAIN_BOOK, LONG_BOOK, LONG_FOLDER, book, output, seedFixtures, openDrawer, readBook, assertRuntimeErrors } from './helpers.mjs';

const SECOND_BOOK = 'Mobile QA — Book 02';
const UNSELECTED_BOOK = 'Mobile QA — Book 03';
const folder = page => page.locator('.stwid--folder').filter({
  has: page.locator('.stwid--folder-label', { hasText: LONG_FOLDER }),
}).first();
const picker = page => page.locator('dialog.stwid--add-lorebooks-dialog[open]');
const rows = page => picker(page).locator('.stwid--add-lorebooks-row');
const row = (page, name) => rows(page).filter({
  has: page.locator('.stwid--add-lorebooks-name', { hasText: name }),
});
const search = page => picker(page).getByRole('searchbox', { name: 'Search lorebooks or folders', exact: true });
const button = (page, name) => picker(page).getByRole('button', { name, exact: true });
const selectedCount = page => picker(page).locator('.stwid--add-lorebooks-toolbar [role="status"]');

async function openPicker(page) {
  await folder(page).getByRole('button', { name: 'Folder menu', exact: true }).tap();
  const action = page.locator('.stwid--blocker').getByRole('button', { name: /Add Lorebooks…$/ });
  await expect(action).toBeVisible();
  await action.tap();
  await expect(picker(page)).toBeVisible();
  await expect(picker(page)).toHaveAttribute('aria-label', `Add lorebooks to ${LONG_FOLDER}`);
  await expect(picker(page).getByRole('heading')).toHaveText(`Add lorebooks to “${LONG_FOLDER}”`);
}

async function captureLayout(page, info, label) {
  const metrics = await picker(page).evaluate(modal => {
    const measure = node => {
      const rect = node.getBoundingClientRect();
      return {
        clientWidth: node.clientWidth, scrollWidth: node.scrollWidth,
        clientHeight: node.clientHeight, scrollHeight: node.scrollHeight,
        left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        overflowY: getComputedStyle(node).overflowY,
      };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: measure(document.documentElement),
      modal: measure(modal),
      content: measure(modal.querySelector('.stwid--add-lorebooks-content')),
      list: measure(modal.querySelector('.stwid--add-lorebooks-list')),
      names: [...modal.querySelectorAll('.stwid--add-lorebooks-name')].map(node => ({ text: node.textContent, ...measure(node) })),
    };
  });
  const screenshotPath = join(output, `${info.project.name}-bulk-picker-${label}.png`);
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: screenshotPath });
  await info.attach(`bulk-picker-${label}`, { path: screenshotPath, contentType: 'image/png' });
  await info.attach(`bulk-picker-${label}-geometry`, { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' });
  expect.soft(metrics.document.scrollWidth, `${label}: extension must not increase the host's initial overflow`).toBeLessThanOrEqual(page.mobileQaDocumentWidth + 1);
  for (const key of ['modal', 'content', 'list']) {
    expect.soft(metrics[key].scrollWidth, `${label}: ${key} must not overflow horizontally`).toBeLessThanOrEqual(metrics[key].clientWidth + 1);
  }
  expect.soft(metrics.modal.left, `${label}: left dialog edge`).toBeGreaterThanOrEqual(-1);
  expect.soft(metrics.modal.right, `${label}: right dialog edge`).toBeLessThanOrEqual(metrics.viewport.width + 1);
  for (const name of metrics.names) {
    expect.soft(name.scrollWidth, `${label}: lorebook name should wrap`).toBeLessThanOrEqual(name.clientWidth + 1);
  }
}

async function expectReachable(control) {
  // Scrolling is intentional on short viewports. Check that controls can be
  // brought fully into view and are not covered by a clipped dialog/footer.
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeInViewport({ ratio: 0.99 });
  if (await control.isEnabled()) {
    await expect.poll(() => control.evaluate(node => {
      const rect = node.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return node === hit || node.contains(hit);
    })).toBe(true);
  }
  const bounds = await control.boundingBox();
  expect(bounds.height, 'Touch controls must be at least 44px high').toBeGreaterThanOrEqual(43.5);
}

test.beforeEach(async ({ page }) => {
  await seedFixtures(page);
  await openDrawer(page);
});

test.afterEach(async ({ page }, info) => {
  await assertRuntimeErrors(page, info);
});

test('bulk picker keeps long names and controls reachable, preserves filtered selection, and cancels without writes', async ({ page }, info) => {
  const before = new Map();
  for (const name of [MAIN_BOOK, LONG_BOOK, SECOND_BOOK]) before.set(name, await readBook(page, name));
  const writes = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/worldinfo/edit') writes.push(request.postDataJSON()?.name);
  });

  await openPicker(page);
  await expect(rows(page).filter({ has: page.locator('.stwid--add-lorebooks-name', { hasText: /^Mobile QA/ }) })).toHaveCount(14);
  await expect(picker(page).locator('input[type="checkbox"]:disabled')).toHaveCount(2);
  await expect(row(page, MAIN_BOOK).getByRole('checkbox')).toBeDisabled();
  await expect(row(page, 'Mobile QA — Book 01').getByRole('checkbox')).toBeDisabled();
  await expect(selectedCount(page)).toHaveText('0 selected');
  await expect(button(page, 'Add selected')).toBeDisabled();
  await expect(button(page, 'Clear selection')).toBeDisabled();
  await captureLayout(page, info, 'initial');

  for (const control of [search(page), button(page, 'Select visible'), button(page, 'Clear selection'), button(page, 'Add selected'), button(page, 'Cancel')]) {
    await expectReachable(control);
  }
  await captureLayout(page, info, 'footer');

  await search(page).fill(LONG_FOLDER);
  await expect(rows(page)).toHaveCount(2);
  await expect(button(page, 'Select visible')).toBeDisabled();

  await search(page).fill('Book 0');
  await expect(rows(page)).toHaveCount(9);
  await button(page, 'Select visible').tap();
  await expect(selectedCount(page)).toHaveText('8 selected');
  await expect(row(page, 'Mobile QA — Book 01').getByRole('checkbox')).not.toBeChecked();

  await search(page).fill('Book 12');
  await button(page, 'Select visible').tap();
  await expect(selectedCount(page)).toHaveText('9 selected');
  await search(page).fill('Book 02');
  await expect(row(page, SECOND_BOOK).getByRole('checkbox')).toBeChecked();
  await expect(selectedCount(page)).toHaveText('9 selected');
  await button(page, 'Clear selection').tap();
  await expect(selectedCount(page)).toHaveText('0 selected');
  await search(page).fill('');
  await expect(picker(page).locator('input[type="checkbox"]:checked')).toHaveCount(0);

  await search(page).fill("L'été 東京");
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, LONG_BOOK).locator('.stwid--add-lorebooks-name')).toHaveText(LONG_BOOK);
  await row(page, LONG_BOOK).getByRole('checkbox').tap();
  await expect(row(page, LONG_BOOK).getByRole('checkbox')).toBeChecked();
  await expect(selectedCount(page)).toHaveText('1 selected');
  await captureLayout(page, info, 'long-book');
  await search(page).fill('Book 02');
  await row(page, SECOND_BOOK).getByRole('checkbox').tap();
  await expect(row(page, SECOND_BOOK).getByRole('checkbox')).toBeChecked();
  await expect(selectedCount(page)).toHaveText('2 selected');
  await search(page).fill('no matching synthetic lorebook');
  await expect(rows(page)).toHaveCount(0);
  await expect(picker(page)).toContainText('No matching lorebooks.');
  await expect(selectedCount(page)).toHaveText('2 selected');
  await expect(button(page, 'Add selected')).toBeEnabled();
  await expect(button(page, 'Select visible')).toBeDisabled();
  await button(page, 'Cancel').tap();
  await expect(picker(page)).toHaveCount(0);

  for (const [name, original] of before) expect(await readBook(page, name), `${name}: cancel must preserve the server copy`).toEqual(original);
  expect(writes, 'Selecting, filtering, clearing, and cancelling must not save lorebooks').toEqual([]);
});

test('bulk picker adds selected lorebooks durably and preserves entries and unrelated metadata', async ({ page }, info) => {
  const before = new Map();
  for (const name of [LONG_BOOK, SECOND_BOOK, MAIN_BOOK, UNSELECTED_BOOK]) before.set(name, await readBook(page, name));
  await openPicker(page);

  await search(page).fill("L'été 東京");
  await row(page, LONG_BOOK).getByRole('checkbox').tap();
  await expect(row(page, LONG_BOOK).getByRole('checkbox')).toBeChecked();
  await expect(selectedCount(page)).toHaveText('1 selected');
  await search(page).fill('Book 02');
  await button(page, 'Select visible').tap();
  await expect(selectedCount(page)).toHaveText('2 selected');
  await search(page).fill('');
  await expect(picker(page).locator('input[type="checkbox"]:checked')).toHaveCount(2);
  await expect(row(page, LONG_BOOK).getByRole('checkbox')).toBeChecked();
  await expect(row(page, SECOND_BOOK).getByRole('checkbox')).toBeChecked();
  await expectReachable(button(page, 'Add selected'));
  await captureLayout(page, info, 'before-save');
  await button(page, 'Add selected').tap();
  await expect(picker(page)).toHaveCount(0);

  for (const name of [LONG_BOOK, SECOND_BOOK]) {
    const expected = structuredClone(before.get(name));
    expected.metadata.folder = LONG_FOLDER;
    await expect.poll(() => readBook(page, name), { message: `${name}: only folder metadata should change` }).toEqual(expected);
  }
  for (const name of [MAIN_BOOK, UNSELECTED_BOOK]) expect(await readBook(page, name)).toEqual(before.get(name));

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.stwid--body[data-extension-src]').waitFor({ state: 'attached' });
  await openDrawer(page);
  if (!await book(page, MAIN_BOOK).isVisible()) await folder(page).getByLabel('Collapse or expand this folder', { exact: true }).tap();
  for (const name of [LONG_BOOK, SECOND_BOOK]) {
    await expect(book(page, name)).toBeVisible();
    expect(await book(page, name).evaluate(node => node.closest('.stwid--folder').querySelector('.stwid--folder-label').textContent)).toBe(LONG_FOLDER);
    const saved = await readBook(page, name);
    expect(saved.metadata).toEqual({ ...before.get(name).metadata, folder: LONG_FOLDER });
    expect(saved.entries).toEqual(before.get(name).entries);
  }

  await openPicker(page);
  await expect(picker(page).locator('input[type="checkbox"]:disabled')).toHaveCount(4);
  await search(page).fill("L'été 東京");
  await expect(row(page, LONG_BOOK).getByRole('checkbox')).toBeDisabled();
  await expect(row(page, LONG_BOOK)).toContainText(`Already in ${LONG_FOLDER}`);
  await expect(selectedCount(page)).toHaveText('0 selected');
  await expect(button(page, 'Add selected')).toBeDisabled();
  await expectReachable(button(page, 'Cancel'));
  await captureLayout(page, info, 'after-reload');
  await button(page, 'Cancel').tap();
});
