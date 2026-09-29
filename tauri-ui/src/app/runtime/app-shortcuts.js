const APP_SHORTCUT_ACTIONS = Object.freeze({
  reload: 'reload',
  forceReload: 'force_reload',
  zoomIn: 'zoom_in',
  zoomOut: 'zoom_out',
  zoomReset: 'zoom_reset',
  toggleDevtools: 'toggle_devtools',
});

function eventCode(event) {
  if (!event || typeof event !== 'object') return '';
  if (typeof event.code === 'string' && event.code) return event.code;
  if (typeof event.key !== 'string') return '';
  if (event.key === 'F5' || event.key === 'F12') return event.key;
  if (event.key === '=' || event.key === '+') return 'Equal';
  if (event.key === '-' || event.key === '_') return 'Minus';
  if (event.key === '0') return 'Digit0';
  return '';
}

export function appShortcutActionForEvent(event) {
  if (!event || typeof event !== 'object' || event.defaultPrevented || event.isComposing) {
    return null;
  }

  const code = eventCode(event);
  const ctrl = event.ctrlKey === true;
  const meta = event.metaKey === true;
  const primary = ctrl !== meta && (ctrl || meta);
  const alt = event.altKey === true;
  const shift = event.shiftKey === true;

  if (alt) return null;
  if (code === 'F5' && !shift && !meta) {
    return ctrl ? APP_SHORTCUT_ACTIONS.forceReload : APP_SHORTCUT_ACTIONS.reload;
  }
  if (code === 'F12' && !primary && !shift) return APP_SHORTCUT_ACTIONS.toggleDevtools;
  if (!primary) return null;
  if (code === 'Equal') return APP_SHORTCUT_ACTIONS.zoomIn;
  if (code === 'Minus') return APP_SHORTCUT_ACTIONS.zoomOut;
  if (code === 'Digit0' && !shift) return APP_SHORTCUT_ACTIONS.zoomReset;
  return null;
}

export function createAppShortcutHandler({ executeShortcut, onError = () => {} }) {
  if (typeof executeShortcut !== 'function') {
    throw new TypeError('executeShortcut must be a function');
  }
  if (typeof onError !== 'function') throw new TypeError('onError must be a function');

  return function handleAppShortcut(event) {
    const action = appShortcutActionForEvent(event);
    if (!action || (event.repeat && !action.startsWith('zoom_'))) return false;

    event.preventDefault();
    event.stopPropagation();
    Promise.resolve()
      .then(() => executeShortcut(action))
      .catch((error) => onError(error, action));
    return true;
  };
}

export function installAppShortcutHandler({ target, executeShortcut, onError }) {
  if (!target || typeof target.addEventListener !== 'function') {
    throw new TypeError('target must support addEventListener');
  }
  const handler = createAppShortcutHandler({ executeShortcut, onError });
  target.addEventListener('keydown', handler, { capture: true });
  return () => target.removeEventListener('keydown', handler, { capture: true });
}
