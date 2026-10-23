'use strict';

async function closeOwnedListeners(sockets, listeners) {
  const pendingSockets = [...sockets].map(
    (socket) =>
      new Promise((resolve, reject) => {
        // Server close can precede socket close. Attach before destroy, including
        // sockets already destroyed whose close event has not yet been delivered.
        const closed = () => resolve();
        socket.once('close', closed);
        try {
          socket.destroy();
        } catch {
          socket.removeListener('close', closed);
          reject(new Error('n08_owned_listener_cleanup_failed'));
        }
      })
  );
  const pendingListeners = listeners.map(
    (listener) =>
      new Promise((resolve, reject) => {
        if (!listener.listening) return resolve();
        listener.close((error) =>
          error ? reject(new Error('n08_owned_listener_cleanup_failed')) : resolve()
        );
      })
  );
  // Attempt every owned resource even when one operation rejects. The original
  // enclosing Job still bounds the whole cleanup; no deadline is extended.
  const results = await Promise.allSettled([...pendingSockets, ...pendingListeners]);
  if (results.some((result) => result.status === 'rejected'))
    throw new Error('n08_owned_listener_cleanup_failed');
  return listeners.every((listener) => !listener.listening) && sockets.size === 0;
}

module.exports = { closeOwnedListeners };
