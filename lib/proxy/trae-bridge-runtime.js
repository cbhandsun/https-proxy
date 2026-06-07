/**
 * Trae Bridge Runtime - 编排层
 *
 * 把三个子模块 (utils / progress / streams) 装配成单一的 createTraeBridgeRuntime(deps) 工厂。
 * 保留 100% 向后兼容:所有原 723 行实现的 API 在此处统一 re-export。
 *
 * 拆分:
 *   - trae-bridge-utils.js     SSE/队列/错误格式化/心跳 (128 行)
 *   - trae-bridge-progress.js  raw_event + log 进度 (380 行)
 *   - trae-bridge-streams.js   OpenAI/Responses/Claude 写流 (215 行)
 *
 * 本文件只剩装配 + 类型注释 (本文件 ~80 行)
 */

const { createTraeBridgeUtils } = require('./trae-bridge-utils');
const { createTraeBridgeProgress } = require('./trae-bridge-progress');
const { createTraeBridgeStreams } = require('./trae-bridge-streams');

function createTraeBridgeRuntime(deps) {
  const utils = createTraeBridgeUtils(deps);
  const progress = createTraeBridgeProgress(deps);
  const streams = createTraeBridgeStreams(Object.assign({}, deps, {
    streamTraeOfficialBridge: utils.streamTraeOfficialBridge,
    startLiveHeartbeat: utils.startLiveHeartbeat,
    getTraeBridgeErrorMessage: utils.getTraeBridgeErrorMessage,
    formatTraeBridgeStreamError: utils.formatTraeBridgeStreamError,
    formatTraeInteraction: utils.formatTraeInteraction,
    startTraeLogProgress: progress.startTraeLogProgress,
    formatTraeLogVisibleText: progress.formatTraeLogVisibleText,
    writeRawProgress: progress.writeRawProgress,
    isLogProgressVisibleEnabled: progress.isLogProgressVisibleEnabled,
  }));

  return {
    // utils
    enqueueBridgeRequest: utils.enqueueBridgeRequest,
    parseSseEvents: utils.parseSseEvents,
    formatTraeInteraction: utils.formatTraeInteraction,
    getTraeBridgeErrorMessage: utils.getTraeBridgeErrorMessage,
    formatTraeBridgeStreamError: utils.formatTraeBridgeStreamError,
    startLiveHeartbeat: utils.startLiveHeartbeat,
    callTraeOfficialBridge: utils.callTraeOfficialBridge,
    streamTraeOfficialBridge: utils.streamTraeOfficialBridge,
    // progress
    isRawProgressCommentEnabled: progress.isRawProgressCommentEnabled,
    isRawProgressVisibleEnabled: progress.isRawProgressVisibleEnabled,
    isLogProgressVisibleEnabled: progress.isLogProgressVisibleEnabled,
    summarizeTraeRawEvent: progress.summarizeTraeRawEvent,
    formatTraeRawVisibleText: progress.formatTraeRawVisibleText,
    formatTraeLogVisibleText: progress.formatTraeLogVisibleText,
    writeRawProgress: progress.writeRawProgress,
    startTraeLogProgress: progress.startTraeLogProgress,
    // streams
    writeTraeBridgeOpenAIStream: streams.writeTraeBridgeOpenAIStream,
    writeTraeBridgeOpenAILiveStream: streams.writeTraeBridgeOpenAILiveStream,
    buildTraeBridgeOpenAIResponsesResponse: streams.buildTraeBridgeOpenAIResponsesResponse,
    writeTraeBridgeOpenAIResponsesStream: streams.writeTraeBridgeOpenAIResponsesStream,
    writeTraeBridgeOpenAIResponsesLiveStream: streams.writeTraeBridgeOpenAIResponsesLiveStream,
    buildTraeBridgeClaudeMessageResponse: streams.buildTraeBridgeClaudeMessageResponse,
    writeTraeBridgeClaudeStream: streams.writeTraeBridgeClaudeStream,
    writeTraeBridgeClaudeLiveStream: streams.writeTraeBridgeClaudeLiveStream,
  };
}

module.exports = {
  createTraeBridgeRuntime,
};
