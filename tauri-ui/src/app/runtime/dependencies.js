export function bindDomainDependencies(domainName, candidate, requiredNames) {
  if (typeof domainName !== 'string' || domainName.trim() === '') {
    throw new TypeError('domainName must be a non-empty string');
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError(`${domainName} dependencies must be an object`);
  }
  if (
    !Array.isArray(requiredNames) ||
    requiredNames.some((name) => typeof name !== 'string' || name.trim() === '')
  ) {
    throw new TypeError(`${domainName} required dependency names must be non-empty strings`);
  }

  const missing = [...new Set(requiredNames)].filter(
    (name) => !Object.prototype.hasOwnProperty.call(candidate, name)
  );
  if (missing.length > 0) {
    throw new Error(`${domainName} dependencies missing: ${missing.sort().join(', ')}`);
  }
  return candidate;
}
