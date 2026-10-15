import { applyMobileHeaderLayout, MOBILE_EDITOR_MEDIA_QUERY } from './editor-panel-mobile.js';
import { splitKeywordsAndRegexes } from '../shared/st-host.js';
import { closeOpenMultiselectDropdownMenus } from '../shared/multiselect-dropdown.js';
import { beginEntryNavigation, cancelEntryNavigation, hasPendingEntryNavigation, preserveEntryNavigation } from '../shared/entry-navigation.js';

const ACTIVE_STATE_CLASS = 'stwid--state-active';
const FOCUS_CLASS = 'stwid--focus';
const AMS_OPEN_CLASS = 'stwid--ams-open';
const MOBILE_PANEL_OPEN_CLASS = 'stwid--mobile-panel-open';
const AMS_WIRED_DATASET_VALUE = '1';
const EDITOR_EVENT_INPUT = 'input';
const EDITOR_EVENT_CHANGE = 'change';
const EDITOR_EVENT_KEYDOWN = 'keydown';
const EDITOR_CONTROL_SELECTOR = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

const sameEntryValue = (left, right) => {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && left.length !== right.length) return false;
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(right, key) && sameEntryValue(left[key], right[key]));
};

const controlSnapshot = (control) => {
  if (control.type === 'checkbox' || control.type === 'radio') return Boolean(control.checked);
  if (control.multiple) return JSON.stringify(Array.from(control.selectedOptions ?? [], (option) => option.value));
  return String(control.value ?? control.textContent ?? '');
};

// The host mutates its editor model at different times: content on input, keys
// after an asynchronous change handler. Compare the control's own field rather
// than inferring a commit from an unrelated change elsewhere in that model.
const controlMatchesEntry = (control, entry) => {
  const name = control.name;
  const value = String(control.value ?? '');
  const options = Array.from(control.selectedOptions ?? []);
  if (name === 'key' || name === 'keysecondary') {
    const keys = control.tagName === 'SELECT'
      ? options.map((option) => option.text ?? option.textContent ?? '')
      : splitKeywordsAndRegexes(value);
    return sameEntryValue(keys, entry[name] ?? []);
  }
  if (name === 'entryStateSelector') {
    const state = entry.constant ? 'constant' : entry.vectorized ? 'vectorized' : 'normal';
    return value === state;
  }
  if (name === 'entryLogicType') return Number(value) === entry.selectiveLogic;
  if (name === 'character_exclusion') return control.checked === Boolean(entry.characterFilter?.isExclude);
  if (name === 'characterFilter') {
    const names = options.filter((option) => option.dataset?.type === 'character')
      .map((option) => option.innerText ?? option.text ?? option.textContent ?? '');
    const tags = options.filter((option) => option.dataset?.type === 'tag').map((option) => option.value);
    return sameEntryValue(names, entry.characterFilter?.names ?? [])
      && sameEntryValue(tags, entry.characterFilter?.tags ?? []);
  }
  if (name === 'delay_until_recursion') return control.checked === Boolean(entry.delayUntilRecursion);
  if (name === 'delayUntilRecursionLevel') {
    if (!value) return typeof entry.delayUntilRecursion === 'boolean';
    const level = Number(value);
    return (Number.isNaN(level) ? false : level) === entry.delayUntilRecursion;
  }
  if (name === 'position') {
    const role = options[0]?.dataset?.role;
    return Number(value) === entry.position
      && (!role || Number(role) === entry.role);
  }
  if (name === 'scanDepth') {
    const depth = value === '' ? null : Math.floor(Number(value));
    return depth === entry.scanDepth;
  }
  if (name === 'group') return value.trim() === (entry.group ?? '');
  if (name && Object.hasOwn(entry, name)) {
    if (control.type === 'checkbox') return control.checked === Boolean(entry[name]);
    if (control.multiple) return sameEntryValue(options.map((option) => option.value), entry[name] ?? []);
    if (control.type === 'number' || typeof entry[name] === 'number') {
      const numeric = Number(value);
      return (Number.isNaN(numeric) ? null : numeric) === entry[name];
    }
    if (control.tagName === 'SELECT' && (typeof entry[name] === 'boolean' || entry[name] === null)) {
      return (value === 'null' ? null : value === 'true') === entry[name];
    }
    return value === String(entry[name] ?? '');
  }
  // Select2's search box holds an uncommitted tag/keyword until it is accepted.
  if (control.classList?.contains('select2-search__field')) return value.length === 0;
  return false;
};

const NON_EDITING_KEYS = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'CapsLock',
  'Tab',
  'Escape',
  'Enter',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
]);

const resetEditorOwnershipState = ({ setCurrentEditor, setCurrentEditorKey, setIsEditorDirty }) => {
  setCurrentEditor(null);
  setCurrentEditorKey(null);
  setIsEditorDirty(false);
};

const hasActivationSettingsDom = (activationBlock, activationBlockParent) => {
  return Boolean(activationBlock && activationBlockParent);
};

const hasValidEditorKey = (name, uid) => {
  return Boolean(name && uid !== null && uid !== undefined);
};

const wireEditorDirtyTracking = ({ dom, markEditorDirtyIfCurrent, shouldMarkDirtyOnKeydown }) => {
  const onEditorInput = markEditorDirtyIfCurrent;
  const onEditorChange = markEditorDirtyIfCurrent;
  const onEditorKeydown = (evt) => {
    if (shouldMarkDirtyOnKeydown(evt)) {
      markEditorDirtyIfCurrent(evt);
    }
  };

  dom.editor?.addEventListener?.(EDITOR_EVENT_INPUT, onEditorInput, true);
  dom.editor?.addEventListener?.(EDITOR_EVENT_CHANGE, onEditorChange, true);
  dom.editor?.addEventListener?.(EDITOR_EVENT_KEYDOWN, onEditorKeydown, true);

  const cleanup = () => {
    dom.editor?.removeEventListener?.(EDITOR_EVENT_INPUT, onEditorInput, true);
    dom.editor?.removeEventListener?.(EDITOR_EVENT_CHANGE, onEditorChange, true);
    dom.editor?.removeEventListener?.(EDITOR_EVENT_KEYDOWN, onEditorKeydown, true);
  };

  return { cleanup };
};

const createActivationSettingsController = ({
  activationBlock,
  activationBlockParent,
  clearEditor,
  clearEntryHighlights,
  dom,
  hideActivationSettings,
  resetEditorOwnership,
}) => {
  const renderActivationSettings = () => {
    clearEditor({ resetCurrent: false });
    if (dom.order.toggle.classList.contains(ACTIVE_STATE_CLASS)) {
      dom.order.toggle.click();
    }
    clearEntryHighlights();
    const activationHeading = document.createElement('h4');
    {
      activationHeading.textContent = 'Global World Info/Lorebook activation settings';
      dom.editor.append(activationHeading);
    }
    dom.editor.append(activationBlock);
    dom.drawer.body?.classList?.add(MOBILE_PANEL_OPEN_CLASS);
  };

  const showActivationSettings = () => {
    if (!hasActivationSettingsDom(activationBlock, activationBlockParent)) return;
    dom.activationToggle.classList.add(ACTIVE_STATE_CLASS);
    resetEditorOwnership();
    renderActivationSettings();
  };

  const toggleActivationSettings = () => {
    if (!hasActivationSettingsDom(activationBlock, activationBlockParent)) return;
    const isActive = dom.activationToggle.classList.toggle(ACTIVE_STATE_CLASS);
    resetEditorOwnership();
    if (isActive) {
      renderActivationSettings();
    } else {
      activationBlockParent.append(activationBlock);
      clearEditor({ resetCurrent: false });
    }
  };

  return {
    hideActivationSettings,
    showActivationSettings,
    toggleActivationSettings,
  };
};

const createFocusControls = ({ createFocusToggleButton, dom }) => {
  const appendUnfocusButton = () => {
    const unfocus = createFocusToggleButton('stwid--unfocus-toggle', 'fa-compress', 'Unfocus');
    dom.editor.append(unfocus);
  };

  const appendFocusButton = (entryEditorDom) => {
    const focusContainer =
      entryEditorDom.querySelector('label[for="content"] > small > span > span') ??
      entryEditorDom.querySelector('label[for="content "] > small > span > span');
    if (!focusContainer) return;
    const focusToggleButton = createFocusToggleButton('stwid--focus-toggle', 'fa-expand', 'Focus');
    focusContainer.append(focusToggleButton);
  };

  return { appendFocusButton, appendUnfocusButton };
};

const syncAmsDrawerIcon = ({ chevronIcon, isOpen }) => {
  if (!chevronIcon) return;
  chevronIcon.classList.toggle('up', isOpen);
  chevronIcon.classList.toggle('down', !isOpen);
  chevronIcon.classList.toggle('fa-circle-chevron-up', isOpen);
  chevronIcon.classList.toggle('fa-circle-chevron-down', !isOpen);
};

const wireAmsDrawerSection = (entryEditorDom, attempts = 0) => {
  if (!document.contains(entryEditorDom)) return;
  const amsHeader = entryEditorDom.querySelector('.userSettingsInnerExpandable');
  const amsDrawer = amsHeader?.closest('.inline-drawer');
  if (!amsHeader || !amsDrawer) {
    if (attempts < 30) {
      requestAnimationFrame(() => wireAmsDrawerSection(entryEditorDom, attempts + 1));
    }
    return;
  }

  if (amsDrawer.dataset.stwidAmsWired === AMS_WIRED_DATASET_VALUE) return;
  amsDrawer.dataset.stwidAmsWired = AMS_WIRED_DATASET_VALUE;

  amsDrawer.classList.add('stwid--ams');
  amsDrawer.classList.remove(AMS_OPEN_CLASS);
  amsDrawer.classList.remove('openDrawer');
  if (document.body.classList.contains('stwid--ams-disabled')) {
    amsDrawer.style.setProperty('display', 'none', 'important');
  } else {
    amsDrawer.style.removeProperty('display');
  }
  const chevronIcon = amsDrawer.querySelector('.inline-drawer-icon');
  syncAmsDrawerIcon({ chevronIcon, isOpen: false });

  amsHeader.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = amsDrawer.classList.toggle(AMS_OPEN_CLASS);
    syncAmsDrawerIcon({ chevronIcon, isOpen });
  });
};

const prepareToOpenEntryEditor = ({ getSelectFrom, isTokenCurrent, selectEnd }) => {
  if (!isTokenCurrent?.()) return false;
  if (getSelectFrom()) selectEnd();
  return true;
};

const buildEntryEditDom = async ({
  buildSavePayload,
  getWorldEntry,
  isTokenCurrent,
  name,
  entry,
}) => {
  if (!isTokenCurrent()) return null;
  const payload = buildSavePayload(name);
  const payloadEntry = payload?.entries?.[entry.uid];
  if (!payloadEntry) return null;
  const entryEditorDom = (await getWorldEntry(name, payload, payloadEntry))[0];
  const drawerToggle = entryEditorDom?.querySelector?.('.inline-drawer');
  if (drawerToggle) {
    $(drawerToggle).trigger('inline-drawer-toggle');
  }
  if (!isTokenCurrent()) return null;
  return { entryEditorDom, payloadEntry };
};

const renderEntryEditorDom = ({
  appendUnfocusButton,
  clearEditor,
  clearEntryHighlights,
  dom,
  entryEditorDom,
  entryRowDom,
  header,
}) => {
  clearEditor({ resetCurrent: false });
  clearEntryHighlights();
  entryRowDom.classList.add(ACTIVE_STATE_CLASS);
  appendUnfocusButton();
  dom.drawer.body?.classList?.add(MOBILE_PANEL_OPEN_CLASS);
  if (header) dom.editor.append(header);
  dom.editor.append(entryEditorDom);
  return entryRowDom;
};

const fetchEntryHeaderElement = async (renderTemplateAsync, isTokenCurrent) => {
  if (!isTokenCurrent()) return null;
  const headerTemplate = await renderTemplateAsync('worldInfoKeywordHeaders');
  if (!isTokenCurrent()) return null;
  return document
    .createRange()
    .createContextualFragment(headerTemplate)
    .querySelector('#WIEntryHeaderTitlesPC');
};

const fixTextpoleHeights = (entryEditorDom) => {
  // Separate the write/read/write phases so the browser only reflows once
  // instead of once per textarea (PERF-W4-06): reset both heights, then read
  // both scrollHeights, then apply both final heights.
  const textpoleTextareas = [
    ...entryEditorDom.querySelectorAll('.keyprimarytextpole, .keysecondarytextpole'),
  ];
  for (const textpoleTextarea of textpoleTextareas) {
    textpoleTextarea.style.height = '0px';
  }
  const finalHeights = textpoleTextareas.map(
    (textpoleTextarea) => textpoleTextarea.scrollHeight + 3,
  );
  textpoleTextareas.forEach((textpoleTextarea, index) => {
    textpoleTextarea.style.height = `${finalHeights[index]}px`;
  });
};

const createDirtyTracker = ({ dom }) => {
  let isEditorDirty = false;
  let currentEditorKey = null;
  let mountedEditor = null;
  let editorEntry = null;
  let hasUnknownDirtyControl = false;
  let cleanEntrySnapshot = null;
  const cleanControlSnapshots = new Map();
  const dirtyControls = new Set();

  const resetControlSnapshots = () => {
    cleanEntrySnapshot = JSON.stringify(editorEntry);
    cleanControlSnapshots.clear();
    for (const control of mountedEditor?.querySelectorAll(EDITOR_CONTROL_SELECTOR) ?? []) {
      cleanControlSnapshots.set(control, controlSnapshot(control));
    }
    dirtyControls.clear();
    hasUnknownDirtyControl = false;
  };

  const setMountedEditor = (element, entry) => {
    mountedEditor = element;
    editorEntry = entry;
    resetControlSnapshots();
  };

  const markEditorClean = (name, uid) => {
    if (!hasValidEditorKey(name, uid)) return;
    currentEditorKey = { name, uid };
    isEditorDirty = false;
    resetControlSnapshots();
  };

  const markEditorDirtyIfCurrent = (event) => {
    if (!currentEditorKey) return;
    const control = event?.target?.closest?.(EDITOR_CONTROL_SELECTOR);
    // A title/content save can finish while its textarea still has focus. Its
    // later blur emits change without another host save; do not reopen a clean
    // draft when both the control and model still match that acknowledged save.
    if (event?.type === EDITOR_EVENT_CHANGE && !isEditorDirty && control
      && cleanControlSnapshots.has(control)
      && controlSnapshot(control) === cleanControlSnapshots.get(control)
      && JSON.stringify(editorEntry) === cleanEntrySnapshot) return;
    isEditorDirty = true;
    if (control) dirtyControls.add(control);
    else hasUnknownDirtyControl = true;
  };

  const markSavedIfMatching = (savedEntry) => {
    if (!editorEntry || !savedEntry || hasUnknownDirtyControl || !sameEntryValue(editorEntry, savedEntry)) return false;
    for (const control of dirtyControls) {
      if (!mountedEditor?.contains(control)) continue;
      // A reverted control is safe only if the model also stayed at its clean
      // baseline. Otherwise a newer saved model may differ from that UI draft.
      if (cleanControlSnapshots.has(control)
        && controlSnapshot(control) === cleanControlSnapshots.get(control)
        && JSON.stringify(editorEntry) === cleanEntrySnapshot) continue;
      if (!controlMatchesEntry(control, editorEntry)) return false;
    }
    isEditorDirty = false;
    resetControlSnapshots();
    return true;
  };

  const shouldMarkDirtyOnKeydown = (evt) => {
    if (evt.ctrlKey || evt.metaKey || evt.altKey) return false;
    const pressedKey = evt.key;
    if (NON_EDITING_KEYS.has(pressedKey)) return false;

    const target = evt.target instanceof HTMLElement ? evt.target : null;
    if (!target) return false;
    return Boolean(
      target.closest('input, textarea, [contenteditable=""], [contenteditable="true"]'),
    );
  };

  const { cleanup } = wireEditorDirtyTracking({
    dom,
    markEditorDirtyIfCurrent,
    shouldMarkDirtyOnKeydown,
  });

  return {
    cleanup,
    markEditorClean,
    markSavedIfMatching,
    setMountedEditor,
    setCurrentEditorKey: (v) => {
      currentEditorKey = v;
      if (!v) setMountedEditor(null, null);
    },
    setIsEditorDirty: (v) => {
      isEditorDirty = v;
      if (!v) resetControlSnapshots();
    },
    getIsEditorDirty: () => isEditorDirty,
    getCurrentEditorKey: () => currentEditorKey,
  };
};

const createEditorClearer = ({ dom, resetEditorOwnership }) => {
  let activeEntryDom = null;

  const clearEntryHighlights = () => {
    if (activeEntryDom) {
      activeEntryDom.classList.remove(ACTIVE_STATE_CLASS);
      activeEntryDom = null;
    }
  };

  const clearEditor = ({ resetCurrent = true } = {}) => {
    cancelEntryNavigation();
    // Removing an ancestor does not trigger each popup's immediate-parent
    // observer. Close owned menus before detaching their document listeners.
    closeOpenMultiselectDropdownMenus(null, dom.editor);
    dom.order?.hydration?.dispose();
    dom.order?.cleanup?.();
    dom.order?.filter?.cancel?.();
    if (dom.order) {
      // A single child node retains its detached parent and the complete table.
      // Release every view-owned reference, while preserving the drawer toggle
      // and renderer cleanup hook that are reused when the manager reopens.
      dom.order.hydration = undefined;
      dom.order.entries = {};
      dom.order.tbody = undefined;
      dom.order.selection = undefined;
      dom.order.refreshSelectionCount = undefined;
      dom.order.sortSelect = undefined;
      dom.order.selectAll = undefined;
      dom.order.start = undefined;
      dom.order.step = undefined;
      if (dom.order.direction) {
        dom.order.direction.up = undefined;
        dom.order.direction.down = undefined;
      }
      if (dom.order.uid) dom.order.uid.start = undefined;
      if (dom.order.filter) {
        dom.order.filter.root = undefined;
        dom.order.filter.preview = undefined;
        dom.order.filter.cancel = undefined;
      }
    }
    dom.editor.innerHTML = '';
    dom.editor.classList.remove(FOCUS_CLASS);
    if (resetCurrent) {
      dom.drawer.body?.classList?.remove(MOBILE_PANEL_OPEN_CLASS);
      resetEditorOwnership();
    }
  };

  const setActiveEntryDom = (entryRowDom) => {
    activeEntryDom = entryRowDom;
  };

  return { clearEntryHighlights, clearEditor, setActiveEntryDom };
};

export const initEditorPanel = ({
  dom,
  activationBlock,
  activationBlockParent,
  renderTemplateAsync,
  getWorldEntry,
  buildSavePayload,
  setCurrentEditor,
  getSelectFrom,
  selectEnd,
}) => {
  const {
    cleanup,
    markEditorClean,
    markSavedIfMatching,
    setMountedEditor,
    setCurrentEditorKey,
    setIsEditorDirty,
    getIsEditorDirty,
    getCurrentEditorKey,
  } = createDirtyTracker({ dom });

  const resetEditorOwnership = () => {
    resetEditorOwnershipState({
      setCurrentEditor,
      setCurrentEditorKey,
      setIsEditorDirty,
    });
  };

  const { clearEntryHighlights, clearEditor, setActiveEntryDom } = createEditorClearer({
    dom,
    resetEditorOwnership,
  });

  // Responsive lifecycle for the open entry editor. The mobile header transform only runs
  // once at open time, so without this the editor keeps a stale layout when the viewport
  // crosses the 1000px breakpoint (e.g. window resize, phone rotation, split-screen).
  const editorLayoutMedia = window.matchMedia?.(MOBILE_EDITOR_MEDIA_QUERY);
  let currentEntryEditorDom = null;
  let reopenCurrentEditor = null;
  let openEditorIsMobileLayout = false;

  const handleEditorLayoutBreakpointChange = () => {
    if (!currentEntryEditorDom || !document.contains(currentEntryEditorDom)) return;
    const nowMobileLayout = editorLayoutMedia?.matches ?? false;
    if (nowMobileLayout === openEditorIsMobileLayout) return;

    if (nowMobileLayout) {
      // Entering mobile: restructure the live editor in place. applyMobileHeaderLayout
      // relocates existing nodes (it does not rebuild them), so unsaved edits survive.
      applyMobileHeaderLayout(currentEntryEditorDom);
      openEditorIsMobileLayout = true;
      return;
    }

    // Leaving mobile for desktop: the transform is destructive and not reversible in
    // place, so the only clean recovery is a full re-render from saved entry data. That
    // would discard unsaved edits, so re-render only when the editor is clean; otherwise
    // keep the user's current input intact even if the layout looks slightly off.
    if (getIsEditorDirty()) return;
    reopenCurrentEditor?.();
  };

  editorLayoutMedia?.addEventListener?.('change', handleEditorLayoutBreakpointChange);

  const resetEditorState = () => {
    if (dom.activationToggle.classList.contains(ACTIVE_STATE_CLASS)) {
      hideActivationSettings();
    } else {
      clearEditor();
    }
    clearEntryHighlights();
  };

  const hideActivationSettings = () => {
    if (!hasActivationSettingsDom(activationBlock, activationBlockParent)) return;
    dom.activationToggle.classList.remove(ACTIVE_STATE_CLASS);
    activationBlockParent.append(activationBlock);
    clearEditor({ resetCurrent: false });
    dom.drawer.body?.classList?.remove(MOBILE_PANEL_OPEN_CLASS);
    resetEditorOwnership();
  };

  const { showActivationSettings, toggleActivationSettings } = createActivationSettingsController({
    activationBlock,
    activationBlockParent,
    clearEditor,
    clearEntryHighlights,
    dom,
    hideActivationSettings,
    resetEditorOwnership,
  });

  const createFocusToggleButton = (toggleClass, iconClass, title) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', title);
    button.classList.add(toggleClass);
    button.classList.add('menu_button');
    button.classList.add('fa-solid', 'fa-fw', iconClass);
    button.title = title;
    button.addEventListener('click', () => {
      dom.editor.classList.toggle(FOCUS_CLASS);
    });
    return button;
  };

  const { appendFocusButton, appendUnfocusButton } = createFocusControls({
    createFocusToggleButton,
    dom,
  });

  const closeCompetingPanels = () => {
    if (dom.activationToggle.classList.contains(ACTIVE_STATE_CLASS)) {
      hideActivationSettings();
    }
    if (dom.order.toggle.classList.contains(ACTIVE_STATE_CLASS)) {
      dom.order.toggle.click();
    }
  };

  const renderEntryEditor = async ({ entry, entryDom: entryRowDom, name, isTokenCurrent, navigation }) => {
    if (getIsEditorDirty()) return false;
    const isCurrent = () => navigation.isCurrent() && (isTokenCurrent?.() ?? true) && !getIsEditorDirty();
    if (!prepareToOpenEntryEditor({ getSelectFrom, isTokenCurrent: isCurrent, selectEnd })) return false;
    preserveEntryNavigation(closeCompetingPanels);
    const header = await fetchEntryHeaderElement(renderTemplateAsync, isCurrent);
    if (!isCurrent()) return false;
    const editor = await buildEntryEditDom({
      buildSavePayload,
      getWorldEntry,
      isTokenCurrent: isCurrent,
      name,
      entry,
    });
    if (!editor || !isCurrent()) return false;
    const { entryEditorDom, payloadEntry } = editor;
    applyMobileHeaderLayout(entryEditorDom);
    appendFocusButton(entryEditorDom);
    preserveEntryNavigation(() => setActiveEntryDom(
      renderEntryEditorDom({
        appendUnfocusButton,
        clearEditor,
        clearEntryHighlights,
        dom,
        entryEditorDom,
        entryRowDom,
        header,
      }),
    ));
    wireAmsDrawerSection(entryEditorDom);
    fixTextpoleHeights(entryEditorDom);
    setCurrentEditor({ name, uid: entry.uid });
    setMountedEditor(entryEditorDom, payloadEntry);
    markEditorClean(name, entry.uid);

    // A failed navigation can supersede this editor's old request token while
    // leaving its DOM mounted. Layout reopening gets a fresh token only after
    // explicit navigation settles, and only while this editor still owns the panel.
    currentEntryEditorDom = entryEditorDom;
    reopenCurrentEditor = () => {
      if (hasPendingEntryNavigation() || currentEntryEditorDom !== entryEditorDom || !document.contains(entryEditorDom)) return;
      return openEntryEditor({ entry, entryDom: entryRowDom, name, isTokenCurrent: () => currentEntryEditorDom === entryEditorDom });
    };
    openEditorIsMobileLayout = editorLayoutMedia?.matches ?? false;
    return true;
  };

  const openEntryEditor = async (options) => {
    if (getIsEditorDirty()) return false;
    const navigation = options.navigation ?? beginEntryNavigation();
    try {
      return await renderEntryEditor({ ...options, navigation });
    } finally {
      if (!options.navigation) navigation.finish();
    }
  };

  const isDirty = (name, uid) => {
    if (!hasValidEditorKey(name, uid)) return false;
    return Boolean(
      getIsEditorDirty() &&
      getCurrentEditorKey()?.name === name &&
      String(getCurrentEditorKey()?.uid) === String(uid),
    );
  };

  const markClean = (name, uid) => {
    if (!hasValidEditorKey(name, uid)) return;
    if (getCurrentEditorKey()?.name !== name || String(getCurrentEditorKey()?.uid) !== String(uid)) return;
    setIsEditorDirty(false);
  };

  const markCleanIfSaved = (name, uid, savedEntry) => {
    if (!isDirty(name, uid)) return false;
    return markSavedIfMatching(savedEntry);
  };

  const cleanupEditorPanel = () => {
    cancelEntryNavigation();
    cleanup();
    setMountedEditor(null, null);
    editorLayoutMedia?.removeEventListener?.('change', handleEditorLayoutBreakpointChange);
  };

  return {
    cleanup: cleanupEditorPanel,
    clearEditor,
    clearEntryHighlights,
    hideActivationSettings,
    showActivationSettings,
    toggleActivationSettings,
    resetEditorState,
    openEntryEditor,
    isDirty,
    markClean,
    markCleanIfSaved,
  };
};
