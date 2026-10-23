'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createLongRecoveryProgress } = require('./recovery-long-progress.cjs');
const progress = createLongRecoveryProgress((line) => process.stderr.write(line));
progress('module_load_started');
const { DatabaseSync } = require('node:sqlite');
const { createRecoverySqliteStore } = require('../../lib/proxy/context-recovery-storage-sqlite');
const {
  createContextRecoverySessions,
  attachContextRecoveryStorage,
} = require('../../lib/proxy/context-recovery-sessions');
const {
  LIST_EVIDENCE_TOOL: LIST,
  READ_EVIDENCE_TOOL: READ,
} = require('../../lib/proxy/context-evidence-tools');
const failure = () => new Error('long_process_recovery_failed');
const check = (value) => {
  if (!value) throw failure();
};
progress('module_load_finished');

async function main() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 16384) throw failure();
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  check(
    input &&
      !Array.isArray(input) &&
      Object.keys(input).sort().join(',') === 'dataKey,databasePath,phase'
  );
  check(
    ['seed', 'resume'].includes(input.phase) &&
      typeof input.databasePath === 'string' &&
      typeof input.dataKey === 'string'
  );
  check(
    path.isAbsolute(input.databasePath) && path.basename(input.databasePath) === 'checkpoint.sqlite'
  );
  const directory = path.dirname(path.resolve(input.databasePath));
  check(
    path.dirname(directory) === path.resolve(os.tmpdir()) &&
      path.basename(directory).startsWith('hpm-long-cold-')
  );
  check(fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink());
  const key = Buffer.from(input.dataKey, 'base64');
  check(key.length === 32 && key.toString('base64') === input.dataKey);
  const now = () => (input.phase === 'seed' ? 1000 : 2000);
  progress('database_open_started');
  const database = new DatabaseSync(input.databasePath);
  progress('database_open_finished');
  progress('store_open_started');
  const store = createRecoverySqliteStore({ database, dataKey: input.dataKey, now });
  progress('store_open_finished');
  const sessions = createContextRecoverySessions({ now });
  sessions.configure(true);
  attachContextRecoveryStorage(sessions, store);
  try {
    check(sessions.inspect().roots === 0);
    const history = Array.from({ length: 3 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: String(index) + '原文🙂'.repeat(90000),
    }));
    const binding = { principal: 'owner', protocol: 'chat', target: 'target' };
    const call = {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'external', type: 'function', function: { name: 'lookup', arguments: '{}' } },
      ],
    };
    const original = 'encrypted-process-original🙂\r\nsecond line';
    const captured = [
      ...history,
      call,
      { role: 'tool', tool_call_id: 'external', content: original },
    ];
    progress('history_ready');
    let capability;
    if (input.phase === 'seed') {
      progress('root_begin_started');
      const root = await sessions.beginAsync({ ...binding, history }, [], () => true);
      progress('root_begin_finished');
      check(root.ok && root.historyFormat === 3);
      progress('root_complete_started');
      check(
        (
          await root.completeObservedAsync(
            [call],
            [{ callId: 'external', toolName: 'lookup', arguments: {}, output: '', completed: true }]
          )
        ).ok
      );
      progress('root_complete_finished');
      progress('continuation_begin_started');
      capability = await sessions.beginAsync(
        { ...binding, history: captured },
        [{ callId: 'external', output: original }],
        () => true
      );
    } else {
      progress('continuation_begin_started');
      capability = await sessions.beginAsync(
        {
          ...binding,
          history: [
            ...captured,
            { role: 'assistant', content: 'done' },
            { role: 'user', content: 'resume' },
          ],
        },
        [],
        () => true
      );
    }
    progress('continuation_begin_finished');
    check(capability.ok && capability.historyFormat === 3 && sessions.inspect().roots === 1);
    progress('list_started');
    const listed = await capability.replyAsync(LIST, {});
    progress('list_finished');
    check(listed.ok);
    const source = JSON.parse(listed.text).sources[0];
    check(source && typeof source.sourceId === 'string');
    progress('read_started');
    const read = await capability.replyAsync(READ, {
      sourceId: source.sourceId,
      digest: source.digest,
    });
    progress('read_finished');
    check(read.ok && JSON.parse(read.text).page.text === original);
    const expiresAt = capability.inspect().expiresAt;
    check(expiresAt === 86401000);
    progress('complete_started');
    check(
      (
        await capability.completeObservedAsync([
          { role: 'assistant', content: input.phase === 'seed' ? 'done' : 'resumed' },
        ])
      ).ok
    );
    progress('complete_finished');
    progress('shutdown_started');
    check((await sessions.shutdownAsync()).ok);
    progress('shutdown_finished');
    // No key, source text, database path or native reply is emitted.
    process.stdout.write(
      JSON.stringify({
        ok: true,
        phase: input.phase,
        historyFormat: 3,
        expiresAt,
        exact: true,
        historyBytes: Buffer.byteLength(JSON.stringify(history)),
      })
    );
  } finally {
    progress('cleanup_started');
    await sessions.shutdownAsync();
    progress('store_close_started');
    store.close();
    database.close();
    progress('store_close_finished');
    key.fill(0);
    progress('cleanup_finished');
  }
}

main().catch(() => {
  process.stderr.write('long_process_recovery_failed\n');
  process.exitCode = 1;
});
