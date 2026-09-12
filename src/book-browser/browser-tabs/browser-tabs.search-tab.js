import { createWorkBudget } from '../../shared/utils.js';

const FILTER_QUERY_CLASS = 'stwid--filter-query';
const INPUT_EVENT = 'input';

const setQueryFiltered = (targetElement, isFiltered) => {
  if (!targetElement) return;
  if (isFiltered) {
    if (!targetElement.classList.contains(FILTER_QUERY_CLASS)) {
      targetElement.classList.add(FILTER_QUERY_CLASS);
    }
    return;
  }
  if (targetElement.classList.contains(FILTER_QUERY_CLASS)) {
    targetElement.classList.remove(FILTER_QUERY_CLASS);
  }
};

const buildEntrySearchSignature = (entry) => {
  const comment = entry?.comment ?? '';
  const entryKeysCsv = Array.isArray(entry?.key) ? entry.key.join(', ') : '';
  return `${String(comment)}\n${String(entryKeysCsv)}`;
};

const getEntrySearchText = (listPanelState, bookName, entry) => {
  if (entry?.uid === null || entry?.uid === undefined) return '';
  const signature = buildEntrySearchSignature(entry);
  const cachedEntrySearch = listPanelState.getEntrySearchCacheValue(bookName, entry.uid);
  if (cachedEntrySearch?.signature === signature) return cachedEntrySearch.text;
  const text = signature.toLowerCase();
  listPanelState.setEntrySearchCacheValue(bookName, entry.uid, { signature, text });
  return text;
};

const applyBookBrowserSearchFilter = async ({
  runtime,
  listPanelState,
  query,
  shouldScanEntries,
  filteredRowRoots,
  isCurrent,
  updateFolderActiveToggles,
}) => {
  const checkpoint = createWorkBudget({ maxItems: 200, budgetMs: 8 });
  const books = Object.entries(runtime.cache);
  const activeBooks = new Set(books.map(([, book]) => book));
  for (const book of filteredRowRoots.keys()) {
    if (!activeBooks.has(book)) filteredRowRoots.delete(book);
  }
  listPanelState.pruneEntrySearchCacheStaleBooks(books.map(([name]) => name));

  for (const [bookName, book] of books) {
    const entries = book.entries;
    const dom = book.dom;
    const entryDoms = dom?.entry;
    const root = dom?.root;
    const isBookCurrent = () => isCurrent()
      && runtime.cache[bookName] === book
      && book.entries === entries
      && book.dom === dom
      && dom?.entry === entryDoms
      && dom?.root === root;
    if (!isBookCurrent()) return false;
    const bookMatch = !query.length || bookName.toLowerCase().includes(query);
    let filteredRoots = filteredRowRoots.get(book);

    if (shouldScanEntries && !bookMatch) {
      if (!filteredRoots) {
        filteredRoots = new Set();
        filteredRowRoots.set(book, filteredRoots);
      }
      const activeEntryUids = new Set();
      const currentFilteredRoots = new Set();
      const entrySnapshot = Object.values(entries ?? {});
      const entryMatches = new Array(entrySnapshot.length);
      let anyEntryMatch = false;
      for (let index = 0; index < entrySnapshot.length; index += 1) {
        const entry = entrySnapshot[index];
        const entryMatch = getEntrySearchText(listPanelState, bookName, entry).includes(query);
        entryMatches[index] = entryMatch;
        if (entry?.uid !== null && entry?.uid !== undefined) activeEntryUids.add(String(entry.uid));
        if (entryMatch) anyEntryMatch = true;
        const pending = checkpoint();
        if (pending) {
          await pending;
          if (!isBookCurrent()) return false;
        }
      }
      if (!isBookCurrent()) return false;
      // Hide confirmed misses before updating their rows, avoiding repeated
      // intermediate rendering at task boundaries. Matching books stay visible
      // so evaluating a query cannot temporarily collapse their scroll space.
      if (!anyEntryMatch) setQueryFiltered(root, true);
      for (let index = 0; index < entrySnapshot.length; index += 1) {
        const entry = entrySnapshot[index];
        const entryMatch = entryMatches[index];
        const entryRoot = entryDoms?.[entry?.uid]?.root;
        setQueryFiltered(entryRoot, !entryMatch);
        if (entryRoot) {
          if (entryMatch) filteredRoots.delete(entryRoot);
          else {
            filteredRoots.add(entryRoot);
            currentFilteredRoots.add(entryRoot);
          }
        }
        const pending = checkpoint();
        if (pending) {
          await pending;
          if (!isBookCurrent()) return false;
        }
      }
      // Drop roots removed or replaced since the previous search. Keep the old
      // set until completion so a cancelled scan can still restore every row.
      if (currentFilteredRoots.size) filteredRowRoots.set(book, currentFilteredRoots);
      else filteredRowRoots.delete(book);
      listPanelState.pruneEntrySearchCacheStaleEntries(bookName, activeEntryUids);
      setQueryFiltered(root, !anyEntryMatch);
    } else {
      // Name-only searches never need to inspect all entry data. Restore only
      // roots hidden by an earlier entry query, including partially applied runs.
      if (filteredRoots) {
        for (const entryRoot of filteredRoots) {
          setQueryFiltered(entryRoot, false);
          filteredRoots.delete(entryRoot);
          const pending = checkpoint();
          if (pending) {
            await pending;
            if (!isBookCurrent()) return false;
          }
        }
        filteredRowRoots.delete(book);
      }
      setQueryFiltered(root, !bookMatch);
    }
    const pending = checkpoint();
    if (pending) {
      await pending;
      if (!isBookCurrent()) return false;
    }
  }
  if (!isCurrent()) return false;
  updateFolderActiveToggles();
  return true;
};

const buildSearchRow = (searchRow, listPanelState, runtime, updateFolderActiveToggles) => {
  const search = document.createElement('input');
  search.classList.add('stwid--search');
  search.classList.add('text_pole');
  search.type = 'search';
  search.placeholder = 'Search books';
  search.title = 'Search books by name';
  search.setAttribute('aria-label', 'Search books');
  listPanelState.searchInput = search;

  let generation = 0;
  let timer = null;
  let disposed = false;
  const filteredRowRoots = new Map();
  const invalidateSearchFilter = () => {
    generation += 1;
    clearTimeout(timer);
    timer = null;
  };
  const applySearchFilter = (runGeneration) => {
    if (disposed || runGeneration !== generation) return Promise.resolve(false);
    const query = search.value.toLowerCase();
    const searchEntries = searchEntriesCheckbox.checked;
    const shouldScanEntries = searchEntries && query.length >= 2;
    return applyBookBrowserSearchFilter({
      runtime,
      listPanelState,
      query,
      shouldScanEntries,
      filteredRowRoots,
      isCurrent: () => !disposed && runGeneration === generation,
      updateFolderActiveToggles,
    });
  };

  const refreshSearchFilter = () => {
    invalidateSearchFilter();
    return applySearchFilter(generation);
  };
  const queueSearchFilter = () => {
    // Cancel a yielding search now, rather than letting it paint an old query
    // during the debounce interval for the next input.
    invalidateSearchFilter();
    if (disposed) return;
    const runGeneration = generation;
    timer = setTimeout(() => {
      timer = null;
      applySearchFilter(runGeneration).catch((error) => {
        console.warn('[STWID] Failed to apply book search', error);
      });
    }, 125);
  };

  search.addEventListener(INPUT_EVENT, queueSearchFilter);
  searchRow.append(search);

  const searchEntriesLabel = document.createElement('label');
  searchEntriesLabel.classList.add('stwid--search-entries');
  searchEntriesLabel.title = 'Search through entries as well (Title/Memo/Keys)';
  const searchEntriesCheckbox = document.createElement('input');
  listPanelState.searchEntriesInput = searchEntriesCheckbox;
  searchEntriesCheckbox.type = 'checkbox';
  searchEntriesCheckbox.addEventListener('click', queueSearchFilter);
  searchEntriesLabel.append(searchEntriesCheckbox);
  searchEntriesLabel.append('Entries');
  searchRow.append(searchEntriesLabel);

  const cleanup = () => {
    disposed = true;
    invalidateSearchFilter();
    filteredRowRoots.clear();
    search.removeEventListener(INPUT_EVENT, queueSearchFilter);
    searchEntriesCheckbox.removeEventListener('click', queueSearchFilter);
  };

  return { search, searchEntriesCheckbox, refreshSearchFilter, invalidateSearchFilter, cleanup };
};

export const createSearchRow = (listPanelState, runtime, updateFolderActiveToggles) => {
  const searchRow = document.createElement('div');
  searchRow.classList.add('stwid--browser-row');
  const searchControls = buildSearchRow(
    searchRow,
    listPanelState,
    runtime,
    updateFolderActiveToggles,
  );
  return { searchRow, ...searchControls };
};

export const mountSearchTabContent = ({ tabContentsById, searchRow }) => {
  const searchTabContent = tabContentsById.get('search');
  if (!searchTabContent) return;
  searchTabContent.append(searchRow);
};
