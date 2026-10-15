// The host editor and Browser rows use the same icon-only entry toggle. Keep
// its accessible state aligned with the icon while the existing click handler
// continues to own data changes, originalData mirroring and saving.
const wiredToggles = new WeakSet();

export const syncEntryToggleChecked = (element) => {
  if (!element) return;
  const checked = String(element.classList.contains('fa-toggle-on'));
  if (element.getAttribute('aria-checked') !== checked) {
    element.setAttribute('aria-checked', checked);
  }
};

export const applyEntryToggleA11y = (element) => {
  if (!element || wiredToggles.has(element)) return false;
  wiredToggles.add(element);
  if (element.getAttribute('tabindex') === null) element.setAttribute('tabindex', '0');
  element.setAttribute('role', 'switch');
  if (element.getAttribute('aria-label') === null) {
    element.setAttribute('aria-label', element.title || "Toggle entry's active state");
  }
  syncEntryToggleChecked(element);

  // Native buttons already synthesize their own keyboard click. The current
  // host uses a div; avoid a second activation if that changes in the future.
  if (element.tagName !== 'BUTTON') {
    element.addEventListener('keydown', (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || element.disabled || element.getAttribute('aria-disabled') === 'true') return;
      element.click();
    });
  }
  // Apply this helper after the host/Browser click handler is registered. Both
  // change their icon synchronously, before awaiting persistence.
  element.addEventListener('click', () => syncEntryToggleChecked(element));
  return true;
};
