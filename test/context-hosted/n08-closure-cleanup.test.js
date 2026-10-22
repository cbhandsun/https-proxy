'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { verifyPinnedClosure } = require('../../scripts/context-hosted/n08/owned-entry.js');
const { closeOwnedResources } = require('../../scripts/context-hosted/n08/cleanup.js');
test('omitted direct and lazy transitive modules reject before any code executes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'n08-closure-'));
  const entry = path.join(root, 'entry.js'),
    child = path.join(root, 'child.js'),
    leaf = path.join(root, 'leaf.js');
  try {
    fs.writeFileSync(entry, "require('./child.js');\n");
    fs.writeFileSync(child, "module.exports=()=>require('./leaf.js');\n");
    fs.writeFileSync(leaf, "throw new Error('must_never_execute');\n");
    const pin = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.throws(
      () => verifyPinnedClosure({ [entry]: pin(entry) }, [entry]),
      /n08_owned_entry_rejected/
    );
    assert.throws(
      () => verifyPinnedClosure({ [entry]: pin(entry), [child]: pin(child) }, [entry]),
      /n08_owned_entry_rejected/
    );
    assert.equal(
      verifyPinnedClosure({ [entry]: pin(entry), [child]: pin(child), [leaf]: pin(leaf) }, [entry])
        .files,
      3
    );
    assert.equal(require.cache[entry], undefined);
    assert.equal(require.cache[child], undefined);
    assert.equal(require.cache[leaf], undefined);
    assert.throws(() =>
      verifyPinnedClosure({ [entry]: '0'.repeat(64), [child]: pin(child), [leaf]: pin(leaf) }, [
        entry,
      ])
    );
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
test('cleanup receipt observes each close and cannot assert sockets closed on failure', async () => {
  const calls = [];
  const sessions = new Map([
    [
      0,
      {
        channel: {
          close: async () => {
            calls.push('channel');
            return true;
          },
        },
      },
    ],
  ]);
  const adapter = {
    closeSession: async () => {
      calls.push('session');
      return true;
    },
  };
  const listener = {
    close: async () => {
      calls.push('listener');
      return true;
    },
  };
  assert.deepEqual(await closeOwnedResources(sessions, adapter, listener), {
    closedChannels: 1,
    expectedChannels: 1,
    syntheticSocketsClosed: true,
  });
  assert.deepEqual(calls, ['session', 'channel', 'listener']);
  for (const close of [
    async () => false,
    async () => {
      throw new Error('private');
    },
  ]) {
    await assert.rejects(
      closeOwnedResources(sessions, adapter, { close }),
      /^Error: n08_owned_cleanup_failed$/
    );
    await assert.rejects(
      closeOwnedResources(new Map([[0, { channel: { close } }]]), adapter, listener),
      /^Error: n08_owned_cleanup_failed$/
    );
  }
  await assert.rejects(
    closeOwnedResources(sessions, adapter, undefined),
    /n08_owned_cleanup_failed/
  );
});
