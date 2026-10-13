'use strict';

const assert = require('assert');
const {
  DEFAULT_CAPACITY_TTL_MS,
  DEFAULT_PROBE_COOLDOWN_MS,
  createContextCapacityController,
} = require('../lib/proxy/context-capacity-controller');

let currentTime = 1000;
const controller = createContextCapacityController({ now: () => currentTime });
assert.equal(controller.targetBytes('host|model', 384 * 1024), 384 * 1024);

const rejected = controller.recordRejection('host|model', 390 * 1024);
assert.ok(rejected.safeBytes < 390 * 1024);
assert.equal(controller.targetBytes('host|model', 384 * 1024), rejected.safeBytes);
assert.equal(controller.diagnostics('host|model').learned, true);

const otherKey = controller.targetBytes('host|other-model', 384 * 1024);
assert.equal(otherKey, 384 * 1024, 'capacity is isolated by provider/model key');

const firstSuccess = controller.recordSuccess('host|model', rejected.safeBytes, 384 * 1024);
assert.equal(firstSuccess.safeBytes, rejected.safeBytes, 'one success does not raise capacity');
controller.recordSuccess('host|model', rejected.safeBytes, 384 * 1024);
const thirdSuccess = controller.recordSuccess('host|model', rejected.safeBytes, 384 * 1024);
assert.equal(thirdSuccess.safeBytes, rejected.safeBytes, 'rapid successes cannot bypass cooldown');
currentTime += DEFAULT_PROBE_COOLDOWN_MS;
const laterSuccess = controller.recordSuccess('host|model', rejected.safeBytes, 384 * 1024);
assert.ok(
  laterSuccess.safeBytes > rejected.safeBytes,
  'cooldown plus near-limit successes permit a probe'
);
assert.equal(
  controller.recordSuccess('host|model', laterSuccess.safeBytes, 384 * 1024).safeBytes,
  laterSuccess.safeBytes,
  'a probe starts another cooldown'
);

controller.recordRejection('host|model', 200 * 1024);
assert.ok(controller.targetBytes('host|model', 384 * 1024) < 200 * 1024);

currentTime += DEFAULT_CAPACITY_TTL_MS + 1;
assert.equal(controller.targetBytes('host|model', 384 * 1024), 384 * 1024);
assert.deepStrictEqual(controller.diagnostics('host|model'), {
  learned: false,
  safeBytes: 0,
  successes: 0,
});

assert.equal(controller.recordRejection('host|invalid', 0), null);
assert.equal(controller.recordSuccess('missing', 1000, 2000), null);

for (const value of [0, -1, NaN, Infinity, {}, Number.MAX_VALUE, 0.1, 1]) {
  assert.equal(controller.recordRejection('invalid', value), null);
}
const tiny = controller.recordRejection('tiny', 100);
assert.ok(tiny.safeBytes > 0 && tiny.safeBytes < 100);
let epochTime = 0;
const epoch = createContextCapacityController({ now: () => epochTime });
epoch.recordRejection('profile-a', 200000);
for (let index = 1; index <= 48; index += 1) {
  epochTime = index * 5 * 60 * 1000;
  epoch.recordSuccess('profile-a', 1000, 384 * 1024);
}
assert.equal(
  epoch.targetBytes('profile-a', 384 * 1024),
  384 * 1024,
  'four hours of tiny successes cannot renew the learned ceiling'
);
assert.equal(epoch.targetBytes('profile-b', 384 * 1024), 384 * 1024);
let probeTime = 0;
const envelope = createContextCapacityController({
  now: () => probeTime,
  probeCooldownMs: 1,
  ttlMs: 100000,
  successesToProbe: 1,
});
envelope.recordRejection('key', 100000);
for (let index = 0; index < 100; index += 1) {
  probeTime += 1;
  envelope.recordSuccess('key', envelope.targetBytes('key', 200000), 200000);
}
assert.ok(
  envelope.targetBytes('key', 200000) <= 98976,
  'probes stay below recent rejection envelope'
);

// Production regression: accepted artifact continuations followed by a host
// rejection must not poison the next smaller, lossless request at 70%.
let evidenceTime = 1000;
const evidence = createContextCapacityController({ now: () => evidenceTime });
for (const bytes of [226259, 228959, 234606]) evidence.recordSuccess('recovery', bytes, 393216);
assert.equal(evidence.targetBytes('recovery', 393216), 393216, 'acceptance alone is not a limit');
assert.deepStrictEqual(evidence.diagnostics('recovery'), {
  learned: false,
  safeBytes: 0,
  successes: 0,
});
assert.equal(evidence.recordRejection('recovery', 241295).safeBytes, 234606);
assert.ok(
  evidence.targetBytes('recovery', 393216) >= 212211,
  'the next smaller request is admissible'
);
assert.equal(evidence.targetBytes('other-profile', 393216), 393216);
assert.equal(
  evidence.targetBytes('recovery', 100000),
  100000,
  'configuration remains a hard ceiling'
);
// A smaller recent rejection overrides larger accepted samples.
assert.ok(evidence.recordRejection('recovery', 210000).safeBytes < 210000);
const belowRecentRejection = evidence.targetBytes('recovery', 393216);
evidence.recordSuccess('recovery', 240000, 393216);
assert.ok(evidence.targetBytes('recovery', 393216) <= 208976);
assert.ok(evidence.targetBytes('recovery', 393216) >= belowRecentRejection);

const stale = createContextCapacityController({ now: () => evidenceTime });
stale.recordSuccess('key', 234606, 393216);
evidenceTime += 5 * 60 * 1000;
assert.equal(
  stale.recordRejection('key', 241295).safeBytes,
  168906,
  'stale acceptance is not a floor'
);
const rollback = createContextCapacityController({ now: () => evidenceTime });
rollback.recordSuccess('key', 234606, 393216);
evidenceTime -= 1;
assert.equal(
  rollback.recordRejection('key', 241295).safeBytes,
  168906,
  'future-dated samples are ignored'
);

const bounded = createContextCapacityController();
bounded.recordSuccess('key', 234606, 393216);
for (let index = 0; index < 8; index += 1) bounded.recordSuccess('key', 1000, 393216);
assert.equal(
  bounded.recordRejection('key', 241295).safeBytes,
  168906,
  'at most eight samples are retained'
);
for (const bytes of [undefined, null, Symbol('invalid'), [], {}, 0, -1, Infinity]) {
  assert.equal(bounded.recordSuccess('key', bytes, 393216), null);
  assert.equal(bounded.recordRejection('key', bytes), null);
}

const boundedProfiles = createContextCapacityController({ maxEntries: 2 });
boundedProfiles.recordRejection('old-profile', 100000);
boundedProfiles.recordSuccess('recent-profile', 5000, 393216);
boundedProfiles.recordSuccess('new-profile', 5000, 393216);
assert.equal(
  boundedProfiles.diagnostics('old-profile').learned,
  false,
  'learning records have a global bound'
);
for (const options of [null, [], { rejectionRatio: Symbol('invalid') }]) {
  assert.equal(
    createContextCapacityController(options).recordRejection('key', 100000).safeBytes,
    70000
  );
}

console.log('[context-capacity-controller.test] ok');
