'use strict';

const {
  loopbackUrl,
  optionsFor,
  isolatedEnvironment,
  cliArguments,
} = require('./nsis-client-claude-options');

const PRIVATE_TOOLS =
  /hpm_list_retained_evidence|hpm_read_retained_evidence|private-thinking-sentinel|private-signature-sentinel/;
const TURN_MS = 120000;
const MAX_OUTPUT = 2 * 1024 * 1024;

function fail(code) {
  return new Error(code);
}

async function runInstalledClaudeCase(input) {
  const options = optionsFor(input);
  const { env, verify } = isolatedEnvironment(options);
  let child;
  let stop;
  let stopping = false;
  let pending;
  let buffer = '';
  let totalBytes = 0;
  let failure;
  let receipt;
  let boundaries = 0;
  let phase = 'prepare';
  const phases = new Set();
  function reject(code) {
    failure ??= code;
    pending?.reject(fail(failure));
  }
  function receive(chunk) {
    totalBytes += Buffer.byteLength(chunk);
    if (totalBytes > MAX_OUTPUT) return reject('claude_output_limit');
    buffer += chunk.toString('utf8');
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        reject('claude_json_invalid');
        continue;
      }
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        reject('claude_json_invalid');
        continue;
      }
      if (['assistant', 'result'].includes(event.type) && PRIVATE_TOOLS.test(line))
        reject('claude_private_wire_leak');
      if (event.type === 'system' && event.subtype === 'compact_boundary') {
        if (!/^compact-[123]$/.test(phase) || phases.has(phase))
          reject('claude_compaction_invalid');
        phases.add(phase);
        boundaries++;
      }
      if (event.type === 'result') {
        if (!pending || event.is_error === true) reject('claude_result_invalid');
        else pending.resolve(event);
      }
    }
  }
  async function turn(text, label) {
    if (failure) throw fail(failure);
    verify();
    phase = label;
    options.onProgress?.({ client: 'claude', phase: label });
    verify();
    let timer;
    try {
      return await new Promise((resolve, rejectTurn) => {
        pending = { resolve, reject: rejectTurn };
        timer = setTimeout(() => reject('claude_turn_deadline'), TURN_MS);
        child.stdin.write(
          JSON.stringify({
            type: 'user',
            message: { role: 'user', content: text },
            parent_tool_use_id: null,
            session_id: '',
          }) + '\n'
        );
      });
    } finally {
      clearTimeout(timer);
      pending = null;
    }
  }
  try {
    verify();
    const handle = await options.spawnOwned({
      executable: options.cliPath,
      args: cliArguments(options),
      cwd: options.caseRoot,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (!handle || typeof handle.stop !== 'function') throw fail('claude_owned_handle_invalid');
    stop = handle.stop;
    child = handle.child;
    verify();
    if (
      !child ||
      !child.stdout ||
      !child.stderr ||
      !child.stdin ||
      typeof child.once !== 'function'
    ) {
      throw fail('claude_owned_handle_invalid');
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', receive);
    child.stderr.resume();
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream.on('error', () => {
        if (!stopping) reject('claude_transport_failed');
      });
    }
    child.once('error', () => reject('claude_launch_failed'));
    child.once('close', () => {
      if (!stopping) reject('claude_early_exit');
    });
    await turn(
      'Call the fixture original MCP tool exactly once with empty arguments. Then reply READY without repeating its contents.',
      'seed'
    );
    for (let index = 1; index <= 3; index++) {
      await turn('/compact', 'compact-' + index);
      if (boundaries !== index) throw fail('claude_compaction_invalid');
      if (index < 3) await turn('Continue the synthetic task and reply READY.', 'between-' + index);
    }
    const result = await turn(
      options.mode === 'default'
        ? 'Reply only DONE. Do not invoke any tools.'
        : 'Recover the retained original evidence, without rerunning its original MCP tool. Answer only the exact value after REQUIRED_MARKER= in that original. Do not include the field name, equals sign, quotes, code formatting or any explanation.',
      'final'
    );
    if (failure) throw fail(failure);
    if (
      typeof result.result !== 'string' ||
      result.result.trim() !== (options.mode === 'default' ? 'DONE' : options.marker)
    ) {
      throw fail('claude_final_mismatch');
    }
    const witness = await options.inspectWitness();
    verify();
    if (
      witness?.sourceCalls !== 1 ||
      witness.classifiedCompactions !== 3 ||
      witness.allRequestsStreaming !== true ||
      witness.fullCoreEntrypointVerified !== true ||
      (options.mode === 'default' &&
        (witness.defaultZeroRecovery !== true || witness.requestCount !== 8)) ||
      (options.mode === 'enhanced' &&
        (witness.exactPrivateRead !== true ||
          witness.independentPublicGeneration !== true ||
          witness.exactAuthorizedEvidenceInPublicRequest !== true))
    )
      throw fail('claude_witness_invalid');
    receipt = Object.freeze({
      client: 'claude',
      mode: options.mode,
      protocolPassed: true,
      compactions: boundaries,
      sourceCalls: 1,
      directModelRequests: 0,
      installedClientQualified: false,
    });
  } catch (error) {
    const code =
      typeof error?.message === 'string' && /^claude_[a-z_]+$/.test(error.message)
        ? error.message
        : 'claude_case_failed';
    failure ??= code;
  } finally {
    pending = null;
    stopping = true;
    let stopped;
    try {
      child?.stdin?.end();
      if (stop) stopped = await stop();
      verify();
    } catch (error) {
      failure =
        error?.message === 'claude_case_identity_changed'
          ? 'claude_case_identity_changed'
          : 'claude_owned_cleanup_failed';
    }
    child?.stdout?.removeListener('data', receive);
    if (buffer.length && !failure) failure = 'claude_json_invalid';
    if (stop && (stopped?.terminal !== true || stopped?.treeStopped !== true)) {
      failure = 'claude_owned_cleanup_failed';
    }
  }
  if (failure) throw fail(failure);
  return receipt;
}

module.exports = { runInstalledClaudeCase, loopbackUrl };
