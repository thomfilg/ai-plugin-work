'use strict';

/**
 * createArtifactStep — declarative builder for steps that PRODUCE an
 * artifact via a skill/agent invocation.
 *
 * Matches the shape of `brief.js`, `spec.js`, `tasks.js`:
 *
 *   1. Precondition fails  → DEFER with `skipReason`
 *   2. Artifact present    → DEFER with `existsReason`
 *   3. Artifact missing    → RUN `command` with `agentType`/`agentPrompt`
 *      (planning docs are auto-appended from `ctx.planningContext` when
 *       `injectPlanningContext: true`)
 */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function assertConfig(cfg) {
  if (!isPlainObject(cfg)) throw new TypeError('createArtifactStep: config object required');
  const required = ['id', 'artifact', 'precondition', 'command', 'agentType'];
  for (const k of required) {
    if (cfg[k] === undefined) throw new TypeError(`createArtifactStep: missing "${k}"`);
  }
  if (typeof cfg.precondition !== 'function') {
    throw new TypeError('createArtifactStep: "precondition" must be (s, ctx) => bool');
  }
  if (typeof cfg.artifactExists !== 'function') {
    throw new TypeError('createArtifactStep: "artifactExists" must be (s, ctx) => bool');
  }
}

function resolveReason(value, s, ctx) {
  if (typeof value === 'function') return value(s, ctx);
  if (typeof value === 'string') return value;
  return null;
}

function buildAgentPrompt(cfg, s, ctx) {
  // `agentPrompt` may be a string OR `(s, ctx) => string`. The function form
  // lets callers interpolate ctx-derived values that aren't available at
  // factory-construction time (e.g. `ctx.getDocsPrompt('READ_DOCS_ON_BRIEF')`
  // in brief.js, or `path.join(ctx.tasksDir, ...)`).
  let base;
  if (typeof cfg.agentPrompt === 'function') {
    base = cfg.agentPrompt(s, ctx) || cfg.command;
  } else {
    base = cfg.agentPrompt || cfg.command;
  }
  if (!cfg.injectPlanningContext) return base;
  const planning = (ctx && ctx.planningContext) || '';
  return `${base}${planning}`;
}

function createArtifactStep(cfg) {
  assertConfig(cfg);

  function artifactStep(add, s, ctx) {
    if (!cfg.precondition(s, ctx)) {
      add(cfg.id, 'DEFER', null, resolveReason(cfg.skipReason, s, ctx) || 'Precondition not met');
      return;
    }
    if (cfg.artifactExists(s, ctx)) {
      const reason = resolveReason(cfg.existsReason, s, ctx) || `${cfg.artifact} already present`;
      add(cfg.id, 'DEFER', null, reason);
      return;
    }
    const reason = resolveReason(cfg.runReason, s, ctx) || `Produce ${cfg.artifact}`;
    add(cfg.id, 'RUN', cfg.command, reason, {
      agentType: cfg.agentType,
      agentPrompt: buildAgentPrompt(cfg, s, ctx),
    });
  }

  artifactStep.__factoryMeta = {
    kind: 'artifact',
    id: cfg.id,
    artifact: cfg.artifact,
    retryTo: null,
  };
  return artifactStep;
}

module.exports = { createArtifactStep };
