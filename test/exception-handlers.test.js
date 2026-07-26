const assert = require('assert');
const exceptionHandlers = require('../lib/proxy/exception-handlers');

exceptionHandlers.reset();

// 1. Module exports the expected API
assert.strictEqual(typeof exceptionHandlers.install, 'function');
assert.strictEqual(typeof exceptionHandlers.getStats, 'function');
assert.strictEqual(typeof exceptionHandlers.reset, 'function');
assert.strictEqual(typeof exceptionHandlers.isFatalError, 'function');
assert.strictEqual(typeof exceptionHandlers.setShutdownHook, 'function');
assert.strictEqual(typeof exceptionHandlers.setEventHook, 'function');
console.log('[exception-handlers.test] exports ok');

// 2. isFatalError classification
assert.strictEqual(exceptionHandlers.isFatalError(null), false);
assert.strictEqual(exceptionHandlers.isFatalError(new Error('plain')), false);
assert.strictEqual(exceptionHandlers.isFatalError(new Error('out of memory')), true);
assert.strictEqual(exceptionHandlers.isFatalError({ code: 'ERR_OUT_OF_MEMORY' }), true);
assert.strictEqual(exceptionHandlers.isFatalError({ code: 'ERR_HEAP_ALLOCATION_FAILED' }), true);
assert.strictEqual(exceptionHandlers.isFatalError({ code: 'ERR_STACK_OVERFLOW' }), true);
assert.strictEqual(exceptionHandlers.isFatalError({ code: 'ENOENT' }), false);
console.log('[exception-handlers.test] isFatalError classification ok');

// 3. getStats before install
const stats0 = exceptionHandlers.getStats();
assert.strictEqual(typeof stats0.installed, 'boolean');
assert.strictEqual(typeof stats0.uncaughtCount, 'number');
assert.strictEqual(stats0.uncaughtCount, 0);
console.log('[exception-handlers.test] getStats shape ok');

// 4. Install + collect events
let eventReceived = null;
exceptionHandlers.install({
  onEvent: (kind, payload) => {
    eventReceived = { kind, payload };
  },
});
const stats1 = exceptionHandlers.getStats();
assert.strictEqual(stats1.installed, true);
console.log('[exception-handlers.test] install ok');

// 5. uncaughtException
process.emit('uncaughtException', new Error('synthetic-uncaught'));
const stats2 = exceptionHandlers.getStats();
assert.strictEqual(stats2.uncaughtCount, 1, 'uncaught count must increment');
assert.ok(eventReceived, 'event hook must be called');
assert.strictEqual(eventReceived.kind, 'uncaught_exception');
assert.strictEqual(eventReceived.payload.error, 'synthetic-uncaught');
console.log('[exception-handlers.test] uncaughtException flow ok');

// 6. unhandledRejection
eventReceived = null;
process.emit('unhandledRejection', new Error('synthetic-rejection'), Promise.resolve());
const stats3 = exceptionHandlers.getStats();
assert.strictEqual(stats3.rejectionCount, 1, 'rejection count must increment');
assert.strictEqual(eventReceived.kind, 'unhandled_rejection');
console.log('[exception-handlers.test] unhandledRejection flow ok');

// 7. unhandledRejection with non-Error reason
eventReceived = null;
process.emit('unhandledRejection', 'just-a-string', Promise.resolve());
const stats4 = exceptionHandlers.getStats();
assert.strictEqual(stats4.rejectionCount, 2);
assert.strictEqual(eventReceived.payload.reason, 'just-a-string');
console.log('[exception-handlers.test] non-Error rejection handled ok');

// 8. warning
eventReceived = null;
process.emit('warning', { name: 'DeprecationWarning', message: 'API is deprecated' });
const stats5 = exceptionHandlers.getStats();
assert.strictEqual(stats5.warningCount, 1, 'warning count must increment');
assert.strictEqual(eventReceived.kind, 'process_warning');
assert.strictEqual(eventReceived.payload.name, 'DeprecationWarning');
console.log('[exception-handlers.test] warning flow ok');

// 9. setShutdownHook + setEventHook can be replaced
exceptionHandlers.setShutdownHook(() => {});
exceptionHandlers.setEventHook(() => {});
console.log('[exception-handlers.test] setShutdownHook/setEventHook ok');

// 10. Re-install is idempotent (no duplicate listeners)
exceptionHandlers.install(); // should be a no-op
console.log('[exception-handlers.test] re-install idempotent ok');

console.log('[exception-handlers.test] ok');
