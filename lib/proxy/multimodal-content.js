'use strict';

const MAX_INLINE_MEDIA_BYTES = 7 * 1024 * 1024;

const MEDIA_PART_TYPES = Object.freeze({
  image_url: 'image',
  input_image: 'image',
  input_audio: 'audio',
  audio_url: 'audio',
  input_video: 'video',
  video_url: 'video',
});

const FORMAT_MIME_TYPES = Object.freeze({
  image: Object.freeze({
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
  }),
  audio: Object.freeze({
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    mpeg: 'audio/mpeg',
    m4a: 'audio/mp4',
    mp4: 'audio/mp4',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    webm: 'audio/webm',
  }),
  video: Object.freeze({
    mp4: 'video/mp4',
    mpeg: 'video/mpeg',
    mpg: 'video/mpeg',
    mov: 'video/quicktime',
    quicktime: 'video/quicktime',
    webm: 'video/webm',
    avi: 'video/x-msvideo',
    '3gp': 'video/3gpp',
  }),
});

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeMediaType(kind, value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw) return '';
  const mapped = FORMAT_MIME_TYPES[kind] && FORMAT_MIME_TYPES[kind][raw];
  const mimeType = mapped || raw;
  if (!new RegExp('^' + kind + '/[a-z0-9][a-z0-9.+-]{0,63}$').test(mimeType)) return '';
  return mimeType;
}

function validateBase64Payload(value, maxBytes = MAX_INLINE_MEDIA_BYTES) {
  if (typeof value !== 'string' || value.length === 0 || /\s/.test(value)) {
    return { ok: false, error: 'media data must be non-empty base64' };
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    return { ok: false, error: 'media data must be valid base64' };
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0) return { ok: false, error: 'media data must not be empty' };
  if (decoded.length > maxBytes) {
    return {
      ok: false,
      error: 'media data exceeds the ' + Math.floor(maxBytes / 1024 / 1024) + ' MiB limit',
    };
  }
  const canonicalInput = value.replace(/=+$/, '');
  const canonicalDecoded = decoded.toString('base64').replace(/=+$/, '');
  if (canonicalInput !== canonicalDecoded) {
    return { ok: false, error: 'media data must be valid base64' };
  }
  return { ok: true, data: value, bytes: decoded.length };
}

function parseDataUrl(value, kind, maxBytes) {
  if (typeof value !== 'string') return { ok: false, error: 'media URL must be a data URL' };
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value);
  if (!match) return { ok: false, error: 'media URL must be a base64 data URL' };
  const mediaType = normalizeMediaType(kind, match[1]);
  if (!mediaType) return { ok: false, error: 'media MIME type does not match its content type' };
  const payload = validateBase64Payload(match[2], maxBytes);
  if (!payload.ok) return payload;
  return { ok: true, mediaType, data: payload.data, bytes: payload.bytes };
}

function nestedMediaValue(part, type) {
  const candidates =
    type === 'image_url'
      ? ['image_url']
      : type === 'input_image'
        ? ['image_url', 'url', 'data']
        : type === 'input_audio'
          ? ['input_audio', 'audio_url', 'url', 'data']
          : type === 'audio_url'
            ? ['audio_url', 'url', 'data']
            : type === 'input_video'
              ? ['input_video', 'video_url', 'url', 'data']
              : ['video_url', 'url', 'data'];
  for (const key of candidates) {
    if (own(part, key) && part[key] != null) return part[key];
  }
  return undefined;
}

function mediaFormat(part, nested) {
  const sources = [nested, part];
  const keys = ['media_type', 'mime_type', 'mimeType', 'format'];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of keys) {
      if (own(source, key) && source[key] != null) return source[key];
    }
  }
  return '';
}

function inspectOpenAIMultimodalPart(part, options = {}) {
  if (!part || typeof part !== 'object') return { recognized: false };
  const type = own(part, 'type') ? String(part.type || '').toLowerCase() : '';
  const kind = MEDIA_PART_TYPES[type];
  if (!kind) return { recognized: false };

  const maxBytes = Number.isSafeInteger(options.maxBytes)
    ? Math.max(1, options.maxBytes)
    : MAX_INLINE_MEDIA_BYTES;
  const nested = nestedMediaValue(part, type);
  if (nested == null) {
    return { recognized: true, kind, ok: false, error: kind + ' data is required' };
  }

  const rawValue =
    nested && typeof nested === 'object'
      ? own(nested, 'url')
        ? nested.url
        : own(nested, 'data')
          ? nested.data
          : undefined
      : nested;
  let parsed;
  if (typeof rawValue === 'string' && rawValue.toLowerCase().startsWith('data:')) {
    parsed = parseDataUrl(rawValue, kind, maxBytes);
  } else {
    const mediaType = normalizeMediaType(kind, mediaFormat(part, nested));
    if (!mediaType) {
      parsed = {
        ok: false,
        error: kind + ' data requires a matching MIME type or supported format',
      };
    } else {
      const payload = validateBase64Payload(rawValue, maxBytes);
      parsed = payload.ok ? { ...payload, mediaType } : payload;
    }
  }

  if (!parsed.ok) return { recognized: true, kind, ok: false, error: parsed.error };
  return {
    recognized: true,
    kind,
    ok: true,
    bytes: parsed.bytes,
    block: {
      type: kind,
      source: {
        type: 'base64',
        media_type: parsed.mediaType,
        data: parsed.data,
      },
    },
  };
}

function validateClaudeMultimodalBlock(block, options = {}) {
  if (!block || typeof block !== 'object') return { recognized: false };
  const kind = own(block, 'type') ? String(block.type || '').toLowerCase() : '';
  if (!['image', 'audio', 'video'].includes(kind)) return { recognized: false };
  const source = own(block, 'source') ? block.source : null;
  if (!source || typeof source !== 'object' || source.type !== 'base64') {
    return { recognized: true, kind, ok: false, error: kind + ' source must be base64' };
  }
  return inspectOpenAIMultimodalPart(
    {
      type: 'input_' + kind,
      data: own(source, 'data') ? source.data : undefined,
      media_type: own(source, 'media_type') ? source.media_type : undefined,
    },
    options
  );
}

function multimodalBlockToOpenAIChatPart(block) {
  const parsed = validateClaudeMultimodalBlock(block);
  if (!parsed.recognized || !parsed.ok) return null;
  const source = parsed.block.source;
  const dataUrl = 'data:' + source.media_type + ';base64,' + source.data;
  if (parsed.kind === 'image') return { type: 'image_url', image_url: { url: dataUrl } };
  if (parsed.kind === 'audio') {
    return {
      type: 'input_audio',
      input_audio: { data: source.data, format: source.media_type },
    };
  }
  return { type: 'video_url', video_url: { url: dataUrl } };
}

module.exports = {
  MAX_INLINE_MEDIA_BYTES,
  MEDIA_PART_TYPES,
  normalizeMediaType,
  validateBase64Payload,
  parseDataUrl,
  inspectOpenAIMultimodalPart,
  validateClaudeMultimodalBlock,
  multimodalBlockToOpenAIChatPart,
};
