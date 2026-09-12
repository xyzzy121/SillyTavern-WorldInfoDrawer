import {
  delay,
  loadWorldInfo,
  saveWorldInfo,
  selected_world_info,
  world_names,
} from './st-host.js';
import { Settings } from './settings.js';
import { mirrorRawBookFieldsToOriginalData } from './original-data.js';
import { registerBookReloadHooks } from './book-reload.js';
import { cloneMetadata, getSortFromMetadata, sortEntries } from './sort-helpers.js';
import { createDeferred } from './utils.js';
import { createUpdateQueue } from './update-queue.js';

const LOG_PREFIX = '[STWID]';
const EDITOR_ROOT_SELECTOR = '.stwid--editor';
const EDITOR_DUPLICATE_REFRESH_TIMEOUT_MS = 15000;

// wi-update-handler lives in src/shared/ and must not import feature modules
// directly (that would invert the shared -> feature dependency direction and
// risk circular imports). Instead, the Book Browser's `refreshList`/`renderEntry`
// and the entry row's `entryState` are injected once at startup via
// registerUiRefreshHooks(), called from index.js before any WORLDINFO_UPDATED
// event can reach this module. Calls before registration warn and no-op instead
// of throwing.
let uiRefreshHooks = null;

export const registerUiRefreshHooks = ({
  refreshList,
  renderEntry,
  entryState,
  waitForListRefreshIdle,
  refreshSearchFilter,
  invalidateSearchFilter,
}) => {
  uiRefreshHooks = { refreshList, renderEntry, entryState, waitForListRefreshIdle, refreshSearchFilter, invalidateSearchFilter };
};

const callRefreshList = async () => {
  if (!uiRefreshHooks?.refreshList) {
    console.warn(LOG_PREFIX, 'UI refresh hooks not registered yet; skipping refreshList().');
    return;
  }
  await uiRefreshHooks.refreshList();
};

// Book-level reconciliation below decides "is this book on screen?" purely from
// `cache`. A full list refresh empties that cache while the rows are still
// attached, so reconciling inside one appends a duplicate row for every book.
// Waiting the refresh out costs nothing: it rebuilds the cache from disk, which
// is a superset of what this handler would have done.
//
// Without the hook the handler still runs — `renderBook` drops a book's
// previous row before caching a new one, so the rows stay correct — but the
// ordering guarantee is gone, so say so rather than degrade silently.
const callWaitForListRefreshIdle = async () => {
  if (!uiRefreshHooks?.waitForListRefreshIdle) {
    console.warn(
      LOG_PREFIX,
      'UI refresh hooks not registered yet; reconciling without waiting for a list refresh.',
    );
    return;
  }
  await uiRefreshHooks.waitForListRefreshIdle();
};

const callRenderEntry = async (worldEntry, name, before) => {
  if (!uiRefreshHooks?.renderEntry) {
    console.warn(LOG_PREFIX, 'UI refresh hooks not registered yet; skipping renderEntry().');
    return;
  }
  await uiRefreshHooks.renderEntry(worldEntry, name, before);
};

const callEntryState = (entry) => {
  if (!uiRefreshHooks?.entryState) {
    console.warn(LOG_PREFIX, 'UI refresh hooks not registered yet; skipping entryState().');
    return 'normal';
  }
  return uiRefreshHooks.entryState(entry);
};

// E8/E8b — the Entry Manager's inline character/tag filter dropdown must close
// when *someone else* changes the entry it is editing, and must not close for
// the extension's own saves. There is no origin tracking in the codebase, so
// "external" is decided by value (D17): the diff below already compares the
// cached value — which the cell updates before it saves — against what the host
// just reported, so a save of our own produces no diff and no notification,
// while a genuine outside edit produces both. Injected the same way as the UI
// refresh hooks, to keep `shared/` free of feature-folder imports.
let characterFilterChangeHook = null;

export const registerCharacterFilterChangeHook = (onExternalChange) => {
  characterFilterChangeHook = typeof onExternalChange === 'function' ? onExternalChange : null;
};

const maybeTriggerEditorRefreshForField = ({
  isCurrentEditor,
  selector,
  expectedValue,
  triggerEditorRefreshOnce,
}) => {
  if (!isCurrentEditor) return;
  const editorFieldInput = document.querySelector(selector);
  if (!editorFieldInput || editorFieldInput.value !== String(expectedValue)) {
    triggerEditorRefreshOnce();
  }
};

// Drops from the cache every book the host no longer lists, detaching its row
// first so nothing later reads a book that is gone. Exported for the unit tests only
// — production reaches it through updateWIChange.
export const removeStaleCachedBooks = ({ cache, worldNames }) => {
  const liveNames = new Set(worldNames);
  for (const [worldName, cachedWorld] of Object.entries(cache)) {
    if (liveNames.has(worldName)) continue;
    cachedWorld.dom.root.remove();
    delete cache[worldName];
  }
};

// Renders every book the host lists that the cache has not got yet, placing it
// at the alphabetical position the already-cached rows define rather than
// appending. Exported for the unit tests only — production reaches it through
// updateWIChange.
export const renderMissingBooks = async ({
  cache,
  worldNames,
  loadWorldInfoForBook,
  listPanelApi,
  isCurrent = () => true,
}) => {
  for (const worldName of [...worldNames]) {
    if (!isCurrent()) return false;
    if (cache[worldName]) continue;
    const worldData = await loadWorldInfoForBook(worldName);
    if (!isCurrent()) return false;
    // A refresh or another render may have installed this book during the read.
    if (cache[worldName]) continue;
    const before = Object.keys(cache)
      .filter((name) => name.toLowerCase().localeCompare(worldName.toLowerCase()) > 0)
      .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()))[0];
    const beforeRoot = before ? cache[before]?.dom?.root ?? null : null;
    await listPanelApi.renderBook(worldName, beforeRoot, worldData, null, {
      isCurrent,
      refreshSearch: false,
    });
    if (!isCurrent()) return false;
  }
  return true;
};

// Cheap equality check for a single entry field. Array fields (key,
// keysecondary, triggers) are the common case and are compared element by
// element instead of via JSON.stringify (PERF-W4-01); only genuine non-array
// objects (e.g. characterFilter) fall back to JSON serialization.
// Exported for the unit tests only — no production caller outside this module.
export const areEntryFieldValuesEqual = (oldValue, newValue) => {
  if (oldValue === newValue) return true;
  if (Array.isArray(oldValue) && Array.isArray(newValue)) {
    if (oldValue.length !== newValue.length) return false;
    for (let index = 0; index < oldValue.length; index += 1) {
      if (oldValue[index] !== newValue[index]) return false;
    }
    return true;
  }
  if (
    typeof oldValue === 'object' &&
    oldValue !== null &&
    typeof newValue === 'object' &&
    newValue !== null
  ) {
    return JSON.stringify(oldValue) === JSON.stringify(newValue);
  }
  return false;
};

// Walks one changed entry field by field and decides what to touch: which row
// nodes to update and whether the open editor may be refreshed. Exported for
// the unit tests only — in production it is reached through
// syncBookEntriesAndDom below.
export const applyEntryFieldDiff = ({
  bookName,
  entryUid,
  oldEntry,
  updatedEntry,
  cache,
  editorPanelApi,
  isCurrentEditor,
  triggerEditorRefreshOnce,
  shouldRefreshEditor,
}) => {
  let hasChange = false;
  const currentEntryIsOpen = isCurrentEditor(bookName, entryUid);
  for (const fieldName of new Set([...Object.keys(oldEntry), ...Object.keys(updatedEntry)])) {
    const oldValue = oldEntry[fieldName];
    const newValue = updatedEntry[fieldName];
    if (areEntryFieldValuesEqual(oldValue, newValue)) continue;

    hasChange = true;
    // Only reached when the value actually differs, which is exactly the
    // "external change" test the inline filter dropdown needs (E8b). Fired
    // here rather than from a `case`, so the field keeps the default branch's
    // editor-refresh behaviour without a copy of it.
    if (fieldName === 'characterFilter') {
      characterFilterChangeHook?.(bookName, entryUid, updatedEntry);
    }
    switch (fieldName) {
      case 'content': {
        maybeTriggerEditorRefreshForField({
          isCurrentEditor: currentEntryIsOpen,
          selector: `${EDITOR_ROOT_SELECTOR} [name="content"]`,
          expectedValue: updatedEntry.content,
          triggerEditorRefreshOnce,
        });
        break;
      }
      case 'comment': {
        maybeTriggerEditorRefreshForField({
          isCurrentEditor: currentEntryIsOpen,
          selector: `${EDITOR_ROOT_SELECTOR} [name="comment"]`,
          expectedValue: updatedEntry.comment,
          triggerEditorRefreshOnce,
        });
        cache[bookName].dom.entry[entryUid].comment.textContent = updatedEntry.comment;
        break;
      }
      case 'key': {
        maybeTriggerEditorRefreshForField({
          isCurrentEditor: hasChange && currentEntryIsOpen,
          selector: `${EDITOR_ROOT_SELECTOR} textarea[name="${fieldName}"]`,
          expectedValue: updatedEntry[fieldName].join(', '),
          triggerEditorRefreshOnce,
        });
        cache[bookName].dom.entry[entryUid].key.textContent = updatedEntry.key.join(', ');
        break;
      }
      case 'disable': {
        if (hasChange && currentEntryIsOpen) {
          triggerEditorRefreshOnce();
        }
        cache[bookName].dom.entry[entryUid].isEnabled.classList[newValue ? 'remove' : 'add'](
          'fa-toggle-on',
        );
        cache[bookName].dom.entry[entryUid].isEnabled.classList[newValue ? 'add' : 'remove'](
          'fa-toggle-off',
        );
        break;
      }
      case 'constant':
      case 'vectorized': {
        if (hasChange && currentEntryIsOpen) {
          triggerEditorRefreshOnce();
        }
        cache[bookName].dom.entry[entryUid].strategy.value = callEntryState(updatedEntry);
        break;
      }
      default: {
        maybeTriggerEditorRefreshForField({
          isCurrentEditor: hasChange && currentEntryIsOpen,
          selector: `${EDITOR_ROOT_SELECTOR} [name="${fieldName}"]`,
          expectedValue: updatedEntry[fieldName],
          triggerEditorRefreshOnce,
        });
        break;
      }
    }
  }

  if (!currentEntryIsOpen) {
    return hasChange;
  }

  if (shouldRefreshEditor()) {
    cache[bookName].dom.entry[entryUid].root.click();
  }

  return hasChange;
};

// Syncs one book's incoming data into the cache and the on-screen rows,
// including the per-entry once-only editor refresh guard. Exported for the
// unit tests only — production reaches it through updateWIChange.
export const syncBookEntriesAndDom = async ({
  bookName,
  cache,
  data,
  listPanelApi,
  editorPanelApi,
  getCurrentEditor,
  setCurrentEditor,
  shouldAutoRefreshEditor,
  isCurrent = () => true,
}) => {
  const cachedBook = cache[bookName];
  const cachedEntries = cachedBook?.entries;
  const cachedDom = cachedBook?.dom;
  const cachedEntryDoms = cachedDom?.entry;
  const canApply = () =>
    isCurrent() && cache[bookName] === cachedBook && cachedBook?.entries === cachedEntries &&
    cachedBook?.dom === cachedDom && cachedDom?.entry === cachedEntryDoms;
  if (!cachedBook || !cachedEntries || !cachedEntryDoms || !canApply()) return false;
  // Inline edits mutate these cache objects in place. Keep reconciliation in
  // one UI task so an older payload cannot overwrite input accepted halfway
  // through a pass; only the existing row-render awaits may suspend it.
  const isCurrentEditor = (entryUid) => {
    const currentEditor = getCurrentEditor();
    return currentEditor?.name === bookName && String(currentEditor?.uid) === String(entryUid);
  };
  const world = { entries: {}, metadata: cloneMetadata(data.metadata) };
  const updatedSort = getSortFromMetadata(world.metadata) ?? cachedBook.sort;
  const sortChoice = {
    sort: updatedSort?.sort ?? Settings.instance.sortLogic,
    direction: updatedSort?.direction ?? Settings.instance.sortDirection,
  };

  for (const [entryUid, entryData] of Object.entries(data.entries)) {
    world.entries[entryUid] = structuredClone(entryData);
  }

  const { entries: _entries, metadata: _metadata, ...extras } = data ?? {};
  cachedBook.extras = structuredClone(extras);

  for (const entryUid of Object.keys(cachedEntries)) {
    if (!canApply()) return false;
    if (world.entries[entryUid]) continue;
    cachedEntryDoms[entryUid]?.root?.remove();
    delete cachedEntryDoms[entryUid];
    delete cachedEntries[entryUid];
    if (!isCurrentEditor(entryUid)) continue;
    if (editorPanelApi) {
      editorPanelApi.clearEditor();
    } else {
      setCurrentEditor(null);
    }
  }

  const newEntries = Object.keys(world.entries)
    .filter((entryUid) => !cachedEntries[entryUid])
    .map((entryUid) => world.entries[entryUid]);

  if (newEntries.length > 0) {
    // Sort the merged list (existing + all new entries) ONCE instead of
    // re-sorting the whole book per new entry (PERF-W4-02). Then, in a single
    // right-to-left pass, record each position's insert anchor: the nearest
    // entry to its right that already has a rendered DOM node (i.e. an existing
    // entry — new entries have none yet). Inserting new entries left-to-right
    // before that anchor reproduces the same fully-sorted order the old
    // per-entry re-sort produced, without the O(k * n log n) cost.
    const newEntrySet = new Set(newEntries);
    const sorted = sortEntries(
      [...Object.values(cachedEntries), ...newEntries],
      sortChoice.sort,
      sortChoice.direction,
    );

    const anchorEntries = new Array(sorted.length);
    let nextAnchorEntry = null;
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      anchorEntries[index] = nextAnchorEntry;
      if (cachedEntryDoms[sorted[index].uid]) nextAnchorEntry = sorted[index];
    }

    for (let index = 0; index < sorted.length; index += 1) {
      if (!canApply()) return false;
      const entryToInsert = sorted[index];
      if (!newEntrySet.has(entryToInsert)) continue;
      // Resolve the anchor's DOM node freshly at insert time so a node that has
      // gone away degrades to an append (null) instead of throwing.
      const anchorEntry = anchorEntries[index];
      const beforeRoot = anchorEntry
        ? (cachedEntryDoms[anchorEntry.uid]?.root ?? null)
        : null;
      await callRenderEntry(entryToInsert, bookName, beforeRoot);
      if (!canApply()) return false;
    }
  }

  let hasUpdate = false;
  for (const [entryUid, cachedEntry] of Object.entries(cachedEntries)) {
    if (!canApply()) return false;
    const updatedEntry = world.entries[entryUid];
    let needsEditorRefresh = false;
    const triggerEditorRefreshOnce = () => {
      if (needsEditorRefresh) return true;
      if (!shouldAutoRefreshEditor(bookName, entryUid)) return false;
      needsEditorRefresh = true;
      return true;
    };

    const entryHasChange = applyEntryFieldDiff({
      bookName,
      entryUid,
      oldEntry: cachedEntry,
      updatedEntry,
      cache,
      editorPanelApi,
      isCurrentEditor: (_, currentEntryUid) => isCurrentEditor(currentEntryUid),
      triggerEditorRefreshOnce,
      shouldRefreshEditor: () => needsEditorRefresh,
    });

    if (entryHasChange) {
      hasUpdate = true;
    }
  }

  if (!canApply()) return false;
  cachedBook.entries = world.entries;
  const prevSort = cachedBook.sort;
  listPanelApi.setCacheMetadata(bookName, world.metadata);
  const sortChanged = JSON.stringify(prevSort) !== JSON.stringify(cachedBook.sort);
  if (hasUpdate || sortChanged) {
    listPanelApi.sortEntriesIfNeeded(bookName);
  }
  const currentEditor = getCurrentEditor();
  const currentUid = currentEditor?.uid;
  if (
    isCurrent() && cache[bookName] === cachedBook && currentEditor?.name === bookName &&
    currentUid !== null && currentUid !== undefined && world.entries[currentUid]
  ) {
    // Only the editor can verify that a host acknowledgement matches both its
    // mounted model and current controls. Unrelated updates never clear edits.
    editorPanelApi?.markCleanIfSaved?.(bookName, currentUid, world.entries[currentUid]);
  }
  return true;
};

const createWorldInfoUpdateWaiter = ({
  waitDelay,
  getUpdateWIChangeToken,
  isUpdateInProgress,
  getUpdateStarted,
  getUpdateFinished,
}) => {
  const waitForWorldInfoUpdate = async () => {
    const tokenAtCall = getUpdateWIChangeToken();

    while (getUpdateWIChangeToken() === tokenAtCall) {
      if (isUpdateInProgress()) {
        await getUpdateFinished()?.promise;
        continue;
      }
      await getUpdateStarted().promise;
    }

    await getUpdateFinished()?.promise;
    return true;
  };

  const waitForWorldInfoUpdateWithTimeout = async (
    waitPromise,
    timeoutMs = EDITOR_DUPLICATE_REFRESH_TIMEOUT_MS,
  ) => {
    const result = await Promise.race([
      waitPromise.then(() => true),
      waitDelay(timeoutMs).then(() => false),
    ]);
    return result;
  };

  return {
    waitForWorldInfoUpdate,
    waitForWorldInfoUpdateWithTimeout,
  };
};

const createEditorDuplicateRefreshWorker = ({
  getCurrentEditor,
  refreshBookList,
  reopenEditorEntry,
  waitForWorldInfoUpdate,
  waitForWorldInfoUpdateWithTimeout,
}) => {
  const editorDuplicateRefreshQueue = [];
  let isEditorDuplicateRefreshWorkerRunning = false;

  const runEditorDuplicateRefreshWorker = async () => {
    if (isEditorDuplicateRefreshWorkerRunning) return;
    isEditorDuplicateRefreshWorkerRunning = true;
    try {
      while (editorDuplicateRefreshQueue.length > 0) {
        const waitPromise = editorDuplicateRefreshQueue.shift();
        const hasUpdate = await waitForWorldInfoUpdateWithTimeout(waitPromise);
        if (!hasUpdate) continue;

        const currentEditor = getCurrentEditor();
        const reopenTarget = currentEditor ? { ...currentEditor } : null;
        await refreshBookList();
        reopenEditorEntry(reopenTarget);
      }
    } finally {
      isEditorDuplicateRefreshWorkerRunning = false;
      if (editorDuplicateRefreshQueue.length > 0) {
        void runEditorDuplicateRefreshWorker();
      }
    }
  };

  const queueEditorDuplicateRefresh = () => {
    editorDuplicateRefreshQueue.push(waitForWorldInfoUpdate());
    void runEditorDuplicateRefreshWorker();
  };

  return { queueEditorDuplicateRefresh };
};

const registerWorldInfoListeners = ({
  eventBus,
  eventTypes,
  onWorldInfoUpdated,
  onWorldInfoSettingsUpdated,
}) => {
  if (!eventBus || !eventTypes) {
    return () => {};
  }

  eventBus.on(eventTypes.WORLDINFO_UPDATED, onWorldInfoUpdated);
  eventBus.on(eventTypes.WORLDINFO_SETTINGS_UPDATED, onWorldInfoSettingsUpdated);
  eventBus.on(eventTypes.CHAT_CHANGED, onWorldInfoSettingsUpdated);

  return () => {
    eventBus.removeListener(eventTypes.WORLDINFO_UPDATED, onWorldInfoUpdated);
    eventBus.removeListener(eventTypes.WORLDINFO_SETTINGS_UPDATED, onWorldInfoSettingsUpdated);
    eventBus.removeListener(eventTypes.CHAT_CHANGED, onWorldInfoSettingsUpdated);
  };
};

export const initWIUpdateHandler = ({
  cache,
  getCurrentEditor,
  setCurrentEditor,
  getListPanelApi,
  getEditorPanelApi,
  getRefreshBookSourceLinks,
}) => {
  const stContext = SillyTavern.getContext();
  const eventBus = stContext?.eventSource;
  const eventTypes = stContext?.eventTypes ?? stContext?.event_types;

  let updateWIChangeStarted = createDeferred();

  let updateWIChangeFinished;

  let updateWIChangeToken = 0;
  let isWIUpdateInProgress = false;

  const shouldAutoRefreshEditor = (name, uid) => {
    const editorPanelApi = getEditorPanelApi();

    if (!editorPanelApi?.isDirty) return true;
    return !editorPanelApi.isDirty(name, uid);
  };

  const buildSavePayload = (name) => ({
    ...structuredClone(cache[name].extras ?? {}),
    entries: structuredClone(cache[name].entries),
    metadata: cloneMetadata(cache[name].metadata),
  });

  const updateSettingsChange = () => {
    const listPanelApi = getListPanelApi();
    const activeNames = new Set(selected_world_info);
    for (const [name, world] of Object.entries(cache)) {
      const active = activeNames.has(name);
      if (world?.dom?.active && world.dom.active.checked !== active) {
        world.dom.active.checked = active;
      }
    }
    listPanelApi?.applyActiveFilter?.();
    listPanelApi?.updateFolderActiveToggles?.();
    getRefreshBookSourceLinks()?.('worldinfo_settings_updated');
  };

  const processUpdateBatch = async (batch, isQueueCurrent) => {
    const cycleFinished = createDeferred();
    updateWIChangeFinished = cycleFinished;
    updateWIChangeToken += 1;
    isWIUpdateInProgress = true;
    updateWIChangeStarted.resolve();

    try {
      await callWaitForListRefreshIdle();
      if (!isQueueCurrent()) return;
      uiRefreshHooks?.invalidateSearchFilter?.();

      const listPanelApi = getListPanelApi();
      const editorPanelApi = getEditorPanelApi();
      const isRefreshCurrent = listPanelApi?.captureRefreshGuard?.() ?? (() => true);
      const isCurrent = () => isQueueCurrent() && isRefreshCurrent();
      removeStaleCachedBooks({ cache, worldNames: world_names });
      await renderMissingBooks({
        cache,
        worldNames: world_names,
        loadWorldInfoForBook: loadWorldInfo,
        listPanelApi,
        isCurrent,
      });
      if (!isCurrent()) {
        // A full refresh reloads authoritative book data. Let it finish before
        // resolving direct reconciliation callers, without applying this older
        // batch over its replacement cache. Teardown does not wait on the UI.
        if (isQueueCurrent()) await callWaitForListRefreshIdle();
        return;
      }
      const errors = new Map();
      for (const { name, data } of batch) {
        if (!isCurrent()) return;
        if (!name || !cache[name]) continue;
        try {
          await syncBookEntriesAndDom({
            bookName: name,
            cache,
            data,
            listPanelApi,
            editorPanelApi,
            getCurrentEditor,
            setCurrentEditor,
            shouldAutoRefreshEditor,
            isCurrent,
          });
          if (!isCurrent()) {
            if (isQueueCurrent()) await callWaitForListRefreshIdle();
            return;
          }
        } catch (error) {
          // One broken book must not discard updates for the rest of the batch.
          errors.set(name, error);
        }
      }
      if (!isCurrent()) return;
      getRefreshBookSourceLinks()?.('worldinfo_updated');
      await uiRefreshHooks?.refreshSearchFilter?.();
      return errors;
    } finally {
      isWIUpdateInProgress = false;
      updateWIChangeStarted = createDeferred();
      cycleFinished.resolve();
    }
  };

  const updateQueue = createUpdateQueue({ processBatch: processUpdateBatch, delayMs: 100 });
  const updateWIChange = (name = null, data = null) =>
    updateQueue.enqueue(name, data, { immediate: true });
  const updateWIChangeDebounced = (name = null, data = null) => {
    // Event emitters and MutationObserver do not consume completion promises.
    void updateQueue.enqueue(name, data).catch((error) => {
      if (error?.name !== 'AbortError') console.error(LOG_PREFIX, 'World Info update failed.', error);
    });
  };

  // Direct failed-save reconciliation flushes pending events through the same
  // serialized worker and waits for its own result before refreshing the table.
  registerBookReloadHooks({ reconcileBook: updateWIChange });

  const { waitForWorldInfoUpdate, waitForWorldInfoUpdateWithTimeout } = createWorldInfoUpdateWaiter(
    {
      waitDelay: delay,
      getUpdateWIChangeToken: () => updateWIChangeToken,
      isUpdateInProgress: () => isWIUpdateInProgress,
      getUpdateStarted: () => updateWIChangeStarted,
      getUpdateFinished: () => updateWIChangeFinished,
    },
  );

  const reopenEditorEntry = (editorState) => {
    if (!editorState?.name || editorState?.uid === null || editorState?.uid === undefined) return;
    const entryDom = cache[editorState.name]?.dom?.entry?.[editorState.uid]?.root;
    if (entryDom) {
      entryDom.click();
    }
  };

  const { queueEditorDuplicateRefresh } = createEditorDuplicateRefreshWorker({
    getCurrentEditor,
    refreshBookList: callRefreshList,
    reopenEditorEntry,
    waitForWorldInfoUpdate,
    waitForWorldInfoUpdateWithTimeout,
  });

  const fillEmptyTitlesWithKeywords = async (name) => {
    const data = await loadWorldInfo(name);
    if (!data || typeof data !== 'object' || !data.entries || typeof data.entries !== 'object') {
      return;
    }
    let hasUpdates = false;
    for (const entry of Object.values(data.entries)) {
      const hasTitle = Boolean(entry.comment?.trim());
      if (hasTitle) continue;
      const keywords = Array.isArray(entry.key)
        ? entry.key.map((it) => it?.trim()).filter(Boolean)
        : [];
      if (keywords.length === 0) continue;
      entry.comment = keywords.join(', ');
      mirrorRawBookFieldsToOriginalData(data, entry, ['comment']);
      hasUpdates = true;
    }
    if (!hasUpdates) return;
    await saveWorldInfo(name, data, true);
  };

  const onWorldInfoUpdated = (name, world) => updateWIChangeDebounced(name, world);
  const onWorldInfoSettingsUpdated = () => updateSettingsChange();
  const removeWorldInfoListeners = registerWorldInfoListeners({
    eventBus,
    eventTypes,
    onWorldInfoUpdated,
    onWorldInfoSettingsUpdated,
  });
  const cleanup = () => {
    removeWorldInfoListeners();
    updateQueue.dispose();
    registerBookReloadHooks({ reconcileBook: null });
  };

  return {
    buildSavePayload,
    cleanup,
    fillEmptyTitlesWithKeywords,
    getUpdateWIChangeFinished: () => updateWIChangeFinished,
    getUpdateWIChangeStarted: () => updateWIChangeStarted,
    queueEditorDuplicateRefresh,
    updateWIChange,
    updateWIChangeDebounced,
    updateSettingsChange,
    waitForWorldInfoUpdate,
    waitForWorldInfoUpdateWithTimeout,
  };
};
