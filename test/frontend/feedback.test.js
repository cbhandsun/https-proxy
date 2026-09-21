// Tests for the toast + confirmation feedback domain.
//
// Regression: toasts had no live region so screen readers never announced
// success/failure, and the confirmation dialog had no focus containment or
// focus return, so keyboard users could tab into the page behind it.

const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

function makeElement(tag = 'div') {
  const element = {
    tagName: String(tag).toUpperCase(),
    children: [],
    className: '',
    style: {},
    attributes: {},
    focused: false,
    isConnected: true,
    hidden: false,
    disabled: false,
    listeners: {},
    classList: {
      values: new Set(),
      add(value) {
        this.values.add(value);
      },
      remove(value) {
        this.values.delete(value);
      },
      contains(value) {
        return this.values.has(value);
      },
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name)
        ? this.attributes[name]
        : null;
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    focus() {
      this.focused = true;
      documentRef.activeElement = this;
    },
    remove() {},
  };
  return element;
}

const elements = new Map();
const documentRef = {
  activeElement: null,
  listeners: {},
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, makeElement('div'));
    return elements.get(id);
  },
  createElement: makeElement,
  addEventListener(type, handler) {
    (this.listeners[type] ||= []).push(handler);
  },
  removeEventListener(type, handler) {
    const handlers = this.listeners[type] || [];
    const index = handlers.indexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  },
};

function dispatchKeydown(event) {
  const handlers = documentRef.listeners.keydown || [];
  for (const handler of handlers) handler(event);
}

let importSequence = 0;
async function loadFeedback(sandbox) {
  Object.assign(globalThis, sandbox);
  const moduleUrl = pathToFileURL(
    path.join(__dirname, '..', '..', 'tauri-ui', 'src', 'app', 'domains', 'feedback.js')
  );
  moduleUrl.searchParams.set('test', String(importSequence++));
  return import(moduleUrl.href);
}

function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  globalThis.document = Object.assign(documentRef, {
    body: makeElement('body'),
    querySelectorAll: () => [],
  });
  const feedback = await loadFeedback({
    window: {},
    document: globalThis.document,
  });

  const dependencies = { $: (id) => documentRef.getElementById(id) };
  assert.throws(
    () => feedback.configureFeedback({}),
    /feedback dependencies missing: \$/,
    'the domain must fail closed when its lookups are missing'
  );
  assert.throws(() => feedback.configureFeedback(null), /must be an object/);
  feedback.configureFeedback(dependencies);

  // Toast: announced, appended to the container, then removed.
  const container = documentRef.getElementById('toastContainer');
  const successToast = feedback.showToast('已保存', 'success');
  assert.equal(successToast.getAttribute('role'), 'status');
  assert.equal(successToast.textContent, '已保存');
  assert.equal(container.children.length, 1);

  const errorToast = feedback.showToast('保存失败', 'error');
  assert.equal(errorToast.getAttribute('role'), 'alert');
  assert.equal(container.children.length, 2);

  await tick(3500);
  await tick(400);

  // Confirmation dialog: initial focus, focus trap, Escape, and focus return.
  const opener = makeElement('button');
  opener.id = 'deleteProfile';
  documentRef.activeElement = opener;
  const modal = documentRef.getElementById('confirmModal');
  const ok = documentRef.getElementById('confirmOk');
  const cancel = documentRef.getElementById('confirmCancel');
  const title = documentRef.getElementById('confirmTitle');
  const message = documentRef.getElementById('confirmMessage');

  const confirmed = feedback.confirmAction({
    title: '删除上游',
    message: '该操作不可撤销',
    confirmText: '删除',
    cancelText: '保留',
  });
  assert.equal(title.textContent, '删除上游');
  assert.equal(message.textContent, '该操作不可撤销');
  assert.equal(ok.textContent, '删除');
  assert.equal(cancel.textContent, '保留');
  assert.equal(cancel.focused, true, 'Cancel receives initial focus');
  assert.equal(modal.classList.contains('active'), true);
  assert.equal(modal.getAttribute('aria-hidden'), 'false');

  // Focus is pulled back when it escapes the dialog.
  documentRef.activeElement = opener;
  ok.focused = false;
  dispatchKeydown({ key: 'Tab', shiftKey: false, preventDefault() {} });
  assert.equal(cancel.focused, true, 'Tab from outside the dialog is recaptured');

  // Escape closes the dialog and returns focus to the opener.
  opener.focused = false;
  let prevented = false;
  dispatchKeydown({
    key: 'Escape',
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true, 'Escape is consumed by the dialog');
  assert.equal(await confirmed, false, 'Escape resolves as a cancel');
  assert.equal(modal.classList.contains('active'), false);
  assert.equal(modal.getAttribute('aria-hidden'), 'true');
  assert.equal(opener.focused, true, 'focus returns to the control that opened the dialog');
  assert.equal(
    (documentRef.listeners.keydown || []).length,
    0,
    'the keydown listener is removed when the dialog closes'
  );
  documentRef.activeElement = opener;
  const accepted = feedback.confirmAction({ title: '确认', message: '继续？' });
  assert.equal(ok.textContent, '确认');
  const acceptHandler = ok.onclick;
  assert.equal(typeof acceptHandler, 'function', 'the confirm button is bound');
  acceptHandler();
  acceptHandler();
  assert.equal(await accepted, true);
  assert.equal(opener.focused, true);

  documentRef.activeElement = opener;
  const clicked = feedback.confirmAction({ title: '确认', message: '继续？' });
  const backdropHandler = modal.onclick;
  assert.equal(typeof backdropHandler, 'function', 'the backdrop is bound');
  backdropHandler({ target: modal });
  assert.equal(await clicked, false, 'clicking the backdrop cancels');
  assert.equal(opener.focused, true);
  assert.equal(modal.onclick, null, 'prior handlers are released after settling');
  assert.equal(ok.onclick, null);
  assert.equal(
    (documentRef.listeners.keydown || []).length,
    0,
    'closing via backdrop also releases the keydown listener'
  );

  // A missing dialog fails closed instead of hanging the caller.
  const emptyLookup = { $: () => null };
  await loadFeedback({ window: {}, document: globalThis.document });
  feedback.configureFeedback(emptyLookup);
  assert.equal(await feedback.confirmAction({ title: 'x', message: 'y' }), false);

  console.log('[feedback.test] ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
