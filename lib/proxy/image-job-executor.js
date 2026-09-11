'use strict';

const {
  openAIImageGenerationResponseFromGemini,
  openAIImageGenerationToGemini,
  parseGeminiImageResponse,
} = require('./openai-images');
const {
  applyGeminiCooldown,
  buildGeminiProxyRequestOptions,
} = require('./handlers/route-gemini-utils');

class ImageJobExecutionError extends Error {
  constructor(type, message, statusCode, retryAfterSeconds) {
    super(message);
    this.name = 'ImageJobExecutionError';
    this.publicError = {
      type,
      message,
      status: statusCode,
      ...(retryAfterSeconds ? { retry_after: retryAfterSeconds } : {}),
    };
  }
}

function publicUpstreamImageError(statusCode, retryAfterSeconds) {
  if (statusCode === 429) {
    return new ImageJobExecutionError(
      'rate_limit_error',
      'Gemini image generation is rate limited. Retry later.',
      429,
      retryAfterSeconds
    );
  }
  if (statusCode === 401 || statusCode === 403) {
    return new ImageJobExecutionError(
      'authentication_error',
      'Gemini image generation authentication failed.',
      statusCode
    );
  }
  if (statusCode >= 400 && statusCode < 500) {
    return new ImageJobExecutionError(
      'invalid_request_error',
      'Gemini rejected the image generation request.',
      statusCode
    );
  }
  return new ImageJobExecutionError(
    'upstream_unavailable',
    'Gemini image generation is temporarily unavailable.',
    statusCode >= 500 ? statusCode : 502
  );
}

function createGeminiImageJobExecutor(ctx) {
  const {
    codeAssistGenerateRequest,
    codeAssistUserAgent,
    geminiGeneratePath,
    geminiInlineImageToClaudeBlock,
    getGeminiCooldown,
    http,
    https,
    logProxyEvent,
    maxResponseBytes = 16 * 1024 * 1024,
    parseGeminiError,
    setGeminiCooldown,
    shouldUseCodeAssistUpstream,
    unwrapCodeAssistResponse,
  } = ctx;

  return function executeGeminiImageJob({ apiKey, jobId, prepared, request, signal, target }) {
    const targetModel = prepared.rewriteTo !== '-' ? prepared.rewriteTo : request.model;
    const cooldown = getGeminiCooldown(prepared.profile && prepared.profile.id, targetModel);
    if (cooldown) {
      return Promise.reject(
        new ImageJobExecutionError(
          'rate_limit_error',
          'Gemini image generation is in a local cooldown period.',
          429,
          cooldown.retryAfterSeconds
        )
      );
    }

    const geminiBody = openAIImageGenerationToGemini(request);
    const useCodeAssist = shouldUseCodeAssistUpstream(prepared, apiKey);
    const codeAssist = useCodeAssist
      ? codeAssistGenerateRequest(prepared, geminiBody, targetModel, false)
      : null;
    const requestBody = Buffer.from(JSON.stringify(useCodeAssist ? codeAssist.body : geminiBody));
    const upstreamPath = useCodeAssist
      ? codeAssist.target.pathname + codeAssist.target.search
      : geminiGeneratePath(target.path, targetModel, false);
    const headers = {
      'content-type': 'application/json',
      'content-length': requestBody.length,
    };
    if (useCodeAssist) headers['user-agent'] = codeAssistUserAgent();
    if (apiKey) {
      if (String(apiKey).startsWith('ya29.')) headers.authorization = `Bearer ${apiKey}`;
      else headers['x-goog-api-key'] = apiKey;
    }
    const transport = useCodeAssist || target.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      let settled = false;
      let proxyReq = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        callback(value);
      };
      const onAbort = () => {
        if (proxyReq && typeof proxyReq.destroy === 'function') proxyReq.destroy();
        finish(
          reject,
          new ImageJobExecutionError('cancelled', 'Image generation was cancelled.', 409)
        );
      };
      if (signal && signal.aborted) {
        onAbort();
        return;
      }

      proxyReq = transport.request(
        buildGeminiProxyRequestOptions({
          target,
          useCodeAssist,
          codeAssist,
          path: upstreamPath,
          headers,
        }),
        (proxyRes) => {
          const chunks = [];
          let bytes = 0;
          let tooLarge = false;
          proxyRes.on('data', (chunk) => {
            if (tooLarge || settled) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            bytes += buffer.length;
            if (bytes > maxResponseBytes) {
              tooLarge = true;
              chunks.length = 0;
              if (typeof proxyRes.destroy === 'function') proxyRes.destroy();
              finish(
                reject,
                new ImageJobExecutionError(
                  'upstream_response_too_large',
                  'Gemini image response exceeded the proxy limit.',
                  502
                )
              );
              return;
            }
            chunks.push(buffer);
          });
          proxyRes.on('error', () => {
            if (tooLarge || settled) return;
            finish(
              reject,
              new ImageJobExecutionError(
                'proxy_error',
                'Gemini image response was interrupted.',
                502
              )
            );
          });
          proxyRes.on('end', () => {
            if (tooLarge || settled) return;
            const responseBody = Buffer.concat(chunks, bytes).toString('utf8');
            const statusCode = Number(proxyRes.statusCode) || 502;
            if (statusCode < 200 || statusCode >= 300) {
              const parsedError = parseGeminiError(statusCode, responseBody);
              const retryAfterSeconds = parsedError.retryAfterSeconds;
              applyGeminiCooldown({
                statusCode,
                retryAfterSeconds,
                profileId: prepared.profile && prepared.profile.id,
                targetModel,
                setGeminiCooldown,
              });
              logProxyEvent('image_job_upstream_error', {
                jobId,
                profileId: prepared.profile && prepared.profile.id,
                targetModel,
                statusCode,
                errorType: parsedError.type,
                retryAfterSeconds,
              });
              finish(reject, publicUpstreamImageError(statusCode, retryAfterSeconds));
              return;
            }
            try {
              const payload = parseGeminiImageResponse(responseBody, unwrapCodeAssistResponse);
              const result = openAIImageGenerationResponseFromGemini(
                payload,
                request,
                geminiInlineImageToClaudeBlock
              );
              finish(resolve, result);
            } catch (_error) {
              finish(
                reject,
                new ImageJobExecutionError(
                  'invalid_upstream_response',
                  'Gemini returned an invalid image response.',
                  502
                )
              );
            }
          });
        }
      );
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      proxyReq.once('timeout', () => {
        proxyReq.destroy();
        finish(
          reject,
          new ImageJobExecutionError('upstream_timeout', 'Gemini image generation timed out.', 504)
        );
      });
      proxyReq.once('error', () => {
        if (signal && signal.aborted) {
          onAbort();
          return;
        }
        finish(
          reject,
          new ImageJobExecutionError('proxy_error', 'Gemini image generation request failed.', 502)
        );
      });
      proxyReq.end(requestBody);
    });
  };
}

module.exports = {
  ImageJobExecutionError,
  createGeminiImageJobExecutor,
  publicUpstreamImageError,
};
