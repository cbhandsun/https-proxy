'use strict';
async function closeOwnedResources(sessions, adapter, listener) {
  let clean = true,
    closedChannels = 0,
    syntheticSocketsClosed = false;
  for (const [index, retained] of sessions) {
    try {
      if (adapter && (await adapter.closeSession(index)) !== true) clean = false;
    } catch {
      clean = false;
    }
    try {
      if ((await retained.channel.close()) !== true) clean = false;
      else closedChannels++;
    } catch {
      clean = false;
    }
  }
  if (listener) {
    try {
      syntheticSocketsClosed = (await listener.close()) === true;
    } catch {
      clean = false;
    }
  }
  if (!clean || !syntheticSocketsClosed || closedChannels !== sessions.size)
    throw new Error('n08_owned_cleanup_failed');
  return Object.freeze({ closedChannels, expectedChannels: sessions.size, syntheticSocketsClosed });
}
module.exports = { closeOwnedResources };
