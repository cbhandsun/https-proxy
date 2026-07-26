const assert = require('node:assert/strict');

(async () => {
  const { bindDomainDependencies } = await import('../../tauri-ui/src/app/runtime/dependencies.js');
  const runtime = {
    action() {},
    get config() {
      return undefined;
    },
  };

  assert.equal(bindDomainDependencies('audit', runtime, ['action', 'config']), runtime);
  assert.throws(() => bindDomainDependencies('', runtime, []), /domainName/);
  assert.throws(() => bindDomainDependencies('audit', null, []), /must be an object/);
  assert.throws(() => bindDomainDependencies('audit', [], []), /must be an object/);
  assert.throws(() => bindDomainDependencies('audit', runtime, null), /required dependency names/);
  assert.throws(
    () => bindDomainDependencies('audit', runtime, ['missing', 'missing']),
    /dependencies missing: missing/
  );

  console.log('[dependencies.test] ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
