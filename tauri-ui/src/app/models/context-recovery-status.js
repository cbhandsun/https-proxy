function data(value, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError();
  return descriptor.value;
}

function formatRecoveryLocation(runtime) {
  try {
    const host = data(runtime, 'host');
    const directory = data(runtime, 'contextRecoveryDirectory');
    if (
      typeof host !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,255}$/.test(host) ||
      typeof directory !== 'string' ||
      directory.length > 4096 ||
      Array.from(directory).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }) ||
      !/^(?:\/|[A-Za-z]:[\\/])(?:[\s\S]*[\\/])?context-recovery-v1$/.test(directory)
    )
      throw new TypeError();
    return `运行主机：${host}；加密留存目录（启用后使用）：${directory}。`;
  } catch {
    return '运行主机与留存目录未核验。';
  }
}

function formatPolicyApplication(policy, version, requested) {
  if (!Object.hasOwn(policy, 'runtimeApplication')) return '';
  const state = data(policy, 'runtimeApplication');
  const appliedVersion = data(policy, 'appliedVersion');
  const appliedPolicy = data(policy, 'appliedPolicy');
  if (['unverified', 'unavailable'].includes(state)) {
    if (appliedVersion !== null || appliedPolicy !== null) throw new TypeError();
    return state === 'unavailable' ? '代理规划状态不可用。' : '';
  }
  if (
    !['matched', 'mismatch'].includes(state) ||
    !(
      (appliedVersion === 1 && appliedPolicy === 'legacy') ||
      (appliedVersion === 2 && ['native-first', 'enhanced'].includes(appliedPolicy))
    ) ||
    (state === 'matched') !== (appliedVersion === version && appliedPolicy === requested)
  )
    throw new TypeError();
  return state === 'matched'
    ? '代理已载入该策略；完整请求路径与客户端兼容尚未验收。'
    : '代理载入的策略与当前配置不一致，请检查重载状态。';
}

function formatPolicy(value) {
  try {
    const policy = data(value, 'policy');
    const version = data(policy, 'version');
    const migration = data(policy, 'migrationRequired');
    const requested = data(policy, 'requestedPolicy');
    if (data(policy, 'plannerApplication') !== 'unverified') throw new TypeError();
    const application = formatPolicyApplication(policy, version, requested);
    if (version === 1 && migration === true && requested === 'legacy')
      return `旧版上下文策略，尚未迁移。${application}`;
    if (version === 2 && migration === false && ['native-first', 'enhanced'].includes(requested))
      return application
        ? `已选择${requested === 'native-first' ? '原生优先' : '精确恢复增强'}。${application}`
        : requested === 'native-first'
          ? '已选择原生优先，普通请求规划尚未核验。'
          : '已选择精确恢复增强，普通请求规划尚未核验。';
    throw new TypeError();
  } catch {
    return '上下文策略版本未核验。';
  }
}

function formatRetention(value) {
  try {
    const retention = data(value, 'retention');
    const ttl = data(retention, 'absoluteTtlMs');
    const roots = data(retention, 'maxActiveRoots');
    if (
      ![1, 2].includes(data(retention, 'policyVersion')) ||
      !Number.isSafeInteger(ttl) ||
      ttl < 60000 ||
      ttl > 24 * 60 * 60 * 1000 ||
      ttl % 60000 !== 0 ||
      !Number.isSafeInteger(roots) ||
      roots < 1 ||
      roots > 256
    )
      throw new TypeError();
    const duration = ttl === 86400000 ? '24 小时' : `${ttl / 60000} 分钟`;
    return `原文从代理建立恢复记录起最多保留 ${duration}，读取和重启不续期；已有记录保持原到期时间；整个代理最多同时维护 ${roots} 个活动聊天，分支共享限额。`;
  } catch {
    return '留存期限与聊天容量未核验。';
  }
}

export function formatContextRecoveryStatus(value, runtime) {
  const unavailable = '上下文恢复：运行状态不可用，请检查代理版本与管理连接';
  try {
    const storage = data(value, 'storage');
    const webSocket = data(value, 'webSocket');
    if (
      data(value, 'schemaVersion') !== 1 ||
      !['memory', 'persistent', 'unavailable'].includes(storage) ||
      data(value, 'restartRetention') !== false ||
      !['passthrough', 'restricted_unverified'].includes(webSocket)
    )
      return unavailable;
    const valid = data(value, 'configValid');
    const requested = data(value, 'requestedEnabled');
    const applied = data(value, 'appliedEnabled');
    const runtimeState = data(value, 'state');
    if (
      ![
        'invalid_config',
        'pending_application',
        'unavailable',
        'enabled_restricted',
        'disabled',
      ].includes(runtimeState) ||
      typeof valid !== 'boolean' ||
      typeof requested !== 'boolean' ||
      (applied !== null && typeof applied !== 'boolean')
    )
      return unavailable;
    const state = !valid
      ? '配置无效'
      : runtimeState === 'unavailable' || storage === 'unavailable'
        ? '运行不可用'
        : runtimeState === 'pending_application' || applied === null || applied !== requested
          ? '等待配置应用'
          : applied
            ? webSocket === 'passthrough'
              ? '已开启（仅限受支持 HTTP 路径）'
              : '已开启（仅限受支持路径）'
            : '已关闭';
    const totals = { bound: 0, bindingUnavailable: 0, completed: 0, failed: 0 };
    const counters = data(value, 'counters');
    for (const kind of ['chat', 'responses', 'claude']) {
      const counts = data(counters, kind);
      for (const event of Object.keys(totals)) {
        const count = data(counts, event);
        if (!Number.isSafeInteger(count) || count < 0) return unavailable;
        totals[event] = Math.min(Number.MAX_SAFE_INTEGER, totals[event] + count);
      }
    }
    const retention =
      storage === 'persistent'
        ? '原文加密留存，跨重启读回尚未完成验收'
        : storage === 'unavailable'
          ? '原文存储不可用'
          : '原文仅内存，重启丢失';
    const transport =
      webSocket === 'passthrough' ? 'WebSocket 透传' : 'WebSocket 恢复为实验路径，完整兼容未验收';
    return `上下文恢复：${state}；进程累计：绑定 ${totals.bound}，绑定不足 ${totals.bindingUnavailable}，内部续接完成 ${totals.completed}，失败 ${totals.failed}。${retention}；${transport}；插件与实际客户端验收未核验。${formatPolicy(value)}${formatRetention(value)}${formatRecoveryLocation(runtime)}`;
  } catch {
    return unavailable;
  }
}
