const safeRegex = require('safe-regex2');

const MAX_ROUTING_PATTERN_CHARS = 128;
const MAX_ROUTING_INPUT_CHARS = 128;

function hasQuantifiedAlternation(pattern) {
  return /\((?:\\.|[^()])*\|(?:\\.|[^()])*\)(?:[+*]|\{\d+(?:,\d*)?\})/.test(pattern);
}

function compileSafeRoutingPattern(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: 'pattern must be a non-empty string' };
  }
  if (value.length > MAX_ROUTING_PATTERN_CHARS) {
    return {
      ok: false,
      error: `pattern must contain at most ${MAX_ROUTING_PATTERN_CHARS} characters`,
    };
  }

  let regex;
  try {
    regex = new RegExp(value);
  } catch (error) {
    return { ok: false, error: 'pattern is invalid' };
  }
  if (!safeRegex(regex) || hasQuantifiedAlternation(value)) {
    return { ok: false, error: 'pattern has unsafe backtracking complexity' };
  }
  return { ok: true, regex };
}

function safeRoutingPatternMatches(pattern, input) {
  if (typeof input !== 'string' || input.length > MAX_ROUTING_INPUT_CHARS) return false;
  const compiled = compileSafeRoutingPattern(pattern);
  return compiled.ok ? compiled.regex.test(input) : false;
}

module.exports = {
  MAX_ROUTING_PATTERN_CHARS,
  MAX_ROUTING_INPUT_CHARS,
  compileSafeRoutingPattern,
  safeRoutingPatternMatches,
};
