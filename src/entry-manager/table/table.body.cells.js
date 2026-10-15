import { setTooltip, formatCharacterFilter } from '../entry-manager.utils.js';
import { ENTRY_MANAGER_RECURSION_OPTIONS } from '../../shared/constants.js';
import { createMoveButton } from './table.body.row-sorting.js';
import { mirrorEntryFieldsToOriginalData } from '../../shared/original-data.js';
import { buildCharacterFilterCell } from './table.body.character-filter.js';

const TEXT_POLE_CLASS = 'text_pole';
const ORDER_INPUT_TIGHT_CLASS = 'stwid--order-input';

export const ENTRY_MANAGER_CELL_ORDER = [
  'select', 'drag', 'enabled', 'entry', 'strategy', 'position', 'depth', 'outlet',
  'group', 'order', 'sticky', 'cooldown', 'delay', 'automationId', 'trigger',
  'recursion', 'budget', 'characterFilter',
];
const STATIC_COLUMNS = new Set(['select', 'entry']);
const NUMBER_COLUMNS = new Set(['depth', 'order', 'sticky', 'cooldown', 'delay', 'trigger']);

const createEntryMoveHandle = () => {
  const handle = document.createElement('div');
  handle.classList.add('stwid--sortable-handle', 'fa-solid', 'fa-fw', 'fa-grip-lines');
  setTooltip(handle, 'Drag to reorder rows');
  return handle;
};

export function getEntryManagerCellText(col, entry, options) {
  switch (col) {
    case 'drag': return '▴\n☰\n▾';
    case 'enabled': return entry.disable ? 'Off' : 'On';
    case 'strategy': return options.strategyLabels?.get(options.entryState(entry)) ?? options.entryState(entry);
    case 'position': return options.positionLabels?.get(String(entry.position)) ?? String(entry.position ?? '');
    case 'outlet': return options.isOutletPosition(entry.position) ? entry.outletName ?? '' : '';
    case 'group': return [entry.group, entry.groupOverride ? 'Prioritize' : ''].filter(Boolean).join('\n');
    case 'trigger': return String(entry.probability ?? '');
    case 'budget': return entry.ignoreBudget ? 'Ignore budget' : 'Respect budget';
    case 'recursion': return ENTRY_MANAGER_RECURSION_OPTIONS.filter(({ value }) => entry[value]).map(({ label }) => label).join('\n') || 'None';
    case 'characterFilter': return formatCharacterFilter(entry, options.characterFilterIndex).map(({ label }) => label).join('\n') || 'No filter';
    default: return String(entry[col] ?? '');
  }
}

// Rows stay in the table, including filtered/offscreen rows. Bulk operations,
// selection and native Find therefore retain the complete logical scope.
export function buildEntryManagerRow(options) {
  const { dom, cache, entryRow, entryManagerState = { columns: {} } } = options;
  const tr = document.createElement('tr');
  tr.setAttribute('data-book', entryRow.book);
  tr.setAttribute('data-uid', entryRow.data.uid);
  const rowOptions = { ...options, tr };
  const cells = new Map();
  const visible = (col) => entryManagerState.columns[col] !== false;
  const currentEntry = () => cache[entryRow.book]?.entries?.[entryRow.data.uid] ?? entryRow.data;
  const writePlaceholder = (col, cell) => {
    const enabled = visible(col);
    const text = enabled ? getEntryManagerCellText(col, currentEntry(), options) : '';
    const tabIndex = enabled ? 0 : -1;
    const label = `Edit ${col}: ${text}`;
    // Bulk edits usually change one column. Keep other text nodes and focus
    // attributes intact instead of forcing table layout for every preview.
    if (cell.textContent !== text) cell.textContent = text;
    if (cell.tabIndex !== tabIndex) cell.tabIndex = tabIndex;
    if (cell.getAttribute('aria-label') !== label) cell.setAttribute('aria-label', label);
  };
  const hydrateCell = (col) => {
    const previous = cells.get(col);
    if (!previous?.hasAttribute('data-stwid-pending') || !visible(col)) return previous;
    entryRow.data = currentEntry();
    const cell = buildEntryManagerCell(col, rowOptions);
    previous.replaceWith(cell);
    cells.set(col, cell);
    return cell;
  };
  for (const col of ENTRY_MANAGER_CELL_ORDER) {
    let cell;
    if (STATIC_COLUMNS.has(col)) {
      cell = buildEntryManagerCell(col, rowOptions);
    } else {
      cell = document.createElement('td');
      cell.setAttribute('data-col', col);
      cell.setAttribute('data-stwid-pending', '');
      cell.classList.add('stwid--deferred-cell');
      // Sortable needs a native target before deferred controls exist. Reuse
      // the cell itself so thousands of offscreen rows need no extra elements.
      if (col === 'drag') cell.classList.add('stwid--sortable-handle');
      if (NUMBER_COLUMNS.has(col)) cell.classList.add('stwid--order-table--number-columns');
      writePlaceholder(col, cell);
    }
    cells.set(col, cell);
    tr.append(cell);
  }
  tr.stwidHydrateCell = hydrateCell;
  tr.stwidHydrate = () => {
    for (const col of ENTRY_MANAGER_CELL_ORDER) hydrateCell(col);
    tr.dataset.stwidHydrated = 'true';
  };
  tr.stwidRefreshPending = () => {
    for (const [col, cell] of cells) {
      if (cell.hasAttribute('data-stwid-pending')) writePlaceholder(col, cell);
    }
  };
  tr.stwidRefreshCell = (col) => {
    const cell = cells.get(col);
    if (!cell) return;
    if (cell.hasAttribute('data-stwid-pending')) return writePlaceholder(col, cell);
    entryRow.data = currentEntry();
    const replacement = buildEntryManagerCell(col, rowOptions);
    cell.replaceWith(replacement);
    cells.set(col, replacement);
  };
  tr.stwidRefreshFields = (fields) => {
    const mapped = {
      disable: 'enabled', constant: 'strategy', vectorized: 'strategy',
      probability: 'trigger', outletName: 'outlet', ignoreBudget: 'budget',
      groupOverride: 'group', comment: 'entry', key: 'entry',
      excludeRecursion: 'recursion', preventRecursion: 'recursion', delayUntilRecursion: 'recursion',
    };
    const columns = new Set([...fields].map((field) => mapped[field] ?? field));
    if (fields.has('position')) columns.add('outlet');
    for (const col of columns) {
      const cell = cells.get(col);
      // The character-filter registry owns its active dropdown and updates.
      if (!cell || col === 'characterFilter' || cell.contains(document.activeElement)) continue;
      tr.stwidRefreshCell(col);
    }
    tr.stwidRefreshPending();
  };
  tr.stwidRemapUid = (uid) => {
    tr.setAttribute('data-uid', uid);
    tr.stwidRefreshCell('entry');
  };
  dom.order.entries[entryRow.book] ??= {};
  dom.order.entries[entryRow.book][entryRow.data.uid] = tr;
  options.setEntryManagerRowSelected(tr, true);
  return tr;
}

export function buildNumberInputCell({ col, name, tooltip, max = '99999', getValue, onSave }) {
  const td = document.createElement('td');
  td.setAttribute('data-col', col);
  td.classList.add('stwid--order-table--number-columns');
  const inputEl = document.createElement('input');
  inputEl.classList.add('stwid--input', TEXT_POLE_CLASS);
  inputEl.name = name;
  setTooltip(inputEl, tooltip);
  inputEl.min = '0';
  inputEl.max = max;
  inputEl.type = 'number';
  inputEl.value = getValue() ?? '';
  inputEl.addEventListener('change', async () => {
    const value = parseInt(inputEl.value);
    await onSave(Number.isFinite(value) ? value : undefined);
  });
  td.append(inputEl);
  return td;
}

export function buildTextInput({ name, tooltip, getValue, onChange }) {
  const inputEl = document.createElement('input');
  inputEl.classList.add('stwid--input', TEXT_POLE_CLASS, ORDER_INPUT_TIGHT_CLASS);
  inputEl.name = name;
  setTooltip(inputEl, tooltip);
  inputEl.type = 'text';
  inputEl.value = getValue() ?? '';
  inputEl.addEventListener('change', async () => {
    await onChange(inputEl.value);
  });
  return inputEl;
}

function buildRecursionOptionRow({
  entryRow,
  tr,
  key,
  label,
  cache,
  enqueueSave,
  applyEntryManagerRecursionFilterToRow,
}) {
  const row = document.createElement('label');
  row.classList.add('stwid--option-check-row');
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.classList.add('checkbox');
  setTooltip(input, label);
  input.checked = Boolean(entryRow.data[key]);
  input.addEventListener('change', async () => {
    const entryData = cache[entryRow.book].entries[entryRow.data.uid];
    entryData[key] = input.checked;
    entryRow.data[key] = input.checked;
    mirrorEntryFieldsToOriginalData(cache[entryRow.book], entryData, [key]);
    applyEntryManagerRecursionFilterToRow(tr, entryData);
    await enqueueSave(entryRow.book);
  });
  row.append(input, label);
  return row;
}

// Cell factories are called only when a visible column approaches the viewport.
export function buildEntryManagerCell(col, {
  entryRow,
  tr,
  characterFilterIndex,
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
}) {
  switch (col) {
    case 'select': {
      const select = document.createElement('td');
      select.setAttribute('data-col', 'select');
      const selectButton = document.createElement('div');
      selectButton.classList.add('stwid--order-select', 'fa-solid', 'fa-fw');
      setTooltip(selectButton, 'Include/exclude this row from Apply Order');
      const selectIcon = document.createElement('i');
      selectIcon.classList.add('fa-solid', 'fa-fw', 'stwid--icon');
      selectButton.append(selectIcon);
      selectButton.addEventListener('click', () => {
        setEntryManagerRowSelected(tr, !isEntryManagerRowSelected(tr));
        updateEntryManagerSelectAllButton();
        refreshSelectionCount?.();
      });
      select.append(selectButton);
      return select;
    }
    case 'drag': {
      const handle = document.createElement('td');
      handle.setAttribute('data-col', 'drag');
      const controls = document.createElement('div');
      controls.classList.add('stwid--order-move');
      const upButton = createMoveButton({
        row: tr,
        direction: 'up',
        iconClass: 'fa-caret-up',
        title: 'Move up',
        jumpTitle: 'the top of the filtered list',
        dom,
        getVisibleEntryManagerRows,
        updateCustomOrderFromDom,
      });
      const downButton = createMoveButton({
        row: tr,
        direction: 'down',
        iconClass: 'fa-caret-down',
        title: 'Move down',
        jumpTitle: 'the bottom of the filtered list',
        dom,
        getVisibleEntryManagerRows,
        updateCustomOrderFromDom,
      });
      controls.append(upButton, createEntryMoveHandle(), downButton);
      handle.append(controls);
      return handle;
    }
    case 'enabled': {
      const active = document.createElement('td');
      active.setAttribute('data-col', 'enabled');
      const enabledToggle = enabledToggleTemplate.cloneNode(true);
      enabledToggle.classList.add('stwid--enabled');
      enabledToggle.tabIndex = 0;
      enabledToggle.setAttribute('role', 'button');
      enabledToggle.setAttribute('aria-label', 'Enable entry');
      setTooltip(enabledToggle, 'Enable/disable this entry');
      const applyEnabledIcon = (el, disabled) => {
        for (const [name, present] of [['fa-toggle-off', Boolean(disabled)], ['fa-toggle-on', !disabled]]) {
          if (el.classList.contains(name) !== present) el.classList.toggle(name, present);
        }
        if (el === enabledToggle) {
          const pressed = String(!disabled);
          if (el.getAttribute('aria-pressed') !== pressed) el.setAttribute('aria-pressed', pressed);
        }
      };
      applyEnabledIcon(enabledToggle, entryRow.data.disable);
      enabledToggle.addEventListener('keydown', (event) => {
        if (event.ctrlKey || event.metaKey || event.altKey || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        enabledToggle.click();
      });
      enabledToggle.addEventListener('click', async () => {
        const entryData = cache[entryRow.book].entries[entryRow.data.uid];
        const nextDisabled = !entryData.disable;
        entryData.disable = nextDisabled;
        entryRow.data.disable = nextDisabled;
        mirrorEntryFieldsToOriginalData(cache[entryRow.book], entryData, ['disable']);
        applyEnabledIcon(enabledToggle, nextDisabled);
        const listToggle = cache[entryRow.book].dom.entry?.[entryRow.data.uid]?.isEnabled;
        if (listToggle) {
          applyEnabledIcon(listToggle, nextDisabled);
    }
    await enqueueSave(entryRow.book);
  });
  active.append(enabledToggle);
  return active;
    }
    case 'entry': {
      const entryCell = document.createElement('td');
      entryCell.setAttribute('data-col', 'entry');
      const entryCellWrap = document.createElement('div');
      entryCellWrap.classList.add('stwid--colwrap', 'stwid--entry');
      const bookLabel = document.createElement('div');
      bookLabel.classList.add('stwid--book');
      const bookIcon = document.createElement('i');
      bookIcon.classList.add('fa-solid', 'fa-fw', 'fa-book-atlas');
      bookLabel.append(bookIcon);
      const bookText = document.createElement('span');
      bookText.textContent = entryRow.book;
      bookLabel.append(bookText);
      entryCellWrap.append(bookLabel);
      const commentLink = document.createElement('a');
      commentLink.classList.add('stwid--comment', 'stwid--comment-link');
      commentLink.href = `#world_entry/${encodeURIComponent(entryRow.data.uid)}`;
      commentLink.textContent = entryRow.data.comment ?? '';
      commentLink.addEventListener('click', (evt) => {
        evt.preventDefault();
        focusWorldEntry(entryRow.book, entryRow.data.uid);
      });
      entryCellWrap.append(commentLink);
      const key = document.createElement('div');
      key.classList.add('stwid--key');
      key.textContent = entryRow.data.key.join(', ');
      entryCellWrap.append(key);
      entryCell.append(entryCellWrap);
      return entryCell;
    }
    case 'strategy': {
      const strategy = document.createElement('td');
      strategy.setAttribute('data-col', 'strategy');
      const strategySelect = strategyTemplate.cloneNode(true);
      strategySelect.classList.add('stwid--strategy', 'stwid--sort-select');
      setTooltip(strategySelect, 'Entry strategy');
      strategySelect.value = entryState(entryRow.data);
      strategySelect.addEventListener('change', async () => {
        const value = strategySelect.value;
        const listStrategy = cache[entryRow.book]?.dom?.entry?.[entryRow.data.uid]?.strategy;
        if (listStrategy) listStrategy.value = value;
        switch (value) {
          case 'constant':
            cache[entryRow.book].entries[entryRow.data.uid].constant = true;
            cache[entryRow.book].entries[entryRow.data.uid].vectorized = false;
            break;
          case 'normal':
            cache[entryRow.book].entries[entryRow.data.uid].constant = false;
            cache[entryRow.book].entries[entryRow.data.uid].vectorized = false;
            break;
          case 'vectorized':
            cache[entryRow.book].entries[entryRow.data.uid].constant = false;
            cache[entryRow.book].entries[entryRow.data.uid].vectorized = true;
            break;
    }
    mirrorEntryFieldsToOriginalData(
      cache[entryRow.book],
      cache[entryRow.book].entries[entryRow.data.uid],
      ['constant', 'vectorized'],
    );
    applyEntryManagerStrategyFilterToRow(tr, cache[entryRow.book].entries[entryRow.data.uid]);
    await enqueueSave(entryRow.book);
  });
  strategy.append(strategySelect);
  return strategy;
    }
    case 'position': {
      const positionSelect = positionTemplate.cloneNode(true);
      const position = document.createElement('td');
      position.setAttribute('data-col', 'position');
      positionSelect.classList.add('stwid--position', 'stwid--sort-select');
      setTooltip(positionSelect, 'Where this entry is inserted');
      positionSelect.value = entryRow.data.position;
      positionSelect.addEventListener('change', async () => {
        const value = positionSelect.value;
        const numericPosition = Number(value);
        const nextPosition = Number.isNaN(numericPosition) ? 0 : numericPosition;
        const listPosition = cache[entryRow.book]?.dom?.entry?.[entryRow.data.uid]?.position;
        if (listPosition) listPosition.value = value;
        cache[entryRow.book].entries[entryRow.data.uid].position = nextPosition;
        entryRow.data.position = nextPosition;
        mirrorEntryFieldsToOriginalData(
          cache[entryRow.book],
          cache[entryRow.book].entries[entryRow.data.uid],
          ['position'],
        );
        applyEntryManagerPositionFilterToRow(tr, cache[entryRow.book].entries[entryRow.data.uid]);
        tr.stwidRefreshCell?.('outlet');
        await enqueueSave(entryRow.book);
      });
      position.append(positionSelect);
      return position;
    }
    case 'depth': {
      return buildNumberInputCell({
          col: 'depth',
          name: 'depth',
          tooltip: 'Entry depth',
          getValue: () => entryRow.data.depth,
          onSave: async (value) => {
            const entryData = cache[entryRow.book].entries[entryRow.data.uid];
            entryData.depth = value;
            mirrorEntryFieldsToOriginalData(cache[entryRow.book], entryData, ['depth']);
            await enqueueSave(entryRow.book);
          },
      });
    }
    case 'outlet': {
      const outlet = document.createElement('td');
      outlet.setAttribute('data-col', 'outlet');
      const outletWrap = document.createElement('div');
      outletWrap.classList.add('stwid--colwrap', 'stwid--outlet');
      const outletInput = buildTextInput({
        name: 'outletName',
        tooltip: 'Outlet name (used for outlet positions)',
        getValue: () =>
          cache[entryRow.book].entries[entryRow.data.uid].outletName ?? entryRow.data.outletName ?? '',
        onChange: async (nextValue) => {
          const entryData = cache[entryRow.book].entries[entryRow.data.uid];
          entryData.outletName = nextValue;
          entryRow.data.outletName = nextValue;
          mirrorEntryFieldsToOriginalData(cache[entryRow.book], entryData, ['outletName']);
          syncEntryManagerOutletFilters();
          refreshOutletFilterIndicator();
          applyEntryManagerOutletFilters();
          await enqueueSave(entryRow.book);
          tr.stwidRefreshCell?.('outlet');
        },
      });
      const updateOutlet = () => {
        const entryData = cache[entryRow.book].entries[entryRow.data.uid];
        const currentPosition = entryData.position;
        const outletName = entryData.outletName ?? entryRow.data.outletName ?? '';
        outletInput.value = outletName;
        outletWrap.hidden = !isOutletPosition(currentPosition);
      };
      updateOutlet();
      outletWrap.append(outletInput);
      outlet.append(outletWrap);
      return outlet;
    }
    case 'group': {
      const group = document.createElement('td');
      group.setAttribute('data-col', 'group');
      const groupWrap = document.createElement('div');
      groupWrap.classList.add('stwid--colwrap', 'stwid--outlet', 'stwid--recursion-options');
      const groupInput = buildTextInput({
        name: 'group',
        tooltip: 'Inclusion group name',
        getValue: () => cache[entryRow.book].entries[entryRow.data.uid].group ?? '',
        onChange: async (nextValue) => {
          const entryData = cache[entryRow.book].entries[entryRow.data.uid];
          entryData.group = nextValue;
          entryRow.data.group = nextValue;
          mirrorEntryFieldsToOriginalData(cache[entryRow.book], entryData, ['group']);
          syncEntryManagerGroupFilters();
          refreshGroupFilterIndicator();
          applyEntryManagerGroupFilters();
          await enqueueSave(entryRow.book);
        },
      });
      groupWrap.append(groupInput, document.createElement('br'));
      const prioritizeRow = document.createElement('label');
      prioritizeRow.classList.add('stwid--option-check-row');
      const prioritizeInput = document.createElement('input');
      prioritizeInput.type = 'checkbox';
      prioritizeInput.classList.add('checkbox');
      setTooltip(prioritizeInput, 'Prioritize this entry within its inclusion group');
      prioritizeInput.checked = Boolean(entryRow.data.groupOverride);
      prioritizeInput.addEventListener('change', async () => {
        const entryData = cache[entryRow.book].entries[entryRow.data.uid];
        entryData.groupOverride = prioritizeInput.checked;
        entryRow.data.groupOverride = prioritizeInput.checked;
        mirrorEntryFieldsToOriginalData(cache[entryRow.book], entryData, ['groupOverride']);
        await enqueueSave(entryRow.book);
      });
      prioritizeRow.append(prioritizeInput, 'Prioritize');
      groupWrap.append(prioritizeRow);
      group.append(groupWrap);
      return group;
    }
    case 'order': {
      return buildNumberInputCell({
          col: 'order',
          name: 'order',
          tooltip: 'Order value',
          getValue: () => entryRow.data.order,
          onSave: async (value) => {
            const entryData = cache[entryRow.book].entries[entryRow.data.uid];
            entryData.order = value;
            mirrorEntryFieldsToOriginalData(cache[entryRow.book], entryData, ['order']);
            await enqueueSave(entryRow.book);
          },
      });
    }
    case 'sticky': {
      return buildNumberInputCell({
          col: 'sticky',
          name: 'sticky',
          tooltip: 'Sticky duration',
          getValue: () => entryRow.data.sticky,
          onSave: async (value) => {
            const entryData = cache[entryRow.book].entries[entryRow.data.uid];
            entryData.sticky = value;
            mirrorEntryFieldsToOriginalData(cache[entryRow.book], entryData, ['sticky']);
            await enqueueSave(entryRow.book);
          },
      });
    }
    case 'cooldown': {
      return buildNumberInputCell({
          col: 'cooldown',
          name: 'cooldown',
          tooltip: 'Cooldown duration',
          getValue: () => entryRow.data.cooldown,
          onSave: async (value) => {
            const entryData = cache[entryRow.book].entries[entryRow.data.uid];
            entryData.cooldown = value;
            mirrorEntryFieldsToOriginalData(cache[entryRow.book], entryData, ['cooldown']);
            await enqueueSave(entryRow.book);
          },
      });
    }
    case 'delay': {
      return buildNumberInputCell({
          col: 'delay',
          name: 'delay',
          tooltip: 'Delay before activation',
          getValue: () => entryRow.data.delay,
          onSave: async (value) => {
            const entryData = cache[entryRow.book].entries[entryRow.data.uid];
            entryData.delay = value;
            mirrorEntryFieldsToOriginalData(cache[entryRow.book], entryData, ['delay']);
            await enqueueSave(entryRow.book);
          },
      });
    }
    case 'automationId': {
      const automationId = document.createElement('td');
      automationId.setAttribute('data-col', 'automationId');
      automationId.classList.add('stwid--order-table--number-columns');
      const automationIdInput = buildTextInput({
        name: 'automationId',
        tooltip: 'Automation ID',
        getValue: () =>
          cache[entryRow.book].entries[entryRow.data.uid].automationId ??
          entryRow.data.automationId ??
          '',
        onChange: async (nextValue) => {
          const entryData = cache[entryRow.book].entries[entryRow.data.uid];
          entryData.automationId = nextValue;
          entryRow.data.automationId = nextValue;
          mirrorEntryFieldsToOriginalData(cache[entryRow.book], entryData, ['automationId']);
          syncEntryManagerAutomationIdFilters();
          refreshAutomationIdFilterIndicator();
          applyEntryManagerAutomationIdFilters();
          await enqueueSave(entryRow.book);
        },
      });
      automationId.append(automationIdInput);
      return automationId;
    }
    case 'trigger': {
      return buildNumberInputCell({
          col: 'trigger',
          name: 'selective_probability',
          tooltip: 'Trigger chance percentage',
          max: '100',
          getValue: () => entryRow.data.probability,
          onSave: async (value) => {
            const entryData = cache[entryRow.book].entries[entryRow.data.uid];
            entryData.probability = value;
            entryRow.data.probability = value;
            mirrorEntryFieldsToOriginalData(cache[entryRow.book], entryData, ['probability']);
            await enqueueSave(entryRow.book);
          },
      });
    }
    case 'recursion': {
      const recursion = document.createElement('td');
      recursion.setAttribute('data-col', 'recursion');
      const recursionWrap = document.createElement('div');
      recursionWrap.classList.add('stwid--recursion-options');
      for (const { value, label } of ENTRY_MANAGER_RECURSION_OPTIONS) {
        recursionWrap.append(
          buildRecursionOptionRow({
            entryRow,
            tr,
            key: value,
            label,
            cache,
            enqueueSave,
            applyEntryManagerRecursionFilterToRow,
          }),
        );
      }
      recursion.append(recursionWrap);
      return recursion;
    }
    case 'budget': {
      const budget = document.createElement('td');
      budget.setAttribute('data-col', 'budget');
      const budgetWrap = document.createElement('div');
      budgetWrap.classList.add('stwid--recursion-options');
      const budgetRow = document.createElement('label');
      budgetRow.classList.add('stwid--option-check-row');
      const budgetInput = document.createElement('input');
      budgetInput.type = 'checkbox';
      budgetInput.classList.add('checkbox');
      setTooltip(budgetInput, 'Ignore World Info budget limit for this entry');
      budgetInput.checked = Boolean(entryRow.data.ignoreBudget);
      budgetInput.addEventListener('change', async () => {
        const entryData = cache[entryRow.book].entries[entryRow.data.uid];
        entryData.ignoreBudget = budgetInput.checked;
        entryRow.data.ignoreBudget = budgetInput.checked;
        mirrorEntryFieldsToOriginalData(cache[entryRow.book], entryData, ['ignoreBudget']);
        await enqueueSave(entryRow.book);
      });
      budgetRow.append(budgetInput, 'Ignore budget');
      budgetWrap.append(budgetRow);
      budget.append(budgetWrap);
      return budget;
    }
    case 'characterFilter': {
      return buildCharacterFilterCell({ entryRow, cache, enqueueSave, characterFilterIndex });
    }
  }
}
