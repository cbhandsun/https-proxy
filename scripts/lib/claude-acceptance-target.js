'use strict';

function claudeAcceptanceTarget(base, inbound) {
  try {
    if (typeof base !== 'string' || typeof inbound !== 'string' || inbound.length > 4096)
      throw new Error();
    const target = new URL(base);
    if (
      target.origin !== 'https://api.deepseek.com' ||
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      !['', '/', '/anthropic', '/anthropic/'].includes(target.pathname) ||
      !/^\/(?:anthropic\/)?v1\/messages(?:\?beta=true)?$/.test(inbound)
    )
      throw new Error();
    const incoming = new URL(inbound, target.origin);
    target.pathname = '/anthropic/v1/messages';
    target.search = incoming.search;
    return target;
  } catch {
    throw new Error('claude_acceptance_target_refused');
  }
}

module.exports = { claudeAcceptanceTarget };
