const HEALTH_SUCCESS_OUTPUT = '代理服务健康检查：\n状态: 正常\n一切正常！';
const HEALTH_UNHEALTHY_OUTPUT = '健康检查失败：代理服务未处于健康状态。';
const HEALTH_UNREACHABLE_OUTPUT = '健康检查失败：无法连通本地代理管理端口。';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function formatHealthCommandResult(value) {
  if (isRecord(value) && value.ok === true) {
    return {
      code: 0,
      output: HEALTH_SUCCESS_OUTPUT,
      ok: true,
      message: HEALTH_SUCCESS_OUTPUT,
      running: true,
    };
  }
  return {
    code: -1,
    output: HEALTH_UNHEALTHY_OUTPUT,
    ok: false,
    error: HEALTH_UNHEALTHY_OUTPUT,
    message: HEALTH_UNHEALTHY_OUTPUT,
    running: false,
  };
}

export async function executeHealthCommand(fetchHealth) {
  if (typeof fetchHealth !== 'function') {
    throw new TypeError('fetchHealth must be a function');
  }
  try {
    return formatHealthCommandResult(await fetchHealth());
  } catch (_error) {
    return {
      code: -1,
      output: HEALTH_UNREACHABLE_OUTPUT,
      ok: false,
      error: HEALTH_UNREACHABLE_OUTPUT,
      message: HEALTH_UNREACHABLE_OUTPUT,
      running: false,
    };
  }
}
