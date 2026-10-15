import { cloneMetadata } from '../../shared/sort-helpers.js';
import { createWorkBudget } from '../../shared/utils.js';
import { createBookLoader } from './book-list.loading.js';

// The shared time budget can yield earlier than this row-count cap.
const ENTRY_RENDER_BATCH_SIZE = 50;
const BOOK_COLLAPSE_TOOLTIP = 'Collapse/expand this book';
const UNSAVED_ENTRY_RETRY_MESSAGE =
  'Entry was not saved. Keep this editor open and save again when ready.';

const createBooksViewSlice = ({
  listPanelState,
  runtime,
  coreUiSelectors,
  foldersViewSlice,
  selectionDnDSlice,
  bookMenuSlice,
  getFolderFromMetadata,
  getFolderRegistry,
  registerFolderName,
  getBookSortChoice,
  setBookCollapsed,
  setCacheMetadata,
  updateBookSourceLinks,
  updateCollapseAllToggle,
  persistFolderCollapseStates,
}) => {
  const bookLoader = createBookLoader((name) => runtime.loadWorldInfo(name));
  const pendingReplacementRoots = new WeakMap();
  let renderGeneration = 0;
  let disposed = false;
  const isPinned = (name) =>
    runtime.navigationBooks?.has(name) ||
    runtime.getCurrentEditor?.()?.name === name ||
    runtime.dom.books.stwidDragEntryBook === name ||
    (listPanelState.selectFrom === name && listPanelState.selectList?.length > 0) ||
    listPanelState.dragBookName === name;
  const needsRows = (name, world) => {
    if (isPinned(name)) return true;
    const root = world.dom?.root;
    if (!root || world.dom.entryList.classList.contains('stwid--state-collapsed')) return false;
    if (root.classList.contains('stwid--filter-query') || root.classList.contains('stwid--filter-visibility')) return false;
    const folder = isFolderGroupingEnabled()
      ? listPanelState.getFolderDom?.(getFolderFromMetadata(world.metadata)) : null;
    return !folder || (!folder.root.hidden && !folder.books.classList.contains('stwid--state-collapsed'));
  };
  const releaseRows = (name, world) => {
    const rows = world.rowRender;
    if (!rows || rows.status === 'unmounted') return;
    rows.generation += 1;
    rows.status = 'unmounted';
    rows.promise = null;
    world.dom.entryList.innerHTML = '';
    world.dom.entry = {};
    world.dom.entryList.removeAttribute?.('aria-busy');
    runtime.releaseSearchRows?.(world);
  };
  const ensureBookRows = (name, { force = false } = {}) => {
    const world = runtime.cache[name];
    if (!world || disposed) return Promise.resolve(false);
    const rows = world.rowRender;
    if (!force && !needsRows(name, world)) {
      releaseRows(name, world);
      return Promise.resolve(false);
    }
    if (rows.status === 'mounted') return Promise.resolve(true);
    if (rows.promise) return rows.promise;
    const generation = ++rows.generation;
    const listGeneration = renderGeneration;
    const entries = world.entries;
    const revision = rows.revision;
    const isCurrent = () => !disposed && listGeneration === renderGeneration &&
      runtime.cache[name] === world && world.entries === entries && rows.revision === revision && rows.generation === generation &&
      (force || needsRows(name, world));
    rows.status = 'rendering';
    world.dom.entryList.setAttribute('aria-busy', 'true');
    const loading = document.createElement('div');
    loading.classList.add('stwid--entry-loading');
    loading.textContent = 'Loading entries…';
    loading.setAttribute('role', 'status');
    world.dom.entryList.append(loading);
    const task = async () => {
      const staging = { ...world, dom: { ...world.dom, entry: {}, entryList: document.createElement('div') } };
      const { sort, direction } = getBookSortChoice(name);
      const sorted = runtime.sortEntries(Object.values(entries), sort, direction);
      const checkpoint = createWorkBudget({ maxItems: ENTRY_RENDER_BATCH_SIZE });
      for (const entry of sorted) {
        if (!isCurrent()) return false;
        await runtime.renderEntry(entry, name, null, { world: staging });
        const pause = checkpoint();
        if (pause) await pause;
      }
      if (!isCurrent()) return false;
      const query = (listPanelState.searchInput?.value ?? '').toLowerCase();
      const filterEntries = Boolean(listPanelState.searchEntriesInput?.checked) &&
        query.length >= 2 && !name.toLowerCase().includes(query);
      for (const entry of sorted) {
        const match = !filterEntries || `${entry.comment ?? ''}\n${(entry.key ?? []).join(', ')}`.toLowerCase().includes(query);
        staging.dom.entry[entry.uid]?.root?.classList.toggle('stwid--filter-query', !match);
      }
      world.dom.entryList.innerHTML = '';
      world.dom.entryList.append(...Array.from(staging.dom.entryList.children));
      world.dom.entry = staging.dom.entry;
      staging.dom.entryList = world.dom.entryList;
      runtime.registerSearchRows?.(world);
      rows.status = 'mounted';
      return true;
    };
    rows.promise = task().finally(() => {
      if (rows.generation !== generation) return;
      rows.promise = null;
      loading.remove();
      world.dom.entryList.removeAttribute?.('aria-busy');
      if (rows.status === 'rendering') rows.status = 'unmounted';
    });
    return rows.promise;
  };
  const updateEntryDemand = async () => {
    // Sequential work budgets prevent expanding many books from spawning many
    // simultaneous row builders and starving input on mobile.
    for (const [name, world] of Object.entries(runtime.cache)) {
      if (disposed) return;
      if (!needsRows(name, world)) releaseRows(name, world);
    }
    for (const [name, world] of Object.entries(runtime.cache)) {
      if (disposed) return;
      if (needsRows(name, world)) await ensureBookRows(name);
    }
  };
  const isFolderGroupingEnabled = () => Boolean(runtime?.Settings?.instance?.featureFolderGrouping);
  const compareCaseInsensitiveNames = (leftName, rightName) =>
    leftName.toLowerCase().localeCompare(rightName.toLowerCase());
  const toggleBookCollapsedState = (bookName, entryList) => {
    const isCollapsed = !entryList.classList.contains('stwid--state-collapsed');
    setBookCollapsed(bookName, isCollapsed);
  };

  const createCachedBookState = (bookName, bookData, parentElement) => {
    const data = bookData ?? null;
    if (!data || typeof data !== 'object') {
      console.warn(`[STWID] renderBook: skipping "${bookName}" — invalid or missing book payload.`);
      return null;
    }

    const { entries: rawEntries, metadata: rawMetadata, ...rawExtras } = data;
    const world = {
      entries: {},
      metadata: cloneMetadata(rawMetadata),
      sort: runtime.getSortFromMetadata(rawMetadata),
      extras: structuredClone(rawExtras),
      rowRender: { status: 'unmounted', generation: 0, revision: 0, promise: null },
    };
    for (const [entryId, entryData] of Object.entries(rawEntries ?? {})) {
      world.entries[entryId] = structuredClone(entryData);
    }
    world.dom = {
      root: undefined,
      name: undefined,
      sourceLinks: undefined,
      active: undefined,
      entryList: undefined,
      entry: {},
    };
    // Assigning over the cache entry orphans whatever row the previous render
    // of this book left on screen: `runtime.cache` is the only handle anything
    // has on that node, so nothing would ever remove it and the book would show
    // twice. Two render paths reach this line — `loadList` and the
    // WORLDINFO_UPDATED handler's `renderMissingBooks` — and a full refresh
    // empties the cache while the rows stay attached, so they genuinely do
    // overlap (verified in the browser 14-08-2026: one drag-into-folder
    // rendered 19 books as 26 rows).
    //
    // Hand the node back rather than removing it here: renderBook can still
    // abort part-way (see its cache-identity guard) and must not leave the book
    // with no row at all. The caller drops it at insert time instead, so the
    // old row only ever goes away once a new one is ready to take its place.
    const previousWorld = runtime.cache[bookName];
    const previousRoot =
      pendingReplacementRoots.get(previousWorld) ?? previousWorld?.dom?.root ?? null;
    if (previousRoot) pendingReplacementRoots.set(world, previousRoot);
    runtime.cache[bookName] = world;
    setCacheMetadata(bookName, data.metadata);

    let targetParent = parentElement ?? runtime.dom.books;
    if (!parentElement) {
      const folderName = getFolderFromMetadata(runtime.cache[bookName].metadata);
      if (isFolderGroupingEnabled() && folderName) {
        const folderDom = foldersViewSlice.ensureFolderDom(folderName);
        targetParent = folderDom?.books ?? targetParent;
      }
    }

    return { previousRoot, world, targetParent };
  };

  const resolveFailedEntrySave = async (editorOpened, bookName, rollbackOptimisticEntry) => {
    const hasUnsavedEditorChanges = Boolean(runtime.isDirtyCheck?.());
    const canConfirm = Boolean(runtime.Popup?.show?.confirm);
    if (!(editorOpened && hasUnsavedEditorChanges)) {
      rollbackOptimisticEntry();
      toastr.error('Failed to create new entry. Please try again.');
      return;
    }

    if (!canConfirm) {
      toastr.error(UNSAVED_ENTRY_RETRY_MESSAGE);
      return;
    }

    const retryNow = await runtime.Popup.show.confirm(
      'Failed to save this new entry. Retry now? Press Cancel to keep your edits open.',
    );
    if (retryNow) {
      try {
        const retryPayload = runtime.buildSavePayload(bookName);
        await runtime.saveWorldInfo(bookName, retryPayload, true);
        toastr.success('New entry saved after retry.');
        return;
      } catch (retryErr) {
        console.error('[STWID] add-entry: retry save failed; keeping editor open.', retryErr);
      }
    }

    const discardUnsaved = await runtime.Popup.show.confirm(
      'Save still failed. Discard this unsaved entry and close the editor?',
    );
    if (!discardUnsaved) {
      toastr.error(UNSAVED_ENTRY_RETRY_MESSAGE);
      return;
    }

    rollbackOptimisticEntry();
    toastr.error('Failed to create new entry. Please try again.');
  };

  const buildBookHeader = (bookName, worldState, entryList) => {
    const head = document.createElement('div');
    head.classList.add('stwid--head');

    let collapseToggle;
    const title = document.createElement('div');
    worldState.dom.name = title;
    title.classList.add('stwid--title');
    title.textContent = bookName;
    title.title = BOOK_COLLAPSE_TOOLTIP;
    title.setAttribute('draggable', 'true');
    title.addEventListener('dragstart', (evt) => {
      listPanelState.dragBookName = bookName;
      if (evt.dataTransfer) {
        evt.dataTransfer.effectAllowed = 'copyMove';
        evt.dataTransfer.setData('text/plain', bookName);
      }
    });
    title.addEventListener('dragend', () => {
      listPanelState.dragBookName = null;
      for (const folderDom of listPanelState.getFolderDomValues()) {
        folderDom.root.classList.remove('stwid--state-target');
      }
      for (const bookDom of Object.values(runtime.cache)) {
        bookDom.dom.root.classList.remove('stwid--state-target');
      }
      void runtime.updateEntryDemand?.();
    });
    title.addEventListener('click', () => {
      toggleBookCollapsedState(bookName, entryList);
    });
    head.append(title);

    const actions = document.createElement('div');
    actions.classList.add('stwid--actions');

    const sourceLinks = document.createElement('div');
    worldState.dom.sourceLinks = sourceLinks;
    sourceLinks.classList.add('stwid--source-links', 'stwid--state-empty');
    actions.append(sourceLinks);

    const active = document.createElement('input');
    worldState.dom.active = active;
    active.title = 'Toggle global active status for this book';
    active.setAttribute('aria-label', 'Toggle global active status for this book');
    active.type = 'checkbox';
    const selected = runtime.getSelectedWorldInfo
      ? runtime.getSelectedWorldInfo()
      : runtime.selected_world_info;
    active.checked = selected.includes(bookName);
    active.addEventListener('click', async () => {
      active.disabled = true;
      try {
        const select = document.querySelector(coreUiSelectors.worldInfoSelect);
        const option = select
          ? [...select.options].find((opt) => opt.textContent === bookName)
          : null;
        if (option && select) {
          option.selected = active.checked;
          runtime.onWorldInfoChange('__notSlashCommand__');
        }
      } finally {
        active.disabled = false;
      }
    });
    actions.append(active);

    const add = document.createElement('div');
    add.classList.add('stwid--action');
    add.classList.add('stwid--add');
    add.classList.add('fa-solid', 'fa-fw', 'fa-plus');
    add.title = 'Create new entry in this book';
    add.setAttribute('aria-label', 'Create new entry in this book');
    add.addEventListener('click', async () => {
      const saveData = runtime.buildSavePayload(bookName);
      const newEntry = runtime.createWorldInfoEntry(bookName, saveData);
      let entryRendered = false;
      let editorOpened = false;
      const rollbackOptimisticEntry = () => {
        delete runtime.cache[bookName]?.entries?.[newEntry.uid];
        if (entryRendered) {
          const entryDom = runtime.cache[bookName]?.dom?.entry?.[newEntry.uid];
          if (entryDom?.root?.parentElement) {
            entryDom.root.remove();
          }
          if (runtime.cache[bookName]?.dom?.entry) {
            delete runtime.cache[bookName].dom.entry[newEntry.uid];
          }
        }
        if (editorOpened) {
          runtime.resetEditor?.();
        }
      };
      try {
        runtime.cache[bookName].entries[newEntry.uid] = structuredClone(newEntry);
        runtime.cache[bookName].rowRender.revision += 1;
        if (runtime.cache[bookName].rowRender.status === 'rendering') {
          releaseRows(bookName, runtime.cache[bookName]);
        }
        if (runtime.cache[bookName].rowRender.status === 'mounted') {
          await runtime.renderEntry(newEntry, bookName);
        }
        await runtime.openEntry?.(bookName, newEntry.uid);
        entryRendered = true;
        editorOpened = true;
        await runtime.saveWorldInfo(bookName, saveData, true);
      } catch (err) {
        console.error('[STWID] add-entry: save failed, rolling back optimistic state.', err);
        await resolveFailedEntrySave(editorOpened, bookName, rollbackOptimisticEntry);
      }
    });
    actions.append(add);

    const menuTrigger = bookMenuSlice()?.buildBookMenuTrigger(bookName);
    if (menuTrigger) {
      actions.append(menuTrigger);
    }

    collapseToggle = document.createElement('div');
    runtime.cache[bookName].dom.collapseToggle = collapseToggle;
    collapseToggle.classList.add('stwid--action');
    collapseToggle.classList.add('stwid--collapseToggle');
    collapseToggle.classList.add('fa-solid', 'fa-fw', 'fa-chevron-down');
    collapseToggle.title = BOOK_COLLAPSE_TOOLTIP;
    collapseToggle.setAttribute('aria-label', 'Collapse or expand this book');
    collapseToggle.addEventListener('click', () => {
      toggleBookCollapsedState(bookName, entryList);
    });
    actions.append(collapseToggle);

    updateBookSourceLinks(bookName);
    head.append(actions);

    return head;
  };

  const insertBookInAlphabeticalOrder = (bookName, bookElement, targetParent, beforeElement) => {
    if (beforeElement && beforeElement.parentElement === targetParent) {
      beforeElement.insertAdjacentElement('beforebegin', bookElement);
      return;
    }
    targetParent.append(bookElement);
  };

  const groupBooksByFolder = (books) => {
    const folderGroups = new Map();
    const rootBooks = [];
    for (const book of books) {
      const folderName = getFolderFromMetadata(book.data?.metadata);
      if (isFolderGroupingEnabled() && folderName) {
        if (!folderGroups.has(folderName)) {
          registerFolderName(folderName);
          folderGroups.set(folderName, []);
        }
        folderGroups.get(folderName).push(book);
        continue;
      }
      rootBooks.push(book);
    }

    const folderRegistry = getFolderRegistry();
    const allFolderNames = new Set(folderRegistry);
    for (const folderName of folderGroups.keys()) {
      allFolderNames.add(folderName);
    }

    return {
      folderGroups,
      rootBooks,
      sortedFolders: [...allFolderNames].sort(compareCaseInsensitiveNames),
    };
  };

  const renderBookBatch = async (booksToRender, getParentElement, isCurrent, checkpoint) => {
    for (let i = 0; i < booksToRender.length; i++) {
      if (!isCurrent()) return;
      const book = booksToRender[i];
      await renderBook(book.name, null, book.data, getParentElement(), {
        isCurrent,
        updateToggle: false,
      });
      const pause = checkpoint();
      if (pause) await pause;
    }
  };

  const renderGroupedBooks = async (sortedFolders, folderGroups, rootBooks, isCurrent) => {
    const checkpoint = createWorkBudget();
    for (const folderName of sortedFolders) {
      if (!isCurrent()) return;
      const folderDom = foldersViewSlice.ensureFolderDom(folderName, runtime.dom.books, {
        updateToggle: false,
      });
      const folderBooks = folderGroups.get(folderName) ?? [];
      await renderBookBatch(folderBooks, () => folderDom.books, isCurrent, checkpoint);
      const pause = checkpoint();
      if (pause) await pause;
    }
    await renderBookBatch(rootBooks, () => runtime.dom.books, isCurrent, checkpoint);
  };

  const renderBook = async (name, before = null, bookData = null, parent = null, options = {}) => {
    const generation = renderGeneration;
    const isCurrent = () =>
      !disposed && generation === renderGeneration && (options.isCurrent?.() ?? true);
    if (!isCurrent()) return null;
    const data = bookData ?? (await bookLoader.load(name));
    if (!isCurrent()) return null;
    const cachedBookState = createCachedBookState(name, data, parent);
    if (!cachedBookState) {
      return null;
    }
    const { previousRoot, world, targetParent } = cachedBookState;
    const book = document.createElement('div');
    world.dom.root = book;
    book.classList.add('stwid--book');
    book.addEventListener('dragover', (evt) =>
      selectionDnDSlice()?.onBookDropTargetDragOver(evt, book),
    );
    book.addEventListener('dragleave', (evt) =>
      selectionDnDSlice()?.onBookDropTargetDragLeave(evt, book),
    );
    book.addEventListener('drop', async (evt) =>
      selectionDnDSlice()?.onBookDropTargetDrop(evt, name, book, () =>
        getFolderFromMetadata(runtime.cache[name]?.metadata),
      ),
    );

    const entryList = document.createElement('div');
    world.dom.entryList = entryList;
    entryList.classList.add('stwid--entry-list');
    entryList.classList.add('stwid--state-collapsed');

    const head = buildBookHeader(name, world, entryList);
    book.append(head);

    const initialCollapsed =
      listPanelState.getCollapseState(name) ??
      entryList.classList.contains('stwid--state-collapsed');
    book.append(entryList);

    // Swap, don't append: this render superseded whatever row the last one left
    // behind, and that row is unreachable from the cache now. Removing it only
    // here means every early return above leaves the old row on screen rather
    // than leaving the book with none.
    previousRoot?.remove();
    insertBookInAlphabeticalOrder(name, book, targetParent, before);
    pendingReplacementRoots.delete(world);
    // Applying after attachment also restores expanded state: the shared
    // setter deliberately ignores detached DOM left by superseded renders.
    setBookCollapsed(name, initialCollapsed, { updateToggle: options.updateToggle !== false });

    return book;
  };

  const loadList = async (options = {}) => {
    const generation = ++renderGeneration;
    const isCurrent = () =>
      !disposed && generation === renderGeneration && (options.isCurrent?.() ?? true);
    if (!isCurrent()) return false;
    runtime.dom.books.stwidDragEntryBook = null;
    listPanelState.dragBookName = null;
    runtime.dom.books.classList.remove('stwid--state-dragging');
    runtime.dom.books.innerHTML = '';
    foldersViewSlice.resetFolderDoms();

    const worldNames = runtime.getWorldNames ? runtime.getWorldNames() : runtime.world_names;
    const sortedNames = runtime.safeToSorted(worldNames ?? [], compareCaseInsensitiveNames);
    const books = await bookLoader.loadMany(sortedNames, isCurrent);
    if (!books || !isCurrent()) return false;
    const { folderGroups, rootBooks, sortedFolders } = groupBooksByFolder(books);

    // Prune collapse state for books/folders that no longer exist so these maps
    // don't grow unbounded across a long session. `sortedNames` and
    // `sortedFolders` are the authoritative live-name sets for this load. An
    // empty book library is valid and must still drop stale book state.
    listPanelState.pruneCollapseStatesStaleBooks(sortedNames);
    const removedFolderCollapseKeys =
      listPanelState.pruneFolderCollapseStatesStaleFolders(sortedFolders);
    if (removedFolderCollapseKeys > 0) {
      persistFolderCollapseStates();
    }

    await renderGroupedBooks(sortedFolders, folderGroups, rootBooks, isCurrent);
    if (!isCurrent()) return false;
    runtime.applyActiveFilter?.();
    updateCollapseAllToggle();
    foldersViewSlice.updateCollapseAllFoldersToggle();
    return true;
  };

  return {
    loadList,
    renderBook,
    ensureBookRows,
    updateEntryDemand,
    releaseRows,
    invalidate: () => { renderGeneration += 1; },
    cleanup: () => {
      disposed = true;
      renderGeneration += 1;
      bookLoader.dispose();
    },
  };
};

export { createBooksViewSlice };
