/**
 * sleep.js — synchronous sleep via Atomics.wait.
 *
 * No subprocess, no event-loop dependency — replaces the previous
 * `execSync('node -e setTimeout…')` pattern, which crashed the whole
 * orchestrator with an uncaught `spawnSync /bin/sh ETIMEDOUT` when the
 * machine was under load (triage.js:20, echo-6209).
 */

'use strict';

function sleepSync(ms) {
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, ms);
  } catch {
    /* sleep best-effort */
  }
}

/**
 * Sleep up to `ms`, in `chunkMs` slices, calling `shouldWake()` between
 * slices. Returns true when it woke early because shouldWake() was truthy.
 */
function sleepSyncInterruptible(ms, shouldWake, chunkMs) {
  const chunk = chunkMs || 5000;
  let remaining = ms;
  while (remaining > 0) {
    sleepSync(Math.min(chunk, remaining));
    remaining -= chunk;
    try {
      if (shouldWake && shouldWake()) return true;
    } catch {
      /* wake-check is best-effort */
    }
  }
  return false;
}

module.exports = { sleepSync, sleepSyncInterruptible };
