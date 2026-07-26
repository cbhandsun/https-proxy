const MAX_FRONTEND_ERRORS = 100;
const MAX_CONTEXT_CHARS = 120;
const MAX_MESSAGE_CHARS = 1000;

function sanitizeErrorText(value, maxChars = MAX_MESSAGE_CHARS) {
  const text = String(value == null ? '' : value)
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(
      /([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password)=)[^&#\s]*/gi,
      '$1[redacted]'
    )
    .replace(
      /\b(api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password)\s*[:=]\s*['"]?[^&#\s,'"}]+/gi,
      '$1=[redacted]'
    );
  return text.slice(0, maxChars);
}

function errorRecord(context, error, now = Date.now()) {
  const normalizedContext = sanitizeErrorText(context, MAX_CONTEXT_CHARS) || 'frontend.error';
  if (error instanceof Error) {
    return {
      at: now,
      context: normalizedContext,
      type: error.name || 'Error',
      message: sanitizeErrorText(error.message),
    };
  }
  return {
    at: now,
    context: normalizedContext,
    type: typeof error,
    message: sanitizeErrorText(error),
  };
}

function frontendErrorStore() {
  const host = globalThis;
  if (!Array.isArray(host.__hpmFrontendErrors)) host.__hpmFrontendErrors = [];
  return host.__hpmFrontendErrors;
}

export function reportFrontendError(context, error) {
  const entry = errorRecord(context, error);
  const store = frontendErrorStore();
  store.push(entry);
  if (store.length > MAX_FRONTEND_ERRORS) store.splice(0, store.length - MAX_FRONTEND_ERRORS);
  return entry;
}

export function getFrontendErrors() {
  return frontendErrorStore().map((entry) => ({ ...entry }));
}

export const _test = { errorRecord, sanitizeErrorText };
