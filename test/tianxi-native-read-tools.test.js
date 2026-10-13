'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { resolveTianxiNativeReadTools } = require('../lib/proxy/tianxi-native-read-tools');

const fakeFs = {
  realpathSync: {
    native(value) {
      return value;
    },
  },
  statSync() {
    return { isDirectory: () => true };
  },
};

test('Tianxi native read tools require explicit profile opt-in and a local directory', () => {
  assert.equal(resolveTianxiNativeReadTools({}), null);
  const config = resolveTianxiNativeReadTools(
    { tianxiNativeReadTools: true, tianxiWorkspace: 'E:\\Project' },
    { fs: fakeFs }
  );
  assert.equal(config.cwd, 'E:\\Project');
  assert.deepEqual(config.allowedTools, ['Read', 'Glob', 'Grep']);
  assert.ok(config.disallowedTools.includes('Write'));
  assert.ok(config.disallowedTools.includes('Bash'));
  assert.equal(config.permissionMode, 'dontAsk');
  assert.ok(config.disallowedTools.includes('Edit'));
  assert.ok(config.disallowedTools.includes('Task'));
  assert.ok(config.disallowedTools.includes('Agent'));
});

test('Tianxi native read tools reject invalid, remote, missing and non-directory workspaces', () => {
  for (const workspace of [
    '',
    '../relative',
    '\\\\server\\share',
    '\\\\?\\C:\\device',
    'E:\\bad\npath',
    'E:\\' + 'x'.repeat(1024),
    null,
  ]) {
    assert.throws(
      () =>
        resolveTianxiNativeReadTools(
          { tianxiNativeReadTools: true, tianxiWorkspace: workspace },
          { fs: fakeFs }
        ),
      { code: 'tianxi_native_workspace_invalid' }
    );
  }
  assert.throws(
    () =>
      resolveTianxiNativeReadTools(
        { tianxiNativeReadTools: true, tianxiWorkspace: 'E:\\missing' },
        {
          fs: {
            ...fakeFs,
            realpathSync: {
              native: () => {
                throw new Error('private path');
              },
            },
          },
        }
      ),
    { code: 'tianxi_native_workspace_invalid' }
  );
  assert.throws(
    () =>
      resolveTianxiNativeReadTools(
        { tianxiNativeReadTools: true, tianxiWorkspace: 'E:\\file' },
        { fs: { ...fakeFs, statSync: () => ({ isDirectory: () => false }) } }
      ),
    { code: 'tianxi_native_workspace_invalid' }
  );
});

test('Tianxi read tools select the Codex project only inside the authorized root', () => {
  const profile = {
    tianxiNativeReadTools: true,
    tianxiWorkspace: 'E:\\Work\\proxy',
    tianxiWorkspaceRoot: 'E:\\Work',
  };
  const input = (cwd) => [
    {
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: `User context\n<environment_context>\n<cwd>${cwd}</cwd>\n</environment_context>`,
        },
      ],
    },
    { role: 'user', content: [{ type: 'input_text', text: 'Describe the project' }] },
  ];
  assert.equal(resolveTianxiNativeReadTools(profile, { fs: fakeFs }).cwd, 'E:\\Work\\proxy');
  assert.equal(
    resolveTianxiNativeReadTools(profile, { fs: fakeFs, requestInput: input('E:\\Work\\notes') })
      .cwd,
    'E:\\Work\\notes'
  );
  assert.equal(
    resolveTianxiNativeReadTools(profile, {
      fs: fakeFs,
      requestInput: [...input('E:\\Work\\notes'), ...input('e:\\work\\notes')],
    }).cwd,
    'E:\\Work\\notes'
  );
  for (const cwd of ['E:\\Workspace-other', 'C:\\secret', '..\\secret', '\\\\server\\share']) {
    assert.throws(
      () => resolveTianxiNativeReadTools(profile, { fs: fakeFs, requestInput: input(cwd) }),
      { code: 'tianxi_native_workspace_invalid' }
    );
  }
  for (const malformed of [
    '<environment_context><cwd>E:\\Work\\notes</cwd>',
    '<environment_context><cwd>E:\\Work\\notes</cwd><cwd>E:\\Work\\other</cwd></environment_context>',
    '<environment_context><cwd>E:\\Work\\notes</cwd></environment_context><environment_context><cwd>E:\\Work\\other</cwd></environment_context>',
    `<environment_context>${'x'.repeat(8193)}<cwd>E:\\Work\\notes</cwd></environment_context>`,
  ]) {
    assert.throws(
      () =>
        resolveTianxiNativeReadTools(profile, {
          fs: fakeFs,
          requestInput: [{ role: 'user', content: malformed }],
        }),
      { code: 'tianxi_native_workspace_invalid' }
    );
  }
  const escapingFs = {
    ...fakeFs,
    realpathSync: {
      native(value) {
        return value === 'E:\\Work\\linked' ? 'C:\\secret' : value;
      },
    },
  };
  assert.throws(
    () =>
      resolveTianxiNativeReadTools(profile, {
        fs: escapingFs,
        requestInput: input('E:\\Work\\linked'),
      }),
    { code: 'tianxi_native_workspace_invalid' }
  );
});
