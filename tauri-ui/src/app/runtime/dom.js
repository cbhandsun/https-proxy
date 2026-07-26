export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

export function clearElement(element) {
  if (element) element.textContent = '';
}

export function appendOption(select, value, label = value) {
  if (!select || typeof select.appendChild !== 'function') {
    throw new TypeError('select must support appendChild');
  }
  const option = document.createElement('option');
  option.value = String(value == null ? '' : value);
  option.textContent = String(label == null ? '' : label);
  select.appendChild(option);
  return option;
}

export function debounce(callback, delay = 180) {
  if (typeof callback !== 'function') {
    throw new TypeError('debounce callback must be a function');
  }
  const normalizedDelay = Number.isFinite(delay) && delay >= 0 ? delay : 180;
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), normalizedDelay);
  };
}
