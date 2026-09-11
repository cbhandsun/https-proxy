'use strict';

const { extractSseDataPayloads } = require('./sse');

const MAX_IMAGE_PROMPT_CHARS = 32768;
const ALLOWED_IMAGE_SIZES = new Set([
  'auto',
  '1024x1024',
  '1024x1536',
  '1536x1024',
  '1024x1792',
  '1792x1024',
]);
const ALLOWED_IMAGE_RESPONSE_FORMATS = new Set(['b64_json', 'url']);
const OPENAI_IMAGE_TOOL_MODELS = new Set(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']);
const DEFAULT_OPENAI_IMAGE_RESPONSES_MODEL = 'gpt-6-astra';
const IMAGE_ASPECT_RATIO_BY_SIZE = Object.freeze({
  '1024x1024': '1:1',
  '1024x1536': '2:3',
  '1536x1024': '3:2',
  '1024x1792': '9:16',
  '1792x1024': '16:9',
});

function imageRequestError(message) {
  return { ok: false, error: { type: 'invalid_request_error', message } };
}

function normalizeOptionalImageString(value, maxChars = 64) {
  if (value == null) return '';
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > maxChars || !/^[a-z0-9._-]+$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function normalizeImageModel(value) {
  if (typeof value !== 'string') return '';
  const model = value.trim();
  if (!model || model.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(model)) {
    return '';
  }
  return model;
}

function parseOpenAIImageGenerationRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return imageRequestError('Image generation request body must be a JSON object.');
  }
  const model = normalizeImageModel(value.model);
  if (!model) {
    return imageRequestError('model is required.');
  }
  if (typeof value.prompt !== 'string' || !value.prompt.trim()) {
    return imageRequestError('prompt is required.');
  }
  const prompt = value.prompt.trim();
  if (prompt.length > MAX_IMAGE_PROMPT_CHARS) {
    return imageRequestError(`prompt exceeds ${MAX_IMAGE_PROMPT_CHARS} characters.`);
  }

  const parsedN = value.n == null ? 1 : Number(value.n);
  if (!Number.isInteger(parsedN) || parsedN !== 1) {
    return imageRequestError('This image generation route currently supports n=1 only.');
  }

  const size = value.size == null ? 'auto' : normalizeOptionalImageString(value.size);
  if (!size || !ALLOWED_IMAGE_SIZES.has(size)) {
    return imageRequestError('Unsupported image size.');
  }

  const responseFormatValue = value.response_format == null ? 'b64_json' : value.response_format;
  const responseFormat = normalizeOptionalImageString(responseFormatValue);
  if (!responseFormat || !ALLOWED_IMAGE_RESPONSE_FORMATS.has(responseFormat)) {
    return imageRequestError('response_format must be b64_json or url.');
  }

  const options = {};
  for (const field of ['quality', 'style', 'background', 'output_format']) {
    if (value[field] != null && normalizeOptionalImageString(value[field]) == null) {
      return imageRequestError(`${field} must be a short, safe string.`);
    }
    if (value[field] != null) options[field] = normalizeOptionalImageString(value[field]);
  }

  return {
    ok: true,
    request: {
      model,
      prompt,
      n: 1,
      size,
      responseFormat,
      options,
    },
  };
}

function openAIImageGenerationToGemini(request) {
  const aspectRatio = IMAGE_ASPECT_RATIO_BY_SIZE[request.size];
  return {
    contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
    generationConfig: {
      responseModalities: ['IMAGE'],
      ...(aspectRatio ? { imageConfig: { aspectRatio } } : {}),
    },
  };
}

function geminiCandidateParts(payload) {
  const candidates = payload && Array.isArray(payload.candidates) ? payload.candidates : [];
  return candidates.flatMap((candidate) => {
    const content = candidate && candidate.content;
    return content && Array.isArray(content.parts) ? content.parts : [];
  });
}

function parseGeminiImageResponse(body, unwrapResponse = (payload) => payload) {
  const text = String(body || '').trim();
  if (!text) throw new TypeError('Gemini image response body was empty.');
  let frames;
  try {
    const isSse = /^(?:data:|event:|:)/.test(text);
    // Strip leading SSE comments before using the shared event extractor.
    const json = isSse
      ? extractSseDataPayloads(text.replace(/^(?::[^\n]*\r?\n\s*)+/, '')).map((data) =>
          JSON.parse(data)
        )
      : JSON.parse(text);
    frames = Array.isArray(json) ? json : [json];
  } catch (error) {
    // JSON parser messages can include upstream content; never forward them.
    throw new TypeError('Gemini image response contained invalid JSON.', { cause: error });
  }
  if (frames.length === 0) throw new TypeError('Gemini image response contained no payloads.');
  const candidates = [];
  let promptFeedback;
  for (const frame of frames) {
    const payload = unwrapResponse(frame);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TypeError('Gemini image response payload must be an object.');
    }
    if (payload.error || (frame && frame.error)) {
      throw new TypeError('Gemini image response contained an upstream error.');
    }
    if (Array.isArray(payload.candidates)) {
      for (const candidate of payload.candidates) candidates.push(candidate);
    }
    if (payload.promptFeedback) promptFeedback = payload.promptFeedback;
  }
  return { candidates, ...(promptFeedback ? { promptFeedback } : {}) };
}

function missingImageMessage(payload, parts) {
  const knownReasons = new Set([
    'STOP',
    'MAX_TOKENS',
    'SAFETY',
    'RECITATION',
    'OTHER',
    'BLOCKLIST',
    'PROHIBITED_CONTENT',
    'SPII',
    'IMAGE_SAFETY',
    'IMAGE_PROHIBITED_CONTENT',
    'IMAGE_RECITATION',
    'IMAGE_OTHER',
    'NO_IMAGE',
    'MALFORMED_RESPONSE',
  ]);
  const candidates = payload && Array.isArray(payload.candidates) ? payload.candidates : [];
  const reasons = candidates.map((candidate) => candidate && candidate.finishReason);
  if (payload && payload.promptFeedback) reasons.push(payload.promptFeedback.blockReason);
  const safeReasons = [...new Set(reasons.filter((reason) => knownReasons.has(reason)))];
  const detail = safeReasons.length
    ? ` Upstream reason: ${safeReasons.join(', ')}.`
    : parts.some((part) => part && (part.inlineData || part.inline_data))
      ? ' Upstream image data was invalid or unsupported.'
      : parts.some((part) => part && typeof part.text === 'string')
        ? ' Upstream returned text only.'
        : ' Upstream returned no image parts.';
  return 'Gemini image generation response did not contain a valid image.' + detail;
}

function openAIImageGenerationResponseFromGemini(
  payload,
  request,
  geminiInlineImageToClaudeBlock,
  created = Math.floor(Date.now() / 1000)
) {
  if (typeof geminiInlineImageToClaudeBlock !== 'function') {
    throw new TypeError('Gemini image output converter is unavailable.');
  }
  const parts = geminiCandidateParts(payload).filter((part) => part && part.thought !== true);
  const revisedPrompt = parts
    .filter((part) => part && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim()
    .slice(0, 8192);
  const images = parts
    .map((part) => geminiInlineImageToClaudeBlock(part))
    .filter((block) => block && block.type === 'image');
  if (images.length === 0) {
    throw new TypeError(missingImageMessage(payload, parts));
  }
  return {
    created,
    data: images.slice(0, request.n).map((block) => {
      const source = block.source;
      const image =
        request.responseFormat === 'url'
          ? { url: `data:${source.media_type};base64,${source.data}` }
          : { b64_json: source.data };
      return revisedPrompt ? { ...image, revised_prompt: revisedPrompt } : image;
    }),
  };
}

function openAIImageGenerationToResponses(request, model = DEFAULT_OPENAI_IMAGE_RESPONSES_MODEL) {
  const tool = {
    type: 'image_generation',
    model: request.model,
  };
  if (request.size && request.size !== 'auto') tool.size = request.size;
  for (const [source, target] of [
    ['quality', 'quality'],
    ['background', 'background'],
    ['output_format', 'output_format'],
  ]) {
    const value = request.options && request.options[source];
    if (value) tool[target] = value;
  }
  return {
    model,
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: request.prompt }],
      },
    ],
    tools: [tool],
    stream: true,
    store: false,
  };
}

function parseOpenAIResponsesImageGenerationPayloads(body) {
  const text = String(body || '').trim();
  if (!text) throw new TypeError('OpenAI Responses image generation response was empty.');

  const ssePayloads = extractSseDataPayloads(text);
  if (ssePayloads.length > 0) {
    const frames = [];
    for (const payload of ssePayloads) {
      try {
        frames.push(JSON.parse(payload));
      } catch (error) {
        // Parser error messages can include upstream content; keep them private.
      }
    }
    if (frames.length === 0) {
      throw new TypeError('OpenAI Responses image generation stream contained invalid JSON.');
    }
    return frames;
  }

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    throw new TypeError('OpenAI Responses image generation response contained invalid JSON.', {
      cause: error,
    });
  }
}

function responseImageGenerationItems(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const items = [];
  if (Array.isArray(payload.output)) items.push(...payload.output);
  if (payload.item) items.push(payload.item);
  if (payload.response && Array.isArray(payload.response.output))
    items.push(...payload.response.output);
  return items.filter((item) => item && item.type === 'image_generation_call');
}

function parseOpenAIResponsesImageGenerationResponse(
  payload,
  request,
  created = Math.floor(Date.now() / 1000)
) {
  const frames = Array.isArray(payload) ? payload : [payload];
  const images = [];
  const partialImages = [];
  let revisedPrompt = '';
  for (const frame of frames) {
    if (!frame || typeof frame !== 'object') continue;
    for (const item of responseImageGenerationItems(frame)) {
      const result = typeof item.result === 'string' ? item.result.trim() : '';
      if (result) images.push(result);
      if (!revisedPrompt && typeof item.revised_prompt === 'string') {
        revisedPrompt = item.revised_prompt.trim().slice(0, 8192);
      }
    }
    const partialImage =
      typeof frame.b64_json === 'string'
        ? frame.b64_json.trim()
        : typeof frame.partial_image_b64 === 'string'
          ? frame.partial_image_b64.trim()
          : '';
    if (
      (frame.type === 'image_generation.partial_image' ||
        frame.type === 'response.image_generation_call.partial_image') &&
      partialImage
    ) {
      partialImages.push(partialImage);
    }
  }
  if (images.length === 0) {
    images.push(...partialImages.slice(-request.n));
  }
  if (images.length === 0) {
    throw new TypeError('OpenAI Responses image generation did not return an image.');
  }
  return {
    created,
    data: images.slice(0, request.n).map((image) => {
      const value =
        request.responseFormat === 'url'
          ? { url: `data:image/png;base64,${image}` }
          : { b64_json: image };
      return revisedPrompt ? { ...value, revised_prompt: revisedPrompt } : value;
    }),
  };
}

module.exports = {
  MAX_IMAGE_PROMPT_CHARS,
  OPENAI_IMAGE_TOOL_MODELS,
  DEFAULT_OPENAI_IMAGE_RESPONSES_MODEL,
  parseOpenAIImageGenerationRequest,
  openAIImageGenerationToGemini,
  openAIImageGenerationToResponses,
  openAIImageGenerationResponseFromGemini,
  parseOpenAIResponsesImageGenerationPayloads,
  parseOpenAIResponsesImageGenerationResponse,
  parseGeminiImageResponse,
};
