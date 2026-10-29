'use strict';
// Fixed HTTP classes only. Never inspect or disclose response content.
const statuses = Object.freeze([400, 401, 403, 409, 413, 429, 500, 502, 503, 504]);
function seedReplyFailurePhase(status) {
  if (!Number.isInteger(status) || status < 100 || status > 599) return 173;
  if (status === 200) return null;
  const index = statuses.indexOf(status);
  return index === -1 ? 172 : 162 + index;
}
module.exports = { seedReplyFailurePhase };
