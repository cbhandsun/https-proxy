'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  installPublicationActionHook,
} = require('../../scripts/context-hosted/n09-business/publication-action-hook');
const safe = { message: 'n09_publication_action_hook_failed' };
function deferred() {
  let resolve, reject;
  const pending = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { pending, resolve, reject };
}
test('only the action name crosses the hook after the real producer resolves; original result and receiver survive', async () => {
  const producer = deferred(),
    observer = deferred(),
    entered = deferred(),
    result = Object.freeze({ ok: true }),
    calls = [];
  let observed = false,
    touched = 0;
  const session = Object.defineProperty({}, 'PRIVATE', {
      get() {
        touched++;
        throw Error('PRIVATE');
      },
    }),
    args = [session, 'prepare', ['PRIVATE']];
  const exported = {
    async invokeRecoveryPublication(...input) {
      calls.push({ receiver: this, args: input });
      return producer.pending;
    },
  };
  const descriptor = Object.getOwnPropertyDescriptor(exported, 'invokeRecoveryPublication');
  const handle = installPublicationActionHook({
    publicationExports: exported,
    afterPublicationAction(...input) {
      observed = true;
      entered.resolve();
      assert.deepEqual(input, ['prepare']);
      return observer.pending;
    },
  });
  const pending = Reflect.apply(exported.invokeRecoveryPublication, exported, args);
  assert.equal(observed, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].receiver, exported);
  assert.equal(calls[0].args[0], session);
  assert.equal(calls[0].args[2], args[2]);
  producer.resolve(result);
  await entered.pending;
  assert.equal(observed, true);
  let delivered = false;
  void pending.then(() => {
    delivered = true;
  });
  await Promise.resolve();
  assert.equal(delivered, false);
  observer.resolve();
  assert.equal(await pending, result);
  assert.equal(touched, 0);
  handle.close();
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(exported, 'invokeRecoveryPublication'),
    descriptor
  );
  handle.close();
});
test('an original publication rejection is preserved and never enters the observer', async () => {
  const original = Error('PRIVATE'),
    exported = {
      async invokeRecoveryPublication() {
        throw original;
      },
    };
  let observed = 0;
  const handle = installPublicationActionHook({
    publicationExports: exported,
    afterPublicationAction() {
      observed++;
    },
  });
  await assert.rejects(
    exported.invokeRecoveryPublication({}, 'prepare'),
    (error) => error === original
  );
  assert.equal(observed, 0);
  handle.close();
});
test('callback rejection, thenable, returned data and reentrancy cannot hand out the original success', async () => {
  let touched = 0;
  const hostile = {
    get then() {
      touched++;
      throw Error('PRIVATE');
    },
  };
  for (const callback of [
    () => false,
    () => hostile,
    () => Promise.resolve(false),
    () => Promise.reject(Error('PRIVATE')),
    () => {
      throw Error('PRIVATE');
    },
  ]) {
    let calls = 0;
    const exported = {
      async invokeRecoveryPublication() {
        calls++;
        return { ok: true };
      },
    };
    const handle = installPublicationActionHook({
      publicationExports: exported,
      afterPublicationAction: callback,
    });
    await assert.rejects(exported.invokeRecoveryPublication({}, 'prepare'), safe);
    await assert.rejects(exported.invokeRecoveryPublication({}, 'withdraw'), safe);
    assert.equal(calls, 1);
    handle.close();
  }
  assert.equal(touched, 0);
  const exported = {
    async invokeRecoveryPublication() {
      return { ok: true };
    },
  };
  let nested;
  const handle = installPublicationActionHook({
    publicationExports: exported,
    afterPublicationAction() {
      nested = exported.invokeRecoveryPublication({}, 'prepare');
      nested.catch(() => {});
    },
  });
  await assert.rejects(exported.invokeRecoveryPublication({}, 'prepare'), safe);
  await assert.rejects(nested, safe);
  handle.close();
});
test('closing during observation does not release the original value; captured wrapper resumes only as the unhooked producer', async () => {
  const observer = deferred(),
    exported = {
      async invokeRecoveryPublication() {
        return { ok: true };
      },
    };
  const handle = installPublicationActionHook({
    publicationExports: exported,
    afterPublicationAction: () => observer.pending,
  });
  const captured = exported.invokeRecoveryPublication;
  const pending = captured({}, 'prepare');
  await Promise.resolve();
  handle.close();
  observer.resolve();
  await assert.rejects(pending, safe);
  assert.deepEqual(await captured({}, 'withdraw'), { ok: true });
});
test("duplicate installations and descriptor substitution are rejected without replacing someone else's export", () => {
  const exported = {
      async invokeRecoveryPublication() {
        return { ok: true };
      },
    },
    input = { publicationExports: exported, afterPublicationAction() {} };
  const original = exported.invokeRecoveryPublication,
    handle = installPublicationActionHook(input);
  assert.throws(() => installPublicationActionHook(input), safe);
  const replacement = async () => ({ ok: true });
  exported.invokeRecoveryPublication = replacement;
  assert.throws(() => handle.close(), safe);
  assert.equal(exported.invokeRecoveryPublication, replacement);
  assert.throws(() => handle.close(), safe);
  assert.notEqual(replacement, original);
});
test('unsafe, missing, accessor and immutable input fails without executing traps or coercion', () => {
  let touched = 0;
  const proxy = Proxy.revocable({}, {});
  proxy.revoke();
  const accessor = Object.defineProperty({}, 'invokeRecoveryPublication', {
    get() {
      touched++;
      throw Error('PRIVATE');
    },
    enumerable: true,
  });
  for (const publicationExports of [
    null,
    {},
    [],
    proxy.proxy,
    accessor,
    Object.freeze({ async invokeRecoveryPublication() {} }),
    { async *invokeRecoveryPublication() {} },
    {
      invokeRecoveryPublication() {
        return Promise.resolve();
      },
    },
  ])
    assert.throws(
      () => installPublicationActionHook({ publicationExports, afterPublicationAction() {} }),
      safe
    );
  for (const callback of [
    null,
    {},
    function* () {},
    new Proxy(() => {}, {
      apply() {
        touched++;
      },
    }),
  ])
    assert.throws(
      () =>
        installPublicationActionHook({
          publicationExports: { async invokeRecoveryPublication() {} },
          afterPublicationAction: callback,
        }),
      safe
    );
  assert.equal(touched, 0);
});

test('even a malformed successful producer cannot send arbitrary action data to the observer', async () => {
  for (const action of [null, {}, [], Symbol('PRIVATE'), 'PRIVATE']) {
    let observed = 0;
    const exported = {
      async invokeRecoveryPublication() {
        return { ok: true };
      },
    };
    const handle = installPublicationActionHook({
      publicationExports: exported,
      afterPublicationAction() {
        observed++;
      },
    });
    await assert.rejects(exported.invokeRecoveryPublication({}, action), safe);
    assert.equal(observed, 0);
    handle.close();
  }
});

test('observer native promise properties never execute accessor or species hooks', async () => {
  let touched = 0;
  for (const property of ['then', 'constructor']) {
    const exported = {
      async invokeRecoveryPublication() {
        return { ok: true };
      },
    };
    const handle = installPublicationActionHook({
      publicationExports: exported,
      afterPublicationAction() {
        const pending = Promise.resolve();
        Object.defineProperty(pending, property, {
          get() {
            touched++;
            throw Error('PRIVATE');
          },
        });
        return pending;
      },
    });
    await assert.rejects(exported.invokeRecoveryPublication({}, 'prepare'), safe);
    handle.close();
  }
  assert.equal(touched, 0);
});
