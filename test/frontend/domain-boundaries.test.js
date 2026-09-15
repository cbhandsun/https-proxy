const assert = require('node:assert/strict');

(async () => {
  const prompts = await import('../../tauri-ui/src/app/domains/prompts.js');
  const rateLimits = await import('../../tauri-ui/src/app/domains/rate-limits.js');

  assert.equal(prompts.normalizePromptClientType(' CODEX '), 'codex');
  assert.equal(prompts.normalizePromptClientType('unknown-client'), 'claude');
  assert.equal(prompts.normalizePromptClientType(null), 'claude');

  assert.deepEqual(prompts.parsePromptSyncResponse(null), {
    ok: false,
    error: '服务返回了无效响应',
  });
  assert.deepEqual(
    prompts.parsePromptSyncResponse({ ok: true, path: ' C:\\Users\\me\\AGENTS.md ' }),
    {
      ok: true,
      path: 'C:\\Users\\me\\AGENTS.md',
    }
  );
  assert.deepEqual(prompts.parsePromptSyncResponse({ ok: false, error: '' }), {
    ok: false,
    error: '同步失败',
  });
  assert.equal(
    prompts.parsePromptSyncResponse({ ok: true, path: 'x'.repeat(1500) }).path.length,
    1000
  );

  const storedPrompts = new Map([['prompt_content_codex', 'saved codex prompt']]);
  global.localStorage = {
    getItem: (key) => storedPrompts.get(key) ?? null,
    setItem: (key, value) => storedPrompts.set(key, String(value)),
  };
  const promptClientType = { value: 'claude', dataset: {} };
  const promptContent = { value: 'current claude prompt', dataset: {} };
  const elements = {
    promptClientType,
    promptContent,
    syncPromptBtn: null,
    saveTemplateBtn: null,
  };
  prompts.configurePrompts({
    $: (id) => elements[id] || null,
    get config() {
      return undefined;
    },
    showToast() {},
    storage: {
      parsePromptTemplates() {
        return [];
      },
      limits: {
        promptNameChars: 128,
        promptContentChars: 200000,
      },
    },
  });
  prompts.bindPromptControls();
  promptClientType.value = 'codex';
  promptClientType.onchange();
  assert.equal(storedPrompts.get('prompt_content_claude'), 'current claude prompt');
  assert.equal(promptContent.value, 'saved codex prompt');

  assert.deepEqual(rateLimits.parseRateLimitsResponse(undefined), {
    ok: false,
    error: '服务返回了无效响应',
  });
  assert.deepEqual(rateLimits.parseRateLimitsResponse({ ok: false, error: ' denied ' }), {
    ok: false,
    error: 'denied',
    cooldowns: [],
  });
  assert.deepEqual(rateLimits.parseRateLimitsResponse({ ok: true }), {
    ok: true,
    limits: [],
    cooldowns: [],
  });
  assert.equal(rateLimits.nextCooldownRefreshDelay(undefined), null);
  assert.equal(rateLimits.nextCooldownRefreshDelay([{ retryAfterSeconds: -1 }]), null);
  assert.equal(rateLimits.nextCooldownRefreshDelay([{ retryAfterSeconds: 0.1 }]), 1000);
  assert.equal(rateLimits.nextCooldownRefreshDelay([{ retryAfterSeconds: 30 }]), 30000);
  assert.equal(rateLimits.nextCooldownRefreshDelay([{ retryAfterSeconds: 3600 }]), 60000);
  assert.equal(
    rateLimits.nextCooldownRefreshDelay([{ retryAfterSeconds: 120 }, { retryAfterSeconds: 2 }]),
    2000
  );
  assert.deepEqual(
    rateLimits.parseRateLimitsResponse({
      ok: true,
      limits: [
        null,
        {
          model: 'model-a',
          window: 'daily',
          percent: '81',
          remainingPercent: '19',
          resetDisplay: 'tomorrow',
        },
      ],
    }),
    {
      ok: true,
      limits: [
        {
          model: 'model-a',
          window: 'daily',
          percent: 81,
          remainingPercent: 19,
          resetDisplay: 'tomorrow',
          resetIn: '',
        },
      ],
      cooldowns: [],
    }
  );
  assert.deepEqual(
    rateLimits.parseRateLimitsResponse({
      ok: false,
      error: 'upstream unavailable',
      cooldowns: [
        {
          profileId: 'workbuddy-official',
          targetModel: 'deepseek-v4.1-flash',
          retryAfterSeconds: '3661',
          resetIn: '1h2m',
          resetDisplay: '16:21',
          source: 'upstream_reset_time',
        },
        { targetModel: 'broken', retryAfterSeconds: -1 },
      ],
    }),
    {
      ok: false,
      error: 'upstream unavailable',
      cooldowns: [
        {
          profileId: 'workbuddy-official',
          targetModel: 'deepseek-v4.1-flash',
          retryAfterSeconds: 3661,
          resetDisplay: '16:21',
          resetIn: '1h2m',
          source: 'upstream_reset_time',
        },
      ],
    }
  );
  const oversized = rateLimits.parseRateLimitsResponse({
    ok: true,
    limits: Array.from({ length: 150 }, (_, index) => ({ model: `m-${index}` })),
  });
  assert.equal(oversized.limits.length, 100);

  console.log('[domain-boundaries.test] ok');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
