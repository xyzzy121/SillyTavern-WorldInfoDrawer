import { expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export const output = process.env.ST_MOBILE_OUTPUT || fileURLToPath(new URL('./test-results/', import.meta.url));
export const MAIN_BOOK = 'Mobile QA — Main';
export const LONG_FOLDER = 'Mobile folder ' + 'VeryLongFolder'.repeat(22);
export const LONG_BOOK = "Mobile QA — L'été 東京 " + 'Long lorebook title '.repeat(8);
export const book = (page, name = MAIN_BOOK) => page.locator('.stwid--book').filter({ has: page.locator('.stwid--head > .stwid--title', { hasText: name }) }).first();

export async function loadHost(page) {
  await page.goto('/', { waitUntil: 'networkidle' });
  const onboarding = page.locator('dialog[open]').filter({ hasText: 'Welcome to SillyTavern!' });
  if (await onboarding.count()) {
    const saved = page.waitForResponse(response => {
      if (!response.url().endsWith('/api/settings/save')) return false;
      try { return response.request().postDataJSON()?.username === 'Mobile QA'; } catch { return false; }
    });
    await onboarding.locator('textarea, input[type="text"]').last().fill('Mobile QA');
    await onboarding.locator('.popup-button-ok').click();
    await expect(onboarding).toHaveCount(0);
    await saved;
    await page.waitForLoadState('networkidle');
  }
  await page.locator('.stwid--body[data-extension-src]').waitFor({ state: 'attached' });
}

export async function seedFixtures(page) {
  const events = [];
  page.mobileQaEvents = events;
  const providerMetadata = {};
  page.mobileQaProviderMetadata = providerMetadata;
  // These host startup endpoints proxy provider metadata on the server. Stub
  // them before navigation so the mobile suite stays local without credentials.
  await page.route(/\/api\/horde\/(?:status|text-models|text-workers)(?:\?.*)?$/, route => {
    const path = new URL(route.request().url()).pathname;
    providerMetadata[path] = (providerMetadata[path] || 0) + 1;
    return route.fulfill({ json: path === '/api/horde/status' ? { ok: false } : [] });
  });
  page.on('pageerror', error => events.push({ kind:'pageerror', message:error.message, stack:error.stack }));
  page.on('console', message => { if (['warning','error'].includes(message.type())) events.push({kind:message.type(), message:message.text(), location:message.location()}); });
  page.on('response', response => { if (response.status() >= 400) events.push({kind:'http', url:response.url(), status:response.status()}); });
  page.on('requestfailed', request => events.push({kind:'requestfailed', url:request.url(), error:request.failure()?.errorText}));
  await loadHost(page);
  await page.evaluate(async ({ main, longBook, folder }) => {
    const wi = await import('/scripts/world-info.js');
    const headers = SillyTavern.getContext().getRequestHeaders();
    const names = [main, longBook, ...Array.from({ length: 12 }, (_, i) => `Mobile QA — Book ${String(i + 1).padStart(2, '0')}`)];
    for (let i = 0; i < names.length; i++) {
      const entries = Object.fromEntries(Array.from({ length: i === 0 ? 32 : 2 }, (_, uid) => [uid, {
        ...structuredClone(wi.newWorldInfoEntryTemplate), uid,
        comment: `Entry ${String(uid).padStart(2, '0')} — ${i === 0 ? 'Main' : 'Fixture'}`,
        key: [`keyword${uid}`], content: `Synthetic mobile test content ${uid}.\n` + 'A long editable line for mobile scrolling. '.repeat(8),
        order: 100 + uid,
        constant: uid % 3 === 0, vectorized: uid % 3 === 1,
      }]));
      const data = { entries, metadata: { folder: i === 0 || i === 2 ? folder : '', mobileQaMarker: 'preserve-me' } };
      const response = await fetch('/api/worldinfo/edit', { method: 'POST', headers, body: JSON.stringify({ name: names[i], data }) });
      if (!response.ok) throw new Error(`Fixture save failed: ${response.status}`);
    }
    localStorage.setItem('stwid--folder-registry', JSON.stringify([folder, 'Mobile empty folder']));
  }, { main: MAIN_BOOK, longBook: LONG_BOOK, folder: LONG_FOLDER });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.stwid--body[data-extension-src]').waitFor({ state: 'attached' });
  page.mobileQaDocumentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
}

export async function assertRuntimeErrors(page, info) {
  const events = page.mobileQaEvents || [];
  await info.attach('browser-events', { body:JSON.stringify(events,null,2), contentType:'application/json' });
  await info.attach('stubbed-provider-metadata', { body:JSON.stringify(page.mobileQaProviderMetadata || {},null,2), contentType:'application/json' });
  // Windows Playwright WebKit does not expose speech synthesis. The upstream
  // mobile TTS click listener uses it unguarded; retain this separately in logs.
  const knownHostError = e => info.project.use.browserName === 'webkit'
    && e.message === "Can't find variable: SpeechSynthesisUtterance"
    && e.stack?.includes('/scripts/extensions/tts/system.js:131');
  const injectedSaveError = e => info.title.includes('failed save')
    && /Failed to fetch|Load failed|NetworkError/.test(e.message || '')
    && e.stack?.includes('/scripts/world-info.js:');
  expect(events.filter(e => e.kind === 'pageerror' && !knownHostError(e) && !injectedSaveError(e))).toEqual([]);
  const optionalFilesWatcherMissing = e => e.status === 404
    && new URL(e.url).pathname.includes('/SillyTavern-FilesPluginApi/');
  expect(events.filter(e => e.kind === 'http' && !optionalFilesWatcherMissing(e))).toEqual([]);
  expect(events.filter(e => e.kind === 'requestfailed' && !/abort|cancel/i.test(e.error || '') && !(info.title.includes('failed save') && new URL(e.url).pathname === '/api/worldinfo/edit'))).toEqual([]);
}

export async function openDrawer(page) {
  if (!await page.locator('.stwid--body[data-extension-src]').isVisible()) await page.locator('#WI-SP-button .drawer-toggle').click();
  await expect(page.locator('.stwid--body[data-extension-src]')).toBeVisible();
}

export async function readBook(page, name = MAIN_BOOK) {
  return page.evaluate(async name => {
    const response = await fetch('/api/worldinfo/get', { method: 'POST', headers: SillyTavern.getContext().getRequestHeaders(), body: JSON.stringify({ name }) });
    if (!response.ok) throw new Error(`Read failed: ${response.status}`);
    return response.json();
  }, name);
}

export async function openEntry(page, uid = 0) {
  if (!await book(page).isVisible()) await page.locator('.stwid--folder').filter({ has: page.locator('.stwid--folder-label', { hasText: LONG_FOLDER }) }).locator('.stwid--folder-toggle').click();
  const row = book(page).locator(`.stwid--entry[data-uid="${uid}"]`);
  if (!await row.isVisible()) await book(page).locator('.stwid--head > .stwid--title').click();
  await row.locator('.stwid--comment').click();
  await expect(page.locator('.stwid--editor textarea[name="comment"]')).toBeVisible();
}
