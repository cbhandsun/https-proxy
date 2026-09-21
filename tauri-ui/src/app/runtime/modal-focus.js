// Keyboard containment for modal dialogs.
//
// The confirmation dialog used to move focus to "Cancel" and stop there: Tab
// could walk into the page behind the modal, and closing the dialog dropped
// focus onto <body>, so keyboard and screen-reader users lost their place in
// the app. This module keeps focus inside the dialog while it is open and hands
// focus back to the control that opened it.

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function isElementVisible(element) {
  if (!element) return false;
  if (element.hidden === true) return false;
  if (element.disabled === true) return false;
  if (element.getAttribute && element.getAttribute('aria-hidden') === 'true') return false;
  const style = element.style;
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  return true;
}

function getFocusableElements(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  return Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isElementVisible);
}

function focusElement(element) {
  if (!element || typeof element.focus !== 'function') return false;
  try {
    element.focus();
    return true;
  } catch (error) {
    return false;
  }
}

function createFocusTrap(options = {}) {
  const { root, documentRef, onEscape } = options;
  if (!root) throw new TypeError('createFocusTrap requires a root element');
  if (typeof onEscape !== 'function') throw new TypeError('createFocusTrap requires onEscape');

  let previouslyFocused = null;
  let active = false;

  function activate(initialFocus) {
    const doc = documentRef || (typeof document !== 'undefined' ? document : undefined);
    previouslyFocused = (doc && doc.activeElement) || null;
    active = true;
    if (focusElement(initialFocus)) return true;
    const focusable = getFocusableElements(root);
    return focusElement(focusable[0]);
  }

  function deactivate() {
    if (!active) return;
    active = false;
    const target = previouslyFocused;
    previouslyFocused = null;
    if (target && target.isConnected !== false && focusElement(target)) return true;
    return false;
  }

  function handleKeydown(event) {
    if (!active || !event) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      onEscape();
      return true;
    }
    if (event.key !== 'Tab') return false;

    const focusable = getFocusableElements(root);
    if (focusable.length === 0) {
      event.preventDefault();
      return true;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const doc = documentRef || (typeof document !== 'undefined' ? document : undefined);
    const current = (doc && doc.activeElement) || null;
    const insideDialog = focusable.includes(current);

    if (!insideDialog) {
      event.preventDefault();
      focusElement(event.shiftKey ? last : first);
      return true;
    }
    if (event.shiftKey && current === first) {
      event.preventDefault();
      focusElement(last);
      return true;
    }
    if (!event.shiftKey && current === last) {
      event.preventDefault();
      focusElement(first);
      return true;
    }
    return false;
  }

  return {
    activate,
    deactivate,
    handleKeydown,
    isActive: () => active,
  };
}

export { FOCUSABLE_SELECTOR, createFocusTrap, getFocusableElements };
