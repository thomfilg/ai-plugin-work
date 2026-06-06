'use strict';

/**
 * createGateStep — declarative builder for /work gate steps.
 *
 * Replaces the hand-written `(add, s, ctx) => void` body for any gate that
 * follows the shape:
 *
 *   1. Precondition fails        → DEFER with `noArtifactReason`
 *   2. Artifact unreadable       → RUN `failClosedCommand` (fail-closed)
 *   3. Parser threw              → RUN `runCommand` with the throw message
 *   4. Validator returns valid   → DEFER with `validate.deferReason(parsed)`
 *   5. Validator returns invalid → RUN `runCommand` with `validate.runReason(parsed)`
 *
 * The matrix IS the code — there is no place to add a 6th branch by hand,
 * which is the whole point: the LLM picks values for the table; the factory
 * generates the dispatch.
 */

const fs = require('fs');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function assertConfig(cfg) {
  if (!isPlainObject(cfg)) throw new TypeError('createGateStep: config object required');
  const required = ['id', 'artifact', 'precondition', 'parse', 'validate', 'runCommand'];
  for (const k of required) {
    if (cfg[k] === undefined) throw new TypeError(`createGateStep: missing "${k}"`);
  }
  if (typeof cfg.precondition !== 'function') {
    throw new TypeError('createGateStep: "precondition" must be a function (s, ctx) => bool');
  }
  if (typeof cfg.parse !== 'function') {
    throw new TypeError('createGateStep: "parse" must be a function (text) => parsed');
  }
  if (typeof cfg.validate !== 'function') {
    throw new TypeError(
      'createGateStep: "validate" must be a function (parsed) => { valid, deferReason, runReason, runExtra? }'
    );
  }
}

function readArtifact(artifactPath) {
  try {
    return { ok: true, text: fs.readFileSync(artifactPath, 'utf8') };
  } catch (err) {
    return { ok: false, err };
  }
}

function deferNoArtifact(add, cfg) {
  add(cfg.id, 'DEFER', null, cfg.noArtifactReason || `No ${cfg.artifact} present`);
}

function runFailClosed(add, cfg) {
  // When `failClosedCommand` is unset we fall back to `runCommand`. This is
  // intentional for gates whose recovery action IS "re-run the producer
  // skill" (e.g. `brief-gate` → `/brief`). For gates where unreadable
  // artifact needs a different recovery (rollback, manual fix), pass
  // `failClosedCommand` + `failClosedReason` explicitly.
  const command = cfg.failClosedCommand || cfg.runCommand;
  const reason = cfg.failClosedReason || `${cfg.artifact} unreadable — regenerate`;
  add(cfg.id, 'RUN', command, reason, { agentType: 'skill', agentPrompt: command });
}

function runParserThrew(add, cfg, err) {
  add(cfg.id, 'RUN', cfg.runCommand, `${cfg.artifact} parser threw: ${err.message}`, {
    agentType: 'skill',
    agentPrompt: cfg.runCommand,
  });
}

function resolveReason(value, parsed) {
  if (typeof value === 'function') return value(parsed);
  if (typeof value === 'string') return value;
  return null;
}

function deferValid(add, cfg, validation, parsed) {
  const reason = resolveReason(validation.deferReason, parsed) || 'Validation passed';
  add(cfg.id, 'DEFER', null, reason);
}

function runInvalid(add, cfg, validation, parsed, ctx) {
  const reason = resolveReason(validation.runReason, parsed) || 'Validation failed';
  // `runExtra` receives (parsed, validation, ctx) so it can build payloads
  // that need ctx-derived values — e.g. brief-gate's postResolveCommand
  // needs `path.join(ctx.tasksDir, 'brief.md')`.
  const extra =
    typeof validation.runExtra === 'function'
      ? validation.runExtra(parsed, validation, ctx)
      : { agentType: 'skill', agentPrompt: cfg.runCommand };
  add(cfg.id, 'RUN', cfg.runCommand, reason, extra);
}

function createGateStep(cfg) {
  assertConfig(cfg);

  function gateStep(add, s, ctx) {
    if (!cfg.precondition(s, ctx)) return deferNoArtifact(add, cfg);

    const artifactPath = ctx.path.join(ctx.tasksDir, cfg.artifact);
    const read = readArtifact(artifactPath);
    if (!read.ok) return runFailClosed(add, cfg);

    let parsed;
    try {
      parsed = cfg.parse(read.text);
    } catch (err) {
      return runParserThrew(add, cfg, err);
    }

    let validation;
    try {
      validation = cfg.validate(parsed);
    } catch (err) {
      return runParserThrew(add, cfg, err);
    }

    if (validation && validation.valid) return deferValid(add, cfg, validation, parsed);
    return runInvalid(add, cfg, validation || {}, parsed, ctx);
  }

  gateStep.__factoryMeta = {
    kind: 'gate',
    id: cfg.id,
    artifact: cfg.artifact,
    retryTo: cfg.retryTo || null,
  };
  return gateStep;
}

module.exports = { createGateStep };
