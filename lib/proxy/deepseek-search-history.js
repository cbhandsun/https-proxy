'use strict';
const { parseWebSearchAction } = require('./responses-web-search-history');
function ownValue(value, key) {
  if (value == null || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !('value' in descriptor)) {
    const error = new TypeError('Invalid DeepSeek search history');
    error.code = 'invalid_request_error';
    throw error;
  }
  return descriptor?.value;
}
function normalizeDeepSeekSearchHistory(body) {
  if (!Array.isArray(body.input)) return body;
  let input = body.input;
  for (let index = 0; index < body.input.length; index++) {
    const item = body.input[index];
    if (ownValue(item, 'type') !== 'web_search_call') continue;
    const rawAction = ownValue(item, 'action');
    if (ownValue(rawAction, 'type') !== 'search') continue;
    const action = parseWebSearchAction(rawAction);
    if (action.query === undefined) continue;
    if (action.queries !== undefined && !action.queries.includes(action.query)) {
      const error = new TypeError('Conflicting DeepSeek search history query fields');
      error.code = 'invalid_request_error';
      throw error;
    }
    const queries = action.queries ?? [action.query];
    delete action.query;
    if (input === body.input) input = body.input.slice();
    input[index] = { ...item, action: { ...action, queries } };
  }
  return input !== body.input ? { ...body, input } : body;
}
module.exports = { normalizeDeepSeekSearchHistory };
