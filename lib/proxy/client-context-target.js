'use strict';

const { timingSafeEqual } = require('node:crypto');
const { validateLocalCompactionBinding } = require('./context-compaction-envelope');
const { isWorkBuddyTarget } = require('./workbuddy-request-contract');

const CONTEXT_TARGET_HEADER = 'x-hpm-context-target';
const CONTEXT_TARGET_PATTERN = /^v1\.[a-f0-9]{64}$/;

function contextTargetToken(binding) {
  return 'v1.' + validateLocalCompactionBinding(binding);
}

function inspectClientContextTarget(headers, prepared, parseTargetUrl, apiKey) {
  const descriptor = headers && Object.getOwnPropertyDescriptor(headers, CONTEXT_TARGET_HEADER);
  if (!descriptor) return { pinned: false, ok: true };
  const expected = descriptor.value;
  if (
    !Object.hasOwn(descriptor, 'value') ||
    typeof expected !== 'string' ||
    !CONTEXT_TARGET_PATTERN.test(expected)
  )
    return { pinned: true, ok: false };
  try {
    // Pin the authenticated prepared dispatch, not a client label or mutable config lookup.
    if (!isWorkBuddyTarget(prepared) || apiKey || !prepared.workbuddyAuth?.accessTokenEncrypted)
      return { pinned: true, ok: false };
    const target = parseTargetUrl(prepared.profile.targetUrl);
    const model =
      prepared.rewriteTo && prepared.rewriteTo !== '-'
        ? prepared.rewriteTo
        : JSON.parse(prepared.buffer.toString('utf8')).model;
    const actual = contextTargetToken({
      owner: prepared.profile.id,
      provider: 'workbuddy-wbipc',
      model,
      endpoint: `${target.protocol || 'https:'}//${target.hostname || target.host || 'workbuddy-host'}:${target.port || ''}${target.path || ''}`,
    });
    return {
      pinned: true,
      ok: timingSafeEqual(Buffer.from(expected), Buffer.from(actual)),
      token: actual,
    };
  } catch {
    return { pinned: true, ok: false };
  }
}

module.exports = {
  CONTEXT_TARGET_HEADER,
  CONTEXT_TARGET_PATTERN,
  contextTargetToken,
  inspectClientContextTarget,
};
