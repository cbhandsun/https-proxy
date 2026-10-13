'use strict';

/**
 * Detection helpers for inline media (base64 images/audio/video) inside protocol
 * payloads.
 *
 * Why this module exists: several protocol converters fall back to
 * `JSON.stringify(value)` when they meet a shape they do not model. If that value
 * carries inline media, the base64 ends up in a *text* field and upstream
 * tokenizers bill it per character — a ~500 KB screenshot becomes ~125k prompt
 * tokens instead of roughly a hundred image tokens. These helpers let a converter
 * keep the readable structure while replacing the payload with a placeholder.
 */

const INLINE_MEDIA_PLACEHOLDER = '[inline media omitted]';

// Inline media is charged by upstream tokenizers as media, not as the characters of
// its base64 payload. The exact price is provider and resolution dependent, so a
// small fixed equivalent keeps estimates in the right order of magnitude without
// pretending to be exact. Without this, an 845k-character screenshot reports ~211k
// "tokens", which corrupts request-size estimates, cost accounting, count_tokens
// answers, and context-trimming decisions.
const INLINE_MEDIA_TOKEN_EQUIVALENT = 100;

const DEFAULT_CHARS_PER_TOKEN = 4;

const MEDIA_PART_TYPES = Object.freeze({
  image_url: ['image_url'],
  input_image: ['image_url', 'url', 'data'],
  input_audio: ['input_audio', 'audio_url', 'url', 'data'],
  audio_url: ['audio_url', 'url', 'data'],
  input_video: ['input_video', 'video_url', 'url', 'data'],
  video_url: ['video_url', 'url', 'data'],
});

const DATA_URL_RE = /^data:(?:image|audio|video)\/[a-z0-9][a-z0-9.+-]{0,63};base64,/i;
const EMBEDDED_DATA_URL_RE =
  /data:(?:image|audio|video)\/[a-z0-9][a-z0-9.+-]{0,63};base64,[A-Za-z0-9+/=]*/gi;

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isInlineDataUrl(value) {
  return typeof value === 'string' && DATA_URL_RE.test(value.trim());
}

function isRawBase64Payload(value) {
  return (
    typeof value === 'string' &&
    value.length >= 32 &&
    !/\s/.test(value) &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

function mediaValue(candidate) {
  if (typeof candidate === 'string') return candidate;
  if (!candidate || typeof candidate !== 'object') return undefined;
  if (typeof candidate.url === 'string') return candidate.url;
  if (typeof candidate.data === 'string') return candidate.data;
  return undefined;
}

function carriesPayload(candidate) {
  const value = mediaValue(candidate);
  return isInlineDataUrl(value) || isRawBase64Payload(value);
}

/**
 * True only when the node is a media part that actually carries base64 bytes.
 * Remote https URLs and empty placeholders return false so their characters keep
 * being counted as ordinary text instead of silently disappearing.
 */
function isInlineMediaPart(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
  const type = typeof node.type === 'string' ? node.type.toLowerCase() : '';
  const keys = MEDIA_PART_TYPES[type];
  if (keys) {
    for (const key of keys) {
      if (own(node, key) && carriesPayload(node[key])) return true;
    }
    return false;
  }
  const source = node.source;
  if (
    source &&
    typeof source === 'object' &&
    String(source.type || '').toLowerCase() === 'base64' &&
    carriesPayload(source.data)
  ) {
    return true;
  }
  for (const key of ['inlineData', 'inline_data']) {
    const nested = node[key];
    if (nested && typeof nested === 'object' && carriesPayload(nested.data)) return true;
  }
  return own(node, 'b64_json') && carriesPayload(node.b64_json);
}

function containsInlineMedia(value, depth = 0) {
  if (depth > 24 || value == null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsInlineMedia(item, depth + 1));
  if (isInlineMediaPart(value)) return true;
  return Object.values(value).some((item) => containsInlineMedia(item, depth + 1));
}

/**
 * Structural clone with every inline media payload replaced by a placeholder.
 * Media-free values come back JSON-equivalent to the input, so callers can use
 * this unconditionally without changing existing output.
 */
function redactInlineMedia(value, depth = 0) {
  if (typeof value === 'string') return redactEmbeddedDataUrls(value);
  if (value == null || typeof value !== 'object') return value;
  if (depth > 24) return INLINE_MEDIA_PLACEHOLDER;
  if (isInlineMediaPart(value)) return INLINE_MEDIA_PLACEHOLDER;
  if (Array.isArray(value)) return value.map((item) => redactInlineMedia(item, depth + 1));
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = redactInlineMedia(item, depth + 1);
  }
  return result;
}

/**
 * Replace data URLs that are *embedded* inside a free-form string. Used only when a
 * converter is about to flatten a payload into a literal text field, where an
 * embedded data URL would be billed per character by the upstream tokenizer.
 */
function redactEmbeddedDataUrls(text) {
  if (!text.includes(';base64,')) return text;
  EMBEDDED_DATA_URL_RE.lastIndex = 0;
  return text.replace(EMBEDDED_DATA_URL_RE, INLINE_MEDIA_PLACEHOLDER);
}

/** JSON.stringify that never promotes inline media base64 into literal text. */
function stringifyWithoutInlineMedia(value) {
  return JSON.stringify(redactInlineMedia(value));
}

/**
 * Rough token count for a decoded payload. Inline media counts as a small fixed
 * equivalent instead of its base64 length; everything else stays length/charsPerToken.
 */
function estimateTokensForValue(value, charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
  const ratio = Number(charsPerToken) > 0 ? Number(charsPerToken) : DEFAULT_CHARS_PER_TOKEN;
  // Descendants previously normalized the numeric ratio again. Preserve their
  // fallback even when a stateful caller returns a different second coercion.
  const descendantRatio = ratio > 0 ? ratio : DEFAULT_CHARS_PER_TOKEN;
  return estimateTokensWithRatio(value, ratio, descendantRatio);
}

function estimateTokensWithRatio(value, ratio, descendantRatio = ratio) {
  if (value == null) return 0;
  if (typeof value === 'string') return Math.ceil(value.length / ratio);
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + estimateTokensWithRatio(item, descendantRatio), 0);
  }
  if (typeof value === 'object') {
    if (isInlineMediaPart(value)) return INLINE_MEDIA_TOKEN_EQUIVALENT;
    return Object.values(value).reduce(
      (sum, item) => sum + estimateTokensWithRatio(item, descendantRatio),
      0
    );
  }
  return Math.ceil(String(value).length / ratio);
}

module.exports = {
  INLINE_MEDIA_PLACEHOLDER,
  INLINE_MEDIA_TOKEN_EQUIVALENT,
  MEDIA_PART_TYPES,
  isInlineDataUrl,
  isRawBase64Payload,
  isInlineMediaPart,
  containsInlineMedia,
  redactInlineMedia,
  stringifyWithoutInlineMedia,
  estimateTokensForValue,
};
