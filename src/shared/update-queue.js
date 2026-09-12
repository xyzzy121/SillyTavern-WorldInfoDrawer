// The queue owns pending work, never book data. Each accepted caller settles
// after its batch is reconciled, including callers superseded by a newer payload.
export function createUpdateQueue({ processBatch, delayMs = 100 }) {
  const pending = new Map();
  let timer = null;
  let running = false;
  let disposed = false;
  let activeBatch = [];

  const cancelled = () => new DOMException('World Info update queue closed', 'AbortError');
  const drain = async () => {
    if (running || disposed) return;
    running = true;
    try {
      while (pending.size && !disposed) {
        const batch = [...pending.values()];
        activeBatch = batch;
        pending.clear();
        let errors;
        try {
          errors = await processBatch(batch, () => !disposed);
        } catch (error) {
          errors = new Map(batch.map(({ name }) => [name, error]));
        }
        for (const item of batch) {
          const error = disposed ? cancelled() : errors?.get(item.name);
          for (const waiter of item.waiters) {
            if (error) waiter.reject(error);
            else waiter.resolve();
          }
        }
        activeBatch = [];
      }
    } finally {
      running = false;
    }
  };

  const enqueue = (name = null, data = null, { immediate = false } = {}) => {
    if (disposed) return Promise.reject(cancelled());
    const key = name && data ? name : null;
    let item = pending.get(key);
    if (!item) {
      item = { name: key, data, waiters: [] };
      pending.set(key, item);
    } else {
      item.data = data;
    }
    const promise = new Promise((resolve, reject) => item.waiters.push({ resolve, reject }));
    if (immediate) {
      clearTimeout(timer);
      timer = null;
      // Start after the caller receives its promise, and coalesce same-turn calls.
      queueMicrotask(drain);
    } else if (!running && timer === null) {
      timer = setTimeout(() => {
        timer = null;
        void drain();
      }, delayMs);
    }
    return promise;
  };

  return {
    enqueue,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      timer = null;
      for (const item of pending.values()) {
        for (const waiter of item.waiters) waiter.reject(cancelled());
      }
      // Teardown must release callers even if a host request never settles.
      for (const item of activeBatch) {
        for (const waiter of item.waiters) waiter.reject(cancelled());
      }
      pending.clear();
    },
  };
}
