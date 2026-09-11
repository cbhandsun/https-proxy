'use strict';

const crypto = require('crypto');
const { parseBoundedInteger } = require('./management-utils');

const AbortControllerImpl = globalThis.AbortController;

const IMAGE_JOB_ID_PATTERN = /^imgjob_[a-f0-9]{32}$/;
const TERMINAL_IMAGE_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled']);

class ImageJobStoreError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = 'ImageJobStoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function defaultImageJobId() {
  return `imgjob_${crypto.randomBytes(16).toString('hex')}`;
}

function normalizeOwner(value) {
  const owner = typeof value === 'string' ? value.trim() : '';
  if (!owner || owner.length > 256) {
    throw new ImageJobStoreError('invalid_owner', 'Image job owner is invalid.', 400);
  }
  return owner;
}

function imageJobErrorFromUnknown(error) {
  if (error && error.publicError && typeof error.publicError === 'object') {
    const status = error.publicError.status;
    const retryAfter = error.publicError.retry_after;
    const type = String(error.publicError.type || 'image_generation_failed')
      .replace(/[^a-z0-9._-]/gi, '')
      .slice(0, 64);
    const message = String(error.publicError.message || 'Image generation failed.')
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 500);
    return {
      type: type || 'image_generation_failed',
      message: message || 'Image generation failed.',
      ...(Number.isInteger(status) && status >= 400 && status <= 599 ? { status } : {}),
      ...(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 86_400
        ? { retry_after: retryAfter }
        : {}),
    };
  }
  return {
    type: 'image_generation_failed',
    message: 'Image generation failed.',
  };
}

function publicImageJob(job) {
  const response = {
    id: job.id,
    object: 'image.job',
    status: job.status,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    expires_at: job.expiresAt,
  };
  if (job.startedAt != null) response.started_at = job.startedAt;
  if (job.completedAt != null) response.completed_at = job.completedAt;
  if (job.status === 'completed' && job.result) response.result = job.result;
  if (job.status === 'failed' && job.error) response.error = job.error;
  return response;
}

function createImageJobStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const idFactory = typeof options.idFactory === 'function' ? options.idFactory : defaultImageJobId;
  const schedule = typeof options.schedule === 'function' ? options.schedule : setImmediate;
  const onTransition = typeof options.onTransition === 'function' ? options.onTransition : () => {};
  const maxJobs = parseBoundedInteger(options.maxJobs, 64, 1, 256);
  const maxQueued = parseBoundedInteger(options.maxQueued, 32, 1, maxJobs);
  const maxConcurrent = parseBoundedInteger(options.maxConcurrent, 2, 1, 8);
  const ttlMs = parseBoundedInteger(options.ttlMs, 60 * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000);
  const jobs = new Map();
  const queue = [];
  let activeCount = 0;
  let pumpScheduled = false;

  function nowSeconds() {
    return Math.floor(now() / 1000);
  }

  function removeQueuedId(id) {
    const index = queue.indexOf(id);
    if (index >= 0) queue.splice(index, 1);
  }

  function cleanupExpired() {
    const current = nowSeconds();
    for (const [id, job] of jobs) {
      if (!TERMINAL_IMAGE_JOB_STATUSES.has(job.status)) continue;
      if (job.expiresAt > current) continue;
      jobs.delete(id);
      removeQueuedId(id);
    }
  }

  function evictOldestTerminalJob() {
    for (const [id, job] of jobs) {
      if (!TERMINAL_IMAGE_JOB_STATUSES.has(job.status)) continue;
      jobs.delete(id);
      removeQueuedId(id);
      return true;
    }
    return false;
  }

  function schedulePump() {
    if (pumpScheduled) return;
    pumpScheduled = true;
    schedule(() => {
      pumpScheduled = false;
      pump();
    });
  }

  function finishJob(job, status, fields = {}) {
    const timestamp = nowSeconds();
    job.status = status;
    job.updatedAt = timestamp;
    job.completedAt = timestamp;
    job.expiresAt = Math.max(timestamp + 1, Math.floor((now() + ttlMs) / 1000));
    job.run = null;
    job.controller = null;
    Object.assign(job, fields);
    try {
      onTransition(publicImageJob(job));
    } catch (_error) {}
  }

  function startJob(job) {
    job.status = 'in_progress';
    job.startedAt = nowSeconds();
    job.updatedAt = job.startedAt;
    job.controller = new AbortControllerImpl();
    activeCount += 1;
    try {
      onTransition(publicImageJob(job));
    } catch (_error) {}
    Promise.resolve()
      .then(() => job.run({ id: job.id, signal: job.controller.signal }))
      .then((result) => {
        if (job.status !== 'in_progress') return;
        finishJob(job, 'completed', { result, error: null });
      })
      .catch((error) => {
        if (job.status !== 'in_progress') return;
        finishJob(job, 'failed', { result: null, error: imageJobErrorFromUnknown(error) });
      })
      .finally(() => {
        activeCount = Math.max(0, activeCount - 1);
        schedulePump();
      });
  }

  function pump() {
    cleanupExpired();
    while (activeCount < maxConcurrent && queue.length > 0) {
      const id = queue.shift();
      const job = jobs.get(id);
      if (!job || job.status !== 'queued' || typeof job.run !== 'function') continue;
      startJob(job);
    }
  }

  function create({ owner, run }) {
    cleanupExpired();
    if (typeof run !== 'function') {
      throw new ImageJobStoreError('invalid_runner', 'Image job runner is unavailable.', 500);
    }
    const queuedCount = queue.reduce((count, id) => {
      const job = jobs.get(id);
      return count + (job && job.status === 'queued' ? 1 : 0);
    }, 0);
    if (queuedCount >= maxQueued) {
      throw new ImageJobStoreError('queue_full', 'Image generation queue is full.', 503);
    }
    while (jobs.size >= maxJobs) {
      if (!evictOldestTerminalJob()) break;
    }
    if (jobs.size >= maxJobs) {
      throw new ImageJobStoreError('capacity_exceeded', 'Image job capacity is exhausted.', 503);
    }

    let id = '';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = String(idFactory() || '').toLowerCase();
      if (IMAGE_JOB_ID_PATTERN.test(candidate) && !jobs.has(candidate)) {
        id = candidate;
        break;
      }
    }
    if (!id) {
      throw new ImageJobStoreError('id_generation_failed', 'Unable to allocate image job ID.', 500);
    }

    const timestamp = nowSeconds();
    const job = {
      id,
      owner: normalizeOwner(owner),
      status: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      completedAt: null,
      expiresAt: Math.max(timestamp + 1, Math.floor((now() + ttlMs) / 1000)),
      result: null,
      error: null,
      run,
      controller: null,
    };
    jobs.set(id, job);
    queue.push(id);
    try {
      onTransition(publicImageJob(job));
    } catch (_error) {}
    schedulePump();
    return publicImageJob(job);
  }

  function get(id, owner) {
    cleanupExpired();
    if (!IMAGE_JOB_ID_PATTERN.test(String(id || '').toLowerCase())) return null;
    const job = jobs.get(String(id).toLowerCase());
    if (!job || job.owner !== normalizeOwner(owner)) return null;
    return publicImageJob(job);
  }

  function cancel(id, owner) {
    cleanupExpired();
    if (!IMAGE_JOB_ID_PATTERN.test(String(id || '').toLowerCase())) return null;
    const job = jobs.get(String(id).toLowerCase());
    if (!job || job.owner !== normalizeOwner(owner)) return null;
    if (TERMINAL_IMAGE_JOB_STATUSES.has(job.status)) return publicImageJob(job);

    removeQueuedId(job.id);
    const controller = job.controller;
    finishJob(job, 'cancelled', { result: null, error: null });
    if (controller && typeof controller.abort === 'function') controller.abort();
    schedulePump();
    return publicImageJob(job);
  }

  return {
    create,
    get,
    cancel,
    cleanupExpired,
    stats: () => ({ jobs: jobs.size, queued: queue.length, active: activeCount }),
    _jobs: jobs,
  };
}

module.exports = {
  IMAGE_JOB_ID_PATTERN,
  ImageJobStoreError,
  createImageJobStore,
  imageJobErrorFromUnknown,
};
