'use strict';
/**
 * singleton-guard.js — daemon glue for the per-namespace conductor lock.
 *
 * Extracted from maestro-conduct.js so the conductor stays under the
 * max-lines-per-file gate (mirrors heartbeat.js / restart-guards.js). The pure
 * lock primitive lives in conductor-lock.js; this module wires it to alerts +
 * process lifecycle: claim the lock, refuse (exit 3) on a live conflict, take
 * over under MAESTRO_FORCE=1, and release on exit/signals.
 */
const namespace = require('./namespace');
const conductorLock = require('./conductor-lock');
const alerts = require('./alerts');

/**
 * Claim the namespace's conductor lock or exit(3). Returns the ns label on
 * success. A second daemon in the SAME namespace is detected and refused; a
 * stale lock is reclaimed silently; MAESTRO_FORCE=1 takes over a live lock.
 */
function acquireOrExit() {
  const lockPath = namespace.lockFile();
  const nsLabel = namespace.ns() || '(global)';
  const res = conductorLock.acquire(lockPath, { force: process.env.MAESTRO_FORCE === '1' });
  if (!res.ok) {
    const h = res.held || {};
    alerts.log(
      `CONDUCTOR-EXISTS namespace="${nsLabel}" — a conductor (pid ${h.pid}) already holds ` +
        `${lockPath}. Two conductors double-drive the same agents, so this one refuses to ` +
        `start. Isolate it with MAESTRO_NS=<name>, or set MAESTRO_FORCE=1 to take over.`
    );
    process.exit(3);
  }
  if (res.forced) alerts.log(`CONDUCTOR-FORCED took over lock ${lockPath} (MAESTRO_FORCE=1)`);
  const release = () => conductorLock.release(lockPath);
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      release();
      process.exit(0);
    });
  }
  return nsLabel;
}

module.exports = { acquireOrExit };
