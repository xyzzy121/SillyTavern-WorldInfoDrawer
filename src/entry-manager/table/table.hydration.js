import { createWorkBudget } from '../../shared/utils.js';

const PENDING_CELL = 'td[data-stwid-pending]';
const CONTROL = 'input, select, textarea, button, .stwid--character-filter-trigger, .stwid--enabled';
const SCROLL_IDLE_MS = 120;

export function findVerticalScrollRoot(start) {
  const manager = start.closest?.('.stwid--entry-manager');
  for (let element = start; element; element = element.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(element).overflowY) && element.scrollHeight > element.clientHeight + 1) return element;
    if (element === manager) break;
  }
  return manager ?? start;
}

/** One observer and one cancellable queue for a complete manager render. */
export function createTableHydration({ tbody, isRenderCurrent, onDispose = () => {} }) {
  const pending = new Set();
  const nearViewport = new Set();
  let observer;
  let disposed = false;
  let running = false;
  let revision = 0;
  let scrollRoot;
  let startElement;
  let pointerCell;
  let pointerReleaseTimer;
  let scrollIdleTimer;
  let scrolling = false;
  let observerRevision = 0;

  const current = () => !disposed && isRenderCurrent();
  const drain = async () => {
    if (running || scrolling || !current()) return;
    running = true;
    const checkpoint = createWorkBudget({ maxItems: 12, budgetMs: 8 });
    try {
      while (pending.size && !scrolling && current()) {
        const row = pending.values().next().value;
        pending.delete(row);
        // Keep the native pointer target alive through pointerup/click even if
        // the observer's deferred delivery arrives between those two events.
        if (pointerCell && row.contains(pointerCell)) continue;
        if (row.isConnected && nearViewport.has(row) && !row.classList.contains('stwid--state-filtered')) {
          row.stwidHydrate?.();
        }
        const pause = checkpoint();
        if (pause) await pause;
      }
    } finally {
      running = false;
    }
  };
  const onScroll = () => {
    if (!current()) return;
    // Leave readable cells in place while scrolling. Building controls can
    // relayout the whole table, so resume only after the viewport has settled.
    scrolling = true;
    window.clearTimeout(scrollIdleTimer);
    scrollIdleTimer = window.setTimeout(() => {
      scrollIdleTimer = undefined;
      scrolling = false;
      void drain();
    }, SCROLL_IDLE_MS);
  };
  const releasePointer = () => {
    const row = pointerCell?.closest('tr');
    pointerCell = undefined;
    if (row && nearViewport.has(row) && current()) pending.add(row);
    void drain();
  };
  const deferPointerRelease = () => {
    window.clearTimeout(pointerReleaseTimer);
    pointerReleaseTimer = window.setTimeout(releasePointer, 0);
  };

  // A user can reach a cell through keyboard navigation or a very fast scroll
  // before the observer's work runs. Hydrate synchronously for that action.
  const activate = (event) => {
    const cell = event.target.closest?.(PENDING_CELL);
    if (!cell || !tbody.contains(cell) || !current()) return;
    if (event.type === 'pointerdown') {
      pointerCell = cell;
      return;
    }
    // Pointer focus precedes click. Replacing that target during focus would
    // prevent the browser from delivering the user's initiating click.
    if (event.type === 'focusin' && pointerCell === cell) return;
    if (event.type === 'keydown' && (event.ctrlKey || event.metaKey || event.altKey)) return;
    const row = cell.closest('tr');
    const col = cell.dataset.col;
    let moveDirection;
    if (col === 'drag' && event.type === 'click') {
      const bounds = cell.getBoundingClientRect();
      const relativeY = event.clientY - bounds.top;
      // The middle third is the native grip. Its click does not move the row,
      // and its target stays alive until Sortable finishes the pointer task.
      if (relativeY >= bounds.height / 3 && relativeY <= bounds.height * 2 / 3) return;
      moveDirection = relativeY > bounds.height * 2 / 3 ? 'down' : 'up';
    }
    const replacement = row.stwidHydrateCell?.(col);
    const control = moveDirection === 'down' ? replacement?.querySelector('button:last-child') : replacement?.querySelector(CONTROL);
    if (!control) return;
    control.focus?.({ preventScroll: true });
    if (event.type === 'click') {
      event.preventDefault();
      event.stopPropagation();
      if (control.tagName === 'SELECT' && typeof control.showPicker === 'function') {
        try { control.showPicker(); } catch { control.click(); }
      } else {
        control.click();
      }
      releasePointer();
    } else if (event.type === 'keydown') {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        control.click();
      } else if (event.key?.length === 1 && /^(INPUT|TEXTAREA)$/.test(control.tagName)) {
        event.preventDefault();
        control.value = event.key;
        control.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  };
  for (const type of ['pointerdown', 'click', 'focusin', 'keydown']) tbody.addEventListener(type, activate, true);

  const connectObserver = () => {
      if (!current()) return;
      const root = findVerticalScrollRoot(startElement);
      if (root === scrollRoot) return;
      scrollRoot?.removeEventListener('scroll', onScroll);
      window.clearTimeout(scrollIdleTimer);
      scrollIdleTimer = undefined;
      scrolling = false;
      scrollRoot = root;
      scrollRoot.addEventListener('scroll', onScroll, { passive: true });
      observer?.disconnect();
      nearViewport.clear();
      pending.clear();
      const connection = ++observerRevision;
      observer = new IntersectionObserver((records) => {
        if (!current() || connection !== observerRevision) return;
        for (const { target, isIntersecting } of records) {
          if (isIntersecting) {
            nearViewport.add(target);
            pending.add(target);
          } else {
            nearViewport.delete(target);
            pending.delete(target);
          }
        }
        // Add the whole delivery before draining, so one work budget covers
        // the observer callback even when many rows enter together.
        void drain();
      }, { root, rootMargin: '600px 0px', threshold: 0 });
      for (const row of tbody.children) observer.observe(row);
  };

  const api = {
    start(root) {
      startElement = root;
      connectObserver();
      window.addEventListener('resize', connectObserver);
      window.addEventListener('pointerup', deferPointerRelease);
      window.addEventListener('pointercancel', releasePointer);
    },
    async refreshColumns() {
      const generation = ++revision;
      const checkpoint = createWorkBudget({ maxItems: 100 });
      for (const row of tbody.children) {
        if (!current() || generation !== revision) return;
        row.stwidRefreshPending?.();
        if (nearViewport.has(row)) pending.add(row);
        const pause = checkpoint();
        if (pause) await pause;
      }
      void drain();
    },
    remove(row) {
      observer?.unobserve(row);
      nearViewport.delete(row);
      pending.delete(row);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      revision++;
      observer?.disconnect();
      window.removeEventListener('resize', connectObserver);
      window.removeEventListener('pointerup', deferPointerRelease);
      window.removeEventListener('pointercancel', releasePointer);
      window.clearTimeout(pointerReleaseTimer);
      scrollRoot?.removeEventListener('scroll', onScroll);
      window.clearTimeout(scrollIdleTimer);
      pending.clear();
      nearViewport.clear();
      pointerCell = undefined;
      for (const type of ['pointerdown', 'click', 'focusin', 'keydown']) tbody.removeEventListener(type, activate, true);
      onDispose();
    },
  };
  return api;
}
