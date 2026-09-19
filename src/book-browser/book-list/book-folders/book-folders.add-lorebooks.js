import { createFolderBookSelection, createFolderAssignmentBatch } from './book-folders.bulk-selection.js';

const openDialogs = new WeakMap();
const UNSAVED_MESSAGE = 'Unsaved edits detected. Save or discard changes before adding lorebooks to a folder.';

export function closeAddLorebooksDialog(menuActions) {
  openDialogs.get(menuActions)?.dispose();
}

export function addLorebooksToFolderAction({ folderName, menuActions }) {
  if (!menuActions?.getWorldNames || !menuActions?.setBookFolder || !menuActions?.cache) return;
  if (menuActions.isDirtyCheck?.()) {
    toastr.warning(UNSAVED_MESSAGE);
    return;
  }
  const existing = openDialogs.get(menuActions);
  if (existing) {
    existing.focus();
    return;
  }

  const selection = createFolderBookSelection({ folderName, ...menuActions });
  const modal = document.createElement('dialog');
  modal.classList.add('popup', 'stwid--add-lorebooks-dialog');
  modal.setAttribute('aria-label', `Add lorebooks to ${folderName}`);
  const body = document.createElement('div');
  body.className = 'popup-body';
  const content = document.createElement('div');
  content.className = 'popup-content stwid--add-lorebooks-content';
  const title = document.createElement('h3');
  title.textContent = `Add lorebooks to “${folderName}”`;
  const hint = document.createElement('p');
  hint.textContent = 'Each lorebook belongs to one folder. Adding a lorebook moves it from its current folder.';
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'text_pole';
  search.placeholder = 'Search lorebooks or folders';
  search.setAttribute('aria-label', 'Search lorebooks or folders');
  const toolbar = document.createElement('div');
  toolbar.className = 'stwid--add-lorebooks-toolbar';
  const count = document.createElement('span');
  count.setAttribute('role', 'status');
  const makeButton = (label, className = '') => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu_button ${className}`;
    button.textContent = label;
    return button;
  };
  const selectVisible = makeButton('Select visible');
  const clear = makeButton('Clear selection');
  toolbar.append(count, selectVisible, clear);
  const list = document.createElement('div');
  list.className = 'stwid--add-lorebooks-list';
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', 'Lorebooks');
  const status = document.createElement('p');
  status.className = 'stwid--add-lorebooks-status';
  status.setAttribute('role', 'status');
  const controls = document.createElement('div');
  controls.className = 'popup-controls';
  const add = makeButton('Add selected', 'popup-button-ok');
  const cancel = makeButton('Cancel', 'popup-button-cancel');
  controls.append(add, cancel);
  content.append(title, hint, search, toolbar, list, status, controls);
  body.append(content);
  modal.append(body);

  let disposed = false;
  const batch = createFolderAssignmentBatch({
    folderName, selection, ...menuActions, isCurrent: () => !disposed,
  });
  const updateControls = () => {
    const busy = batch.busy;
    count.textContent = `${selection.selected.size} selected`;
    modal.setAttribute('aria-busy', String(busy));
    search.disabled = busy;
    clear.disabled = busy || !selection.selected.size;
    selectVisible.disabled = busy || !selection.entries(search.value).some((entry) => entry.available && !entry.inDestination);
    add.disabled = busy || !selection.selected.size;
    cancel.disabled = busy;
    for (const checkbox of list.querySelectorAll('input')) {
      checkbox.disabled = busy || checkbox.dataset.unavailable === 'true';
    }
  };
  const renderList = () => {
    list.replaceChildren();
    const entries = selection.entries(search.value);
    for (const entry of entries) {
      const row = document.createElement('label');
      row.className = 'stwid--add-lorebooks-row';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selection.selected.has(entry.name);
      checkbox.dataset.unavailable = String(!entry.available || entry.inDestination);
      checkbox.addEventListener('change', () => {
        selection.select(entry.name, checkbox.checked);
        updateControls();
      });
      const details = document.createElement('span');
      const name = document.createElement('span');
      name.className = 'stwid--add-lorebooks-name';
      name.textContent = entry.name;
      const folder = document.createElement('small');
      folder.textContent = !entry.available ? 'Unavailable — refresh the drawer to load this book'
        : entry.inDestination ? `Already in ${folderName}` : entry.folder ? `Folder: ${entry.folder}` : 'No folder';
      details.append(name, folder);
      row.append(checkbox, details);
      list.append(row);
    }
    if (!entries.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No matching lorebooks.';
      list.append(empty);
    }
    updateControls();
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    openDialogs.delete(menuActions);
    if (modal.open) modal.close();
    modal.remove();
  };
  openDialogs.set(menuActions, { dispose, focus: () => search.focus() });
  modal.addEventListener('close', dispose);
  modal.addEventListener('cancel', (event) => {
    if (batch.busy) event.preventDefault();
  });
  modal.addEventListener('click', (event) => {
    if (event.target === modal && !batch.busy) dispose();
  });
  cancel.addEventListener('click', () => { if (!batch.busy) dispose(); });
  search.addEventListener('input', renderList);
  selectVisible.addEventListener('click', () => {
    if (batch.busy) return;
    selection.selectVisible(search.value);
    renderList();
  });
  clear.addEventListener('click', () => {
    if (batch.busy) return;
    selection.clear();
    renderList();
  });
  add.addEventListener('click', async () => {
    if (batch.busy || !selection.selected.size) return;
    status.textContent = 'Adding selected lorebooks…';
    const pending = batch.submit();
    updateControls();
    const result = await pending;
    if (disposed || !result) return;
    const summary = `${result.moved.length} added, ${result.skipped.length} skipped, ${result.failed.length} failed.`;
    status.textContent = summary;
    if (result.failed.length) status.textContent += ' Failed lorebooks remain selected. Select Retry selected to retry.';
    if (result.blocked) status.textContent += ` ${UNSAVED_MESSAGE}`;
    if (result.refreshDeferred) status.textContent += ' Refresh the drawer after saving or discarding your edits.';
    if (result.refreshError) status.textContent += ' The list could not refresh. Refresh the drawer to see saved changes.';
    renderList();
    add.textContent = result.failed.length ? 'Retry selected' : 'Add selected';
    cancel.textContent = 'Close';
    if (!selection.selected.size && !result.refreshError && !result.refreshDeferred) {
      toastr.success(summary);
      dispose();
    }
  });
  renderList();
  document.body.append(modal);
  modal.showModal();
  search.focus();
}
