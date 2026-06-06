'use strict';

/**
 * createAgentInvocationStep — declarative builder for /work steps that emit
 * a single RUN entry whose `agentPrompt` is assembled from several
 * conditional context sections.
 *
 * This is the shape of `implement.js`: one agent invocation per call, but
 * the prompt is built from many independent pieces (current task, claim
 * status, dependency status, worker slot, planning docs, TDD protocol).
 * Without a factory each piece is wired by hand and the ordering / null
 * handling drifts.
 *
 * The factory takes:
 *   - `precondition(s, ctx)`  — DEFER if false
 *   - `command`               — slash command or agent name
 *   - `agentType`             — 'skill' | 'general-purpose' | named agent
 *   - `sections: PromptSection[]` — ordered list of `{ id, build(s, ctx): string|null }`
 *       Each section that returns a non-empty string is joined with `\n\n`.
 *       Returning null/empty omits the section silently.
 *   - `extras(s, ctx): object` — additional fields merged into the plan entry
 *       (e.g. taskInfo, dependency descriptors). Optional.
 *
 * Decision matrix:
 *   1. precondition false → DEFER with skipReason
 *   2. otherwise          → RUN with assembled agentPrompt + extras
 */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function assertConfig(cfg) {
  if (!isPlainObject(cfg)) throw new TypeError('createAgentInvocationStep: config required');
  if (!cfg.id) throw new TypeError('createAgentInvocationStep: missing "id"');
  if (!cfg.command) throw new TypeError('createAgentInvocationStep: missing "command"');
  if (!cfg.agentType) throw new TypeError('createAgentInvocationStep: missing "agentType"');
  if (!Array.isArray(cfg.sections)) {
    throw new TypeError('createAgentInvocationStep: "sections" must be an array');
  }
  for (const sec of cfg.sections) {
    if (!sec || typeof sec.build !== 'function') {
      throw new TypeError('createAgentInvocationStep: each section needs build(s, ctx)');
    }
  }
  if (cfg.extras !== undefined && typeof cfg.extras !== 'function') {
    throw new TypeError('createAgentInvocationStep: "extras" must be a function when provided');
  }
  if (cfg.onSectionError !== undefined && typeof cfg.onSectionError !== 'function') {
    throw new TypeError(
      'createAgentInvocationStep: "onSectionError" must be a function when provided'
    );
  }
}

function resolve(value, args) {
  if (typeof value === 'function') return value(args);
  if (typeof value === 'string') return value;
  return null;
}

function defaultLogger(sectionId, err) {
  // Stderr fallback so a thrown section builder is never silent. The
  // factory is stand-alone (no plugin imports), so callers that want
  // routing through `logHookError` pass `onSectionError` in cfg.
  const id = sectionId || '?';
  const msg = err && err.message ? err.message : String(err);
  process.stderr.write(`createAgentInvocationStep: section "${id}" threw: ${msg}\n`);
}

function assemblePrompt(sections, s, ctx, onError) {
  const parts = [];
  for (const sec of sections) {
    let chunk = null;
    try {
      chunk = sec.build(s, ctx);
    } catch (err) {
      onError(sec.id, err);
    }
    if (typeof chunk === 'string' && chunk.trim().length > 0) parts.push(chunk);
  }
  return parts.join('\n\n');
}

function createAgentInvocationStep(cfg) {
  assertConfig(cfg);

  function agentInvocationStep(add, s, ctx) {
    if (cfg.precondition && !cfg.precondition(s, ctx)) {
      add(cfg.id, 'DEFER', null, resolve(cfg.skipReason, { s, ctx }) || 'Precondition not met');
      return;
    }
    const onError = cfg.onSectionError || defaultLogger;
    const agentPrompt = assemblePrompt(cfg.sections, s, ctx, onError);
    const reason = resolve(cfg.runReason, { s, ctx }) || `Invoke ${cfg.command}`;
    const extra = typeof cfg.extras === 'function' ? cfg.extras(s, ctx) || {} : {};
    add(cfg.id, 'RUN', cfg.command, reason, {
      agentType: cfg.agentType,
      agentPrompt,
      ...extra,
    });
  }

  agentInvocationStep.__factoryMeta = {
    kind: 'agent-invocation',
    id: cfg.id,
    artifact: null,
    retryTo: cfg.retryTo || null,
    sectionIds: cfg.sections.map((s) => s.id || '?'),
  };
  return agentInvocationStep;
}

module.exports = { createAgentInvocationStep };
