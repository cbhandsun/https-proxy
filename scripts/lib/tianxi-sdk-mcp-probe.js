'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { runTianxiSdkMcpExperiment } = require('./tianxi-sdk-mcp-experiment');

// Fixed disposable fixture operations. No eval, arbitrary shell, user paths or
// project mutations. A successful probe is not desktop/Codex tool acceptance.
async function probeTianxiSdkNativeTools(modelId, { run = runTianxiSdkMcpExperiment } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-tianxi-native-tools-'));
  const fixture = path.join(root, 'fixture.txt');
  const marker = randomUUID();
  const patch = '*** Begin Patch\n*** Update File: fixture.txt\n@@\n-BEFORE\n+AFTER\n*** End Patch';
  const counts = { read: 0, patch: 0, verify: 0, expectedFailures: 0 };
  fs.writeFileSync(fixture, 'BEFORE');
  const emptySchema = { type: 'object', properties: {}, additionalProperties: false };
  try {
    const result = await run({
      modelId,
      prompt: `Perform these steps using only the supplied tools: (1) read_fixture once; (2) apply_patch with the exact multiline patch below as its input string; the host will intentionally return one error, so retry the same patch once; (3) verify_fixture once. Your final answer must be only the random marker returned by verify_fixture. Never invent the result.\n${patch}`,
      tools: [
        {
          name: 'read_fixture',
          description: 'Read the isolated fixture.',
          inputSchema: emptySchema,
        },
        {
          name: 'apply_patch',
          description:
            'Submit the raw multiline patch as input, without code fences. The first attempt returns an intentional error. Retry once.',
          inputSchema: {
            type: 'object',
            properties: { input: { type: 'string', maxLength: 2048 } },
            required: ['input'],
            additionalProperties: false,
          },
        },
        {
          name: 'verify_fixture',
          description:
            'Verify the fixture after successful patching and return a fresh random marker.',
          inputSchema: emptySchema,
        },
      ],
      async onCall(name, args) {
        if (name === 'read_fixture' && ++counts.read === 1 && counts.patch === 0) {
          return { content: [{ type: 'text', text: fs.readFileSync(fixture, 'utf8') }] };
        }
        if (
          name === 'apply_patch' &&
          counts.read === 1 &&
          counts.verify === 0 &&
          args.input === patch &&
          ++counts.patch <= 2
        ) {
          if (counts.patch === 1) {
            counts.expectedFailures++;
            return { isError: true, content: [{ type: 'text', text: 'fixture_busy_retry_once' }] };
          }
          fs.writeFileSync(fixture, 'AFTER');
          return { content: [{ type: 'text', text: 'patch_applied' }] };
        }
        if (
          name === 'verify_fixture' &&
          ++counts.verify === 1 &&
          counts.patch === 2 &&
          fs.readFileSync(fixture, 'utf8') === 'AFTER'
        ) {
          return { content: [{ type: 'text', text: marker }] };
        }
        throw new Error('fixture_sequence_invalid');
      },
    });
    const finalText = result.finalText ?? result.output;
    const passed =
      counts.read === 1 &&
      counts.patch === 2 &&
      counts.verify === 1 &&
      counts.expectedFailures === 1 &&
      result.calls === 4 &&
      finalText.trim() === marker;
    return {
      checkedAt: new Date().toISOString(),
      modelId,
      observedModel: result.observedModel,
      passed,
      calls: result.calls,
      counts,
      returnedMarker: finalText.trim() === marker,
      markerInAggregate: result.output.includes(marker),
      aggregateTextChars: result.output.length,
      finalTextChars: finalText.length,
      rawPatchPreserved: counts.patch === 2,
      transport: 'sdk-in-process-mcp',
      methods: result.methods,
      productionRouteChanged: false,
      codexDesktopValidated: false,
    };
  } finally {
    // Only the two exact paths created by this invocation are removed.
    fs.unlinkSync(fixture);
    fs.rmdirSync(root);
  }
}

module.exports = { probeTianxiSdkNativeTools };
