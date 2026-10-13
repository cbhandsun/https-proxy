'use strict';

// Owner-only lifecycle controller, not a tool or retry mechanism. Catalog reads
// are bounded, single-flight and versioned. A noisy/invalid source cannot cause
// stale catalogs to be published or unbounded automatic recovery work.
function createEvidenceGatewayCatalogRefresh({ load, replace, suspend, notify, isClosed }) {
  let active = null;
  let revision = 0;
  let attempts = 0;
  let notificationFailures = 0;
  async function publishChange() {
    if (isClosed()) return;
    try {
      await notify();
    } catch {
      notificationFailures++;
    }
  }
  function refresh() {
    if (isClosed()) return Promise.resolve({ ok: false });
    revision++;
    suspend();
    if (active) return active;
    active = Promise.resolve()
      .then(async () => {
        let accepted = false;
        for (let round = 0; round < 2 && attempts < 32 && !isClosed(); round++) {
          const version = revision;
          attempts++;
          try {
            const catalog = await load();
            if (isClosed()) return { ok: false };
            if (revision !== version) continue;
            replace(catalog);
            accepted = true;
            break;
          } catch {
            if (revision === version) break;
          }
        }
        if (!accepted) suspend();
        const beforeNotification = revision;
        await publishChange();
        // A new notification while publishing invalidates that publication too.
        if (beforeNotification !== revision && !isClosed()) {
          suspend();
          accepted = false;
          await publishChange();
        }
        return { ok: accepted };
      })
      .finally(() => {
        active = null;
      });
    return active;
  }
  return { refresh, inspect: () => ({ active: active !== null, attempts, notificationFailures }) };
}

module.exports = { createEvidenceGatewayCatalogRefresh };
