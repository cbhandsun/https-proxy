'use strict';
// Fixed synthetic Messages policy; never rewrite a Responses request into Messages.
const CLAUDE_DIAGNOSTIC_POLICY = Object.freeze({
  client: 'claude',
  initialEntryProtocols: Object.freeze(Array(4).fill('claude')),
  scope: 'staged_claude_enhanced_protocol_diagnostic',
  paths: Object.freeze(['/v1/messages', '/v1/messages?beta=true']),
});
module.exports = { CLAUDE_DIAGNOSTIC_POLICY };
