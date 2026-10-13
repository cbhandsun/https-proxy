'use strict';
function waitForProxyFixtureReady(
  child,
  { setTimer = setTimeout, clearTimer = clearTimeout, probeReady } = {}
) {
  if (
    !child ||
    typeof child.once !== 'function' ||
    typeof child.removeListener !== 'function' ||
    !child.stdout ||
    typeof child.stdout.on !== 'function' ||
    typeof child.stdout.removeListener !== 'function' ||
    typeof setTimer !== 'function' ||
    typeof clearTimer !== 'function' ||
    (probeReady !== undefined && typeof probeReady !== 'function')
  )
    throw new TypeError('Invalid proxy fixture readiness input');
  if (child.exitCode != null || child.signalCode != null)
    return Promise.reject(new Error('Fixture stopped before startup'));
  return new Promise((resolve, reject) => {
    let tail = '',
      settled = false,
      phase = 'no_stdout';
    const controller = new globalThis.AbortController();
    let probeTimer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      if (probeTimer !== undefined) clearTimer(probeTimer);
      controller.abort();
      child.stdout.removeListener('data', data);
      child.removeListener('error', failed);
      child.removeListener('exit', stopped);
      tail = '';
      if (error) reject(error);
      else resolve();
    };
    const data = (chunk) => {
      if (!Buffer.isBuffer(chunk) && typeof chunk !== 'string') {
        finish(new Error('Invalid fixture stdout chunk'));
        return;
      }
      // Inspect the complete chunk before retaining only the bounded marker tail.
      const text = tail + chunk.toString('utf8');
      if (!probeReady && text.includes('Mgmt:')) {
        finish();
        return;
      }
      if (phase === 'no_stdout' && text.length) phase = 'stdout_seen';
      if (text.includes('Generating local CA signed certificate')) phase = 'certificate_started';
      if (text.includes('Certificate generated:')) phase = 'certificate_ready';
      tail = text.slice(-64);
    };
    const failed = () => finish(new Error('Fixture process failed before startup'));
    const stopped = () => finish(new Error('Fixture stopped before startup'));
    const timer = setTimer(
      () => finish(new Error('Fixture startup deadline (' + phase + ')')),
      15000
    );
    child.stdout.on('data', data);
    child.once('error', failed);
    child.once('exit', stopped);
    if (probeReady) {
      const probe = () => {
        if (settled) return;
        Promise.resolve()
          .then(() => (settled ? false : probeReady(controller.signal)))
          .then((ready) => {
            if (settled) return;
            if (ready === true) finish();
            else if (ready !== false) finish(new Error('Invalid fixture readiness probe result'));
            else probeTimer = setTimer(probe, 100);
          })
          .catch(() => finish(new Error('Fixture readiness probe failed')));
      };
      probe();
    }
  });
}
module.exports = { waitForProxyFixtureReady };
