'use strict';

/**
 * createDetectorRunner — declarative builder for the detector-runner
 * shape that wraps a `{ detect(ctx) => hit }` module in the event-loop's
 * "guard → detect → dispatch hit/miss → short-circuit?" wrapper.
 *
 * Fits any event loop that runs a pipeline of detector modules per tick.
 * Each detector does some subset of the same matrix; without a factory
 * the variations drift (e.g. one detector forgets the eligibility guard,
 * another loses its onMiss cleanup).
 *
 * Decision matrix:
 *   1. `requireRestartEligible: true`  + !eligible           → return false (skip)
 *   2. detect(ctx).hit === false                              → onMiss?(ctx, hit); return false
 *   3. `requireRestartEligible: 'after-hit'` + !eligible      → onIneligibleHit?(ctx, hit); return false
 *   4. otherwise                                              → onHit(ctx, hit); short-circuit per flag
 *
 * Return value is `boolean` — true means "halt the remaining detectors for
 * this tick" (the caller's pipeline loop reads this). When `shortCircuit`
 * is false the runner always returns false regardless of onHit's return.
 *
 * Config:
 *   - name                     string — detector key in DETECTORS (for meta)
 *   - detector                 { detect(ctx) → hit } — the detector module
 *   - requireRestartEligible   true | false | 'after-hit' (default: false)
 *   - shortCircuit             boolean (default: false)
 *   - onHit(ctx, hit)          required; return truthy to short-circuit
 *   - onMiss(ctx, hit)         optional; receives the full hit object (some
 *                              detectors return {hit:false, reset:true})
 *   - onIneligibleHit(ctx,hit) optional; only consulted when requireRestartEligible === 'after-hit'
 */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function bail(msg) {
  throw new TypeError(`createDetectorRunner: ${msg}`);
}

function assertConfig(cfg) {
  if (!isPlainObject(cfg)) bail('config object required');
  if (!cfg.name) bail('missing "name"');
  if (!cfg.detector || typeof cfg.detector.detect !== 'function') {
    bail('"detector" must have a detect(ctx) function');
  }
  if (typeof cfg.onHit !== 'function') bail('"onHit" must be a function');
  assertOptionalCallbacks(cfg);
  assertEligibilityMode(cfg);
}

function assertOptionalCallbacks(cfg) {
  const optionalFns = ['onMiss', 'onIneligibleHit'];
  for (const k of optionalFns) {
    if (cfg[k] !== undefined && typeof cfg[k] !== 'function') {
      bail(`"${k}" must be a function when provided`);
    }
  }
}

function assertEligibilityMode(cfg) {
  if (cfg.requireRestartEligible === undefined) return;
  const allowed = [true, false, 'after-hit'];
  if (!allowed.includes(cfg.requireRestartEligible)) {
    bail('"requireRestartEligible" must be true, false, or "after-hit"');
  }
}

function runMissPath(cfg, ctx, hit) {
  if (typeof cfg.onMiss === 'function') cfg.onMiss(ctx, hit);
  return false;
}

function runIneligibleHitPath(cfg, ctx, hit) {
  if (typeof cfg.onIneligibleHit === 'function') cfg.onIneligibleHit(ctx, hit);
  return false;
}

function runHitPath(cfg, ctx, hit) {
  const result = cfg.onHit(ctx, hit);
  return cfg.shortCircuit ? Boolean(result) : false;
}

function createDetectorRunner(cfg) {
  assertConfig(cfg);
  const mode = cfg.requireRestartEligible || false;

  function detectorRunner(ctx, isEligible) {
    if (mode === true && !isEligible) return false;
    const hit = cfg.detector.detect(ctx);
    if (!hit || !hit.hit) return runMissPath(cfg, ctx, hit || { hit: false });
    if (mode === 'after-hit' && !isEligible) return runIneligibleHitPath(cfg, ctx, hit);
    return runHitPath(cfg, ctx, hit);
  }

  detectorRunner.__factoryMeta = {
    kind: 'detector-runner',
    name: cfg.name,
    shortCircuit: Boolean(cfg.shortCircuit),
    requireRestartEligible: mode,
  };
  return detectorRunner;
}

module.exports = { createDetectorRunner };
