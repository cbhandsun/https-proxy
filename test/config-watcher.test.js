const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { debounceReload } = require('../lib/proxy/config-watcher');

// Use a temp dir for all test artifacts
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgwatcher-'));
const CFG_FILE = path.join(TMP_DIR, 'proxy.config.json');

function writeJson(obj) {
  fs.writeFileSync(CFG_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

function rmrf() {
  try {
    fs.unlinkSync(CFG_FILE);
  } catch (e) {}
  try {
    fs.rmdirSync(TMP_DIR);
  } catch (e) {}
}

(async () => {
  // 1. debounce merges multiple change events
  writeJson({ activeProfile: 'A' });
  let reloadCount = 0;
  let lastConfig = null;
  const watcher1 = debounceReload(
    CFG_FILE,
    (cfg) => {
      reloadCount += 1;
      lastConfig = cfg;
    },
    {
      debounceMs: 50,
    }
  );
  await sleep(50);
  // Emit several "change" events back-to-back
  fs.writeFileSync(CFG_FILE, JSON.stringify({ activeProfile: 'B' }));
  await sleep(20);
  fs.writeFileSync(CFG_FILE, JSON.stringify({ activeProfile: 'C' }));
  await sleep(20);
  fs.writeFileSync(CFG_FILE, JSON.stringify({ activeProfile: 'D' }));
  await sleep(20);
  await waitFor(() => reloadCount === 1, 500);
  assert.strictEqual(
    reloadCount,
    1,
    'multiple changes should collapse to one reload, got: ' + reloadCount
  );
  assert.strictEqual(lastConfig.activeProfile, 'D', 'last write wins');
  watcher1.close();
  console.log('[config-watcher.test] debounce ok');

  // 2. reloadFn error doesn't kill the watcher
  writeJson({ activeProfile: 'E' });
  let errCount = 0;
  const watcher2 = debounceReload(
    CFG_FILE,
    () => {
      throw new Error('synthetic');
    },
    {
      debounceMs: 30,
      onError: () => {
        errCount += 1;
      },
    }
  );
  await sleep(50);
  fs.writeFileSync(CFG_FILE, JSON.stringify({ activeProfile: 'F' }));
  await waitFor(() => errCount >= 1, 500);
  assert.ok(errCount >= 1, 'onError should fire on bad reload');
  watcher2.close();
  console.log('[config-watcher.test] error resilience ok');

  // 3. close() stops further reloads
  writeJson({ activeProfile: 'G' });
  let afterClose = 0;
  const watcher3 = debounceReload(
    CFG_FILE,
    () => {
      afterClose += 1;
    },
    { debounceMs: 30 }
  );
  watcher3.close();
  fs.writeFileSync(CFG_FILE, JSON.stringify({ activeProfile: 'H' }));
  await sleep(80);
  assert.strictEqual(afterClose, 0, 'close() should prevent reloads');
  console.log('[config-watcher.test] close ok');

  // 4. scheduleNow triggers an immediate reload
  writeJson({ activeProfile: 'I' });
  let immediateCount = 0;
  const watcher4 = debounceReload(
    CFG_FILE,
    () => {
      immediateCount += 1;
    },
    { debounceMs: 1000 }
  );
  watcher4.scheduleNow();
  await waitFor(() => immediateCount === 1, 500);
  assert.strictEqual(immediateCount, 1, 'scheduleNow should trigger immediate reload');
  watcher4.close();
  console.log('[config-watcher.test] scheduleNow ok');

  // 5. EBUSY/EPERM retries - simulate by reading the file while watcher is reading
  writeJson({ activeProfile: 'J' });
  let retryCount = 0;
  const watcher5 = debounceReload(
    CFG_FILE,
    () => {
      retryCount += 1;
    },
    {
      debounceMs: 30,
      retryDelayMs: 10,
      maxRetries: 3,
    }
  );
  await sleep(50);
  fs.writeFileSync(CFG_FILE, JSON.stringify({ activeProfile: 'K' }));
  await waitFor(() => retryCount === 1, 500);
  assert.strictEqual(retryCount, 1, 'normal read should succeed without retry');
  watcher5.close();
  console.log('[config-watcher.test] normal read ok');

  // 6. reload lock: concurrent reloads should not overlap
  writeJson({ activeProfile: 'L' });
  let inFlight = 0;
  let maxConcurrent = 0;
  const watcher6 = debounceReload(
    CFG_FILE,
    async (cfg) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await sleep(50);
      inFlight -= 1;
      return cfg;
    },
    { debounceMs: 20 }
  );
  await sleep(50);
  // Burst of writes
  for (let i = 0; i < 5; i += 1) {
    fs.writeFileSync(CFG_FILE, JSON.stringify({ activeProfile: 'L' + i }));
    await sleep(5);
  }
  await sleep(200);
  assert.strictEqual(
    maxConcurrent,
    1,
    'reload lock must serialize reloads, got max=' + maxConcurrent
  );
  watcher6.close();
  console.log('[config-watcher.test] reload lock ok');

  // 7. missing file should report through onError without unhandled EventEmitter error
  let missingFileErrors = 0;
  const missingFile = path.join(TMP_DIR, 'missing-proxy.config.json');
  const watcher7 = debounceReload(missingFile, () => {}, {
    onError: () => {
      missingFileErrors += 1;
    },
  });
  assert.strictEqual(
    missingFileErrors,
    1,
    'missing watched file should report exactly one startup error'
  );
  watcher7.close();
  console.log('[config-watcher.test] missing file error ok');

  // 8. Optional loadConfigFn lets production reload apply normalized/decrypted config.
  writeJson({ activeProfile: 'raw-encrypted' });
  let normalizedConfig = null;
  const watcher8 = debounceReload(
    CFG_FILE,
    (cfg) => {
      normalizedConfig = cfg;
    },
    {
      debounceMs: 30,
      loadConfigFn: () => ({
        activeProfile: 'normalized',
        entryAuth: { keys: [{ key: 'plain' }] },
      }),
    }
  );
  watcher8.scheduleNow();
  await waitFor(() => normalizedConfig, 500);
  assert.strictEqual(normalizedConfig.activeProfile, 'normalized');
  assert.strictEqual(normalizedConfig.entryAuth.keys[0].key, 'plain');
  watcher8.close();
  console.log('[config-watcher.test] loadConfigFn normalization ok');

  // 9. Invalid normalized config must not replace the last valid runtime config.
  writeJson({ activeProfile: 'invalid' });
  let invalidApplied = 0;
  let invalidErrors = 0;
  const watcher9 = debounceReload(
    CFG_FILE,
    () => {
      invalidApplied += 1;
    },
    {
      loadConfigFn: () => {
        throw new Error('Invalid proxy configuration');
      },
      onError: () => {
        invalidErrors += 1;
      },
    }
  );
  watcher9.scheduleNow();
  await waitFor(() => invalidErrors === 1, 500);
  assert.strictEqual(invalidApplied, 0);
  watcher9.close();
  console.log('[config-watcher.test] invalid normalized config rejected');

  rmrf();
  console.log('[config-watcher.test] ok');
  process.exit(0);
})().catch((err) => {
  rmrf();
  console.error('config-watcher.test FAILED:', err);
  process.exit(1);
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(10);
  }
}
