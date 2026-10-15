import { test, expect } from '@playwright/test';
import { seedFixtures, assertRuntimeErrors } from './helpers.mjs';

const BOOK_NAME = 'Integration QA — "quoted" 東京';
const triggerSelector = '#stwid-integration-qa-trigger';
const popupSelector = '.stwid--context-menu';

// Exercise the installed extension modules with local substitutes for optional
// plugins. No plugin installation, command execution, or external-editor launch
// is needed to verify their DOM and async contracts.
async function installIntegrationMenu(page, { core = false } = {}) {
  await page.evaluate(async ({ name, core }) => {
    const root = document.querySelector('.stwid--body[data-extension-src]').dataset.extensionSrc.split('/src/')[0];
    const [{ openContextMenu, closeContextMenu }, { createExtensionIntegrationsSlice }, { createBookMenuActionItem }] = await Promise.all([
      import(`${root}/src/shared/context-menu.js`),
      import(`${root}/src/book-browser/book-list/book-list.extension-integrations.js`),
      import(`${root}/src/book-browser/book-list/book-list.book-menu.item.js`),
    ]);
    closeContextMenu();
    const host = document.createElement('div');
    host.id = 'stwid-integration-qa';
    Object.assign(host.style, { position: 'fixed', left: '16px', top: '120px', zIndex: '29000' });
    const qa = window.stwidIntegrationQa = {
      events: [], closeCalls: 0, completed: false, fillCalls: 0,
      selected: null, command: null, actionSelectors: null,
    };
    const deferred = () => {
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      return { promise, resolve };
    };
    qa.selection = deferred();
    qa.action = deferred();
    qa.commandResult = deferred();
    qa.showDestination = () => {
      const dialog = document.createElement('dialog');
      dialog.id = 'stwid-integration-qa-dialog';
      const input = document.createElement('input');
      input.id = 'stwid-integration-qa-destination';
      input.setAttribute('aria-label', 'Integration destination');
      dialog.append(input);
      document.body.append(dialog);
      dialog.showModal();
      input.focus();
    };
    const record = stage => qa.events.push({
      stage,
      menuCount: document.querySelectorAll('.stwid--context-menu').length,
      expanded: qa.trigger.getAttribute('aria-expanded'),
      focused: document.activeElement?.id,
    });
    const deps = {
      extensionNames: [
        'third-party/SillyTavern-WorldInfoBulkEdit',
        'third-party/SillyTavern-WorldInfoExternalEditor',
        'third-party/SillyTavern-LorebookOrdering',
      ],
      getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-STWID-Integration-QA': 'local-only' }),
      setSelectedBookInCoreUi: async selected => {
        qa.selected = selected;
        record('select-book');
        return qa.selection.promise;
      },
      clickCoreUiAction: async selectors => {
        qa.actionSelectors = selectors;
        record('open-bulk-editor');
        qa.showDestination();
        await qa.action.promise;
        qa.completed = true;
      },
      executeSlashCommand: async command => {
        qa.command = command;
        record('execute-stlo');
        qa.showDestination();
        const result = await qa.commandResult.promise;
        qa.completed = true;
        return result;
      },
      createBookMenuActionItem,
    };
    let trigger;
    if (core) {
      const { createBookMenuSlice } = await import(`${root}/src/book-browser/book-list/book-list.book-menu.js`);
      const slice = createBookMenuSlice({
        listPanelState: {},
        runtime: {
          ...deps, extensionNames: [],
          cache: { [name]: { entries: {}, metadata: {} } },
          Settings: { instance: { sortLogic: 'title', sortDirection: 'ascending' } },
          getSortLabel: () => 'Title ascending', appendSortOptions() {},
          isDirtyCheck: () => true,
          fillEmptyTitlesWithKeywords: async () => { qa.fillCalls++; },
        },
        coreUiSelectors: {}, coreUiActionSelectors: {}, folderDeps: {},
        setSelectedBookInCoreUi: deps.setSelectedBookInCoreUi,
        clickCoreUiAction: deps.clickCoreUiAction,
        getBookSortChoice: () => ({ sort: 'title', direction: 'ascending' }),
      });
      trigger = slice.buildBookMenuTrigger(name);
    } else {
      const { appendIntegrationMenuItems } = createExtensionIntegrationsSlice(deps);
      trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'stwid--action stwid--list-dropdown__trigger';
      trigger.textContent = 'Integration menu';
      trigger.setAttribute('aria-haspopup', 'dialog');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.addEventListener('click', event => openContextMenu({
        trigger, event, label: 'Optional integration menu',
        build: (menu, close) => appendIntegrationMenuItems(menu, name, () => {
          qa.closeCalls++;
          close();
        }),
      }));
    }
    qa.trigger = trigger;
    trigger.id = 'stwid-integration-qa-trigger';
    trigger.setAttribute('aria-label', 'Integration test menu');
    host.append(trigger);
    document.body.append(host);
    qa.cleanup = () => {
      closeContextMenu();
      document.querySelector('#stwid-integration-qa-dialog')?.remove();
      host.remove();
    };
  }, { name: BOOK_NAME, core });
}

test.beforeEach(async ({ page }) => { await seedFixtures(page); });
test.afterEach(async ({ page }, info) => {
  await page.evaluate(() => window.stwidIntegrationQa?.cleanup());
  await assertRuntimeErrors(page, info);
});

test('optional Bulk Edit closes before awaited selection and preserves the destination focus', async ({ page }) => {
  await installIntegrationMenu(page);
  await page.locator(triggerSelector).tap();
  await page.locator(`${popupSelector} .stwid--bulkEdit`).tap();
  await expect(page.locator(popupSelector)).toHaveCount(0);
  await expect(page.locator(triggerSelector)).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => window.stwidIntegrationQa.selected)).toBe(BOOK_NAME);
  expect(await page.evaluate(() => window.stwidIntegrationQa.events)).toMatchObject([
    { stage: 'select-book', menuCount: 0, expanded: 'false' },
  ]);
  await page.evaluate(() => window.stwidIntegrationQa.selection.resolve(true));
  const destination = page.locator('#stwid-integration-qa-destination');
  await expect(destination).toBeFocused();
  expect(await page.evaluate(() => window.stwidIntegrationQa.actionSelectors)).toEqual(['.stwibe--trigger']);
  await page.evaluate(() => window.stwidIntegrationQa.action.resolve());
  await expect.poll(() => page.evaluate(() => window.stwidIntegrationQa.closeCalls)).toBe(1);
  await expect(destination).toBeFocused();
  expect(await page.evaluate(() => window.stwidIntegrationQa.events.at(-1).menuCount)).toBe(0);
});

test('optional External Editor request is intercepted locally and its late completion cannot steal focus', async ({ page }) => {
  let releaseResponse;
  const responseGate = new Promise(resolve => { releaseResponse = resolve; });
  const requests = [];
  await page.route('**/api/plugins/wiee/editor', async route => {
    requests.push({ method: route.request().method(), body: route.request().postDataJSON(), headers: route.request().headers() });
    await responseGate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  try {
    await installIntegrationMenu(page);
    await page.locator(triggerSelector).tap();
    await page.locator(`${popupSelector} .stwid--externalEditor`).tap();
    await expect.poll(() => requests.length).toBe(1);
    await expect(page.locator(popupSelector)).toHaveCount(0);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].body).toEqual({ book: BOOK_NAME, command: 'code', commandArguments: ['.'] });
    expect(requests[0].headers['x-stwid-integration-qa']).toBe('local-only');
    await page.evaluate(() => window.stwidIntegrationQa.showDestination());
    const destination = page.locator('#stwid-integration-qa-destination');
    await expect(destination).toBeFocused();
    releaseResponse();
    await expect.poll(() => page.evaluate(() => window.stwidIntegrationQa.closeCalls)).toBe(1);
    await expect(destination).toBeFocused();
    await expect(page.locator(triggerSelector)).toHaveAttribute('aria-expanded', 'false');
  } finally {
    releaseResponse();
  }
});

test('optional STLO preserves selectors and accessible labels while keyboard activation runs once', async ({ page }) => {
  await installIntegrationMenu(page);
  await page.locator(triggerSelector).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(`${popupSelector} .stwid--bulkEdit`)).toBeFocused();
  const stlo = page.locator(`${popupSelector} #lorebook_ordering_button.stwid--stlo`);
  await expect(stlo).toHaveAttribute('type', 'button');
  await expect(stlo).toHaveAttribute('role', 'button');
  await expect(stlo).toHaveAccessibleName('Configure STLO Priority & Budget');
  await expect(stlo).toHaveAttribute('title', 'Configure STLO Priority & Budget');
  await expect(stlo).toHaveAttribute('data-i18n', '[title]stlo.button.configure; [aria-label]stlo.button.configure');
  await stlo.focus();
  await page.keyboard.press('Space');
  await expect(page.locator(popupSelector)).toHaveCount(0);
  await expect(page.locator('#stwid-integration-qa-destination')).toBeFocused();
  expect(await page.evaluate(() => window.stwidIntegrationQa.command)).toBe(`/stlo "${BOOK_NAME.replaceAll('"', '\\"')}"`);
  expect(await page.evaluate(() => window.stwidIntegrationQa.events.filter(event => event.stage === 'execute-stlo').length)).toBe(1);
  expect(await page.evaluate(() => window.stwidIntegrationQa.events[0].menuCount)).toBe(0);
  await page.evaluate(() => window.stwidIntegrationQa.commandResult.resolve(true));
  await expect.poll(() => page.evaluate(() => window.stwidIntegrationQa.closeCalls)).toBe(1);
  await expect(page.locator('#stwid-integration-qa-destination')).toBeFocused();
});

test('core lorebook menu keeps its unsaved-edit guard after native action dismissal', async ({ page }) => {
  await installIntegrationMenu(page, { core: true });
  await page.locator(triggerSelector).tap();
  await page.locator(`${popupSelector} .stwid--fillTitles`).tap();
  await expect(page.locator(popupSelector)).toHaveCount(0);
  await expect(page.locator(triggerSelector)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#toast-container')).toContainText('Unsaved edits detected. Save or discard changes before filling titles.');
  await expect(page.locator(triggerSelector)).toBeFocused();
  expect(await page.evaluate(() => window.stwidIntegrationQa.fillCalls)).toBe(0);
});
