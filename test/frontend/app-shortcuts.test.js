'use strict';

const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(
  path.join(__dirname, '..', '..', 'tauri-ui', 'src', 'app', 'runtime', 'app-shortcuts.js')
).href;

function keyboardEvent(overrides = {}) {
  return {
    code: '',
    key: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    isComposing: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    ...overrides,
  };
}

(async () => {
  const { appShortcutActionForEvent, createAppShortcutHandler, installAppShortcutHandler } =
    await import(moduleUrl);

  assert.strictEqual(appShortcutActionForEvent(keyboardEvent({ code: 'F5' })), 'reload');
  assert.strictEqual(
    appShortcutActionForEvent(keyboardEvent({ code: 'F5', ctrlKey: true })),
    'force_reload'
  );
  assert.strictEqual(
    appShortcutActionForEvent(keyboardEvent({ code: 'Equal', ctrlKey: true })),
    'zoom_in'
  );
  assert.strictEqual(
    appShortcutActionForEvent(keyboardEvent({ key: '+', ctrlKey: true, shiftKey: true })),
    'zoom_in'
  );
  assert.strictEqual(
    appShortcutActionForEvent(keyboardEvent({ code: 'Minus', ctrlKey: true })),
    'zoom_out'
  );
  assert.strictEqual(
    appShortcutActionForEvent(keyboardEvent({ code: 'Digit0', ctrlKey: true })),
    'zoom_reset'
  );
  assert.strictEqual(appShortcutActionForEvent(keyboardEvent({ code: 'F12' })), 'toggle_devtools');

  for (const invalid of [
    null,
    {},
    keyboardEvent({ code: 'F5', shiftKey: true }),
    keyboardEvent({ code: 'F5', altKey: true }),
    keyboardEvent({ code: 'Equal' }),
    keyboardEvent({ code: 'Equal', ctrlKey: true, metaKey: true }),
    keyboardEvent({ code: 'Digit0', ctrlKey: true, shiftKey: true }),
    keyboardEvent({ code: 'KeyO', ctrlKey: true }),
    keyboardEvent({ code: 'F5', defaultPrevented: true }),
    keyboardEvent({ code: 'F5', isComposing: true }),
  ]) {
    assert.strictEqual(appShortcutActionForEvent(invalid), null);
  }

  const actions = [];
  const event = keyboardEvent({ code: 'Equal', ctrlKey: true });
  const handler = createAppShortcutHandler({ executeShortcut: (action) => actions.push(action) });
  assert.strictEqual(handler(event), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(actions, ['zoom_in']);
  assert.strictEqual(event.defaultPrevented, true);
  assert.strictEqual(event.propagationStopped, true);

  assert.strictEqual(handler(keyboardEvent({ code: 'F5', repeat: true })), false);
  assert.strictEqual(handler(keyboardEvent({ code: 'Equal', ctrlKey: true, repeat: true })), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(actions, ['zoom_in', 'zoom_in']);

  const failures = [];
  const failingHandler = createAppShortcutHandler({
    executeShortcut: async () => {
      throw new Error('native failure');
    },
    onError: (error, action) => failures.push([error.message, action]),
  });
  assert.strictEqual(failingHandler(keyboardEvent({ code: 'F12' })), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(failures, [['native failure', 'toggle_devtools']]);

  const listeners = new Map();
  const target = {
    addEventListener(name, listener, options) {
      listeners.set(name, { listener, options });
    },
    removeEventListener(name, listener, options) {
      const entry = listeners.get(name);
      if (entry && entry.listener === listener && entry.options.capture === options.capture) {
        listeners.delete(name);
      }
    },
  };
  const uninstall = installAppShortcutHandler({ target, executeShortcut: () => {} });
  assert.strictEqual(listeners.get('keydown').options.capture, true);
  uninstall();
  assert.strictEqual(listeners.has('keydown'), false);

  assert.throws(() => createAppShortcutHandler({ executeShortcut: null }), /must be a function/);
  assert.throws(
    () => installAppShortcutHandler({ target: {}, executeShortcut: () => {} }),
    /must support addEventListener/
  );

  console.log('app-shortcuts tests: ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
