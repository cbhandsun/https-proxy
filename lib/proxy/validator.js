function validateConfig(config) {
  const errors = [];

  if (!config.activeProfile) errors.push('Missing activeProfile');

  if (!Array.isArray(config.profiles)) {
    errors.push('profiles must be an array');
  } else {
    config.profiles.forEach((p, i) => {
      if (!p.id) errors.push(`Profile [${i}] is missing id`);
      if (!p.protocol) errors.push(`Profile [${p.id || i}] is missing protocol`);
    });
  }

  if (config.mcpHub) {
    if (!Array.isArray(config.mcpHub.servers)) errors.push('mcpHub.servers must be an array');
    if (!Array.isArray(config.mcpHub.routing)) errors.push('mcpHub.routing must be an array');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

module.exports = { validateConfig };
