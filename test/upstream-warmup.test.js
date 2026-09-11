const assert = require('assert');
const { EventEmitter } = require('events');
const {
  createUpstreamWarmup,
  selectWarmupProfiles,
  warmupHeaders,
  warmupSettings,
} = require('../lib/proxy/upstream-warmup');

assert.deepStrictEqual(warmupSettings({ appSettings: { upstreamWarmupEnabled: true } }), {
  enabled: true,
  intervalMs: 45000,
  maxTargets: 4,
  staggerMs: 200,
});
assert.strictEqual(
  warmupSettings({ appSettings: { upstreamWarmupIntervalMs: 1 } }).intervalMs,
  10000
);
assert.strictEqual(
  warmupSettings({ appSettings: { upstreamWarmupMaxTargets: 999 } }).maxTargets,
  16
);
assert.strictEqual(warmupSettings({ appSettings: { upstreamWarmupStaggerMs: -1 } }).staggerMs, 0);
assert.strictEqual(warmupHeaders({ protocol: 'claude' }, 'key')['x-api-key'], 'key');
assert.strictEqual(
  warmupHeaders({ protocol: 'gemini' }, 'ya29.token').authorization,
  'Bearer ya29.token'
);

const routedProfile = {
  id: 'routed',
  protocol: 'openai',
  targetUrl: 'https://routed.example.test/v1',
  apiKey: 'routed-key',
};
const duplicateTarget = { ...routedProfile, id: 'duplicate' };
const activeProfile = {
  id: 'active',
  protocol: 'claude',
  targetUrl: 'https://active.example.test/v1',
  apiKey: 'active-key',
};
const recentProfile = {
  id: 'recent',
  protocol: 'gemini',
  targetUrl: 'https://recent.example.test/v1',
  apiKey: 'recent-key',
};
const selection = selectWarmupProfiles(
  {
    PROFILES: [activeProfile, routedProfile, duplicateTarget, recentProfile],
    ACTIVE_PROFILE: activeProfile,
    MODEL_ROUTES: [
      { from: 'gpt', to: 'gpt-upstream', profileId: 'routed' },
      { from: 'disabled', to: 'disabled', profileId: 'active', enabled: false },
      { from: 'duplicate', to: 'duplicate', profileId: 'duplicate' },
    ],
  },
  2,
  ['recent']
);
assert.strictEqual(selection.eligibleCount, 3);
assert.deepStrictEqual(
  selection.profiles.map((profile) => profile.id),
  ['recent', 'routed'],
  'recent and routed profiles must take priority over the UI-selected active profile'
);

let scheduled;
const requests = [];
const outcomes = [];
const targetCounts = [];
const fakeTransport = {
  request(options, callback) {
    requests.push(options);
    const req = new EventEmitter();
    req.end = () => {
      const res = new EventEmitter();
      res.resume = () => {};
      callback(res);
      res.emit('end');
    };
    req.destroy = () => {};
    return req;
  },
};
const state = {
  CONFIG: {
    appSettings: {
      upstreamWarmupEnabled: true,
      upstreamWarmupIntervalMs: 10000,
      upstreamWarmupMaxTargets: 2,
      upstreamWarmupStaggerMs: 0,
    },
  },
  PROFILES: [activeProfile, routedProfile, recentProfile],
  ACTIVE_PROFILE: activeProfile,
  MODEL_ROUTES: [{ from: 'gpt', to: 'gpt-upstream', profileId: 'routed' }],
};
const warmup = createUpstreamWarmup({
  getRuntimeState: () => state,
  decryptKey: (value) => value,
  getModelsUrl: (targetUrl) => targetUrl + '/models',
  parseTargetUrl: (targetUrl) => new URL(targetUrl),
  http: fakeTransport,
  https: fakeTransport,
  metricsInstance: {
    counter() {
      return {
        inc(_value, labels) {
          outcomes.push(labels.outcome);
        },
      };
    },
    gauge() {
      return {
        set(value, labels) {
          targetCounts.push([labels.state, value]);
        },
      };
    },
  },
  setIntervalFn(fn, ms) {
    scheduled = { fn, ms, unref() {} };
    return scheduled;
  },
  clearIntervalFn(timer) {
    if (timer === scheduled) scheduled = null;
  },
});
warmup.noteProfileUsed(recentProfile);
warmup.refresh();
assert.strictEqual(scheduled.ms, 10000);
assert.strictEqual(requests.length, 2);
assert.strictEqual(requests[0].hostname, 'recent.example.test');
assert.strictEqual(requests[1].hostname, 'routed.example.test');
assert.strictEqual(requests[0].path, '/v1/models');
assert.strictEqual(requests[1].headers.authorization, 'Bearer routed-key');
assert.deepStrictEqual(outcomes, ['response', 'response']);
assert.deepStrictEqual(targetCounts, [
  ['eligible', 3],
  ['selected', 2],
]);
warmup.stop();
assert.strictEqual(scheduled, null);

const skipped = selectWarmupProfiles(
  {
    PROFILES: [
      { id: 'disabled', enabled: false, protocol: 'openai', targetUrl: 'https://x.test' },
      { id: 'trae', protocol: 'trae', targetUrl: 'https://y.test' },
    ],
    MODEL_ROUTES: [
      { from: 'x', to: 'x', profileId: 'disabled' },
      { from: 'y', to: 'y', profileId: 'trae' },
    ],
  },
  4
);
assert.deepStrictEqual(skipped, { eligibleCount: 0, profiles: [] });

console.log('[upstream-warmup.test] ok');
