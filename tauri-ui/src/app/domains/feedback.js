import { bindDomainDependencies } from '../runtime/dependencies.js';
import { reportFrontendError } from '../runtime/frontend-errors.js';
import { createFocusTrap } from '../runtime/modal-focus.js';

let feedbackDependencies;

export function configureFeedback(dependencies) {
  feedbackDependencies = bindDomainDependencies('feedback', dependencies, ['$']);
}

export function showToast(message, type = 'success') {
  const { $ } = feedbackDependencies;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  // Toasts are the only success/failure feedback for most management actions,
  // so they must be announced instead of only appearing visually.
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const container = $('toastContainer');
  if (container) container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
  return toast;
}

export function confirmAction({
  title,
  message,
  confirmText = '确认',
  cancelText = '取消',
  danger = true,
} = {}) {
  const { $ } = feedbackDependencies;
  return new Promise((resolve) => {
    const modal = $('confirmModal');
    const ok = $('confirmOk');
    const cancel = $('confirmCancel');
    if (!modal || !ok || !cancel) {
      reportFrontendError(
        'confirm.missing_dialog',
        new Error('Confirmation dialog markup is unavailable')
      );
      resolve(false);
      return;
    }
    $('confirmTitle').textContent = title;
    $('confirmMessage').textContent = message;
    ok.textContent = confirmText;
    cancel.textContent = cancelText || '取消';
    ok.className = danger ? 'danger' : 'secondary';
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');

    let settled = false;
    const trap = createFocusTrap({
      root: modal,
      documentRef: document,
      onEscape: () => finish(false),
    });
    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      modal.classList.remove('active');
      modal.setAttribute('aria-hidden', 'true');
      document.removeEventListener('keydown', trap.handleKeydown, true);
      ok.onclick = null;
      cancel.onclick = null;
      modal.onclick = null;
      // Return focus to the control that opened the dialog so keyboard users
      // keep their place in the page.
      trap.deactivate();
      resolve(confirmed);
    };
    ok.onclick = () => finish(true);
    cancel.onclick = () => finish(false);
    modal.onclick = (event) => {
      if (event.target === modal) finish(false);
    };
    document.addEventListener('keydown', trap.handleKeydown, true);
    if (!trap.activate(cancel)) ok.focus();
  });
}
