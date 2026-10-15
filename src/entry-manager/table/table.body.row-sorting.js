import { setTooltip } from '../entry-manager.utils.js';
import { mirrorEntryFieldsToOriginalData } from '../../shared/original-data.js';

const STATE_FILTERED_CLASS = 'stwid--state-filtered';
const isRowFilteredOut = (row) => row.classList.contains(STATE_FILTERED_CLASS);

function buildMoveButton({ iconClass, tooltipText }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.classList.add('stwid--order-move-button');
  setTooltip(button, tooltipText);
  const icon = document.createElement('i');
  icon.classList.add('fa-solid', 'fa-fw', iconClass);
  button.append(icon);
  return button;
}

function moveRowAndSyncCustomOrder({
  row,
  direction,
  mode,
  dom,
  getVisibleEntryManagerRows,
  updateCustomOrderFromDom,
}) {
  const visibleRows = getVisibleEntryManagerRows();
  if (!visibleRows.includes(row)) return;

  let targetRow;
  if (mode === 'jump') {
    targetRow = direction === 'up' ? visibleRows[0] : visibleRows[visibleRows.length - 1];
    if (!targetRow || targetRow === row) return;
  } else {
    const index = visibleRows.indexOf(row);
    if (index === -1) return;
    targetRow = direction === 'up' ? visibleRows[index - 1] : visibleRows[index + 1];
    if (!targetRow) return;
  }

  // Let the sorting owner capture the unchanged rows and confirm before moving.
  // Dragging uses the same owner, with a snapshot taken at drag start instead.
  void updateCustomOrderFromDom(() => {
    if (direction === 'up') {
      row.parentElement.insertBefore(row, targetRow);
    } else {
      targetRow.insertAdjacentElement('afterend', row);
    }
  });
}

function moveRowByOneStepInFilteredList({
  row,
  direction,
  dom,
  getVisibleEntryManagerRows,
  updateCustomOrderFromDom,
}) {
  moveRowAndSyncCustomOrder({
    row,
    direction,
    mode: 'step',
    dom,
    getVisibleEntryManagerRows,
    updateCustomOrderFromDom,
  });
}

export function createMoveButton({
  row,
  direction,
  iconClass,
  title,
  jumpTitle,
  dom,
  getVisibleEntryManagerRows,
  updateCustomOrderFromDom,
}) {
  const button = buildMoveButton({
    iconClass,
    tooltipText: `${title}. Double-click to jump to ${jumpTitle}`,
  });
  let clickTimer;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (clickTimer) {
      window.clearTimeout(clickTimer);
    }
    clickTimer = window.setTimeout(() => {
      clickTimer = null;
      moveRowByOneStepInFilteredList({
        row,
        direction,
        dom,
        getVisibleEntryManagerRows,
        updateCustomOrderFromDom,
      });
    }, 250);
  });
  button.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (clickTimer) {
      window.clearTimeout(clickTimer);
      clickTimer = null;
    }
    moveRowAndSyncCustomOrder({
      row,
      direction,
      mode: 'jump',
      dom,
      getVisibleEntryManagerRows,
      updateCustomOrderFromDom,
    });
  });
  return button;
}

function describeReorderView(snapshot, SORT, SORT_DIRECTION) {
  const isStoredOrder = snapshot.sort === SORT.CUSTOM && snapshot.direction === SORT_DIRECTION.ASCENDING;
  const hiddenRowCount = snapshot.rows.filter(isRowFilteredOut).length;
  const clauses = [];
  if (!isStoredOrder) {
    clauses.push(`This view is not in ascending Custom order. Saving will replace the stored order of all ${snapshot.rows.length} entries with the table's current order, including the move.`);
  }
  if (hiddenRowCount > 0) {
    clauses.push(`${hiddenRowCount} ${hiddenRowCount === 1 ? 'entry is' : 'entries are'} hidden by filters. The saved order also includes those hidden entries, whose positions relative to the moved row are not visible.`);
  }
  return clauses.join(' ');
}

async function confirmReorder(message) {
  const { Popup, POPUP_RESULT } = globalThis.SillyTavern?.getContext?.() ?? {};
  if (typeof Popup?.show?.confirm !== 'function' || !POPUP_RESULT) {
    console.warn('[WorldInfoDrawer] Popup is unavailable; aborting the row reorder.');
    globalThis.toastr?.error('Could not show the confirmation dialog. The row order was not changed.');
    return false;
  }
  return (await Popup.show.confirm('Save this row order?', message, {
    okButton: 'Save order',
    cancelButton: 'Cancel',
  })) === POPUP_RESULT.AFFIRMATIVE;
}

export function setupEntryManagerSorting({
  tbody,
  dom,
  cache,
  entryManagerState,
  isRenderCurrent = () => true,
  enqueueSave,
  setEntryManagerSort,
  SORT,
  SORT_DIRECTION,
  getSortableDelay,
  $,
}) {
  let disposed = false;
  let activeOperation = null;
  let dragSnapshot = null;
  const isCurrent = () => !disposed && dom.order.tbody === tbody && isRenderCurrent();
  // The sortable placeholder is a tr too. Only real logical rows belong to an
  // order snapshot; deferred cells and offscreen rows are deliberately included.
  const getRows = () => [...tbody.querySelectorAll('tr')]
    .filter((row) => row.hasAttribute('data-book') && row.hasAttribute('data-uid'));
  const getVisibleEntryManagerRows = () => {
    return isCurrent() ? getRows().filter((row) => !isRowFilteredOut(row)) : [];
  };

  const captureOrder = () => {
    const rows = getRows();
    return {
      rows,
      expectedRows: rows,
      sort: entryManagerState?.sort,
      direction: entryManagerState?.direction,
      entries: rows.map((row) => ({
        book: row.getAttribute('data-book'),
        uid: row.getAttribute('data-uid'),
        filtered: isRowFilteredOut(row),
        entry: cache[row.getAttribute('data-book')]?.entries?.[row.getAttribute('data-uid')],
      })),
    };
  };
  const ownsOrder = (snapshot) => {
    if (!isCurrent() || entryManagerState?.sort !== snapshot.sort || entryManagerState?.direction !== snapshot.direction) return false;
    const rows = getRows();
    return rows.length === snapshot.rows.length
      && snapshot.rows.every((row) => row.parentElement === tbody)
      && rows.every((row, index) => row === snapshot.expectedRows[index]);
  };
  const isSnapshotCurrent = (snapshot) => ownsOrder(snapshot) && snapshot.rows.every((row, index) => {
    const previous = snapshot.entries[index];
    return row.getAttribute('data-book') === previous.book
      && row.getAttribute('data-uid') === previous.uid
      && isRowFilteredOut(row) === previous.filtered
      && cache[previous.book]?.entries?.[previous.uid] === previous.entry;
  });
  const restoreOrder = (snapshot) => {
    // Never append old nodes into a new render or overwrite a newer sort. A
    // filter change can safely roll a drag back while invalidating its save.
    if (ownsOrder(snapshot)) tbody.append(...snapshot.rows);
  };

  const saveCustomOrder = async () => {
    setEntryManagerSort(SORT.CUSTOM, SORT_DIRECTION.ASCENDING);
    const rows = getRows();
    const booksUpdated = new Set();
    const nextIndexByBook = new Map();
    for (const row of rows) {
      const bookName = row.getAttribute('data-book');
      const uid = row.getAttribute('data-uid');
      if (!bookName || !uid) continue;
      if (!cache[bookName]?.entries) continue;
      const entry = cache[bookName].entries[uid];
      if (!entry) continue;
      const nextIndex = nextIndexByBook.get(bookName) ?? 0;
      entry.extensions ??= {};
      if (entry.extensions.display_index !== nextIndex) {
        entry.extensions.display_index = nextIndex;
        mirrorEntryFieldsToOriginalData(cache[bookName], entry, ['displayIndex']);
        booksUpdated.add(bookName);
      }
      nextIndexByBook.set(bookName, nextIndex + 1);
    }
    for (const bookName of booksUpdated) {
      await enqueueSave(bookName);
    }
  };

  const finishReorder = async (snapshot, moveRows) => {
    let writesStarted = false;
    try {
      const message = describeReorderView(snapshot, SORT, SORT_DIRECTION);
      if (message && !(await confirmReorder(message))) {
        restoreOrder(snapshot);
        return;
      }
      if (!isSnapshotCurrent(snapshot)) {
        restoreOrder(snapshot);
        return;
      }
      moveRows?.();
      writesStarted = true;
      await saveCustomOrder();
    } catch (error) {
      if (!writesStarted) restoreOrder(snapshot);
      console.error('[WorldInfoDrawer] Could not reorder entries:', error);
      globalThis.toastr?.error('Could not reorder entries. Please refresh the Entry Manager and try again.');
    } finally {
      if (activeOperation === snapshot) activeOperation = null;
    }
  };

  const updateCustomOrderFromDom = async (moveRows) => {
    if (!isCurrent() || activeOperation) return;
    const snapshot = captureOrder();
    activeOperation = snapshot;
    await finishReorder(snapshot, moveRows);
  };

  const sortable = $(tbody);
  sortable.sortable({
    delay: getSortableDelay(),
    handle: '.stwid--sortable-handle',
    start: () => {
      if (!isCurrent() || activeOperation) return false;
      dragSnapshot = captureOrder();
      activeOperation = dragSnapshot;
    },
    update: async () => {
      const snapshot = dragSnapshot;
      dragSnapshot = null;
      if (!snapshot || !isCurrent()) return;
      snapshot.expectedRows = getRows();
      await finishReorder(snapshot);
    },
    stop: () => {
      // A drag that returns to its original position emits no update.
      if (dragSnapshot && activeOperation === dragSnapshot) activeOperation = null;
      dragSnapshot = null;
    },
  });

  const disposeSorting = () => {
    if (disposed) return;
    disposed = true;
    activeOperation = null;
    dragSnapshot = null;
    if (sortable.sortable('instance')) sortable.sortable('destroy');
  };
  return { getVisibleEntryManagerRows, updateCustomOrderFromDom, disposeSorting };
}
