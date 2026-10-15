// One ownership token spans lazy row materialization and asynchronous editor
// construction. Per-row tokens cannot order requests for different entries.
let generation = 0;
let preserveDepth = 0;
let pendingNavigation = null;

export const beginEntryNavigation = () => {
  const token = ++generation;
  const navigation = {
    isCurrent: () => token === generation,
    finish: () => { if (pendingNavigation === navigation) pendingNavigation = null; },
  };
  pendingNavigation = navigation;
  return navigation;
};

export const hasPendingEntryNavigation = () => pendingNavigation !== null;

export const cancelEntryNavigation = () => {
  if (!preserveDepth) {
    generation += 1;
    pendingNavigation = null;
  }
};

// Only synchronous internal panel changes belong here. A user action that
// arrives during an await must still invalidate the pending navigation.
export const preserveEntryNavigation = (callback) => {
  preserveDepth += 1;
  try { return callback(); }
  finally { preserveDepth -= 1; }
};
