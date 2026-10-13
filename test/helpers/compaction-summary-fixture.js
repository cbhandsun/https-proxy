'use strict';

const { TASK_STATE_SCHEMA } = require('../../lib/proxy/context-task-state');

// Synthetic provider fixture only; never a production fallback or quality claim.
function summaryFixture(request, summary = '历史证据与未验证进展🙂') {
  const payload = JSON.parse(request.messages[1].content);
  const state =
    payload.previous?.state ||
    (payload.sources.length
      ? {
          schema: TASK_STATE_SCHEMA,
          version: 1,
          objectives: [
            {
              text: 'fixture objective',
              sources: [
                {
                  sourceId: payload.sources[0].id,
                  quote: [
                    ...payload.citations.find((entry) => entry.sourceId === payload.sources[0].id)
                      .quote,
                  ]
                    .slice(0, 40)
                    .join(''),
                },
              ],
            },
          ],
          requirements: [],
          decisions: [],
          work: [],
          blockers: [],
          nextSteps: [],
          files: [],
        }
      : null);
  return JSON.stringify({ summary, state });
}

module.exports = { summaryFixture };
