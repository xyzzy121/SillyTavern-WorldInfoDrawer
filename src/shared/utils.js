import { SORT, SORT_DIRECTION } from './constants.js';

const SORT_OPTIONS = [
  ['Custom', SORT.CUSTOM, SORT_DIRECTION.ASCENDING],
  ['Title A-Z', SORT.TITLE, SORT_DIRECTION.ASCENDING],
  ['Title Z-A', SORT.TITLE, SORT_DIRECTION.DESCENDING],
  ['Position ↗', SORT.POSITION, SORT_DIRECTION.ASCENDING],
  ['Position ↘', SORT.POSITION, SORT_DIRECTION.DESCENDING],
  ['Depth ↗', SORT.DEPTH, SORT_DIRECTION.ASCENDING],
  ['Depth ↘', SORT.DEPTH, SORT_DIRECTION.DESCENDING],
  ['Order ↗', SORT.ORDER, SORT_DIRECTION.ASCENDING],
  ['Order ↘', SORT.ORDER, SORT_DIRECTION.DESCENDING],
  ['UID ↗', SORT.UID, SORT_DIRECTION.ASCENDING],
  ['UID ↘', SORT.UID, SORT_DIRECTION.DESCENDING],
  ['Trigger ↗', SORT.TRIGGER, SORT_DIRECTION.ASCENDING],
  ['Trigger ↘', SORT.TRIGGER, SORT_DIRECTION.DESCENDING],
  ['Tokens ↗', SORT.LENGTH, SORT_DIRECTION.ASCENDING],
  ['Tokens ↘', SORT.LENGTH, SORT_DIRECTION.DESCENDING],
  ['Prompt ↗', SORT.PROMPT, SORT_DIRECTION.ASCENDING],
  ['Prompt ↘', SORT.PROMPT, SORT_DIRECTION.DESCENDING],
  // Ticket 07 — by how many characters + tags the entry's filter stores.
  ['Char/Tag Filter ↗', SORT.CHARACTER_FILTER, SORT_DIRECTION.ASCENDING],
  ['Char/Tag Filter ↘', SORT.CHARACTER_FILTER, SORT_DIRECTION.DESCENDING],
];

const createDeferred = () => {
  let resolve;

  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const safeToSorted = (array, comparator) =>
  typeof array.toSorted === 'function'
    ? array.toSorted(comparator)
    : array.slice().sort(comparator);

// scheduler.yield resumes in a new task without the nested-timer minimum delay.
// Older browsers still get a real task boundary through setTimeout.
const yieldToUi = () => typeof globalThis.scheduler?.yield === 'function'
  ? globalThis.scheduler.yield()
  : new Promise((resolve) => setTimeout(resolve, 0));

// Call once per work item; only await a non-null result. Reset the clock after
// yielding so time spent waiting for the browser is not charged to the next slice.
const createWorkBudget = ({ maxItems = 50, budgetMs = 8, now = () => performance.now(), yieldTask = yieldToUi } = {}) => {
  let started = now();
  let items = 0;
  return () => {
    items += 1;
    if (items < maxItems && now() - started < budgetMs) return null;
    return yieldTask().then(() => {
      items = 0;
      started = now();
    });
  };
};

// A task rather than a microtask lets the browser
// paint and handle input between batches.
const maybeYieldToEventLoop = async (index, batchSize) => {
  if ((index + 1) % batchSize !== 0) return;
  await yieldToUi();
};

const getSortLabel = (sort, direction) =>
  SORT_OPTIONS.find(
    ([, optionSort, optionDirection]) => optionSort === sort && optionDirection === direction,
  )?.[0];

const appendSortOptions = (select, currentSort, currentDirection) => {
  for (const [label, sort, direction] of SORT_OPTIONS) {
    const optionEl = document.createElement('option');
    optionEl.value = JSON.stringify({ sort, direction });
    optionEl.textContent = label;
    optionEl.selected = sort === currentSort && direction === currentDirection;
    select.append(optionEl);
  }
};

// Only a successfully resolved constructor is cached: a failed attempt (host
// still loading) must be retried on the next call instead of ending the
// feature for the whole session.
let slashCommandParserCtor = null;
const getSlashCommandParserCtor = async () => {
  if (typeof slashCommandParserCtor === 'function') return slashCommandParserCtor;

  const runtimeCtor = globalThis.SlashCommandParser;
  if (typeof runtimeCtor === 'function') {
    slashCommandParserCtor = runtimeCtor;
    return slashCommandParserCtor;
  }

  try {
    const module = await import('../../../../../slash-commands/SlashCommandParser.js');
    slashCommandParserCtor =
      typeof module?.SlashCommandParser === 'function' ? module.SlashCommandParser : null;
  } catch (error) {
    console.error('Failed to resolve SlashCommandParser', error);
    slashCommandParserCtor = null;
  }
  return slashCommandParserCtor;
};

const executeSlashCommand = async (command) => {
  try {
    const SlashCommandParser = await getSlashCommandParserCtor();
    if (typeof SlashCommandParser !== 'function') {
      console.error('Failed to execute slash command: SlashCommandParser is unavailable.');
      return false;
    }

    const parser = new SlashCommandParser();
    const commandClosure = parser.parse(command);
    if (!commandClosure || typeof commandClosure.execute !== 'function') {
      console.error('Failed to execute slash command: parser returned an invalid command closure.');
      return false;
    }

    await commandClosure.execute();
    return true;
  } catch (error) {
    console.error('Failed to execute slash command', error);
    return false;
  }
};

const parseBooleanSetting = (value, defaultValue) => {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return defaultValue;
};

// Memoized because the option comes from SillyTavern's static page markup and
// table builds read it once per entry. An unresolved lookup is never cached,
// so a missing template keeps being re-queried.
let outletPositionValue;
const getOutletPositionValue = () => {
  if (outletPositionValue !== undefined) return outletPositionValue;

  const value = document.querySelector(
    '#entry_edit_template [name="position"] option[data-i18n="Outlet"]',
  )?.value;
  if (value !== undefined) outletPositionValue = value;
  return value;
};

const isOutletPosition = (position) => {
  const outletValue = getOutletPositionValue();
  if (outletValue === undefined) return false;
  return String(position) === String(outletValue);
};

export {
  appendSortOptions,
  createDeferred,
  createWorkBudget,
  executeSlashCommand,
  getOutletPositionValue,
  getSortLabel,
  isOutletPosition,
  maybeYieldToEventLoop,
  parseBooleanSetting,
  safeToSorted,
  yieldToUi,
};
