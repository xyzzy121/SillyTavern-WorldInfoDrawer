// Moonlit removes this link when its theme is disabled but leaves other style
// elements behind. Its own link ID spells "Echos" without the second "e".
const MOONLIT_THEME_LINK_SELECTOR = 'link#MoonlitEchosTheme-style';
const MOONLIT_HOST_CLASS = 'stwid--host-moonlit';
const activeObservers = new WeakMap();

export const hasMoonlitTheme = (doc = document) =>
  Boolean(doc.head.querySelector(MOONLIT_THEME_LINK_SELECTOR));

export const applyHostCompatibilityClasses = (doc = document) => {
  const present = hasMoonlitTheme(doc);
  doc.body.classList.toggle(MOONLIT_HOST_CLASS, present);
  return present;
};

/** Watch only direct head additions/removals, once per page, with explicit cleanup. */
export const initHostCompatibility = (doc = document) => {
  const existing = activeObservers.get(doc);
  if (existing) return existing;

  applyHostCompatibilityClasses(doc);
  const observer = new MutationObserver(() => applyHostCompatibilityClasses(doc));
  const disconnect = () => {
    observer.disconnect();
    doc.defaultView?.removeEventListener('beforeunload', disconnect);
    if (activeObservers.get(doc) === api) activeObservers.delete(doc);
  };
  const api = { disconnect };
  observer.observe(doc.head, { childList: true });
  doc.defaultView?.addEventListener('beforeunload', disconnect, { once: true });
  activeObservers.set(doc, api);
  return api;
};

export { MOONLIT_HOST_CLASS };
