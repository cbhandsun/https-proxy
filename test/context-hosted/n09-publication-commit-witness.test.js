'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');
const { createRecoverySqliteStore } = require('../../lib/proxy/context-recovery-storage-sqlite');
const {
  createPublicationCommitWitness,
} = require('../../scripts/context-hosted/n09-business/publication-commit-witness');
const safe = { message: 'n09_publication_commit_witness_failed' };
const scope = 'a'.repeat(64);
function fixture(t) {
  const ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hpm-n09-commit-witness-'));
  const runtimeDir = path.join(ownedRoot, 'runtime');
  const directory = path.join(runtimeDir, 'context-recovery-v1');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, '.data-key'), 'synthetic wrapped data');
  const file = path.join(directory, 'checkpoint.sqlite');
  const database = new DatabaseSync(file, { allowExtension: false });
  const store = createRecoverySqliteStore({
    database,
    dataKey: randomBytes(32).toString('base64'),
    now: () => 100,
  });
  store.execute({
    operation: 'save',
    scope,
    expectedRevision: 0,
    expiresAt: 1000,
    state: { synthetic: true },
  });
  store.close();
  database.close();
  t.after(() => fs.rmSync(ownedRoot, { recursive: true, force: true }));
  return { ownedRoot, runtimeDir, file, input: { ownedRoot, runtimeDir, expectedRevision: 1 } };
}
function hash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function writer(file) {
  const worker = new Worker(
    `
    const {parentPort,workerData}=require('node:worker_threads');
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(workerData.file,{allowExtension:false});
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000');
    parentPort.once('message',()=>{
      try {
        db.exec('BEGIN IMMEDIATE; UPDATE recovery_state SET revision=revision+1');
        parentPort.postMessage('committing');
        db.exec('COMMIT');
        db.close();parentPort.postMessage('committed');parentPort.close();
      }catch{try{db.close()}catch{};parentPort.postMessage('failed');parentPort.close();}
    });
    parentPort.postMessage('ready');
  `,
    { eval: true, workerData: { file }, execArgv: [] }
  );
  const messages = [];
  worker.on('message', (value) => messages.push(value));
  const exit = once(worker, 'exit');
  return { worker, messages, exit };
}
async function phase(w, value) {
  const signal = globalThis.AbortSignal.timeout(5000);
  while (!w.messages.includes(value)) {
    assert.equal(w.messages.includes('failed'), false);
    await once(w.worker, 'message', { signal });
  }
}

test(
  'actual file witness observes a pending COMMIT and releases both readonly connections before a real commit',
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t),
      w = writer(f.file);
    let witness;
    try {
      await phase(w, 'ready');
      const original = hash(f.file);
      witness = createPublicationCommitWitness(f.input);
      w.worker.postMessage('start');
      await phase(w, 'committing');
      const proof = await witness.waitPending();
      assert.deepEqual(proof, {
        readAdmissionBlocked: true,
        evidenceLevel: 'sqlite-read-admission-only',
        publicationQualified: false,
      });
      assert.equal(Object.isFrozen(proof), true);
      assert.equal(w.messages.includes('committed'), false);
      assert.equal(hash(f.file), original);
      assert.deepEqual(witness.release(), { released: true });
      await phase(w, 'committed');
      assert.deepEqual(await w.exit, [0]);
      assert.notEqual(hash(f.file), original);
      assert.throws(() => witness.release(), safe);
      witness.close();
    } finally {
      witness?.close();
      await w.worker.terminate();
    }
  }
);

test(
  'no writer cannot become a COMMIT witness and timeout frees the actual reader lock',
  { timeout: 5000 },
  async (t) => {
    const f = fixture(t),
      original = hash(f.file);
    const witness = createPublicationCommitWitness(f.input);
    await assert.rejects(witness.waitPending(), safe);
    assert.equal(hash(f.file), original);
    assert.throws(() => witness.release(), safe);
    witness.close();
    const database = new DatabaseSync(f.file);
    try {
      database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK');
    } finally {
      database.close();
    }
  }
);

test('release before observing and concurrent wait attempts revoke the witness without writing', async (t) => {
  const f = fixture(t),
    original = hash(f.file);
  const first = createPublicationCommitWitness(f.input);
  assert.throws(() => first.release(), safe);
  const second = createPublicationCommitWitness(f.input);
  const pending = assert.rejects(second.waitPending(), safe);
  await assert.rejects(second.waitPending(), safe);
  await pending;
  assert.equal(hash(f.file), original);
});

test('invalid, empty, excessive or executable input is rejected without hooks', (t) => {
  const f = fixture(t);
  let touched = 0;
  const getter = Object.defineProperty({ ...f.input }, 'expectedRevision', {
    enumerable: true,
    get() {
      touched++;
      return 1;
    },
  });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const input of [
    null,
    {},
    [],
    getter,
    new Proxy(f.input, {
      ownKeys() {
        touched++;
        throw Error('PRIVATE');
      },
    }),
    revoked.proxy,
    ...[0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'].map((expectedRevision) => ({
      ...f.input,
      expectedRevision,
    })),
    { ...f.input, private: 'PRIVATE' },
    { ...f.input, runtimeDir: f.ownedRoot },
    { ...f.input, runtimeDir: path.dirname(f.ownedRoot) },
    { ...f.input, runtimeDir: '../relative' },
  ])
    assert.throws(() => createPublicationCommitWitness(input), safe);
  assert.equal(touched, 0);
});

test('mismatched revision, multiple roots, missing files and WAL cannot be admitted as the target boundary', (t) => {
  const f = fixture(t);
  assert.throws(() => createPublicationCommitWitness({ ...f.input, expectedRevision: 2 }), safe);
  let db = new DatabaseSync(f.file);
  db.exec(
    "INSERT INTO recovery_state SELECT '" +
      'b'.repeat(64) +
      "',revision,created_at,expires_at,kind,envelope FROM recovery_state"
  );
  db.close();
  assert.throws(() => createPublicationCommitWitness(f.input), safe);
  db = new DatabaseSync(f.file);
  db.exec(
    "DELETE FROM recovery_state WHERE scope='" + 'b'.repeat(64) + "'; PRAGMA journal_mode=WAL"
  );
  db.close();
  assert.throws(() => createPublicationCommitWitness(f.input), safe);
  fs.unlinkSync(path.join(f.runtimeDir, 'context-recovery-v1/.data-key'));
  assert.throws(() => createPublicationCommitWitness(f.input), safe);
});

test('filesystem aliases and empty or corrupt databases cannot become readonly witnesses', (t) => {
  for (const mode of ['key-link', 'database-link', 'empty', 'corrupt']) {
    const f = fixture(t);
    if (mode === 'key-link')
      fs.linkSync(
        path.join(f.runtimeDir, 'context-recovery-v1/.data-key'),
        path.join(f.ownedRoot, 'alias')
      );
    if (mode === 'database-link') fs.linkSync(f.file, path.join(f.ownedRoot, 'alias'));
    if (mode === 'empty') fs.truncateSync(f.file, 0);
    if (mode === 'corrupt') fs.writeFileSync(f.file, Buffer.alloc(100, 9));
    assert.throws(() => createPublicationCommitWitness(f.input), safe);
  }
});

test('only the exact SQLite BUSY result can witness a pending lock; other failures release ownership', async (t) => {
  for (const error of [
    new Error('SQLITE_BUSY PRIVATE'),
    Object.assign(new Error('PRIVATE'), { code: 'ERR_SQLITE_ERROR', errcode: 6 }),
    Object.assign(new Error('PRIVATE'), { code: 'OTHER', errcode: 5 }),
  ]) {
    const f = fixture(t),
      witness = createPublicationCommitWitness(f.input);
    const original = DatabaseSync.prototype.prepare;
    try {
      DatabaseSync.prototype.prepare = function () {
        throw error;
      };
      await assert.rejects(witness.waitPending(), safe);
    } finally {
      DatabaseSync.prototype.prepare = original;
      witness.close();
    }
    const db = new DatabaseSync(f.file);
    try {
      db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK');
    } finally {
      db.close();
    }
  }
});

test('rollback and close failures remain sticky while every actual handle is closed', (t) => {
  for (const mode of ['rollback', 'close']) {
    const f = fixture(t),
      witness = createPublicationCommitWitness(f.input);
    const exec = DatabaseSync.prototype.exec,
      close = DatabaseSync.prototype.close;
    let closes = 0;
    try {
      DatabaseSync.prototype.exec = function (sql) {
        if (mode === 'rollback' && sql === 'ROLLBACK') throw Error('PRIVATE');
        return Reflect.apply(exec, this, [sql]);
      };
      DatabaseSync.prototype.close = function () {
        const result = Reflect.apply(close, this, []);
        closes++;
        if (mode === 'close' && closes === 1) throw Error('PRIVATE');
        return result;
      };
      assert.throws(() => witness.close(), safe);
      assert.equal(closes, 2);
      assert.throws(() => witness.close(), safe);
      assert.throws(() => witness.release(), safe);
    } finally {
      DatabaseSync.prototype.exec = exec;
      DatabaseSync.prototype.close = close;
    }
    const db = new DatabaseSync(f.file);
    try {
      db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK');
    } finally {
      db.close();
    }
  }
});

test(
  'a replaced pinned key invalidates a real pending witness instead of reporting success',
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t),
      w = writer(f.file);
    let witness;
    try {
      await phase(w, 'ready');
      witness = createPublicationCommitWitness(f.input);
      const key = path.join(f.runtimeDir, 'context-recovery-v1/.data-key');
      fs.renameSync(key, key + '.old');
      fs.writeFileSync(key, 'synthetic wrapped data');
      w.worker.postMessage('start');
      await phase(w, 'committing');
      await assert.rejects(witness.waitPending(), safe);
      await phase(w, 'committed');
      assert.deepEqual(await w.exit, [0]);
      assert.throws(() => witness.release(), safe);
    } finally {
      witness?.close();
      await w.worker.terminate();
    }
  }
);

test(
  'an unrelated exclusive BEGIN can also block a reader and must never receive a COMMIT or publication claim',
  { timeout: 15000 },
  async (t) => {
    const f = fixture(t),
      original = hash(f.file);
    const worker = new Worker(
      `
    const {parentPort,workerData}=require('node:worker_threads');
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(workerData.file,{allowExtension:false});
    db.exec('PRAGMA busy_timeout=1000');
    parentPort.once('message',()=>{
      parentPort.postMessage('exclusive-entering');
      try {db.exec('BEGIN EXCLUSIVE; ROLLBACK');db.close();parentPort.postMessage('exclusive-finished');}
      catch{try{db.close()}catch{};parentPort.postMessage('failed');}
      parentPort.close();
    });parentPort.postMessage('ready');
  `,
      { eval: true, workerData: { file: f.file }, execArgv: [] }
    );
    const messages = [];
    worker.on('message', (value) => messages.push(value));
    const w = { worker, messages, exit: once(worker, 'exit') };
    let witness;
    try {
      await phase(w, 'ready');
      witness = createPublicationCommitWitness(f.input);
      worker.postMessage('start');
      await phase(w, 'exclusive-entering');
      const proof = await witness.waitPending();
      assert.equal(proof.readAdmissionBlocked, true);
      assert.equal(proof.evidenceLevel, 'sqlite-read-admission-only');
      assert.equal(Object.hasOwn(proof, 'commitPending'), false);
      assert.equal(proof.publicationQualified, false);
      assert.deepEqual(witness.release(), { released: true });
      await phase(w, 'exclusive-finished');
      assert.deepEqual(await w.exit, [0]);
      assert.equal(hash(f.file), original);
    } finally {
      witness?.close();
      await worker.terminate();
    }
  }
);
