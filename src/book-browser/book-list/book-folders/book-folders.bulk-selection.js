import { getFolderFromMetadata } from './book-folders.lorebook-folders.js';

const sameFolder = (left, right) =>
  typeof left === 'string' && left.toLowerCase() === right.toLowerCase();

// Names are identities, never normalized or used as selectors/HTML.
export function createFolderBookSelection({ folderName, getWorldNames, cache }) {
  const selected = new Set();
  const names = [...new Set(getWorldNames())].sort((a, b) => a.localeCompare(b));
  const getEntry = (name) => {
    const available = Object.hasOwn(cache, name);
    const folder = available ? getFolderFromMetadata(cache[name]?.metadata) : null;
    return { name, folder, available, inDestination: sameFolder(folder, folderName) };
  };
  const entries = (query = '') => {
    const search = query.toLowerCase();
    return names.map(getEntry).filter(({ name, folder }) =>
      name.toLowerCase().includes(search) || (folder ?? '').toLowerCase().includes(search));
  };
  const select = (name, checked) => {
    if (!names.includes(name)) return;
    const entry = getEntry(name);
    if (checked && entry.available && !entry.inDestination) selected.add(name);
    else selected.delete(name);
  };
  return {
    entries,
    selected,
    select,
    selectVisible(query) {
      for (const entry of entries(query)) {
        if (entry.available && !entry.inDestination) selected.add(entry.name);
      }
    },
    clear: () => selected.clear(),
  };
}

export function createFolderAssignmentBatch({
  folderName, selection, getWorldNames, cache, setBookFolder, refreshList,
  isDirtyCheck = () => false, isCurrent = () => true,
}) {
  let busy = false;
  return {
    get busy() { return busy; },
    async submit() {
      if (busy) return null;
      const result = { moved: [], skipped: [], failed: [], blocked: false, refreshDeferred: false, refreshError: null };
      if (!isCurrent()) return null;
      if (isDirtyCheck()) {
        result.blocked = true;
        return result;
      }
      busy = true;
      let attempted = false;
      try {
        const selectedNames = [...selection.selected];
        for (let i = 0; i < selectedNames.length; i++) {
          if (!isCurrent()) break;
          if (isDirtyCheck()) {
            result.blocked = true;
            break;
          }
          const name = selectedNames[i];
          const existing = new Set(getWorldNames());
          if (!existing.has(name) || (Object.hasOwn(cache, name) && sameFolder(getFolderFromMetadata(cache[name]?.metadata), folderName))) {
            selection.selected.delete(name);
            result.skipped.push(name);
            continue;
          }
          attempted = true;
          try {
            const saved = await setBookFolder(name, folderName);
            if (saved === false || saved?.ok === false) {
              result.failed.push(name);
            } else {
              selection.selected.delete(name);
              result.moved.push(name);
            }
          } catch (error) {
            console.warn('[STWID] Failed to add lorebook to folder.', { name, folderName, error });
            result.failed.push(name);
          }
        }
        if (attempted && isCurrent()) {
          // Refreshing rebuilds the editor; never discard a draft created while saving.
          if (isDirtyCheck()) result.refreshDeferred = true;
          else {
            try { await refreshList?.(); }
            catch (error) { result.refreshError = error; }
          }
        }
        return result;
      } finally {
        busy = false;
      }
    },
  };
}
