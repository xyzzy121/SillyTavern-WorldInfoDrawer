import { createWorkBudget } from '../../shared/utils.js';

// All reads made by a browser instance share the same limit and pending-name
// lookup, including incremental renders that overlap a full list load.
export const createBookLoader = (loadWorldInfo, concurrency = 4) => {
  const pending = [];
  const inFlight = new Map();
  let active = 0;
  let disposed = false;

  const drain = () => {
    while (!disposed && active < concurrency && pending.length) {
      const job = pending.shift();
      active += 1;
      const finish = (settle, value) => {
        active -= 1;
        inFlight.delete(job.name);
        settle(value);
        drain();
      };
      Promise.resolve()
        .then(() => disposed ? null : loadWorldInfo(job.name))
        .then(
          (data) => finish(job.resolve, data),
          (error) => finish(job.reject, error),
        );
    }
  };

  const load = (name) => {
    if (disposed) return Promise.resolve(null);
    if (inFlight.has(name)) return inFlight.get(name);
    const promise = new Promise((resolve, reject) => pending.push({ name, resolve, reject }));
    inFlight.set(name, promise);
    drain();
    return promise;
  };

  const loadMany = async (names, isCurrent = () => true) => {
    const results = new Array(names.length);
    let nextIndex = 0;
    let failure = null;
    const worker = async () => {
      const checkpoint = createWorkBudget();
      while (!disposed && isCurrent() && !failure && nextIndex < names.length) {
        const index = nextIndex++;
        const name = names[index];
        try {
          const data = await load(name);
          if (disposed || !isCurrent()) return;
          if (data && typeof data === 'object') results[index] = { name, data };
          else console.warn(`[STWID] loadList: skipping book with invalid payload — "${name}"`);
          const pause = checkpoint();
          if (pause) await pause;
        } catch (error) {
          failure = { error };
        }
      }
    };
    // Every worker settles before returning, including after failure, so no
    // abandoned read can produce an unhandled rejection or mutate the next run.
    await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
    if (disposed || !isCurrent()) return null;
    if (failure) throw failure.error;
    return results.filter(Boolean);
  };

  return {
    load,
    loadMany,
    dispose() {
      disposed = true;
      for (const job of pending.splice(0)) {
        inFlight.delete(job.name);
        job.resolve(null);
      }
    },
  };
};
