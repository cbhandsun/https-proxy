'use strict';

const CONTEXT_OVERFLOW_MESSAGE =
  'The request exceeds the estimated input budget. Shorten the input, tool definitions, or requested output limit.';

function rejectContextOverflow(clientRes, body, sendJsonError) {
  const budget = body && body.__hpmDiagnostics && body.__hpmDiagnostics.contextBudget;
  if (!budget || !budget.enabled || !(budget.overBudgetTokens > 0)) return false;
  sendJsonError(clientRes, 400, {
    error: {
      type: 'invalid_request_error',
      code: 'context_length_exceeded',
      message: CONTEXT_OVERFLOW_MESSAGE,
    },
  });
  return true;
}

module.exports = { CONTEXT_OVERFLOW_MESSAGE, rejectContextOverflow };
