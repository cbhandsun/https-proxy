'use strict';
const WORKLOADS = Object.freeze(['tool-history', 'short-text', 'long-text', 'image-history']);
const IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
function createBenchmarkRequest(workload) {
  if (!WORKLOADS.includes(workload)) throw new TypeError('Invalid benchmark workload');
  const input = [];
  if (workload === 'tool-history') {
    for (let i = 0; i < 20; i++)
      input.push(
        { role: 'user', content: 'synthetic 中文 😀 ' + 'x'.repeat(256) },
        {
          type: 'function_call',
          call_id: 'call_' + i,
          name: 'lookup',
          arguments: '{"q":"synthetic"}',
        },
        { type: 'function_call_output', call_id: 'call_' + i, output: 'result ' + 'y'.repeat(256) }
      );
  } else if (workload === 'long-text') {
    for (let i = 0; i < 10; i++)
      input.push(
        { role: 'user', content: 'synthetic 中文 😀 ' + 'x'.repeat(2048) },
        { role: 'assistant', content: 'synthetic answer ' + 'y'.repeat(2048) }
      );
  } else if (workload === 'image-history') {
    for (let i = 0; i < 4; i++)
      input.push({
        role: 'user',
        content: [
          { type: 'input_text', text: 'synthetic image ' + i },
          { type: 'input_image', image_url: IMAGE },
        ],
      });
  } else input.push({ role: 'user', content: 'synthetic 中文 😀' });
  return {
    input,
    instructions: 'synthetic system',
    max_output_tokens: 4096,
    ...(workload === 'tool-history'
      ? {
          tools: [
            {
              type: 'function',
              name: 'lookup',
              parameters: { type: 'object', properties: { q: { type: 'string' } } },
            },
          ],
        }
      : {}),
  };
}
module.exports = { WORKLOADS, createBenchmarkRequest };
