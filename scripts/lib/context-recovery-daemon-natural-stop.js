'use strict';

const { dataSnapshot, settle, callable } = require('./context-recovery-daemon-http-boundary');
const { LABELS } = require('./context-recovery-daemon-owned-protocol');
const reject = () => new Error('daemon_natural_stop_rejected');

// The HTTP response acknowledges intent only. Qualification requires a separate
// owned-controller observation of zero exit, empty Job and pipe EOF.
async function completeDaemonNaturalStop(input, http, exchange) {
  try {
    const value = dataSnapshot(input, 'daemon_natural_stop_rejected');
    const target = value.shutdown;
    if (
      Object.keys(value).sort().join(',') !== 'case,pid,shutdown' ||
      !LABELS.includes(value.case) ||
      !Number.isSafeInteger(value.pid) ||
      value.pid < 1 ||
      value.pid > 0xffffffff ||
      !target ||
      Object.keys(target).sort().join(',') !== 'instanceId,pid' ||
      target.pid !== value.pid ||
      typeof target.instanceId !== 'string' ||
      !/^[a-f0-9]{32}$/.test(target.instanceId) ||
      !callable(http) ||
      !callable(exchange)
    )
      throw reject();
    const accepted = dataSnapshot(
      (
        await settle(
          http({ method: 'POST', route: '/v1/local/runtime/stop', body: target }),
          'daemon_natural_stop_rejected'
        )
      ).value,
      'daemon_natural_stop_rejected'
    );
    if (
      accepted.status !== 202 ||
      !accepted.body ||
      Object.keys(accepted.body).sort().join(',') !== 'accepted,instanceId,pid' ||
      accepted.body.accepted !== true ||
      accepted.body.pid !== target.pid ||
      accepted.body.instanceId !== target.instanceId
    )
      throw reject();
    const receipt = dataSnapshot(
      (await settle(exchange({ op: 'reap', case: value.case }), 'daemon_natural_stop_rejected'))
        .value,
      'daemon_natural_stop_rejected'
    );
    if (
      Object.keys(receipt).sort().join(',') !==
        'case,cleanupSemantics,exitCode,id,ok,op,treeEmpty,v' ||
      receipt.v !== 1 ||
      !Number.isSafeInteger(receipt.id) ||
      receipt.id < 1 ||
      receipt.id > 4096 ||
      receipt.op !== 'reap' ||
      receipt.case !== value.case ||
      receipt.ok !== true ||
      receipt.treeEmpty !== true ||
      receipt.cleanupSemantics !== 'natural_exit' ||
      receipt.exitCode !== 0
    )
      throw reject();
    return Object.freeze({ treeEmpty: true, cleanupSemantics: 'natural_exit', exitCode: 0 });
  } catch {
    throw reject();
  }
}

module.exports = { completeDaemonNaturalStop };
