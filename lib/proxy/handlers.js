/**
 * 反向代理主入口(编排层)
 *
 * 该文件只负责"依赖装配 + 工厂串联",所有业务逻辑(协议转换、状态管理、
 * 请求校验、路由处理)都拆分到 lib/proxy/handlers/ 子目录的工厂模块。
 *
 * 模块结构:
 *   ├ handlers/http-utils.js         HTTP 工具(JSON 响应/请求体解析/超时)
 *   ├ handlers/code-assist.js        Google Code Assist 上游适配
 *   ├ handlers/responses-state.js    Responses API 状态/历史/桥接
 *   ├ handlers/request-validators.js 协议转换前的请求字段校验
 *   ├ handlers/route-handlers.js     9 个 handleXxx 路由处理器
 *   └ handlers/management.js         本地管理 API(独立模块,未拆)
 */
'use strict';

const https = require('https');
const http = require('http');
const path = require('path');
const { DATA_DIR } = require('./config');
const { createLogger } = require('./logger');
const { parseBoundedInteger } = require('./management-utils');
const { createHttpUtils } = require('./handlers/http-utils');
const { createCodeAssist } = require('./handlers/code-assist');
const { createResponsesState } = require('./handlers/responses-state');
const { createRequestValidators } = require('./handlers/request-validators');
const { createRouteHandlers } = require('./handlers/route-handlers');
const log = createLogger('handlers');

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': '*',
};

function createProxyHandlers(deps) {
  // maxConversionResponseBytes 和 mcpHub 是 createProxyHandlers 局部需要的,
  // 其他所有 deps(包括函数)都透传给 createRouteHandlers。
  const { maxConversionResponseBytes, mcpHub, ...routeDeps } = deps;

  const CACHE_FILE = path.join(DATA_DIR, '.responses_history.cache.json');
  const conversionResponseLimit = parseBoundedInteger(
    maxConversionResponseBytes,
    16 * 1024 * 1024,
    1024 * 1024,
    64 * 1024 * 1024
  );

  // 1. HTTP 工具
  const httpUtils = createHttpUtils({
    log,
    sendJsonError: routeDeps.sendJsonError,
    CORS_HEADERS,
    extractSseDataPayloads: routeDeps.extractSseDataPayloads,
  });

  // 2. Google Code Assist 适配
  const codeAssistFns = createCodeAssist({ fallbackId: routeDeps.fallbackId });

  // 3. Responses 状态/历史/桥接
  const responsesStateFns = createResponsesState({
    log,
    sendJsonError: routeDeps.sendJsonError,
    logProxyEvent: routeDeps.logProxyEvent,
    logRequestEnd: routeDeps.logRequestEnd,
    fallbackId: routeDeps.fallbackId,
    stableCreated: routeDeps.stableCreated,
    processOpenAIChatSseChunkToResponses: routeDeps.processOpenAIChatSseChunkToResponses,
    flushOpenAIChatSseToResponses: routeDeps.flushOpenAIChatSseToResponses,
    openAIResponsesToChat: routeDeps.openAIResponsesToChat,
    conversionResponseLimit,
    cacheFile: CACHE_FILE,
    limit: 20,
  });

  // 4. 请求校验器
  const validatorFns = createRequestValidators({ sendJsonError: routeDeps.sendJsonError });

  // 5. 9 个 handleXxx 路由处理器(注入所有依赖)
  const routeHandlers = createRouteHandlers({
    // stdlib / 模块级
    https,
    http,
    log,
    CORS_HEADERS,
    maxConversionResponseBytes: conversionResponseLimit,
    mcpHub,
    // 原始 deps(协议转换 + SSE 工具 + 注入函数)
    ...routeDeps,
    // http-utils
    ...httpUtils,
    // code-assist
    ...codeAssistFns,
    // responses-state(仅对外函数,排除共享 Map/timeout)
    ...pickPublic(responsesStateFns),
    // request-validators
    ...validatorFns,
  });

  return {
    ...routeHandlers,
    // 测试用钩子(保持向后兼容)
    _responsesHistory: responsesStateFns.responsesHistory,
    _rememberResponsesHistory: responsesStateFns.rememberResponsesHistory,
    _saveResponsesHistoryToDisk: responsesStateFns.saveResponsesHistoryToDisk,
  };
}

// 提取 responses-state 工厂的对外函数(不暴露共享 Map/timeout 之外的内部状态)
// 注意:responsesHistory Map 本身仍通过 _responsesHistory 在 return 处暴露给测试
function pickPublic(stateFns) {
  return {
    collectBoundedResponse: stateFns.collectBoundedResponse,
    createChatToResponsesBridge: stateFns.createChatToResponsesBridge,
    responsesToChatWithHistory: stateFns.responsesToChatWithHistory,
    rememberResponsesFromChatResponse: stateFns.rememberResponsesFromChatResponse,
    rememberResponsesFromBridge: stateFns.rememberResponsesFromBridge,
  };
}

module.exports = { createProxyHandlers };
