import {
  entryMatchesCharacterFilterValues,
  getCharacterFilterPresenceValue,
} from '../entry-manager.utils.js';
import { CHARACTER_FILTER_PRESENCE_VALUES } from '../../shared/constants.js';

const FILTER_DATASET_KEYS = {
  strategy: 'stwidFilterStrategy',
  position: 'stwidFilterPosition',
  recursion: 'stwidFilterRecursion',
  outlet: 'stwidFilterOutlet',
  automationId: 'stwidFilterAutomationId',
  group: 'stwidFilterGroup',
  script: 'stwidFilterScript',
  // Ticket 08 — the column's two filters: has/hasn't any character/tag filter
  // (R21) and "filter to a specific character or tag" (R22).
  characterFilterPresence: 'stwidFilterCharacterFilterPresence',
  characterFilterValue: 'stwidFilterCharacterFilterValue',
};

// Single source of truth for "which columns contribute to the filtered class":
// every key here is tested when recomputing stwid--state-filtered.
const FILTER_DATASET_KEY_LIST = Object.values(FILTER_DATASET_KEYS);

const normalizeAllowedFilters = (filters, allowedValues) => {
  const allowed = new Set(allowedValues);
  return filters.filter((value) => allowed.has(value));
};

const createFilterNormalizers = ({
  getStrategyValues,
  getPositionValues,
  getOutletValues,
  getAutomationIdValues,
  getGroupValues,
  getCharacterFilterValueKeys,
}) => {
  const normalizeStrategyFilters = (filters) =>
    normalizeAllowedFilters(filters, getStrategyValues());
  const normalizePositionFilters = (filters) =>
    normalizeAllowedFilters(filters, getPositionValues());
  const normalizeOutletFilters = (filters) => normalizeAllowedFilters(filters, getOutletValues());
  const normalizeAutomationIdFilters = (filters) =>
    normalizeAllowedFilters(filters, getAutomationIdValues());
  const normalizeGroupFilters = (filters) => normalizeAllowedFilters(filters, getGroupValues());
  const normalizeCharacterFilterValueFilters = (filters) =>
    normalizeAllowedFilters(filters, getCharacterFilterValueKeys());

  const normalizeGroupValuesForFilter = (groupValues) => {
    if (Array.isArray(groupValues)) {
      if (!groupValues.length) return [''];
      return groupValues.map((value) => String(value ?? '').trim());
    }
    if (groupValues === null || groupValues === undefined) return [''];
    return [String(groupValues).trim()];
  };

  return {
    normalizeStrategyFilters,
    normalizePositionFilters,
    normalizeOutletFilters,
    normalizeAutomationIdFilters,
    normalizeGroupFilters,
    normalizeCharacterFilterValueFilters,
    normalizeGroupValuesForFilter,
  };
};

const createRowFilterStateHelpers = () => {
  let deferredRow = null;
  const updateEntryManagerRowFilterClass = (row) => {
    if (!row) return;
    const isFiltered = FILTER_DATASET_KEY_LIST.some((key) => row.dataset[key] === 'true');
    if (row.classList.contains('stwid--state-filtered') !== isFiltered) {
      row.classList.toggle('stwid--state-filtered', isFiltered);
    }
    row.stwidOnFilterStateChanged?.(isFiltered);
  };

  const setEntryManagerRowFilterState = (row, datasetFlagKey, filtered) => {
    if (!row) return;
    const value = filtered ? 'true' : 'false';
    if (row.dataset[datasetFlagKey] === value) return;
    row.dataset[datasetFlagKey] = value;
    if (deferredRow !== row) updateEntryManagerRowFilterClass(row);
  };

  return {
    setEntryManagerRowFilterState,
    batchRowFilterUpdates: (row, apply) => {
      const previous = deferredRow;
      deferredRow = row;
      try {
        apply();
      } finally {
        deferredRow = previous;
        updateEntryManagerRowFilterClass(row);
      }
    },
  };
};

const createRowFilterAppliers = ({
  entryManagerState,
  entryState,
  getStrategyValues,
  getPositionValues,
  getOutletValues,
  getOutletValue,
  getAutomationIdValues,
  getAutomationIdValue,
  getGroupValues,
  getGroupValue,
  normalizeGroupValuesForFilter,
  setEntryManagerRowFilterState,
}) => {
  const applySimpleSetFilterToRow = ({
    row,
    entryData,
    precomputed,
    valuesFromState,
    valuesFromSource,
    allowedFromState,
    datasetKey,
    getEntryValue,
  }) => {
    const values =
      precomputed?.values ?? (valuesFromState().length ? valuesFromState() : valuesFromSource());
    if (!values.length) {
      setEntryManagerRowFilterState(row, datasetKey, false);
      return;
    }

    const allowed = precomputed?.allowed ?? allowedFromState();
    const entryValue = getEntryValue(entryData);
    setEntryManagerRowFilterState(row, datasetKey, !allowed.has(entryValue));
  };

  const applyEntryManagerStrategyFilterToRow = (row, entryData, precomputed = null) => {
    applySimpleSetFilterToRow({
      row,
      entryData,
      precomputed,
      valuesFromState: () => entryManagerState.strategyValues,
      valuesFromSource: getStrategyValues,
      allowedFromState: () => new Set(entryManagerState.filters.strategy ?? []),
      datasetKey: FILTER_DATASET_KEYS.strategy,
      getEntryValue: entryState,
    });
  };

  const applyEntryManagerPositionFilterToRow = (row, entryData, precomputed = null) => {
    applySimpleSetFilterToRow({
      row,
      entryData,
      precomputed,
      valuesFromState: () => entryManagerState.positionValues,
      valuesFromSource: getPositionValues,
      allowedFromState: () =>
        new Set((entryManagerState.filters.position ?? []).map((value) => String(value))),
      datasetKey: FILTER_DATASET_KEYS.position,
      getEntryValue: (entry) => String(entry.position ?? ''),
    });
  };

  const applyEntryManagerRecursionFilterToRow = (row, entryData, precomputed = null) => {
    const recursionValues = precomputed?.values ?? entryManagerState.recursionValues ?? [];
    if (!recursionValues.length) {
      setEntryManagerRowFilterState(row, FILTER_DATASET_KEYS.recursion, false);
      return;
    }
    const selectedRecursionFilters =
      precomputed?.selectedFilters ?? entryManagerState.filters.recursion ?? [];
    const allowed = precomputed?.allowed ?? new Set(selectedRecursionFilters);
    if (selectedRecursionFilters.length === recursionValues.length) {
      setEntryManagerRowFilterState(row, FILTER_DATASET_KEYS.recursion, false);
      return;
    }
    const hasDelayUntilRecursion = Number(entryData?.delayUntilRecursion) > 0;
    const entryFlags = [
      entryData?.excludeRecursion ? 'excludeRecursion' : null,
      entryData?.preventRecursion ? 'preventRecursion' : null,
      hasDelayUntilRecursion ? 'delayUntilRecursion' : null,
    ].filter(Boolean);
    const matches = entryFlags.some((flag) => allowed.has(flag));
    setEntryManagerRowFilterState(row, FILTER_DATASET_KEYS.recursion, !matches);
  };

  const applyEntryManagerOutletFilterToRow = (row, entryData, precomputed = null) => {
    applySimpleSetFilterToRow({
      row,
      entryData,
      precomputed,
      valuesFromState: () => entryManagerState.outletValues,
      valuesFromSource: getOutletValues,
      allowedFromState: () => new Set(entryManagerState.filters.outlet ?? []),
      datasetKey: FILTER_DATASET_KEYS.outlet,
      getEntryValue: getOutletValue,
    });
  };

  const applyEntryManagerAutomationIdFilterToRow = (row, entryData, precomputed = null) => {
    applySimpleSetFilterToRow({
      row,
      entryData,
      precomputed,
      valuesFromState: () => entryManagerState.automationIdValues,
      valuesFromSource: getAutomationIdValues,
      allowedFromState: () => new Set(entryManagerState.filters.automationId ?? []),
      datasetKey: FILTER_DATASET_KEYS.automationId,
      getEntryValue: getAutomationIdValue,
    });
  };

  const applyEntryManagerGroupFilterToRow = (row, entryData, precomputed = null) => {
    const getGroupMatchValue = (entry) => normalizeGroupValuesForFilter(getGroupValue(entry));
    const values =
      precomputed?.values ??
      (entryManagerState.groupValues.length ? entryManagerState.groupValues : getGroupValues());
    if (!values.length) {
      setEntryManagerRowFilterState(row, FILTER_DATASET_KEYS.group, false);
      return;
    }

    const allowed = precomputed?.allowed ?? new Set(entryManagerState.filters.group ?? []);
    const matches = getGroupMatchValue(entryData).some((value) => allowed.has(value));
    setEntryManagerRowFilterState(row, FILTER_DATASET_KEYS.group, !matches);
  };

  // R21 — a fixed two-value set, so it follows the recursion filter's shape:
  // every value ticked means the toggle is off and no row is hidden.
  const applyEntryManagerCharacterFilterPresenceFilterToRow = (
    row,
    entryData,
    precomputed = null,
  ) => {
    const selected =
      precomputed?.selectedFilters ?? entryManagerState.filters.characterFilterPresence ?? [];
    if (selected.length === CHARACTER_FILTER_PRESENCE_VALUES.length) {
      setEntryManagerRowFilterState(row, FILTER_DATASET_KEYS.characterFilterPresence, false);
      return;
    }
    const allowed = precomputed?.allowed ?? new Set(selected);
    setEntryManagerRowFilterState(
      row,
      FILTER_DATASET_KEYS.characterFilterPresence,
      !allowed.has(getCharacterFilterPresenceValue(entryData)),
    );
  };

  // R22 — inverted convention (see logic.state.js): nothing picked means off.
  const applyEntryManagerCharacterFilterValueFilterToRow = (row, entryData, precomputed = null) => {
    const allowed =
      precomputed?.allowed ?? new Set(entryManagerState.filters.characterFilterValue ?? []);
    setEntryManagerRowFilterState(
      row,
      FILTER_DATASET_KEYS.characterFilterValue,
      !entryMatchesCharacterFilterValues(entryData, allowed),
    );
  };

  return {
    applyEntryManagerCharacterFilterPresenceFilterToRow,
    applyEntryManagerCharacterFilterValueFilterToRow,
    applyEntryManagerStrategyFilterToRow,
    applyEntryManagerPositionFilterToRow,
    applyEntryManagerRecursionFilterToRow,
    applyEntryManagerOutletFilterToRow,
    applyEntryManagerAutomationIdFilterToRow,
    applyEntryManagerGroupFilterToRow,
  };
};

const createBookFilterAppliers = ({
  dom,
  entryManagerState,
  getEntryManagerSourceEntries,
  batchRowFilterUpdates,
  applyEntryManagerCharacterFilterPresenceFilterToRow,
  applyEntryManagerCharacterFilterValueFilterToRow,
  getStrategyValues,
  getPositionValues,
  getOutletValues,
  getAutomationIdValues,
  getGroupValues,
  applyEntryManagerStrategyFilterToRow,
  applyEntryManagerPositionFilterToRow,
  applyEntryManagerRecursionFilterToRow,
  applyEntryManagerOutletFilterToRow,
  applyEntryManagerAutomationIdFilterToRow,
  applyEntryManagerGroupFilterToRow,
}) => {
  // Filtering never changes row order. Read the scoped source directly instead
  // of reconstructing and sorting every entry for each column predicate.
  const forEachEntryRowInBook = (book, callback) => {
    for (const entry of getEntryManagerSourceEntries(book)) {
      const row = dom.order.entries?.[entry.book]?.[entry.data.uid];
      if (row) callback({ entry, row });
    }
  };

  const simpleContext = (key, getValues, normalize = (value) => value) => ({
    values: entryManagerState[key + 'Values'].length
      ? entryManagerState[key + 'Values']
      : getValues(),
    allowed: new Set((entryManagerState.filters[key] ?? []).map(normalize)),
  });
  const filters = {
    strategy: {
      apply: applyEntryManagerStrategyFilterToRow,
      prepare: () => simpleContext('strategy', getStrategyValues),
    },
    position: {
      apply: applyEntryManagerPositionFilterToRow,
      prepare: () => simpleContext('position', getPositionValues, String),
    },
    recursion: {
      apply: applyEntryManagerRecursionFilterToRow,
      prepare: () => ({
        values: entryManagerState.recursionValues ?? [],
        selectedFilters: entryManagerState.filters.recursion ?? [],
        allowed: new Set(entryManagerState.filters.recursion ?? []),
      }),
    },
    outlet: {
      apply: applyEntryManagerOutletFilterToRow,
      prepare: () => simpleContext('outlet', getOutletValues),
    },
    automationId: {
      apply: applyEntryManagerAutomationIdFilterToRow,
      prepare: () => simpleContext('automationId', getAutomationIdValues),
    },
    group: {
      apply: applyEntryManagerGroupFilterToRow,
      prepare: () => simpleContext('group', getGroupValues),
    },
    characterFilterPresence: {
      apply: applyEntryManagerCharacterFilterPresenceFilterToRow,
      prepare: () => ({
        selectedFilters: entryManagerState.filters.characterFilterPresence ?? [],
        allowed: new Set(entryManagerState.filters.characterFilterPresence ?? []),
      }),
    },
    characterFilterValue: {
      apply: applyEntryManagerCharacterFilterValueFilterToRow,
      prepare: () => ({ allowed: new Set(entryManagerState.filters.characterFilterValue ?? []) }),
    },
  };

  const applyFilters = (key) => {
    const { apply, prepare } = filters[key];
    const context = prepare();
    forEachEntryRowInBook(entryManagerState.book, ({ entry, row }) => {
      apply(row, entry.data, context);
    });
  };

  // Build once after header filters have been normalized, then apply all column
  // predicates as each row is created. One class update per row, no final table
  // scans or sorts, and all this work shares the row builder's time budget.
  const createEntryManagerRowFilter = () => {
    const prepared = Object.values(filters).map(({ apply, prepare }) => ({
      apply,
      context: prepare(),
    }));
    return (row, entryData) => batchRowFilterUpdates(row, () => {
      for (const { apply, context } of prepared) apply(row, entryData, context);
    });
  };

  return {
    forEachEntryRowInBook,
    createEntryManagerRowFilter,
    applyEntryManagerStrategyFilters: () => applyFilters('strategy'),
    applyEntryManagerPositionFilters: () => applyFilters('position'),
    applyEntryManagerRecursionFilters: () => applyFilters('recursion'),
    applyEntryManagerOutletFilters: () => applyFilters('outlet'),
    applyEntryManagerAutomationIdFilters: () => applyFilters('automationId'),
    applyEntryManagerGroupFilters: () => applyFilters('group'),
    applyEntryManagerCharacterFilterPresenceFilters: () => applyFilters('characterFilterPresence'),
    applyEntryManagerCharacterFilterValueFilters: () => applyFilters('characterFilterValue'),
  };
};

const createFilterSyncHelpers = ({
  dom,
  entryManagerState,
  forEachEntryRowInBook,
  getStrategyValues,
  getPositionValues,
  getOutletValues,
  getAutomationIdValues,
  getGroupValues,
  normalizeStrategyFilters,
  normalizePositionFilters,
  normalizeOutletFilters,
  normalizeAutomationIdFilters,
  normalizeGroupFilters,
  normalizeCharacterFilterValueFilters,
  setEntryManagerRowFilterState,
}) => {
  const syncSelectableFilters = ({
    getNextValues,
    getPrevValues,
    getSelectedFilters,
    setNextValues,
    setSelectedFilters,
    normalizeSelectedFilters,
  }) => {
    const nextValues = getNextValues();
    const previousValues = getPrevValues();
    const selectedFilters = getSelectedFilters();
    const hadAllSelected = selectedFilters.length === previousValues.length;

    setNextValues(nextValues);
    if (!nextValues.length) {
      setSelectedFilters([]);
      return;
    }

    if (hadAllSelected || !selectedFilters.length) {
      setSelectedFilters([...nextValues]);
      return;
    }

    setSelectedFilters(normalizeSelectedFilters(selectedFilters));
  };

  const clearEntryManagerScriptFilters = () => {
    dom.order.filter.cancel?.();
    forEachEntryRowInBook(entryManagerState.book, ({ row }) => {
      setEntryManagerRowFilterState(row, FILTER_DATASET_KEYS.script, false);
    });
  };

  const syncEntryManagerStrategyFilters = () => {
    syncSelectableFilters({
      getNextValues: getStrategyValues,
      getPrevValues: () => entryManagerState.strategyValues,
      getSelectedFilters: () => entryManagerState.filters.strategy,
      setNextValues: (values) => {
        entryManagerState.strategyValues = values;
      },
      setSelectedFilters: (filters) => {
        entryManagerState.filters.strategy = filters;
      },
      normalizeSelectedFilters: normalizeStrategyFilters,
    });
  };

  const syncEntryManagerPositionFilters = () => {
    syncSelectableFilters({
      getNextValues: getPositionValues,
      getPrevValues: () => entryManagerState.positionValues,
      getSelectedFilters: () => entryManagerState.filters.position,
      setNextValues: (values) => {
        entryManagerState.positionValues = values;
      },
      setSelectedFilters: (filters) => {
        entryManagerState.filters.position = filters;
      },
      normalizeSelectedFilters: normalizePositionFilters,
    });
  };

  const syncEntryManagerOutletFilters = () => {
    syncSelectableFilters({
      getNextValues: getOutletValues,
      getPrevValues: () => entryManagerState.outletValues,
      getSelectedFilters: () => entryManagerState.filters.outlet,
      setNextValues: (values) => {
        entryManagerState.outletValues = values;
      },
      setSelectedFilters: (filters) => {
        entryManagerState.filters.outlet = filters;
      },
      normalizeSelectedFilters: normalizeOutletFilters,
    });
  };

  const syncEntryManagerAutomationIdFilters = () => {
    syncSelectableFilters({
      getNextValues: getAutomationIdValues,
      getPrevValues: () => entryManagerState.automationIdValues,
      getSelectedFilters: () => entryManagerState.filters.automationId,
      setNextValues: (values) => {
        entryManagerState.automationIdValues = values;
      },
      setSelectedFilters: (filters) => {
        entryManagerState.filters.automationId = filters;
      },
      normalizeSelectedFilters: normalizeAutomationIdFilters,
    });
  };

  const syncEntryManagerGroupFilters = () => {
    syncSelectableFilters({
      getNextValues: getGroupValues,
      getPrevValues: () => entryManagerState.groupValues,
      getSelectedFilters: () => entryManagerState.filters.group,
      setNextValues: (values) => {
        entryManagerState.groupValues = values;
      },
      setSelectedFilters: (filters) => {
        entryManagerState.filters.group = filters;
      },
      normalizeSelectedFilters: normalizeGroupFilters,
    });
  };

  // R22 — the offered values change with the roster and with the loaded entries,
  // so a pick that is no longer offered is dropped. Nothing is ever auto-picked:
  // an empty selection is this filter's "off" state, not a missing default.
  const syncEntryManagerCharacterFilterValueFilters = () => {
    const selected = entryManagerState.filters.characterFilterValue ?? [];
    if (!selected.length) {
      entryManagerState.filters.characterFilterValue = [];
      return;
    }
    entryManagerState.filters.characterFilterValue = normalizeCharacterFilterValueFilters(selected);
  };

  return {
    clearEntryManagerScriptFilters,
    syncEntryManagerCharacterFilterValueFilters,
    syncEntryManagerStrategyFilters,
    syncEntryManagerPositionFilters,
    syncEntryManagerOutletFilters,
    syncEntryManagerAutomationIdFilters,
    syncEntryManagerGroupFilters,
  };
};

const createEntryManagerFilters = ({
  dom,
  entryManagerState,
  entryState,
  getEntryManagerSourceEntries,
  getStrategyValues,
  getPositionValues,
  getOutletValues,
  getOutletValue,
  getAutomationIdValues,
  getAutomationIdValue,
  getGroupValues,
  getGroupValue,
  getCharacterFilterValueKeys,
}) => {
  const {
    normalizeStrategyFilters,
    normalizePositionFilters,
    normalizeOutletFilters,
    normalizeAutomationIdFilters,
    normalizeGroupFilters,
    normalizeCharacterFilterValueFilters,
    normalizeGroupValuesForFilter,
  } = createFilterNormalizers({
    getStrategyValues,
    getPositionValues,
    getOutletValues,
    getAutomationIdValues,
    getGroupValues,
    getCharacterFilterValueKeys,
  });

  const { setEntryManagerRowFilterState, batchRowFilterUpdates } = createRowFilterStateHelpers();

  const {
    applyEntryManagerStrategyFilterToRow,
    applyEntryManagerPositionFilterToRow,
    applyEntryManagerRecursionFilterToRow,
    applyEntryManagerOutletFilterToRow,
    applyEntryManagerAutomationIdFilterToRow,
    applyEntryManagerGroupFilterToRow,
    applyEntryManagerCharacterFilterPresenceFilterToRow,
    applyEntryManagerCharacterFilterValueFilterToRow,
  } = createRowFilterAppliers({
    entryManagerState,
    entryState,
    getStrategyValues,
    getPositionValues,
    getOutletValues,
    getOutletValue,
    getAutomationIdValues,
    getAutomationIdValue,
    getGroupValues,
    getGroupValue,
    normalizeGroupValuesForFilter,
    setEntryManagerRowFilterState,
  });

  const {
    forEachEntryRowInBook,
    createEntryManagerRowFilter,
    applyEntryManagerStrategyFilters,
    applyEntryManagerPositionFilters,
    applyEntryManagerRecursionFilters,
    applyEntryManagerOutletFilters,
    applyEntryManagerAutomationIdFilters,
    applyEntryManagerGroupFilters,
    applyEntryManagerCharacterFilterPresenceFilters,
    applyEntryManagerCharacterFilterValueFilters,
  } = createBookFilterAppliers({
    batchRowFilterUpdates,
    dom,
    entryManagerState,
    getEntryManagerSourceEntries,
    applyEntryManagerCharacterFilterPresenceFilterToRow,
    applyEntryManagerCharacterFilterValueFilterToRow,
    getStrategyValues,
    getPositionValues,
    getOutletValues,
    getAutomationIdValues,
    getGroupValues,
    applyEntryManagerStrategyFilterToRow,
    applyEntryManagerPositionFilterToRow,
    applyEntryManagerRecursionFilterToRow,
    applyEntryManagerOutletFilterToRow,
    applyEntryManagerAutomationIdFilterToRow,
    applyEntryManagerGroupFilterToRow,
  });

  const {
    clearEntryManagerScriptFilters,
    syncEntryManagerStrategyFilters,
    syncEntryManagerPositionFilters,
    syncEntryManagerOutletFilters,
    syncEntryManagerAutomationIdFilters,
    syncEntryManagerGroupFilters,
    syncEntryManagerCharacterFilterValueFilters,
  } = createFilterSyncHelpers({
    dom,
    entryManagerState,
    forEachEntryRowInBook,
    getStrategyValues,
    getPositionValues,
    getOutletValues,
    getAutomationIdValues,
    getGroupValues,
    normalizeStrategyFilters,
    normalizePositionFilters,
    normalizeOutletFilters,
    normalizeAutomationIdFilters,
    normalizeGroupFilters,
    normalizeCharacterFilterValueFilters,
    setEntryManagerRowFilterState,
  });

  return {
    createEntryManagerRowFilter,
    applyEntryManagerCharacterFilterPresenceFilterToRow,
    applyEntryManagerCharacterFilterPresenceFilters,
    applyEntryManagerCharacterFilterValueFilterToRow,
    applyEntryManagerCharacterFilterValueFilters,
    normalizeCharacterFilterValueFilters,
    syncEntryManagerCharacterFilterValueFilters,
    applyEntryManagerRecursionFilterToRow,
    applyEntryManagerRecursionFilters,
    applyEntryManagerPositionFilterToRow,
    applyEntryManagerPositionFilters,
    applyEntryManagerOutletFilterToRow,
    applyEntryManagerOutletFilters,
    applyEntryManagerAutomationIdFilterToRow,
    applyEntryManagerAutomationIdFilters,
    applyEntryManagerGroupFilterToRow,
    applyEntryManagerGroupFilters,
    applyEntryManagerStrategyFilterToRow,
    applyEntryManagerStrategyFilters,
    clearEntryManagerScriptFilters,
    normalizeOutletFilters,
    normalizeAutomationIdFilters,
    normalizeGroupFilters,
    normalizePositionFilters,
    normalizeStrategyFilters,
    setEntryManagerRowFilterState,
    syncEntryManagerOutletFilters,
    syncEntryManagerAutomationIdFilters,
    syncEntryManagerGroupFilters,
    syncEntryManagerPositionFilters,
    syncEntryManagerStrategyFilters,
  };
};

export { createEntryManagerFilters };
