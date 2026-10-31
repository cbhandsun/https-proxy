'use strict';
const { createHash } = require('node:crypto');
const CONTRACTS = new Map([
  ['apply_patch', 'fac84e039a3e74d1df78b40b63a115166b9e1ddc92b80c430b2748de6080e73b'],
  ['create_goal', 'b7dc149ea118379b8ee44b5b3390133631197ff5a178229f9bdedd5cdddc6028'],
  ['exec_command', '11105327318bcb1d8a646046c3c945f255ac7013506f01cc9426be8854098fef'],
  ['get_goal', '580a240d537fdfddf24e97595832101d1aabd72199d76783ff519b15f87b0f86'],
  ['update_goal', 'de15724d21f19849fa44aba400ebd69b04d4c89fe9e4e6b59a9ef63c0ce7c7a5'],
  ['view_image', '3eafab63e919ca9ab2e8ddaef5925e15a59a66b37751afbe46e439c21d85c92a'],
  ['write_stdin', '693be7c60c3794d231d707aa3162101482a6a721b8845aa153bc79902a49e28b'],
]);
const NAME = 'codex_native_documentation';
function createNativeToolDocs(description) {
  if (
    typeof description !== 'string' ||
    description.length > 1048576 ||
    description.includes('\0') ||
    !description.startsWith('Run JavaScript code to orchestrate/compose tool calls\n')
  )
    throw new Error('tianxi_native_docs_invalid');
  const sections = description.split(/(?=^#{2,3} )/m);
  const found = new Map();
  for (const section of sections) {
    const name = section.match(/^### `([A-Za-z0-9_]+)`\n/)?.[1];
    if (!CONTRACTS.has(name)) continue;
    const hash = createHash('sha256').update(section.trim()).digest('hex');
    if (found.has(name) || hash !== CONTRACTS.get(name))
      throw new Error('tianxi_native_docs_contract_changed');
    found.set(name, section.trim());
  }
  if (found.size !== CONTRACTS.size || sections[0].length > 16000)
    throw new Error('tianxi_native_docs_contract_changed');
  const compact =
    sections[0].trim() +
    '\n\n' +
    [...found.values()].join('\n\n') +
    '\n\nAdditional original tool documentation is available through codex_native_documentation. Read it in bounded pages before using unfamiliar MCP or app tools. Native ALL_TOOLS discovery remains available. This is documentation only; execute actual tools through the host functions.exec.';
  if (compact.length > 30000) throw new Error('tianxi_native_docs_invalid');
  return {
    compact,
    definition: {
      name: NAME,
      description:
        'Read original host functions.exec documentation, including all nested MCP/app tool contracts, without executing any tool. Pages preserve original bytes. Use a text query to locate a tool or namespace, then read from the returned nextOffset. An empty query reads from offset.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 128 },
          offset: { type: 'integer', minimum: 0, maximum: 1048576 },
        },
        additionalProperties: false,
      },
    },
    call(name, args) {
      if (name !== NAME) return undefined;
      if (
        !args ||
        typeof args !== 'object' ||
        Object.keys(args).some((key) => !['query', 'offset'].includes(key)) ||
        (args.query !== undefined &&
          (typeof args.query !== 'string' ||
            args.query.length > 128 ||
            args.query.includes('\0'))) ||
        (args.offset !== undefined &&
          (!Number.isSafeInteger(args.offset) ||
            args.offset < 0 ||
            args.offset > description.length))
      )
        throw new Error('tianxi_native_docs_invalid');
      const start = args.query
        ? description.indexOf(args.query, args.offset || 0)
        : args.offset || 0;
      const end = start < 0 ? -1 : Math.min(description.length, start + 12000);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              found: start >= 0,
              offset: start,
              nextOffset: end >= description.length ? null : end,
              totalChars: description.length,
              text: start < 0 ? '' : description.slice(start, end),
            }),
          },
        ],
      };
    },
  };
}
module.exports = { createNativeToolDocs };
