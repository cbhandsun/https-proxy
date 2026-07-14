const assert = require('assert');
const {
  applyToolLoopGuardToOpenAIChat,
  countToolResultsAfterLatestUser,
} = require('../lib/proxy/tool-loop-guard');

function makeBody(toolResultCount) {
  const messages = [{ role: 'user', content: '北京天气' }];
  for (let index = 0; index < toolResultCount; index += 1) {
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_' + index,
          type: 'function',
          function: { name: 'web_search', arguments: '{"query":"北京天气"}' },
        },
      ],
    });
    messages.push({
      role: 'tool',
      tool_call_id: 'call_' + index,
      content: '北京天气结果 ' + index,
    });
  }
  return {
    model: 'gemini-3.5-flash',
    messages,
    tools: [
      {
        type: 'function',
        function: {
          name: 'web_search',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      },
    ],
  };
}

assert.strictEqual(countToolResultsAfterLatestUser(null), 0);
assert.strictEqual(
  countToolResultsAfterLatestUser([
    { role: 'user', content: 'old' },
    { role: 'tool', content: 'old result' },
    { role: 'user', content: 'new' },
  ]),
  0
);
assert.strictEqual(countToolResultsAfterLatestUser(makeBody(2).messages), 2);

{
  const body = makeBody(1);
  const result = applyToolLoopGuardToOpenAIChat(body);
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.body, body);
  assert.strictEqual(result.toolResultCount, 1);
}

{
  const body = makeBody(2);
  const result = applyToolLoopGuardToOpenAIChat(body);
  assert.strictEqual(result.applied, true);
  assert.notStrictEqual(result.body, body);
  assert.strictEqual(result.body.tool_choice, undefined);
  assert.strictEqual(result.body.tools, undefined);
  assert.notStrictEqual(result.body.messages, body.messages);
  assert.match(result.body.messages.at(-1).content, /Tool results are already available/);
  assert.match(result.body.messages.at(-1).content, /北京天气结果 1/);
  assert.strictEqual(body.tool_choice, undefined);
  assert.strictEqual(body.tools.length, 1);
}

{
  const body = { ...makeBody(2), tools: [] };
  const result = applyToolLoopGuardToOpenAIChat(body);
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.body, body);
}

{
  const body = makeBody(1);
  const result = applyToolLoopGuardToOpenAIChat(body, { maxToolResults: 1 });
  assert.strictEqual(result.applied, true);
  assert.strictEqual(result.body.tool_choice, undefined);
  assert.strictEqual(result.body.tools, undefined);
  assert.match(result.body.messages.at(-1).content, /北京天气结果 0/);
}

console.log('[tool-loop-guard.test] ok');
