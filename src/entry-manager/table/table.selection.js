/** Per-render counters; row identities never outlive their table. */
export function createSelectionCounter() {
  const rows = new WeakMap();
  let total = 0;
  let selected = 0;
  let visible = 0;
  let visibleSelected = 0;
  return {
    setSelected(row, value, filtered = false) {
      let state = rows.get(row);
      if (!state) {
        state = { selected: false, filtered };
        rows.set(row, state);
        total++;
        if (!filtered) visible++;
      }
      if (state.selected === value) return;
      const delta = value ? 1 : -1;
      selected += delta;
      if (!state.filtered) visibleSelected += delta;
      state.selected = value;
    },
    setFiltered(row, value) {
      const state = rows.get(row);
      if (!state || state.filtered === value) return;
      const delta = value ? -1 : 1;
      visible += delta;
      if (state.selected) visibleSelected += delta;
      state.filtered = value;
    },
    remove(row) {
      const state = rows.get(row);
      if (!state) return;
      total--;
      if (state.selected) selected--;
      if (!state.filtered) {
        visible--;
        if (state.selected) visibleSelected--;
      }
      rows.delete(row);
    },
    snapshot: () => ({ total, selected, visible, visibleSelected }),
  };
}
