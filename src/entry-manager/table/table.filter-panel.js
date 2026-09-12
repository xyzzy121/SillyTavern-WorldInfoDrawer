import { createWorkBudget } from '../../shared/utils.js';
import { closeOpenCharacterFilterDropdown } from './table.body.character-filter.js';

const ROW_FILTER_KEY_SCRIPT = 'stwidFilterScript';
const FILTER_STORAGE_KEY = 'stwid--order-filter';
const DEFAULT_FILTER_SCRIPT = '{{var::entry}}';
const SCRIPT_FILTER_BATCH_SIZE = 100;

function getEntryManagerRow(dom, entryRef) {
  return dom.order.entries?.[entryRef.book]?.[entryRef.data.uid] ?? null;
}

function buildFilterPanelHint({ entryManagerState }) {
  const hintEl = document.createElement('div');
  hintEl.classList.add('stwid--hint');
  const bookContextHint = entryManagerState.book
    ? `<br>Book context: <code>${entryManagerState.book}</code> (entries are scoped to this book).`
    : '';
  hintEl.innerHTML = DOMPurify.sanitize(`
        Script will be called for each entry in all active books.
        Every entry for which the script returns <code>true</code> will be kept.
        Other entries will be filtered out.
        <br>
        Use <code>{{var::entry}}</code> to access the entry and its properties (look
        right for available fields).
        ${bookContextHint}
    `);
  return hintEl;
}

function buildFilterPanelHintAndError({ entryManagerState }) {
  const hintEl = buildFilterPanelHint({ entryManagerState });
  const errorEl = document.createElement('div');
  errorEl.classList.add('stwid--orderFilterError');
  errorEl.hidden = true;
  return { hintEl, errorEl };
}

function attachFilterScriptHandlers({
  dom,
  entryManagerState,
  getEntryManagerEntries,
  setEntryManagerRowFilterState,
  SlashCommandParser,
  debounce,
  hljs,
  isTrueBoolean,
  syntaxEl,
  filterScriptTextarea,
  errorEl,
}) {
  const filterRoot = dom.order.filter.root;
  let generation = 0;
  const cancel = () => { generation += 1; };
  dom.order.filter.cancel = cancel;

  const updateScroll = () => {
    syntaxEl.scrollTop = filterScriptTextarea.scrollTop;
  };
  const updateScrollDebounced = debounce(() => updateScroll(), 150);
  const updateHighlight = () => {
    const scriptText = `${filterScriptTextarea.value}${filterScriptTextarea.value.slice(-1) === '\n' ? ' ' : ''}`;
    syntaxEl.innerHTML = DOMPurify.sanitize(
      hljs.highlight(scriptText, { language: 'stscript', ignoreIllegals: true })?.value ?? '',
    );
  };
  const updateHighlightDebounced = debounce(() => updateHighlight(), 100);
  const saveFilterDebounced = debounce(
    () => localStorage.setItem(FILTER_STORAGE_KEY, filterScriptTextarea.value),
    200,
  );
  const isActive = () => dom.order.filter.root === filterRoot && filterRoot.isConnected &&
    filterRoot.classList.contains('stwid--state-active');

  const showFilterError = (message) => {
    if (!message) {
      errorEl.hidden = true;
      errorEl.textContent = '';
      return;
    }
    errorEl.hidden = false;
    errorEl.textContent = message;
  };

  const updateList = async () => {
    if (!isActive()) return;
    const runGeneration = ++generation;
    const tbody = dom.order.tbody;
    if (!tbody) return;
    const isCurrent = () => runGeneration === generation && isActive() && dom.order.tbody === tbody;
    const filterScriptSource = filterScriptTextarea.value;
    const book = entryManagerState.book;
    const checkpoint = createWorkBudget({ maxItems: SCRIPT_FILTER_BATCH_SIZE });

    closeOpenCharacterFilterDropdown();
    try {
      const Scope = await SlashCommandParser.getScope();
      if (!isCurrent()) return;
      const closure = new Scope();
      await closure.compile(`return async function entryManagerFilter(data) {${filterScriptSource}}();`);
      if (!isCurrent()) return;

      // Scripts run sequentially in the displayed sort order. Only the column
      // predicates use unordered traversal; scripts may depend on execution order.
      const entries = getEntryManagerEntries(book, true);
      for (const entryRef of entries) {
        if (!isCurrent()) return;
        const row = getEntryManagerRow(dom, entryRef);
        if (row) setEntryManagerRowFilterState(row, ROW_FILTER_KEY_SCRIPT, false);
        const pause = checkpoint();
        if (pause) await pause;
      }

      for (const entryRef of entries) {
        if (!isCurrent()) return;
        closure.scope.setVariable(
          'entry',
          JSON.stringify(Object.assign({ book: entryRef.book }, entryRef.data)),
        );
        const result = (await closure.execute()).pipe;
        // The previous script can still be executing when input, panel closure,
        // or a new table supersedes it. Never publish that obsolete result.
        if (!isCurrent()) return;
        const row = getEntryManagerRow(dom, entryRef);
        if (row) setEntryManagerRowFilterState(row, ROW_FILTER_KEY_SCRIPT, !isTrueBoolean(result));
        const pause = checkpoint();
        if (pause) await pause;
      }
      if (isCurrent()) showFilterError(null);
    } catch (error) {
      if (!isCurrent()) return;
      const msg = error instanceof Error ? error.message : String(error);
      showFilterError(`Filter error: ${msg}`);
    }
  };

  const updateListDebounced = debounce((expectedGeneration) => {
    if (expectedGeneration === generation) return updateList();
  }, 250);
  filterScriptTextarea.addEventListener('input', () => {
    // Stop an old run immediately; the debounce delays only the replacement.
    cancel();
    saveFilterDebounced();
    updateHighlightDebounced();
    updateScrollDebounced();
    updateListDebounced(generation);
  });
  filterScriptTextarea.addEventListener('scroll', () => {
    updateScrollDebounced();
  });
  filterScriptTextarea.style.color = 'transparent';
  filterScriptTextarea.style.background = 'transparent';
  filterScriptTextarea.style.setProperty('text-shadow', 'none', 'important');
  updateHighlight();
}

function buildFilterScriptEditor({
  dom,
  entryManagerState,
  getEntryManagerEntries,
  setEntryManagerRowFilterState,
  SlashCommandParser,
  debounce,
  hljs,
  isTrueBoolean,
  errorEl,
}) {
  const scriptPanel = document.createElement('div');
  scriptPanel.classList.add('stwid--script');

  const syntaxEl = document.createElement('pre');
  syntaxEl.classList.add('stwid--syntax');
  scriptPanel.append(syntaxEl);

  const overlay = document.createElement('div');
  overlay.classList.add('stwid--overlay');
  scriptPanel.append(overlay);

  const filterScriptTextarea = document.createElement('textarea');
  const storedFilter = localStorage.getItem(FILTER_STORAGE_KEY);
  filterScriptTextarea.classList.add('stwid--input');
  filterScriptTextarea.classList.add('text_pole');
  filterScriptTextarea.name = 'filter';
  filterScriptTextarea.value = storedFilter ?? DEFAULT_FILTER_SCRIPT;

  if (storedFilter === null || storedFilter === undefined) {
    localStorage.setItem(FILTER_STORAGE_KEY, filterScriptTextarea.value);
  }

  attachFilterScriptHandlers({
    dom,
    entryManagerState,
    getEntryManagerEntries,
    setEntryManagerRowFilterState,
    SlashCommandParser,
    debounce,
    hljs,
    isTrueBoolean,
    syntaxEl,
    filterScriptTextarea,
    errorEl,
  });

  scriptPanel.append(filterScriptTextarea);
  return scriptPanel;
}

function buildFilterPreview({ dom }) {
  const preview = document.createElement('div');
  dom.order.filter.preview = preview;
  preview.classList.add('stwid--preview');
  return preview;
}

export function buildFilterPanel({
  dom,
  entryManagerState,
  getEntryManagerEntries,
  setEntryManagerRowFilterState,
  SlashCommandParser,
  debounce,
  hljs,
  isTrueBoolean,
}) {
  const filter = document.createElement('div');
  dom.order.filter.root = filter;
  filter.classList.add('stwid--script-filter');

  const main = document.createElement('div');
  main.classList.add('stwid--main');

  const { hintEl, errorEl } = buildFilterPanelHintAndError({ entryManagerState });
  main.append(hintEl, errorEl);

  const scriptPanel = buildFilterScriptEditor({
    dom,
    entryManagerState,
    getEntryManagerEntries,
    setEntryManagerRowFilterState,
    SlashCommandParser,
    debounce,
    hljs,
    isTrueBoolean,
    errorEl,
  });
  main.append(scriptPanel);
  filter.append(main);

  const preview = buildFilterPreview({ dom });
  filter.append(preview);

  return filter;
}
