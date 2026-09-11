'use strict';

const { createGeminiImageJobExecutor } = require('../image-job-executor');
const { ImageJobStoreError, createImageJobStore } = require('../image-jobs');
const { parseOpenAIImageGenerationRequest } = require('../openai-images');

function imageJobOwner(entryAuth) {
  if (entryAuth && entryAuth.enabled && entryAuth.key && entryAuth.key.id) {
    return `entry-key:${String(entryAuth.key.id).slice(0, 128)}`;
  }
  return 'entry-key:anonymous';
}

function createOpenAIImageJobHandlers(ctx) {
  const { logProxyEvent, logRequestEnd, parseProxyBody, writeJsonResponse } = ctx;
  const imageJobStore =
    ctx.imageJobStore ||
    createImageJobStore({
      maxJobs: process.env.PROXY_IMAGE_JOB_MAX_JOBS,
      maxQueued: process.env.PROXY_IMAGE_JOB_MAX_QUEUED,
      maxConcurrent: process.env.PROXY_IMAGE_JOB_MAX_CONCURRENCY,
      ttlMs: process.env.PROXY_IMAGE_JOB_TTL_MS,
      onTransition(job) {
        logProxyEvent('image_job_transition', {
          jobId: job.id,
          status: job.status,
          errorType: job.error && job.error.type,
        });
      },
    });
  const executeImageJob =
    ctx.executeImageJob ||
    createGeminiImageJobExecutor({
      ...ctx,
      maxResponseBytes: ctx.maxConversionResponseBytes,
    });

  function handleOpenAIImageJobCreate(
    clientReq,
    clientRes,
    prepared,
    target,
    apiKey,
    upstreamPath,
    startTime
  ) {
    const parsed = parseProxyBody(clientRes, prepared.buffer);
    if (!parsed) {
      logRequestEnd(clientReq.method, upstreamPath, startTime, 400, {
        type: 'image_job_invalid_json',
      });
      return;
    }
    const validation = parseOpenAIImageGenerationRequest(parsed);
    if (!validation.ok) {
      writeJsonResponse(clientRes, 400, { error: validation.error });
      logRequestEnd(clientReq.method, upstreamPath, startTime, 400, {
        type: 'image_job_invalid_request',
      });
      return;
    }

    try {
      const job = imageJobStore.create({
        owner: imageJobOwner(clientReq.entryAuth),
        run: ({ id, signal }) =>
          executeImageJob({
            apiKey,
            jobId: id,
            prepared: {
              authMode: prepared.authMode,
              authProvider: prepared.authProvider,
              googleOfficialProjectId: prepared.googleOfficialProjectId,
              model: prepared.model,
              profile: prepared.profile,
              rewriteTo: prepared.rewriteTo,
            },
            request: validation.request,
            signal,
            target,
          }),
      });
      const statusUrl = `/v1/image-jobs/${job.id}`;
      writeJsonResponse(
        clientRes,
        202,
        { ...job, status_url: statusUrl },
        { 'Cache-Control': 'no-store', Location: statusUrl, 'Retry-After': '2' }
      );
      logProxyEvent('image_job_created', {
        jobId: job.id,
        profileId: prepared.profile && prepared.profile.id,
        targetModel: prepared.rewriteTo !== '-' ? prepared.rewriteTo : validation.request.model,
      });
      logRequestEnd(clientReq.method, upstreamPath, startTime, 202, {
        type: 'image_job_created',
        jobId: job.id,
      });
    } catch (error) {
      const known = error instanceof ImageJobStoreError;
      const statusCode = known ? error.statusCode : 500;
      writeJsonResponse(
        clientRes,
        statusCode,
        {
          error: {
            type: known ? error.code : 'image_job_error',
            message: known ? error.message : 'Unable to create image job.',
          },
        },
        statusCode === 503 ? { 'Retry-After': '5' } : undefined
      );
      logRequestEnd(clientReq.method, upstreamPath, startTime, statusCode, {
        type: 'image_job_create_error',
        errorType: known ? error.code : 'image_job_error',
      });
    }
  }

  function handleOpenAIImageJobControl(clientReq, clientRes, jobId, startTime) {
    const owner = imageJobOwner(clientReq.entryAuth);
    const job =
      clientReq.method === 'DELETE'
        ? imageJobStore.cancel(jobId, owner)
        : imageJobStore.get(jobId, owner);
    if (!job) {
      writeJsonResponse(clientRes, 404, {
        error: { type: 'not_found', message: 'Image job was not found.' },
      });
      logRequestEnd(clientReq.method, clientReq.url, startTime, 404, {
        type: 'image_job_not_found',
      });
      return;
    }
    writeJsonResponse(clientRes, 200, job, {
      'Cache-Control': 'no-store',
      ...(job.status === 'queued' || job.status === 'in_progress' ? { 'Retry-After': '2' } : {}),
    });
    logRequestEnd(clientReq.method, clientReq.url, startTime, 200, {
      type: clientReq.method === 'DELETE' ? 'image_job_cancelled' : 'image_job_status',
      jobId: job.id,
      status: job.status,
    });
  }

  return {
    handleOpenAIImageJobControl,
    handleOpenAIImageJobCreate,
    _imageJobStore: imageJobStore,
  };
}

module.exports = { createOpenAIImageJobHandlers, imageJobOwner };
