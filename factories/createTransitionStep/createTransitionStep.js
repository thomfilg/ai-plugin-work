'use strict';

/**
 * createTransitionStep — declarative builder for /work steps whose body is
 * "always RUN one command" or "DEFER on a single precondition, else RUN".
 *
 * Fits: `ready.js`, `complete.js`, and (with `deferExtras`) `cleanup.js`.
 * Does NOT fit `commit.js` (it has 4 branches and emits the third action
 * type `PENDING`) — keep that hand-written.
 *
 * Matrix:
 *   1. `precondition(s, ctx) === false` → DEFER with `skipReason` and
 *                                         optional `deferExtras` (agent meta
 *                                         carried on the DEFER entry so the
 *                                         orchestrator can re-check)
 *   2. otherwise                        → RUN with `command` + agent metadata
 *
 * `agentPrompt`, `runReason`, `skipReason`, and `deferExtras` may each be a
 * string/object OR a function `(s, ctx) => string|object` so callers can
 * interpolate ctx values (e.g. ticket id, worktree path).
 */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function assertConfig(cfg) {
  if (!isPlainObject(cfg)) throw new TypeError('createTransitionStep: config required');
  if (!cfg.id) throw new TypeError('createTransitionStep: missing "id"');
  if (!cfg.command) throw new TypeError('createTransitionStep: missing "command"');
  if (cfg.precondition !== undefined && typeof cfg.precondition !== 'function') {
    throw new TypeError('createTransitionStep: "precondition" must be a function when provided');
  }
}

function resolveString(value, s, ctx) {
  if (typeof value === 'function') return value(s, ctx);
  if (typeof value === 'string') return value;
  return null;
}

function resolveExtras(value, s, ctx, fallback) {
  if (typeof value === 'function') return value(s, ctx) || fallback;
  if (value && typeof value === 'object') return value;
  return fallback;
}

function emitDefer(cfg, add, s, ctx) {
  const reason = resolveString(cfg.skipReason, s, ctx) || 'Precondition not met';
  // When `deferExtras` is set, the DEFER entry carries agent metadata so the
  // orchestrator can re-check at step time (e.g. cleanup.js needs the kill
  // command on its DEFER path). When unset, DEFER is metadata-free.
  if (cfg.deferExtras !== undefined) {
    const extras = resolveExtras(cfg.deferExtras, s, ctx, {});
    add(cfg.id, 'DEFER', extras.command || null, reason, extras);
    return;
  }
  add(cfg.id, 'DEFER', null, reason);
}

function emitRun(cfg, add, s, ctx) {
  const reason = resolveString(cfg.runReason, s, ctx) || `Run ${cfg.command}`;
  const agentPrompt =
    typeof cfg.agentPrompt === 'function'
      ? cfg.agentPrompt(s, ctx) || cfg.command
      : cfg.agentPrompt || cfg.command;
  add(cfg.id, 'RUN', cfg.command, reason, {
    agentType: cfg.agentType || 'skill',
    agentPrompt,
  });
}

function createTransitionStep(cfg) {
  assertConfig(cfg);

  function transitionStep(add, s, ctx) {
    if (cfg.precondition && !cfg.precondition(s, ctx)) return emitDefer(cfg, add, s, ctx);
    return emitRun(cfg, add, s, ctx);
  }

  transitionStep.__factoryMeta = {
    kind: 'transition',
    id: cfg.id,
    artifact: null,
    retryTo: cfg.retryTo || null,
  };
  return transitionStep;
}

module.exports = { createTransitionStep };
