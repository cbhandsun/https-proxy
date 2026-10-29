'use strict';

// Shared wire limits do not depend on a planner or an execution backend.
const DEFAULT_WORKBUDDY_OPERATIONAL_INPUT_TOKENS = 96 * 1024;
const DEFAULT_WORKBUDDY_TARGET_BODY_BYTES = 384 * 1024;

module.exports = {
  DEFAULT_WORKBUDDY_OPERATIONAL_INPUT_TOKENS,
  DEFAULT_WORKBUDDY_TARGET_BODY_BYTES,
};
