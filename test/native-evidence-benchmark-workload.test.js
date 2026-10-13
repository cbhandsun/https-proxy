'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createNativeBenchmarkWorkload,
} = require('../scripts/lib/native-compaction-benchmark-workload');
const {
  createNativeEvidenceBenchmarkWorkload,
} = require('../scripts/lib/native-evidence-benchmark-workload');
const { LIST_EVIDENCE_TOOL, READ_EVIDENCE_TOOL } = require('../lib/client/context-evidence-tools');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { replayNativeEvidenceReadback } = require('../scripts/lib/native-evidence-readback-replay');
const {
  createNativeEvidenceBenchmarkWorkloadV2,
} = require('../scripts/lib/native-evidence-benchmark-workload-v2');

function loadEvidence(workload) {
  for (const document of ['design', 'verification'])
    assert.equal(workload.reply('hpm_read_branch', { document }).ok, true);
  let offset = 0;
  do {
    const result = workload.reply('hpm_read_page', { offsetBytes: offset });
    assert.equal(result.ok, true);
    offset = JSON.parse(result.text).page.nextOffsetBytes;
  } while (offset !== null);
  assert.equal(workload.reply('hpm_read_branch', { document: 'release' }).ok, true);
}

function recoverEvidence(workload) {
  const evidence = [];
  let after = null;
  do {
    const args = { limit: 2, ...(after ? { afterSourceId: after } : {}) };
    const index = JSON.parse(workload.reply(LIST_EVIDENCE_TOOL, args).text);
    for (const source of index.sources) {
      let text = '';
      let offset = 0;
      do {
        const result = workload.reply(READ_EVIDENCE_TOOL, {
          sourceId: source.sourceId,
          digest: source.digest,
          offsetBytes: offset,
          limitBytes: 6144,
        });
        assert.equal(result.ok, true);
        const page = JSON.parse(result.text).page;
        text += page.text;
        offset = page.nextOffsetBytes;
      } while (offset !== null);
      evidence.push({ source, text });
    }
    after = index.nextAfterSourceId;
  } while (after !== null);
  return evidence;
}

test('V2 guidance is a separate paged-native candidate, preserving historical corpus and one-shot oracle', () => {
  const historic = createNativeEvidenceBenchmarkWorkload();
  const candidate = createNativeEvidenceBenchmarkWorkloadV2();
  assert.equal(
    historic.descriptor.corpusSha256,
    '07b8b5a3456c171b63355a2d4eaecd67bfa3a1e9530fd3288f5cfe8149670bd5'
  );
  assert.equal(candidate.descriptor.originalCandidateSha256, historic.descriptor.corpusSha256);
  assert.equal(
    candidate.descriptor.baseWorkloadSha256,
    '3530a79d9b7846e71a195412f7f6f812e9c8980449ba53423f592b6f5453370b'
  );
  assert.notEqual(candidate.descriptor.corpusSha256, historic.descriptor.corpusSha256);
  assert.equal(candidate.descriptor.version, 2);
  assert.equal(candidate.descriptor.realNativeModelAcceptanceVerified, false);
  assert.deepEqual(candidate.tools, historic.tools);
  assert.deepEqual(candidate.expected, historic.expected);
  assert.ok(historic.prompts.some((prompt) => prompt.includes('console.log')));
  assert.ok(candidate.prompts.every((prompt) => prompt.includes('text(result)')));
  assert.ok(candidate.prompts.every((prompt) => !prompt.includes('console.log完整')));
  loadEvidence(candidate);
  const recovered = recoverEvidence(candidate);
  assert.equal(recovered.length, 7);
  assert.equal(candidate.diagnostics().readbackComplete, true);
  assert.equal(candidate.reply('hpm_verify_state', candidate.expected).ok, true);
  assert.equal(candidate.reply('hpm_verify_state', candidate.expected).ok, false);
  candidate.close();
  historic.close();
  assert.equal(candidate.reply('hpm_list_retained_evidence', {}).ok, false);
  assert.throws(() => createNativeEvidenceBenchmarkWorkloadV2({ unknown: true }));
});

test('independent index recovers all exact original outputs after simulated in-window evidence loss', () => {
  const candidate = createNativeEvidenceBenchmarkWorkload();
  loadEvidence(candidate);
  assert.equal(candidate.diagnostics().readbackComplete, false);
  // Offline state-loss simulation only; no fake native checkpoint/model proof.
  const lostWindow = [{ role: 'user', content: 'Only latest requirements remain.' }];
  assert.ok(candidate.inspectInput(lostWindow).every((item) => item.observed === false));
  const retained = recoverEvidence(candidate);
  const baseline = createNativeBenchmarkWorkload();
  for (const { source, text } of retained) {
    const args = source.callId.startsWith('branch-')
      ? { document: source.callId.slice('branch-'.length) }
      : { offsetBytes: Number(source.callId.slice('page-'.length)) };
    assert.equal(text, baseline.reply(source.toolName, args).text);
  }
  assert.equal(retained.length, 7);
  assert.equal(candidate.diagnostics().evidenceLedger.capturedCount, 7);
  assert.equal(candidate.diagnostics().readbackComplete, true);
  assert.equal(
    candidate.reply('hpm_read_branch', { document: 'design' }).code,
    'duplicate_tool_read'
  );
  assert.equal(candidate.reply('hpm_read_page', { offsetBytes: 0 }).code, 'page_sequence_invalid');
  candidate.close();
});

test('strict oracle uses recovered source findings, not inserted answers; early mismatches still fail once', () => {
  for (const incorrect of [false, true]) {
    const candidate = createNativeEvidenceBenchmarkWorkload();
    loadEvidence(candidate);
    const recovered = recoverEvidence(candidate);
    const branches = Object.fromEntries(
      recovered
        .filter((item) => item.source.toolName === 'hpm_read_branch')
        .map((item) => [
          item.source.callId.slice(7),
          item.text.split('\n').map((line) => JSON.parse(line)),
        ])
    );
    const pageRows = recovered
      .filter((item) => item.source.toolName === 'hpm_read_page')
      .map((item) => JSON.parse(item.text).page.text)
      .join('')
      .split('\n')
      .map((line) => JSON.parse(line));
    const sourceIdentity = branches.design.find((row) => row.project);
    const state = {
      project: sourceIdentity.project,
      color: '蓝色',
      count: 11,
      receipt: sourceIdentity.receipt,
      candidate: 'B',
      status: 'not_verified',
      designFinding: branches.design.find((row) => row.finding).finding,
      verificationFinding: branches.verification.find((row) => row.finding).finding,
      pageFinding: pageRows.find((row) => row.finding).finding,
      releaseFinding: branches.release.find((row) => row.finding).finding,
    };
    if (incorrect) {
      state.designFinding = 'wrong early evidence';
      state.verificationFinding = 'wrong early evidence';
    }
    assert.equal(candidate.reply('hpm_verify_state', state).ok, !incorrect);
    assert.equal(candidate.reply('hpm_verify_state', state).code, 'duplicate_state_verification');
    const oracle = candidate
      .diagnostics()
      .toolReplies.find((item) => item.tool === 'hpm_verify_state');
    assert.deepEqual(
      oracle.mismatchFields,
      incorrect ? ['designFinding', 'verificationFinding'] : []
    );
    assert.ok(!JSON.stringify(candidate.diagnostics()).includes('wrong early evidence'));
    candidate.close();
  }
});

test('candidate changes are explicitly separate from unchanged fixed workload and prior summaries', () => {
  const base = createNativeBenchmarkWorkload();
  const candidate = createNativeEvidenceBenchmarkWorkload({ owner: 'test', threadId: 'isolated' });
  assert.equal(
    base.descriptor.corpusSha256,
    '3530a79d9b7846e71a195412f7f6f812e9c8980449ba53423f592b6f5453370b'
  );
  assert.equal(candidate.descriptor.baseWorkloadSha256, base.descriptor.corpusSha256);
  assert.notEqual(candidate.descriptor.corpusSha256, base.descriptor.corpusSha256);
  assert.equal(candidate.descriptor.fixedNoRereadComparison, false);
  assert.deepEqual(candidate.prompts.slice(0, 2), base.prompts.slice(0, 2));
  assert.deepEqual(candidate.tools.slice(0, 3), base.tools);
  for (const value of ['designFinding', 'verificationFinding', 'pageFinding', 'releaseFinding'])
    assert.ok(!candidate.prompts.join('').includes(base.expected[value]));
  assert.equal(candidate.diagnostics().readbackComplete, false);
  candidate.close();
  assert.equal(candidate.reply(LIST_EVIDENCE_TOOL, {}).code, 'evidence_workload_closed');
});

test('failed/malformed original reads are not retained; independent tools cannot create or replay evidence', () => {
  const candidate = createNativeEvidenceBenchmarkWorkload();
  assert.equal(candidate.reply('hpm_read_branch', { document: 'unknown' }).ok, false);
  assert.equal(candidate.reply('execute_command', {}).ok, false);
  assert.equal(candidate.reply(LIST_EVIDENCE_TOOL, {}).ok, true);
  assert.equal(candidate.diagnostics().evidenceLedger.retainedEntries, 0);
  candidate.reply('hpm_read_branch', { document: 'design' });
  candidate.reply('hpm_read_branch', { document: 'design' });
  assert.equal(candidate.diagnostics().evidenceLedger.capturedCount, 1);
  assert.equal(candidate.diagnostics().readbackComplete, false);
  for (const value of [null, [], { extra: true }, { owner: '' }, { threadId: 'bad\nthread' }])
    assert.throws(() => createNativeEvidenceBenchmarkWorkload(value));
  candidate.close();
});

test('retention quota/failure never replays an already completed source tool', () => {
  const filename = require.resolve('../scripts/lib/native-evidence-benchmark-workload');
  const localRequire = createRequire(filename);
  const testModule = { exports: {} };
  let captures = 0;
  const realLedger = localRequire('../../lib/client/context-evidence-ledger');
  const testRequire = (name) =>
    name === '../../lib/client/context-evidence-ledger'
      ? {
          createContextEvidenceLedger(options) {
            const ledger = realLedger.createContextEvidenceLedger(options);
            ledger.capture = () => {
              captures++;
              throw new Error('private failure details');
            };
            return ledger;
          },
        }
      : localRequire(name);
  // Failure injection at the storage seam; no production dependency override.
  vm.runInThisContext('(function(require,module){' + fs.readFileSync(filename, 'utf8') + '\n})')(
    testRequire,
    testModule
  );
  const candidate = testModule.exports.createNativeEvidenceBenchmarkWorkload();
  assert.deepEqual(candidate.reply('hpm_read_branch', { document: 'design' }), {
    ok: false,
    code: 'evidence_retention_failed',
  });
  assert.equal(
    candidate.reply('hpm_read_branch', { document: 'design' }).code,
    'duplicate_tool_read'
  );
  assert.equal(captures, 1);
  assert.equal(candidate.diagnostics().toolReplies.length, 1);
  assert.equal(candidate.diagnostics().evidenceLedger.retainedEntries, 0);
  candidate.close();
});

test('repeatable offline replay qualifies only byte fidelity, never native/model/install/cost gates', () => {
  const report = replayNativeEvidenceReadback();
  assert.equal(report.providerRequests, 0);
  assert.equal(report.offlineFidelityPassed, true);
  assert.equal(report.sourceWindowLossSimulated, true);
  assert.equal(report.originalSourceReadCountBefore, 7);
  assert.equal(report.originalSourceReadCountAfter, 7);
  assert.equal(report.originalToolsReplayed, false);
  assert.equal(report.ledger.fullyReadSources, 7);
  assert.equal(report.evidence.length, 7);
  assert.equal(report.nativeCompactionInvoked, false);
  assert.equal(report.nativeModelSemanticsVerified, false);
  assert.equal(report.installedClientIntegrationVerified, false);
  assert.equal(report.matchedLatencyOrEconomicsVerified, false);
  assert.deepEqual(report, replayNativeEvidenceReadback());
  assert.ok(!JSON.stringify(report).includes('preserve_native_checkpoint'));
});

test('native read-back observation requires the full tool result, not receipt/prompts/partial output', () => {
  const candidate = createNativeEvidenceBenchmarkWorkload();
  candidate.reply('hpm_read_branch', { document: 'design' });
  const source = JSON.parse(candidate.reply(LIST_EVIDENCE_TOOL, {}).text).sources[0];
  const reply = candidate.reply(READ_EVIDENCE_TOOL, {
    sourceId: source.sourceId,
    digest: source.digest,
  });
  assert.equal(
    candidate.inspectReadbackInput([{ type: 'function_call_output', output: reply.text }])[0]
      .observed,
    true
  );
  assert.equal(
    candidate.inspectReadbackInput([
      {
        type: 'custom_tool_call_output',
        output: JSON.stringify({ contentItems: [{ text: reply.text }] }),
      },
    ])[0].observed,
    true
  );
  assert.equal(
    candidate.inspectReadbackInput([{ role: 'user', content: reply.text }])[0].observed,
    false
  );
  assert.equal(
    candidate.inspectReadbackInput([
      { type: 'function_call_output', output: reply.text.slice(0, 300) },
    ])[0].observed,
    false
  );
  assert.equal(
    candidate.inspectReadbackInput([
      { type: 'function_call_output', output: { receipt: source.digest } },
    ])[0].observed,
    false
  );
  const diagnostic = candidate.diagnostics().retainedPageReplies[0];
  diagnostic.sha256 = 'mutated';
  assert.notEqual(candidate.diagnostics().retainedPageReplies[0].sha256, 'mutated');
  let executed = 0;
  const getter = Object.defineProperty({}, 'output', {
    enumerable: true,
    get() {
      executed++;
      return 'untrusted';
    },
  });
  const cycle = [];
  cycle.push(cycle);
  for (const input of [
    null,
    cycle,
    [getter],
    [{ type: 'function_call_output', output: 'x'.repeat(2 * 1024 * 1024) }],
  ])
    assert.equal(candidate.inspectReadbackInput(input)[0].observed, false);
  assert.equal(executed, 0);
  candidate.close();
});
