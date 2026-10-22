function data(value, keys) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  if (Reflect.ownKeys(value).sort().join(',') !== keys) return null;
  const result = {};
  for (const key of keys.split(',')) {
    const slot = Object.getOwnPropertyDescriptor(value, key);
    if (!slot?.enumerable || !Object.hasOwn(slot, 'value')) return null;
    result[key] = slot.value;
  }
  return result;
}

const revisionValid = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function parsePolicyPreview(value) {
  try {
    const result = data(
      value,
      'fromVersion,impacts,migrationRequired,ok,persistencePreference,requestedPolicy,requestedRecovery,revision,targetVersion'
    );
    if (
      !result ||
      result.ok !== true ||
      !revisionValid(result.revision) ||
      ![1, 2].includes(result.fromVersion) ||
      result.targetVersion !== 2 ||
      result.migrationRequired !== (result.fromVersion === 1) ||
      typeof result.requestedRecovery !== 'boolean' ||
      typeof result.persistencePreference !== 'boolean' ||
      result.requestedPolicy !== (result.requestedRecovery ? 'enhanced' : 'native-first')
    )
      return null;
    const expected = result.requestedRecovery
      ? ['existing_recovery_preferences_retained']
      : ['automatic_trimming_disabled', 'evidence_dependent_history_requires_recovery'];
    if (!Array.isArray(result.impacts) || result.impacts.length !== expected.length) return null;
    for (let i = 0; i < expected.length; i++) {
      if (Object.getOwnPropertyDescriptor(result.impacts, String(i))?.value !== expected[i])
        return null;
    }
    return {
      revision: result.revision,
      migrationRequired: result.migrationRequired,
      recovery: result.requestedRecovery,
    };
  } catch {
    return null;
  }
}

export function parsePolicyApplied(value) {
  try {
    const result = data(value, 'changed,ok,revision,runtimeApplication,saved,targetVersion');
    if (
      !result ||
      result.ok !== true ||
      result.saved !== true ||
      typeof result.changed !== 'boolean' ||
      !revisionValid(result.revision) ||
      result.targetVersion !== 2 ||
      result.runtimeApplication !== 'pending'
    )
      return null;
    return { revision: result.revision };
  } catch {
    return null;
  }
}

export function bindContextPolicyControls({
  getElement,
  getConfig,
  confirmAction,
  fetchRequest,
  getApiBase,
  setTimer = setTimeout,
  cancelTimer = clearTimeout,
}) {
  const button = getElement('applyContextPolicy');
  const status = getElement('contextPolicyMigrationStatus');
  let busy = false;
  async function request(suffix, body) {
    const controller = new AbortController();
    let timer;
    try {
      const expiry = new Promise((resolve) => {
        timer = setTimer(() => {
          controller.abort();
          resolve(null);
        }, 10000);
      });
      const action = (async () => {
        const response = await fetchRequest(`${getApiBase()}/v1/local/context-policy/${suffix}`, {
          method: body ? 'POST' : 'GET',
          signal: controller.signal,
          ...(body
            ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
            : {}),
        });
        if (!response.ok) return null;
        return await response.json();
      })();
      return await Promise.race([action, expiry]);
    } catch {
      return null;
    } finally {
      cancelTimer(timer);
    }
  }
  button.onclick = async () => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    status.textContent = '正在核对已保存的上下文策略。';
    try {
      const current = getConfig();
      const revision = current?._revision;
      if (!revisionValid(revision)) {
        status.textContent = '请先保存或重新加载配置，再应用新策略。';
        return;
      }
      const preview = parsePolicyPreview(await request('preview'));
      if (!preview || preview.revision !== revision) {
        status.textContent = '无法核对配置，或配置已在其他位置修改。请重新加载后再操作。';
        return;
      }
      if (!preview.migrationRequired) {
        status.textContent = '已保存新策略；客户端兼容情况请查看运行状态。';
        return;
      }
      const confirmed = await confirmAction({
        title: '应用新的上下文策略',
        message: preview.recovery
          ? '保留已保存的自动恢复和加密留存选择，应用新策略。页面中尚未保存的修改不参与本次操作。'
          : '普通请求将保留完整上下文，超限时明确报错。依赖代理恢复原文的旧聊天无法直接继续，可能返回恢复已关闭。保留已保存的加密留存选择和数据。页面中尚未保存的修改不参与本次操作。',
        confirmText: '应用新策略',
        danger: false,
      });
      if (!confirmed) {
        status.textContent = '未应用新策略。';
        return;
      }
      if (getConfig() !== current || current._revision !== revision) {
        status.textContent = '页面配置已变化，请重新核对后再操作。';
        return;
      }
      const applied = parsePolicyApplied(
        await request('apply', { confirm: true, revision, targetVersion: 2 })
      );
      if (!applied || getConfig() !== current || current._revision !== revision) {
        status.textContent = '未确认迁移结果，请重新加载配置核对。';
        return;
      }
      current.appSettings = { ...current.appSettings, contextPolicyVersion: 2 };
      current._revision = applied.revision;
      status.textContent = '新策略已保存并请求代理重载；实际运行情况与客户端兼容性请查看运行状态。';
    } catch {
      status.textContent = '未确认迁移结果，请重新加载配置核对。';
    } finally {
      busy = false;
      button.disabled = false;
      button.setAttribute('aria-busy', 'false');
    }
  };
}
