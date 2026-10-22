'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { normalizeCompactionData } = require('../../lib/proxy/context-compaction-envelope');
const {
  CAPACITY_PROFILES,
  exerciseCapacityProfile,
} = require('./context-recovery-capacity-workload');
const failure = () => new Error('context_recovery_capacity_qualification_failed');
const keys = (value) => value && !Array.isArray(value) && Object.keys(value).sort().join(',');
const integer = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;

function parseIndexes(input) {
  const indexes = normalizeCompactionData(input, 1024);
  if (
    !Array.isArray(indexes) ||
    !indexes.length ||
    indexes.length > CAPACITY_PROFILES.length ||
    new Set(indexes).size !== indexes.length ||
    indexes.some((index) => !integer(index, CAPACITY_PROFILES.length - 1))
  )
    throw failure();
  return indexes;
}

function parseCapacityReports(input, selection) {
  try {
    const indexes = parseIndexes(selection);
    const reports = normalizeCompactionData(input, 16384);
    if (!Array.isArray(reports) || reports.length !== indexes.length) throw failure();
    return reports.map((report, position) => {
      const profile = CAPACITY_PROFILES[indexes[position]];
      if (
        keys(report) !==
          'completedTurns,finalResultsObserved,firstCoverageGap,firstFailure,firstReadFailure,profile,qualified,reopenCount,verifiedRecoveries' ||
        JSON.stringify(report.profile) !== JSON.stringify(profile) ||
        !integer(report.completedTurns, profile.turns * profile.roots) ||
        !integer(report.verifiedRecoveries, profile.recoveries * profile.roots) ||
        !integer(report.reopenCount, profile.turns) ||
        typeof report.finalResultsObserved !== 'boolean' ||
        typeof report.qualified !== 'boolean'
      )
        throw failure();
      for (const field of ['firstCoverageGap', 'firstFailure', 'firstReadFailure']) {
        const item = report[field];
        if (item === null) continue;
        if (
          !item ||
          !integer(item.root, profile.roots - 1) ||
          !Number.isSafeInteger(item.round) ||
          item.round < 1 ||
          item.round > profile.turns + 1
        )
          throw failure();
        if (field === 'firstCoverageGap') {
          if (
            keys(item) !== 'availableSources,expectedSources,root,round' ||
            !integer(item.expectedSources, profile.turns) ||
            !integer(item.availableSources, item.expectedSources)
          )
            throw failure();
        } else if (
          keys(item) !== 'code,phase,root,round' ||
          !['begin', 'complete', 'list', 'read'].includes(item.phase) ||
          typeof item.code !== 'string' ||
          !/^[a-z_]{1,64}$/.test(item.code)
        )
          throw failure();
      }
      const qualified =
        report.completedTurns === profile.turns * profile.roots &&
        report.verifiedRecoveries === profile.recoveries * profile.roots &&
        report.finalResultsObserved &&
        !report.firstCoverageGap &&
        !report.firstFailure &&
        !report.firstReadFailure;
      if (report.qualified !== qualified) throw failure();
      return report;
    });
  } catch {
    throw failure();
  }
}

// Wait for a clean exit as well as exactly one valid reply. Worker errors and
// malformed/partial replies never become a capacity refusal or expose details.
function readCapacityWorker(worker, indexes) {
  return new Promise((resolve, reject) => {
    let result;
    worker.on('message', (value) => {
      try {
        if (result) throw failure();
        result = parseCapacityReports(value, indexes);
      } catch {
        reject(failure());
      }
    });
    worker.once('error', () => reject(failure()));
    worker.once('exit', (code) => (code === 0 && result ? resolve(result) : reject(failure())));
  });
}

function capacityWorkerSelections() {
  // Keep the original two-worker limit. Start expensive independent profiles
  // first instead of queuing the largest behind two smaller profiles while
  // the other worker becomes idle. Every frozen profile still runs once.
  const selections = [[], []];
  const loads = [0, 0];
  const jobs = CAPACITY_PROFILES.map((profile, index) => ({
    index,
    cost: profile.roots * profile.turns * (profile.outputBytes + 4096),
  })).sort((a, b) => b.cost - a.cost || a.index - b.index);
  for (const job of jobs) {
    const worker = loads[0] <= loads[1] ? 0 : 1;
    selections[worker].push(job.index);
    loads[worker] += job.cost;
  }
  return selections;
}

async function runCapacityProfiles() {
  const selections = capacityWorkerSelections();
  const workers = [];
  try {
    const jobs = selections.map((indexes) => {
      const worker = new Worker(__filename, { workerData: indexes });
      workers.push(worker);
      return readCapacityWorker(worker, indexes);
    });
    const groups = await Promise.all(jobs);
    const reports = new Array(CAPACITY_PROFILES.length);
    groups.forEach((group, index) =>
      group.forEach((report, position) => {
        reports[selections[index][position]] = report;
      })
    );
    return reports;
  } finally {
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
  }
}

if (!isMainThread && require.main === module) {
  const indexes = parseIndexes(workerData);
  parentPort.postMessage(indexes.map((index) => exerciseCapacityProfile(CAPACITY_PROFILES[index])));
  parentPort.close();
}

module.exports = {
  parseCapacityReports,
  readCapacityWorker,
  runCapacityProfiles,
  capacityWorkerSelections,
};
