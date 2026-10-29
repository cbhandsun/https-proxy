'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolvePhysicalTestTempDirectory } = require('../lib/test-runtime');
const { getDiagnosticContract } = require('../scripts/lib/codex-stop-diagnostic-contract');
for (const client of ['codex', 'claude'])
  test(
    client +
      ' actual diagnostic PS driver pins contract before launch, rejects post-launch drift and preserves cleanup failures',
    (t) => {
      const contract = getDiagnosticContract(client);
      const root = fs.mkdtempSync(path.join(resolvePhysicalTestTempDirectory(), 'codex-stop-run-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const good = {
        schemaVersion: 1,
        scope: contract.SCOPE,
        diagnosticPassed: true,
        failedPhase: null,
        failureCode: null,
        ownedTreeEmpty: true,
        syntheticSocketsClosed: true,
        installedQualified: false,
        realProvider: false,
        retention24hQualified: false,
        modelRequests: 0,
        probesPassed: true,
        tlsVerified: true,
        nonLoopbackBlocked: true,
        listenerOwned: true,
      };
      const cases = [{ name: 'success', text: JSON.stringify(good) + '\n' }];
      for (const [name, change] of Object.entries({
        crossScope: { scope: getDiagnosticContract(client === 'codex' ? 'claude' : 'codex').SCOPE },
        probe: { probesPassed: false },
        tls: { tlsVerified: false },
        blocked: { nonLoopbackBlocked: false },
        listener: { listenerOwned: false },
        tree: { ownedTreeEmpty: false },
        sockets: { syntheticSocketsClosed: false },
        installed: { installedQualified: true },
        provider: { realProvider: true },
        requests: { modelRequests: 1 },
        phase: { failedPhase: 'PRIVATE' },
        code: { failureCode: 'PRIVATE' },
        type: { installedQualified: 0 },
        missing: { modelRequests: undefined },
      }))
        cases.push({ name, text: JSON.stringify({ ...good, ...change }) + '\n' });
      cases.push({
        name: 'duplicate',
        text:
          JSON.stringify(good).replace('"modelRequests":0', '"modelRequests":0,"modelRequests":0') +
          '\n',
      });
      const cp = path.join(root, 'contract.json'),
        ip = path.join(root, 'cases.json');
      fs.writeFileSync(cp, JSON.stringify(contract));
      fs.writeFileSync(ip, JSON.stringify(cases));
      const r = spawnSync(
        'pwsh',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-File',
          path.join(__dirname, 'fixtures/codex-stop-diagnostic-run.ps1'),
          '-Repository',
          path.resolve(__dirname, '..'),
          '-FixtureRoot',
          root,
          '-ContractFile',
          cp,
          '-CasesFile',
          ip,
          '-Client',
          client,
        ],
        { encoding: 'utf8', timeout: 15000, maxBuffer: 8192 }
      );
      assert.ifError(r.error);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stderr, '');
      const result = JSON.parse(r.stdout);
      for (const row of result.parsed) assert.equal(row.rejected, row.name !== 'success', row.name);
      for (const row of result.driven) {
        assert.equal(row.failed, row.mode !== 'success', row.mode);
        assert.equal(row.treeEmpty, row.mode !== 'unconfirmed', row.mode);
        assert.equal(row.reportPresent, row.mode === 'success', row.mode);
      }
    }
  );
