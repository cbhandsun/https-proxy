// Tests for the modal focus containment runtime.

const assert = require('node:assert/strict');

function makeElement(tag, options = {}) {
  const element = {
    tagName: String(tag).toUpperCase(),
    hidden: Boolean(options.hidden),
    disabled: Boolean(options.disabled),
    style: { ...(options.style || {}) },
    attributes: {},
    focused: false,
    isConnected: true,
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name)
        ? this.attributes[name]
        : null;
    },
    focus() {
      this.focused = true;
      documentRef.activeElement = this;
    },
  };
  return element;
}

const documentRef = { activeElement: null };

(async () => {
  const { createFocusTrap, getFocusableElements, FOCUSABLE_SELECTOR } =
    await import('../../tauri-ui/src/app/runtime/modal-focus.js');

  const opener = makeElement('button');
  const confirmButton = makeElement('button');
  const cancelButton = makeElement('button');
  const hiddenButton = makeElement('button', { hidden: true });
  const ariaHiddenButton = makeElement('button');
  ariaHiddenButton.setAttribute('aria-hidden', 'true');
  const disabledButton = makeElement('button', { disabled: true });
  const dialog = {
    querySelectorAll(selector) {
      assert.equal(selector, FOCUSABLE_SELECTOR);
      return [confirmButton, cancelButton, hiddenButton, ariaHiddenButton, disabledButton];
    },
  };

  assert.deepEqual(
    getFocusableElements(dialog).map((element) => element),
    [confirmButton, cancelButton],
    'hidden, aria-hidden, and disabled controls must be excluded from tab order'
  );
  assert.deepEqual(getFocusableElements(null), []);
  assert.deepEqual(getFocusableElements({}), []);

  documentRef.activeElement = opener;
  let escapeCount = 0;
  const trap = createFocusTrap({
    root: dialog,
    documentRef,
    onEscape: () => {
      escapeCount += 1;
    },
  });

  assert.equal(trap.isActive(), false, 'the trap starts inactive');
  assert.equal(trap.activate(cancelButton), true);
  assert.equal(cancelButton.focused, true, 'activation focuses the requested control');
  assert.equal(trap.isActive(), true);

  // Escape is intercepted and routed to the close handler.
  assert.equal(
    trap.handleKeydown({ key: 'Escape', preventDefault() {} }),
    true,
    'Escape must be consumed by the dialog'
  );
  assert.equal(escapeCount, 1);

  // Tab wraps from the last control to the first.
  let prevented = false;
  documentRef.activeElement = cancelButton;
  assert.equal(
    trap.handleKeydown({
      key: 'Tab',
      shiftKey: false,
      preventDefault() {
        prevented = true;
      },
    }),
    true
  );
  assert.equal(prevented, true, 'wrapping Tab is prevented so focus stays inside');
  assert.equal(confirmButton.focused, true, 'Tab from the last control wraps to the first');

  // Shift+Tab wraps from the first control back to the last.
  documentRef.activeElement = confirmButton;
  confirmButton.focused = false;
  assert.equal(trap.handleKeydown({ key: 'Tab', shiftKey: true, preventDefault() {} }), true);
  assert.equal(cancelButton.focused, true, 'Shift+Tab from the first control wraps to the last');

  // Focus that escaped to the page is pulled back into the dialog.
  documentRef.activeElement = opener;
  confirmButton.focused = false;
  assert.equal(trap.handleKeydown({ key: 'Tab', shiftKey: false, preventDefault() {} }), true);
  assert.equal(confirmButton.focused, true, 'focus outside the dialog is recaptured');

  // Interior moves are left to the browser.
  documentRef.activeElement = confirmButton;
  assert.equal(
    trap.handleKeydown({ key: 'Tab', shiftKey: false, preventDefault() {} }),
    false,
    'interior Tab moves must not be prevented'
  );
  assert.equal(trap.handleKeydown(null), false, 'a missing event is ignored');
  assert.equal(trap.handleKeydown({ key: 'a' }), false, 'unrelated keys pass through');

  // Closing the dialog returns focus to the opener.
  opener.focused = false;
  assert.equal(trap.deactivate(), true);
  assert.equal(opener.focused, true, 'focus returns to the control that opened the dialog');
  assert.equal(trap.isActive(), false);
  assert.equal(trap.handleKeydown({ key: 'Escape', preventDefault() {} }), false);
  assert.equal(escapeCount, 1, 'an inactive trap must not handle Escape');

  // A detached opener falls back to no focus move instead of throwing.
  documentRef.activeElement = opener;
  const detachedOpener = makeElement('button');
  detachedOpener.isConnected = false;
  documentRef.activeElement = detachedOpener;
  const secondTrap = createFocusTrap({ root: dialog, documentRef, onEscape() {} });
  assert.equal(secondTrap.activate(confirmButton), true);
  assert.equal(secondTrap.deactivate(), false, 'a detached opener cannot receive focus back');

  // An empty dialog keeps focus out of the page.
  const emptyTrap = createFocusTrap({
    root: { querySelectorAll: () => [] },
    documentRef,
    onEscape() {},
  });
  assert.equal(emptyTrap.activate(), false, 'no focusable control means activation cannot focus');
  assert.equal(
    emptyTrap.handleKeydown({ key: 'Tab', preventDefault() {} }),
    true,
    'Tab must be suppressed when nothing inside the dialog is focusable'
  );

  assert.throws(() => createFocusTrap({ documentRef, onEscape() {} }), /requires a root element/);
  assert.throws(() => createFocusTrap({ root: dialog }), /requires onEscape/);

  console.log('[modal-focus.test] ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
