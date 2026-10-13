'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { spawnSync } = require('node:child_process');
const { createBenchmarkCases } = require('./protocol-benchmark-cases');
const root = path.resolve(__dirname, '../..');
function invalidArguments() {
  throw new TypeError('Invalid protocol benchmark arguments');
}
function integer(value, minimum, maximum) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) invalidArguments();
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < minimum || numeric > maximum) invalidArguments();
  return numeric;
}
function parseArguments(args) {
  const options = {
    iterations: 200,
    warmup: 20,
    samples: 3,
    output: path.join(root, 'tmp/protocol-benchmark/results.json'),
  };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--iterations', '--warmup', '--samples', '--output'].includes(key) || seen.has(key))
      invalidArguments();
    seen.add(key);
    const value = args[i + 1];
    if (key === '--output') {
      if (
        typeof value !== 'string' ||
        value.startsWith('--') ||
        !value.endsWith('.json') ||
        value.includes('\0')
      )
        invalidArguments();
      options.output = path.resolve(value);
    } else
      options[key.slice(2)] = integer(
        value,
        key === '--warmup' ? 0 : 1,
        key === '--samples' ? 9 : key === '--warmup' ? 200 : 10000
      );
  }
  return options;
}
function loadedSourceHash() {
  const hash = createHash('sha256');
  for (const file of Object.keys(require.cache)
    .filter(
      (file) =>
        file.startsWith(root + path.sep) &&
        file.endsWith('.js') &&
        !file.includes(path.sep + 'node_modules' + path.sep)
    )
    .sort()) {
    hash.update(path.relative(root, file).replaceAll('\\', '/'));
    hash.update(fs.readFileSync(file));
  }
  return hash.digest('hex');
}
function measureCase(id, variant, iterations, warmup) {
  const entry = createBenchmarkCases().find((value) => value.id === id);
  if (
    !entry ||
    !entry.variants.includes(variant) ||
    !Number.isSafeInteger(iterations) ||
    iterations < 1 ||
    iterations > 10000 ||
    !Number.isSafeInteger(warmup) ||
    warmup < 0 ||
    warmup > 200
  )
    invalidArguments();
  const parity = entry.variants.map((name) => entry.run(name, true));
  if (parity.length > 1 && parity.some((value) => value.fingerprint !== parity[0].fingerprint))
    throw new Error('Protocol benchmark parity failed');
  for (let i = 0; i < warmup; i++) entry.run(variant);
  global.gc?.();
  const baseline = process.memoryUsage();
  let heapPeak = baseline.heapUsed,
    rssPeak = baseline.rss,
    result;
  const sampleEvery = Math.max(1, Math.floor(iterations / 20));
  const cpuStart = process.cpuUsage(),
    started = performance.now();
  for (let i = 0; i < iterations; i++) {
    result = entry.run(variant);
    if (i % sampleEvery === 0 || i === iterations - 1) {
      const memory = process.memoryUsage();
      heapPeak = Math.max(heapPeak, memory.heapUsed);
      rssPeak = Math.max(rssPeak, memory.rss);
    }
  }
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);
  return {
    id,
    variant,
    iterations,
    warmup,
    inputBytes: entry.inputBytes,
    sourceHash: loadedSourceHash(),
    parityVerified: true,
    cpuMicrosPerOperation: (cpu.user + cpu.system) / iterations,
    wallMillisPerOperation: wallMs / iterations,
    heapBaselineBytes: baseline.heapUsed,
    sampledHeapPeakBytes: heapPeak,
    sampledHeapPeakIncreaseBytes: heapPeak - baseline.heapUsed,
    rssBaselineBytes: baseline.rss,
    sampledRssPeakBytes: rssPeak,
    processLifetimeMaxRssBytes: process.resourceUsage().maxRSS * 1024,
    ...result,
  };
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function sanitizeWorkerResult(result, entry, variant, options) {
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    result.id !== entry.id ||
    result.variant !== variant ||
    result.parityVerified !== true ||
    result.iterations !== options.iterations ||
    result.warmup !== options.warmup ||
    typeof result.sourceHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(result.sourceHash)
  )
    throw new Error('Protocol benchmark worker returned invalid metrics');
  const clean = { id: entry.id, variant, parityVerified: true, sourceHash: result.sourceHash };
  const fields = [
    'iterations',
    'warmup',
    'inputBytes',
    'cpuMicrosPerOperation',
    'wallMillisPerOperation',
    'heapBaselineBytes',
    'sampledHeapPeakBytes',
    'sampledHeapPeakIncreaseBytes',
    'rssBaselineBytes',
    'sampledRssPeakBytes',
    'processLifetimeMaxRssBytes',
    'outputBytes',
  ];
  for (const field of fields) {
    if (typeof result[field] !== 'number' || !Number.isFinite(result[field]) || result[field] < 0)
      throw new Error('Protocol benchmark worker returned invalid metrics');
    clean[field] = result[field];
  }
  if (entry.variants.length === 1) {
    for (const field of [
      'bufferedPayloadPeakBytes',
      'downstreamWrites',
      'upstreamPauses',
      'reports',
    ]) {
      if (!Number.isSafeInteger(result[field]) || result[field] < 0)
        throw new Error('Protocol benchmark worker returned invalid metrics');
      clean[field] = result[field];
    }
    if (typeof result.stopped !== 'boolean')
      throw new Error('Protocol benchmark worker returned invalid metrics');
    clean.stopped = result.stopped;
  }
  return clean;
}
function runBenchmark(options, workerPath) {
  const cases = createBenchmarkCases(),
    samples = [];
  for (let sample = 0; sample < options.samples; sample++) {
    for (const entry of sample % 2 ? [...cases].reverse() : cases) {
      for (const variant of sample % 2 ? [...entry.variants].reverse() : entry.variants) {
        const child = spawnSync(
          process.execPath,
          [
            '--expose-gc',
            workerPath,
            '--worker',
            entry.id,
            variant,
            String(options.iterations),
            String(options.warmup),
          ],
          { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024, windowsHide: true }
        );
        if (child.error || child.status !== 0) throw new Error('Protocol benchmark worker failed');
        const result = sanitizeWorkerResult(JSON.parse(child.stdout), entry, variant, options);
        samples.push({ sample: sample + 1, ...result });
      }
    }
  }
  if (new Set(samples.map((sample) => sample.sourceHash)).size !== 1)
    throw new Error('Protocol benchmark sources changed during measurement');
  const summary = cases.map((entry) => {
    const variants = entry.variants.map((variant) => {
      const measured = samples.filter(
        (sample) => sample.id === entry.id && sample.variant === variant
      );
      return {
        variant,
        medianCpuMicrosPerOperation: median(measured.map((sample) => sample.cpuMicrosPerOperation)),
        medianWallMillisPerOperation: median(
          measured.map((sample) => sample.wallMillisPerOperation)
        ),
        maxSampledHeapPeakIncreaseBytes: Math.max(
          ...measured.map((sample) => sample.sampledHeapPeakIncreaseBytes)
        ),
        maxSampledRssPeakBytes: Math.max(...measured.map((sample) => sample.sampledRssPeakBytes)),
        outputBytes: measured[0].outputBytes,
        ...(entry.variants.length === 1
          ? {
              bufferedPayloadPeakBytes: measured[0].bufferedPayloadPeakBytes,
              stopped: measured[0].stopped,
            }
          : {}),
      };
    });
    const native = variants.find((value) => value.variant === 'native'),
      legacy = variants.find((value) => value.variant === 'legacy');
    return {
      id: entry.id,
      variants,
      ...(native && legacy
        ? {
            nativeToLegacyCpuRatio:
              legacy.medianCpuMicrosPerOperation > 0
                ? native.medianCpuMicrosPerOperation / legacy.medianCpuMicrosPerOperation
                : null,
          }
        : {}),
    };
  });
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuModel: os.cpus()[0]?.model || 'unknown',
    },
    methodology: {
      iterations: options.iterations,
      warmup: options.warmup,
      samples: options.samples,
      isolatedProcessPerSample: true,
      forcedGcBeforeTiming: true,
      alternatingVariantOrder: true,
      memorySampling: 'about 20 snapshots per sample, included in CPU and wall timing',
      memoryLimitations:
        'Sampled peaks are lower bounds. Process max RSS includes startup and warmup. Heap increases are not allocation counts. Slow-client peak counts payload bytes, excluding object overhead.',
      parityNormalization:
        'Object key order and equivalent Claude text blocks; generated Responses item IDs and optional Gemini wire IDs excluded, call ordering and call_id retained.',
      scope:
        'Synthetic local conversion plus serialization and converter setup; excludes network, provider generation, authentication and production latency.',
      cpuLimitations:
        'CPU timers can be coarse on Windows; zero means below timer resolution, not zero CPU cost.',
    },
    summary,
    samples,
  };
}
module.exports = { parseArguments, integer, measureCase, runBenchmark, sanitizeWorkerResult };
