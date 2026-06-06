'use strict';

/**
 * createPlanMutatorStep — declarative builder for pseudo-steps that
 * MUTATE other plan entries instead of emitting their own. Models
 * `task-advance.js`, which patches `check` and `task_review` entries
 * with `nextAction` / `taskInfo` based on task progress.
 *
 * Configuration:
 *   - `precondition(s, ctx)`            → if false, no-op (no DEFER emitted —
 *                                          pseudo-steps are silent by design)
 *   - `mutations: Mutation[]` where each Mutation is:
 *       {
 *         id,
 *         targetStepIds: string[],        // which sibling entries to patch
 *         predicate(s, ctx): boolean,     // run this mutation?
 *         patch(entry, s, ctx): object    // partial fields to Object.assign onto the entry
 *       }
 *
 * Decision matrix:
 *   1. precondition false → no-op (no plan entry, no mutation)
 *   2. otherwise          → for each mutation whose predicate passes,
 *                           apply `patch(entry, s, ctx)` to every entry in
 *                           `ctx.plan` whose `step` is in `targetStepIds`.
 *
 * Like `task-advance.js`, this step does NOT call `add()`. It reads
 * `ctx.plan` and mutates in place.
 */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function assertConfig(cfg) {
  if (!isPlainObject(cfg)) throw new TypeError('createPlanMutatorStep: config required');
  if (!cfg.id) throw new TypeError('createPlanMutatorStep: missing "id"');
  if (!Array.isArray(cfg.mutations) || cfg.mutations.length === 0) {
    throw new TypeError('createPlanMutatorStep: "mutations" must be a non-empty array');
  }
  for (const m of cfg.mutations) {
    if (!m || typeof m.predicate !== 'function' || typeof m.patch !== 'function') {
      throw new TypeError(
        'createPlanMutatorStep: each mutation needs predicate(s,ctx) and patch(entry,s,ctx)'
      );
    }
    if (!Array.isArray(m.targetStepIds) || m.targetStepIds.length === 0) {
      throw new TypeError('createPlanMutatorStep: each mutation needs non-empty targetStepIds');
    }
  }
}

function applyMutation(mutation, plan, s, ctx) {
  const targets = new Set(mutation.targetStepIds);
  for (const entry of plan) {
    if (!entry || !targets.has(entry.step)) continue;
    let patch;
    try {
      patch = mutation.patch(entry, s, ctx);
    } catch {
      patch = null;
    }
    if (patch && typeof patch === 'object') Object.assign(entry, patch);
  }
}

function createPlanMutatorStep(cfg) {
  assertConfig(cfg);

  function planMutatorStep(_add, s, ctx) {
    if (cfg.precondition && !cfg.precondition(s, ctx)) return;
    const plan = ctx && Array.isArray(ctx.plan) ? ctx.plan : null;
    if (!plan) return;
    for (const mutation of cfg.mutations) {
      let runIt;
      try {
        runIt = mutation.predicate(s, ctx);
      } catch {
        runIt = false;
      }
      if (runIt) applyMutation(mutation, plan, s, ctx);
    }
  }

  planMutatorStep.__factoryMeta = {
    kind: 'plan-mutator',
    id: cfg.id,
    artifact: null,
    retryTo: null,
    mutationIds: cfg.mutations.map((m) => m.id || '?'),
  };
  return planMutatorStep;
}

module.exports = { createPlanMutatorStep };
