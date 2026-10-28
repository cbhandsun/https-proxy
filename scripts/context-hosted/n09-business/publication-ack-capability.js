'use strict';
const { types } = require('node:util');
const { fields } = require('../n09-ack/contract');
const fail = () => new Error('n09_publication_ack_capability_rejected');
const original = ['arm', 'waitHeld', 'release', 'waitReleased', 'close'];
const extra = ['armCancellation', 'waitTriggerHeld', 'releaseTrigger'];

// A cancellation capability is all-or-nothing. Older direct-boundary fixtures
// retain their original exact shape; a partial extension grants neither route.
function publicationAckCapability(input) {
  try {
    if (!input || typeof input !== 'object' || types.isProxy(input)) throw fail();
    const cancellation = extra.some((name) => Object.hasOwn(input, name));
    const methods = fields(input, [...original, ...(cancellation ? extra : [])]);
    for (const [name, fn] of Object.entries(methods))
      if (
        typeof fn !== 'function' ||
        types.isProxy(fn) ||
        types.isGeneratorFunction(fn) ||
        (['release', 'releaseTrigger', 'close'].includes(name) && types.isAsyncFunction(fn))
      )
        throw fail();
    return Object.freeze({ methods: Object.freeze(methods), cancellation });
  } catch {
    throw fail();
  }
}
module.exports = { publicationAckCapability };
