'use strict';

// Scope assertions for the disposable probe, not a JavaScript security sandbox.
// The actual Codex client remains responsible for enforcing execution policy.
function createTianxiNativeProbeScope() {
  const cells = new Set();
  const calls = [];
  let rejected = 0;
  const fail = () => {
    rejected++;
    throw new Error('tianxi_codex_probe_tool_out_of_scope');
  };
  return {
    observeOutput(value) {
      if (typeof value !== 'string' || Buffer.byteLength(value) > 60000) return;
      for (const match of value.matchAll(
        /Script running with cell ID ([A-Za-z0-9_-]{1,80})(?=\s|$)/g
      )) {
        if (cells.size < 32) cells.add(match[1]);
      }
    },
    accept(call) {
      if (call?.namespace !== 'functions') return fail();
      if (call.type === 'function_call' && call.name === 'wait') {
        let args;
        try {
          args = JSON.parse(call.arguments);
        } catch {
          return fail();
        }
        if (
          !args ||
          Array.isArray(args) ||
          !cells.has(args.cell_id) ||
          Object.keys(args).some(
            (key) => !['cell_id', 'max_tokens', 'terminate', 'yield_time_ms'].includes(key)
          ) ||
          (args.yield_time_ms !== undefined &&
            (!Number.isSafeInteger(args.yield_time_ms) ||
              args.yield_time_ms < 1 ||
              args.yield_time_ms > 60000)) ||
          (args.max_tokens !== undefined &&
            (!Number.isSafeInteger(args.max_tokens) ||
              args.max_tokens < 1 ||
              args.max_tokens > 10000)) ||
          (args.terminate !== undefined && typeof args.terminate !== 'boolean')
        )
          return fail();
        calls.push('functions.wait');
        return;
      }
      if (
        call.type !== 'custom_tool_call' ||
        call.name !== 'exec' ||
        typeof call.input !== 'string'
      )
        return fail();
      const used = [...call.input.matchAll(/tools\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map(
        (match) => match[1]
      );
      if (
        !used.length ||
        used.some((name) => !['exec_command', 'apply_patch', 'write_stdin'].includes(name))
      )
        return fail();
      calls.push(...used);
    },
    get calls() {
      return [...calls];
    },
    get rejectedCalls() {
      return rejected;
    },
  };
}

module.exports = { createTianxiNativeProbeScope };
