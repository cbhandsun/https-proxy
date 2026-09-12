const fallbackModelSlugs = [
  'codex/gpt-5.6-sol',
  'codex/gpt-5.5',
  'gpt-5.6-sol',
  'gpt-5.5',
  'gpt-6-astra',
];

export function renderCodexDesktopModelOptions({ select, routes, clearElement, appendOption }) {
  if (!select) return;
  const currentValue = String(select.value || '').trim();
  const safeRoutes = Array.isArray(routes) ? routes : [];
  const seen = new Set();
  let firstRouteSlug = '';
  clearElement(select);

  for (const route of safeRoutes) {
    const slug = String((route && route.from) || '').trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    if (!firstRouteSlug) firstRouteSlug = slug;
    const label = String(
      (route && (route.labelOverride || route.displayName || route.from)) || slug
    ).trim();
    appendOption(select, slug, `${label || slug} (${slug})`);
  }
  for (const slug of fallbackModelSlugs) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    appendOption(select, slug, slug);
  }

  if (currentValue && seen.has(currentValue)) select.value = currentValue;
  else if (seen.has(fallbackModelSlugs[0])) select.value = fallbackModelSlugs[0];
  else if (firstRouteSlug) select.value = firstRouteSlug;
}

export function codexDesktopModePayload(connection, auth, getElement) {
  const readValue = (id) => {
    const element = typeof getElement === 'function' ? getElement(id) : null;
    return String((element && element.value) || '').trim();
  };
  return {
    connection,
    auth,
    model: readValue('codexDesktopModel') || undefined,
    reasoningEffort: readValue('codexDesktopReasoningEffort') || undefined,
  };
}
