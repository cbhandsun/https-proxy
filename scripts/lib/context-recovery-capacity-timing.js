'use strict';

const { CAPACITY_PROFILES } = require('./context-recovery-capacity-workload');
const { parseCapacityReports } = require('./context-recovery-capacity-parallel');

// Execution resources and the original performance objective are independent.
// The caller enforces the execution deadline; timing never grants capacity.
const CAPACITY_EXECUTION_BUDGET_MS = 180000;
const CAPACITY_PERFORMANCE_TARGET_MS = 60000;

function createCapacityTiming(elapsedMs, scope) {
  if (
    typeof elapsedMs !== 'number' ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0 ||
    elapsedMs > Number.MAX_SAFE_INTEGER ||
    (scope !== 'capacity-workers' && scope !== 'capacity-command')
  )
    throw new Error('context_recovery_capacity_qualification_failed');
  return {
    scope,
    elapsedMs,
    executionBudgetMs: CAPACITY_EXECUTION_BUDGET_MS,
    executionBudgetMet: elapsedMs <= CAPACITY_EXECUTION_BUDGET_MS,
    performanceTargetMs: CAPACITY_PERFORMANCE_TARGET_MS,
    performanceTargetMet: elapsedMs <= CAPACITY_PERFORMANCE_TARGET_MS,
  };
}

function createCapacityQualificationReport(input, elapsedMs) {
  const timing = createCapacityTiming(elapsedMs, 'capacity-workers');
  const profiles = parseCapacityReports(
    input,
    CAPACITY_PROFILES.map((_, index) => index)
  );
  return {
    workloadVersion: 1,
    scope: 'synthetic-session-capacity',
    transportQualified: false,
    durableStorageQualified: false,
    realModelRequests: 0,
    profiles,
    qualified: profiles.every((profile) => profile.qualified),
    timing,
  };
}

module.exports = {
  CAPACITY_EXECUTION_BUDGET_MS,
  CAPACITY_PERFORMANCE_TARGET_MS,
  createCapacityTiming,
  createCapacityQualificationReport,
};
