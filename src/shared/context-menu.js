import {
  closeOpenMultiselectDropdownMenus,
  MULTISELECT_DROPDOWN_CLOSE_HANDLER,
} from './multiselect-dropdown.js';

let activeMenu = null;
let nextMenuId = 0;

export const closeContextMenu = (owner = null) => {
  if (!owner || owner.contains(activeMenu?.trigger)) activeMenu?.close();
};

/** Body-portalled popup shared by lorebooks and folders. Only an open popup
 * owns document/viewport listeners; closing releases all of them. */
export const openContextMenu = ({ trigger, label, event, build }) => {
  if (activeMenu?.trigger === trigger) return;
  closeContextMenu();
  closeOpenMultiselectDropdownMenus();
  const blocker = document.createElement('div');
  blocker.className = 'stwid--blocker stwid--context-blocker';
  const menu = document.createElement('div');
  menu.className = 'stwid--list-dropdown__menu stwid--menu stwid--context-menu';
  menu.id = `stwid-context-menu-${++nextMenuId}`;
  menu.tabIndex = -1;
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-modal', 'true');
  menu.setAttribute('aria-label', label);
  let closed = false;
  let frame = 0;
  const viewport = window.visualViewport;
  const focusable = () => [...menu.querySelectorAll('button, select, input, a[href], [tabindex="0"]')]
    .filter(el => !el.disabled && el.getClientRects().length);

  const close = ({ restoreFocus = false } = {}) => {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(frame);
    observer.disconnect();
    window.removeEventListener('resize', schedulePosition);
    document.removeEventListener('scroll', onScroll, true);
    viewport?.removeEventListener('resize', schedulePosition);
    viewport?.removeEventListener('scroll', schedulePosition);
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('pagehide', close);
    delete menu[MULTISELECT_DROPDOWN_CLOSE_HANDLER];
    blocker.remove();
    trigger.style.anchorName = '';
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-controls');
    if (activeMenu?.menu === menu) activeMenu = null;
    if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true });
  };

  const position = () => {
    frame = 0;
    if (closed) return;
    if (!trigger.isConnected) { close(); return; }
    const insets = getComputedStyle(blocker);
    const left = (viewport?.offsetLeft ?? 0) + parseFloat(insets.paddingLeft || 0);
    const top = (viewport?.offsetTop ?? 0) + parseFloat(insets.paddingTop || 0);
    const right = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth)
      - parseFloat(insets.paddingRight || 0);
    const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight)
      - parseFloat(insets.paddingBottom || 0);
    menu.style.maxWidth = `${Math.max(0, right - left)}px`;
    menu.style.maxHeight = `${Math.max(0, bottom - top)}px`;
    menu.style.left = '0px';
    menu.style.top = '0px';
    const anchor = trigger.getBoundingClientRect();
    const rect = menu.getBoundingClientRect();
    const below = bottom - anchor.bottom - 4;
    const above = anchor.top - top - 4;
    let y = below >= rect.height || below >= above ? anchor.bottom + 4 : anchor.top - rect.height - 4;
    y = Math.max(top, Math.min(y, bottom - rect.height));
    const x = Math.max(left, Math.min(anchor.right - rect.width, right - rect.width));
    // Rect offsets account for themes that translate the body containing block.
    menu.style.left = `${x - rect.left}px`;
    menu.style.top = `${y - rect.top}px`;
  };
  const schedulePosition = () => { if (!closed && !frame) frame = requestAnimationFrame(position); };
  const onScroll = (evt) => { if (!menu.contains(evt.target)) schedulePosition(); };
  const onKeydown = (evt) => {
    if (evt.key === 'Escape') {
      evt.preventDefault();
      evt.stopImmediatePropagation();
      close({ restoreFocus: true });
    } else if (evt.key === 'Tab') {
      const items = focusable();
      const index = items.indexOf(document.activeElement);
      if (!items.length || index < 0 || (evt.shiftKey ? index === 0 : index === items.length - 1)) {
        evt.preventDefault();
        (evt.shiftKey ? items.at(-1) : items[0])?.focus({ preventScroll: true });
      }
    }
  };
  const observer = new MutationObserver(() => { if (!trigger.isConnected) close(); });
  build(menu, close);
  // Return focus before invoking the action, so refused/export actions have a
  // useful fallback. Dialog/navigation handlers take focus afterward; their
  // late close callbacks are no-ops. Native select interaction stays open.
  menu.addEventListener('click', evt => {
    if (evt.target.closest('button.stwid--menu-item')) close({ restoreFocus: true });
  }, true);
  for (const type of ['pointerdown', 'mousedown', 'touchstart']) {
    blocker.addEventListener(type, evt => evt.stopPropagation());
  }
  blocker.addEventListener('click', evt => {
    evt.stopPropagation();
    if (evt.target === blocker) close({ restoreFocus: true });
  });
  menu[MULTISELECT_DROPDOWN_CLOSE_HANDLER] = close;
  trigger.setAttribute('aria-expanded', 'true');
  trigger.setAttribute('aria-controls', menu.id);
  blocker.append(menu);
  document.body.append(blocker);
  activeMenu = { trigger, menu, close };
  position();
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', schedulePosition);
  viewport?.addEventListener('resize', schedulePosition);
  viewport?.addEventListener('scroll', schedulePosition);
  window.addEventListener('pagehide', close);
  observer.observe(document.body, { childList: true, subtree: true });
  const target = event?.detail === 0 ? focusable()[0] ?? menu : menu;
  target.focus({ preventScroll: true });
};
