'use strict';

const { createHash } = require('node:crypto');
const {
  createCanonicalBindingEncoder,
  createCanonicalBindingFingerprint,
} = require('./context-public-window');
const { recoveryHistoryIdentity } = require('./context-recovery-claude-identity');
const { codexCompactionItemIdentity } = require('./context-recovery-codex-tools');
const { isReusableRecoveryHistory } = require('./context-recovery-history-request');

// Internal callers supply the validated immutable history. Across requests we
// retain only SHA-256 fingerprints and chain results: at most four contexts and
// 4096 items each. Fresh external histories are fully re-hashed. The multi-probe
// owner can opt an internally normalized immutable history into digest reuse.
// At most four such digest vectors remain; weak keys never retain the history.
// Neither cache confers snapshot, owner, policy or read authority.
function createBindingFrontierCache() {
  const contexts = new Map();
  const immutableMemos = [];
  let immutableHistories = new WeakMap();
  return {
    clear() {
      contexts.clear();
      immutableMemos.length = 0;
      immutableHistories = new WeakMap();
    },
    calculate({ scope, continuityScope, seeds, protocol, history, identityFormat }) {
      let frontier = seeds?.frontier ?? scope;
      let continuityFrontier = seeds?.continuityFrontier ?? continuityScope;
      const reusable = isReusableRecoveryHistory(history) && history.length <= 4096;
      const memo = reusable ? immutableHistories.get(history) : undefined;
      const cached = memo?.protocol === protocol ? memo.hashes : undefined;
      const fingerprint = cached
        ? (_identity, index) => cached[index]
        : createCanonicalBindingFingerprint();
      const firstHash = history.length
        ? (cached?.[0] ?? fingerprint(recoveryHistoryIdentity(protocol, history[0])))
        : '';
      // Separate simultaneous conversations that have the same owner/policy.
      // The first digest comes from this exact validated history; its raw
      // content is never retained as a cross-request cache key.
      const key = [scope, continuityScope, frontier, continuityFrontier, firstHash].join(':');
      const prior = contexts.get(key);
      const prefixes = [],
        continuityPrefixes = [],
        hashes = [];
      const encode = createCanonicalBindingEncoder();
      for (const [index, item] of history.entries()) {
        const identity = recoveryHistoryIdentity(protocol, item);
        const hash = index === 0 ? firstHash : fingerprint(identity, index);
        if (
          prior?.hashes[index] === hash &&
          (index === 0 ||
            (prior.prefixes[index - 1] === frontier &&
              prior.continuityPrefixes[index - 1] === continuityFrontier))
        ) {
          frontier = prior.prefixes[index];
          continuityFrontier = prior.continuityPrefixes[index];
        } else {
          const encoded = Buffer.from(encode(identity));
          const continuityIdentity = codexCompactionItemIdentity(identity, index, identityFormat);
          const continuityEncoded =
            continuityIdentity === identity ? encoded : Buffer.from(encode(continuityIdentity));
          frontier = createHash('sha256')
            .update(frontier)
            .update('\0')
            .update(encoded)
            .digest('hex');
          continuityFrontier = createHash('sha256')
            .update(continuityFrontier)
            .update('\0')
            .update(continuityEncoded)
            .digest('hex');
        }
        hashes.push(hash);
        prefixes.push(frontier);
        continuityPrefixes.push(continuityFrontier);
      }
      contexts.delete(key);
      if (history.length <= 4096) {
        if (contexts.size >= 4) contexts.delete(contexts.keys().next().value);
        contexts.set(key, {
          hashes,
          prefixes: [...prefixes],
          continuityPrefixes: [...continuityPrefixes],
        });
      }
      if (reusable) {
        const retained = immutableMemos.indexOf(memo);
        if (retained >= 0) immutableMemos.splice(retained, 1);
        else if (immutableMemos.length === 4) immutableMemos.shift().hashes = undefined;
        const next = { protocol, hashes };
        immutableHistories.set(history, next);
        immutableMemos.push(next);
      }
      return { frontier, continuityFrontier, prefixes, continuityPrefixes };
    },
  };
}

module.exports = { createBindingFrontierCache };
