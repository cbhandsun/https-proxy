'use strict';

const { replayContextCompaction } = require('../lib/proxy/context-quality-replay');
const { contextCompactionWorkloads } = require('./lib/context-compaction-workloads');

const workloads = replayContextCompaction(contextCompactionWorkloads());
const structuralChecksPassed = workloads.every((row) => row.structuralChecksPassed);
process.stdout.write(
  JSON.stringify(
    {
      schema: 'hpm.context.replay',
      version: 1,
      mode: 'offline-structural',
      structuralChecksPassed,
      taskCorrectness: 'not-verified',
      workloads,
    },
    null,
    2
  ) + '\n'
);
if (!structuralChecksPassed) process.exitCode = 1;
