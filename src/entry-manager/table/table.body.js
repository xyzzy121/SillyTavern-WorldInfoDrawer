import { createWorkBudget } from '../../shared/utils.js';
import { setupEntryManagerSorting } from './table.body.row-sorting.js';
import { buildEntryManagerRow } from './table.body.cells.js';
import { createTableHydration } from './table.hydration.js';
import { createCharacterFilterIndex } from '../entry-manager.utils.js';
import { resetCharacterFilterCells } from './table.body.character-filter.js';
import { createSelectionCounter } from './table.selection.js';

// Even lightweight row placeholders share a bounded budget with initial filters.
const ROW_BUILD_BATCH_SIZE = 50;

// Exported for tests only — a failed save is invisible to callers (enqueueSave
// always resolves), so the failure path is covered directly. Everything inside
// the extension still reaches this through buildTableBody().
export function createBookSaveSerializer(saveWorldInfo, buildSavePayload) {
  const inFlightByBook = new Map();

  const pendingByBook = new Set();

  async function runSave(bookName) {
    do {
      pendingByBook.delete(bookName);
      try {
        await saveWorldInfo(bookName, buildSavePayload(bookName), true);
      } catch (err) {
        console.error('[WorldInfoDrawer] Entry Manager save failed for book:', bookName, err);
        toastr.error(`Failed to save "${bookName}" — the last edit may not have been kept.`);
      }
    } while (pendingByBook.has(bookName));
    inFlightByBook.delete(bookName);
  }

  return async function enqueueSave(bookName) {
    if (inFlightByBook.has(bookName)) {
      pendingByBook.add(bookName);
      await inFlightByBook.get(bookName);
    } else {
      const savePromise = runSave(bookName);
      inFlightByBook.set(bookName, savePromise);
      await savePromise;
    }
  };
}

function getEntryEditTemplates() {
  const entryEditTemplate = document.querySelector('#entry_edit_template');
  const enabledToggleTemplate = entryEditTemplate?.querySelector('[name="entryKillSwitch"]');
  const strategyTemplate = entryEditTemplate?.querySelector('[name="entryStateSelector"]');
  const positionTemplate = entryEditTemplate?.querySelector('[name="position"]');
  if (!enabledToggleTemplate || !strategyTemplate || !positionTemplate) {
    throw new Error(
      '[WorldInfoDrawer] Missing entry edit template controls for Entry Manager render.',
    );
  }
  return { enabledToggleTemplate, strategyTemplate, positionTemplate };
}

export async function buildTableBody({
  isRenderCurrent,
  createEntryManagerRowFilter,
  entries,
  entryManagerState,
  dom,
  cache,
  refreshOutletFilterIndicator,
  refreshAutomationIdFilterIndicator,
  refreshGroupFilterIndicator,
  isOutletPosition,
  saveWorldInfo,
  buildSavePayload,
  focusWorldEntry,
  isEntryManagerRowSelected,
  setEntryManagerRowSelected,
  updateEntryManagerSelectAllButton,
  refreshSelectionCount,
  applyEntryManagerStrategyFilterToRow,
  applyEntryManagerPositionFilterToRow,
  applyEntryManagerRecursionFilterToRow,
  applyEntryManagerOutletFilters,
  applyEntryManagerAutomationIdFilters,
  applyEntryManagerGroupFilters,
  syncEntryManagerOutletFilters,
  syncEntryManagerAutomationIdFilters,
  syncEntryManagerGroupFilters,
  entryState,
  getEntryManagerRows,
  setEntryManagerSort,
  SORT,
  SORT_DIRECTION,
  getSortableDelay,
  $,
}) {
  if (!isRenderCurrent()) return null;
  const tbody = document.createElement('tbody');
  dom.order.tbody = tbody;
  dom.order.selection = { tbody, counter: createSelectionCounter() };

  const enqueueSave = createBookSaveSerializer(saveWorldInfo, buildSavePayload);
  const { enabledToggleTemplate, strategyTemplate, positionTemplate } = getEntryEditTemplates();
  const characterFilterIndex = createCharacterFilterIndex();
  const optionLabels = (select) => {
    const labels = new Map();
    for (const option of select.options ?? []) {
      // Native select.value resolves the first option when values repeat.
      if (!labels.has(option.value)) labels.set(option.value, option.textContent);
    }
    return labels;
  };
  const strategyLabels = optionLabels(strategyTemplate);
  const positionLabels = optionLabels(positionTemplate);
  const { getVisibleEntryManagerRows, updateCustomOrderFromDom, disposeSorting } = setupEntryManagerSorting({
    tbody,
    dom,
    cache,
    enqueueSave,
    setEntryManagerSort,
    SORT,
    SORT_DIRECTION,
    getSortableDelay,
    $,
    getEntryManagerRows,
  });

  const applyRowFilters = createEntryManagerRowFilter();
  const checkpoint = createWorkBudget({ maxItems: ROW_BUILD_BATCH_SIZE });
  for (let i = 0; i < entries.length; i++) {
    if (!isRenderCurrent()) { disposeSorting?.(); return tbody; }
    const entryRow = entries[i];
    const row = buildEntryManagerRow({
      entryRow,
      entryManagerState,
      characterFilterIndex,
      strategyLabels,
      positionLabels,
      dom,
      cache,
      enqueueSave,
      focusWorldEntry,
      isEntryManagerRowSelected,
      setEntryManagerRowSelected,
      updateEntryManagerSelectAllButton,
      refreshSelectionCount,
      applyEntryManagerStrategyFilterToRow,
      applyEntryManagerPositionFilterToRow,
      applyEntryManagerRecursionFilterToRow,
      syncEntryManagerOutletFilters,
      syncEntryManagerAutomationIdFilters,
      syncEntryManagerGroupFilters,
      refreshOutletFilterIndicator,
      refreshAutomationIdFilterIndicator,
      refreshGroupFilterIndicator,
      applyEntryManagerOutletFilters,
      applyEntryManagerAutomationIdFilters,
      applyEntryManagerGroupFilters,
      isOutletPosition,
      entryState,
      enabledToggleTemplate,
      strategyTemplate,
      positionTemplate,
      getVisibleEntryManagerRows,
      updateCustomOrderFromDom,
    });
    applyRowFilters(row, entryRow.data);
    tbody.append(row);
    const pause = checkpoint();
    if (pause) await pause;
    // A newer render may have replaced dom.order.tbody during the yield;
    // abandon this stale build so we don't repopulate outdated state.
    if (!isRenderCurrent() || dom.order.tbody !== tbody) { disposeSorting?.(); return tbody; }
  }

  updateEntryManagerSelectAllButton();

  dom.order.hydration = createTableHydration({
    tbody,
    isRenderCurrent,
    onDispose: () => {
      disposeSorting?.();
      resetCharacterFilterCells();
      if (dom.order.tbody === tbody) {
        dom.order.entries = {};
        dom.order.tbody = undefined;
        dom.order.selection = undefined;
      }
    },
  });

  return tbody;
}
