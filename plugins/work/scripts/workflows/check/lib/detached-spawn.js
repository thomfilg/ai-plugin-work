'use strict';

/**
 * check/lib/detached-spawn.js — detached long-running process helpers for the
 * /check environment starter (extracted from hooks/check-start-env.js).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `predicate` every `intervalMs` until truthy or `timeoutMs` elapses.
 * @returns {Promise<boolean>} last predicate result
 */
async function waitFor(predicate, timeoutMs, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
}

/**
 * Spawn a long-running server command DETACHED with its output redirected to
 * a log file instead of parent pipes.
 *
 * Zombie-leak fix (check-start-env-zombies-001): stdio 'pipe' streams keep
 * the parent hook's event loop alive for as long as the child runs — even
 * after child.unref() — so every /check run left this hook resident. Log-file
 * fds give the child a valid output target that survives parent exit, letting
 * the hook terminate while the started server keeps running.
 *
 * @returns {{ proc: import('child_process').ChildProcess, logPath: string }}
 */
function spawnDetachedToLog(command, label, extraEnv = {}) {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-start-env-'));
  const logPath = path.join(logDir, `${label}.log`);
  const fd = fs.openSync(logPath, 'a', 0o600);
  const proc = spawn(command, {
    cwd: process.cwd(),
    shell: true,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', fd, fd],
    detached: true,
  });
  fs.closeSync(fd); // child holds its own copy of the fd
  proc.unref();
  return { proc, logPath };
}

/** Read a child's log file (best-effort). */
function readLog(logPath) {
  try {
    return fs.readFileSync(logPath, 'utf8');
  } catch {
    return '';
  }
}

module.exports = { sleep, waitFor, spawnDetachedToLog, readLog };
