'use strict';

const { readJsonBodyFromRequest } = require('../management-utils');
const {
  parsePolicyMigrationRequest,
  preparePolicyMigration,
} = require('../context-policy-migration');

// Reuses the config-save queue and authenticated local management boundary.
function createManagementContextPolicyHandlers({
  sendJson,
  readCurrent,
  writeConfig,
  reloadProxyConfig,
  enqueueConfigMutation,
  validateConfig,
}) {
  function response(req, res) {
    let sent = false;
    return (status, value) => {
      if (sent || req.aborted || res.destroyed || res.writableEnded) return;
      sent = true;
      try {
        sendJson(res, status, value);
      } catch {
        // A disconnected response never repeats a committed config operation.
      }
    };
  }

  function execute(req, res, request) {
    const reply = response(req, res);
    void enqueueConfigMutation(() => {
      if (req.aborted || res.destroyed || res.writableEnded) return;
      let saved = false;
      try {
        const current = readCurrent();
        if (current.revision === 'missing') {
          reply(409, { ok: false, code: 'context_policy_config_required' });
          return;
        }
        if (request && request.revision !== current.revision) {
          reply(409, { ok: false, code: 'context_policy_revision_conflict' });
          return;
        }
        let prepared;
        try {
          prepared = preparePolicyMigration(current.config);
          if (!validateConfig(prepared.config).valid) throw new TypeError();
        } catch {
          reply(409, { ok: false, code: 'context_policy_config_invalid' });
          return;
        }
        if (!request) {
          reply(200, { ok: true, revision: current.revision, ...prepared.preview });
          return;
        }
        let committedRevision = current.revision;
        if (prepared.preview.migrationRequired) {
          committedRevision = writeConfig(prepared.config);
          saved = true;
        }
        // scheduleNow is asynchronous. This is a request, never runtime proof.
        reloadProxyConfig();
        // Never adopt an external writer's revision into a stale UI document.
        if (readCurrent().revision !== committedRevision) throw new TypeError();
        reply(200, {
          ok: true,
          saved: true,
          changed: saved,
          revision: committedRevision,
          targetVersion: prepared.preview.targetVersion,
          runtimeApplication: 'pending',
        });
      } catch {
        reply(503, {
          ok: false,
          code: saved ? 'context_policy_reload_unconfirmed' : 'context_policy_unavailable',
        });
      }
    }).catch(() => reply(503, { ok: false, code: 'context_policy_unavailable' }));
  }

  return {
    handleLocalContextPolicyPreviewRequest(req, res) {
      if (req.method !== 'GET') {
        response(req, res)(405, { ok: false, code: 'context_policy_method_not_allowed' });
        return;
      }
      execute(req, res, null);
    },
    handleLocalContextPolicyApplyRequest(req, res) {
      const reply = response(req, res);
      if (req.method !== 'POST') {
        reply(405, { ok: false, code: 'context_policy_method_not_allowed' });
        return;
      }
      readJsonBodyFromRequest(
        req,
        (error, input) => {
          let request;
          try {
            if (error) throw new TypeError();
            request = parsePolicyMigrationRequest(input);
          } catch {
            reply(400, { ok: false, code: 'context_policy_migration_invalid' });
            return;
          }
          execute(req, res, request);
        },
        { maxBytes: 256 }
      );
    },
  };
}

module.exports = { createManagementContextPolicyHandlers };
