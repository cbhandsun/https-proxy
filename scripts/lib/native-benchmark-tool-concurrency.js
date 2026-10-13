'use strict';

// Observe genuinely overlapping pending branch reads, not provider tool-item counts.
function createNativeBenchmarkToolConcurrency() {
  const pending = new Map();
  let parallelBranchesObserved = false;
  let maxPendingBranches = 0;
  function begin(document) {
    if (!['design', 'verification'].includes(document)) return () => {};
    if (pending.has(document)) throw new Error('duplicate_pending_branch');
    const lease = Symbol('branch');
    pending.set(document, lease);
    maxPendingBranches = Math.max(maxPendingBranches, pending.size);
    parallelBranchesObserved ||= pending.has('design') && pending.has('verification');
    return () => {
      if (pending.get(document) === lease) pending.delete(document);
    };
  }
  return {
    begin,
    diagnostics: () => ({
      parallelBranchesObserved,
      maxPendingBranches,
      pendingBranches: pending.size,
    }),
  };
}

module.exports = { createNativeBenchmarkToolConcurrency };
