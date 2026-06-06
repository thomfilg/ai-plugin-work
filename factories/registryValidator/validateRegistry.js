'use strict';

/**
 * validateRegistry — completeness checks for the step registry tuple
 * `{ STEPS, STEP_ORDER, STEP_TRANSITIONS, STEP_PIPELINE }`. Returns
 * `{ valid: bool, errors: string[] }`. Designed to consume the shape that
 * `plugins/work/scripts/workflows/work/step-registry.js` actually exports
 * (`STEP_TRANSITIONS` is the merged forward+retry graph; `RETRY_EDGES` is
 * an internal const and is NOT exported).
 *
 * Checks:
 *   R1. Every `STEPS.x` value appears in `STEP_ORDER` (and vice versa).
 *   R2. Every `STEP_TRANSITIONS` key is a known step id.
 *   R3. Every transition target is a known step id, and is either:
 *         - the linear forward edge (next step in STEP_ORDER), or
 *         - a backward edge (target index < source index), or
 *         - the terminal self-loop (source === target on the last step).
 *       Forward-skip edges and forward-jump edges are rejected.
 *   R4. Every entry in `STEP_PIPELINE` is a function.
 *   R5. When entries carry `__factoryMeta`, their `id` is in `STEPS` and
 *       their `retryTo` (if set) appears as a backward transition target
 *       of that id in `STEP_TRANSITIONS`.
 *   R6. No duplicates in `STEP_ORDER`.
 *
 * Hand-written steps (no `__factoryMeta`) are permitted — they pass R4 and
 * are exempt from R5.
 */

function isFn(v) {
  return typeof v === 'function';
}

function checkOrderMatchesIds(STEPS, STEP_ORDER, errors) {
  const idSet = new Set(Object.values(STEPS));
  const orderSet = new Set(STEP_ORDER);
  for (const id of idSet) {
    if (!orderSet.has(id)) errors.push(`R1: STEPS has "${id}" but STEP_ORDER does not`);
  }
  for (const id of STEP_ORDER) {
    if (!idSet.has(id)) errors.push(`R1: STEP_ORDER has "${id}" but STEPS does not`);
  }
}

function checkNoDuplicates(STEP_ORDER, errors) {
  const seen = new Set();
  for (const id of STEP_ORDER) {
    if (seen.has(id)) errors.push(`R6: duplicate step "${id}" in STEP_ORDER`);
    seen.add(id);
  }
}

function buildOrderIndex(STEP_ORDER) {
  return new Map(STEP_ORDER.map((s, i) => [s, i]));
}

function classifyEdge(srcIdx, tgtIdx, orderLen) {
  if (srcIdx === tgtIdx && srcIdx === orderLen - 1) return 'terminal-self';
  if (tgtIdx === srcIdx + 1) return 'forward-linear';
  if (tgtIdx < srcIdx) return 'backward';
  return 'illegal';
}

function checkTransitions(STEPS, STEP_ORDER, STEP_TRANSITIONS, errors) {
  const idSet = new Set(Object.values(STEPS));
  const indexOf = buildOrderIndex(STEP_ORDER);
  for (const [source, targets] of Object.entries(STEP_TRANSITIONS || {})) {
    if (!idSet.has(source)) {
      errors.push(`R2: STEP_TRANSITIONS key "${source}" is not in STEPS`);
      continue;
    }
    if (!Array.isArray(targets)) {
      errors.push(`R2: STEP_TRANSITIONS["${source}"] must be an array`);
      continue;
    }
    const srcIdx = indexOf.get(source);
    for (const tgt of targets) {
      if (!idSet.has(tgt)) {
        errors.push(`R3: STEP_TRANSITIONS["${source}"] → "${tgt}" not in STEPS`);
        continue;
      }
      const kind = classifyEdge(srcIdx, indexOf.get(tgt), STEP_ORDER.length);
      if (kind === 'illegal') {
        errors.push(
          `R3: STEP_TRANSITIONS["${source}"] → "${tgt}" is neither a linear-forward, backward, nor terminal-self edge`
        );
      }
    }
  }
}

function backwardTargetsOf(source, STEP_TRANSITIONS, STEP_ORDER) {
  const indexOf = buildOrderIndex(STEP_ORDER);
  const srcIdx = indexOf.get(source);
  const targets = (STEP_TRANSITIONS && STEP_TRANSITIONS[source]) || [];
  return targets.filter((t) => {
    const tgtIdx = indexOf.get(t);
    return Number.isInteger(tgtIdx) && tgtIdx < srcIdx;
  });
}

function checkPipelineMeta(meta, idx, idSet, STEP_TRANSITIONS, STEP_ORDER, errors) {
  if (!idSet.has(meta.id)) {
    errors.push(`R5: STEP_PIPELINE[${idx}].__factoryMeta.id "${meta.id}" is not in STEPS`);
    return;
  }
  if (!meta.retryTo) return;
  const backward = backwardTargetsOf(meta.id, STEP_TRANSITIONS, STEP_ORDER);
  if (!backward.includes(meta.retryTo)) {
    errors.push(
      `R5: STEP_PIPELINE[${idx}] declares retryTo="${meta.retryTo}" but STEP_TRANSITIONS["${meta.id}"] has no backward edge to it`
    );
  }
}

function checkPipeline(STEPS, STEP_PIPELINE, STEP_TRANSITIONS, STEP_ORDER, errors) {
  const idSet = new Set(Object.values(STEPS));
  if (!Array.isArray(STEP_PIPELINE)) {
    errors.push('R4: STEP_PIPELINE must be an array');
    return;
  }
  for (let i = 0; i < STEP_PIPELINE.length; i++) {
    const h = STEP_PIPELINE[i];
    if (!isFn(h)) {
      errors.push(`R4: STEP_PIPELINE[${i}] is not a function`);
      continue;
    }
    if (h.__factoryMeta) {
      checkPipelineMeta(h.__factoryMeta, i, idSet, STEP_TRANSITIONS, STEP_ORDER, errors);
    }
  }
}

function validateRegistry(registry) {
  const errors = [];
  if (!registry || typeof registry !== 'object') {
    return { valid: false, errors: ['registry object required'] };
  }
  const { STEPS, STEP_ORDER, STEP_TRANSITIONS, STEP_PIPELINE } = registry;
  if (!STEPS || typeof STEPS !== 'object') errors.push('R1: STEPS missing or not an object');
  if (!Array.isArray(STEP_ORDER)) errors.push('R1: STEP_ORDER must be an array');
  if (errors.length) return { valid: false, errors };

  checkOrderMatchesIds(STEPS, STEP_ORDER, errors);
  checkNoDuplicates(STEP_ORDER, errors);
  checkTransitions(STEPS, STEP_ORDER, STEP_TRANSITIONS || {}, errors);
  if (STEP_PIPELINE !== undefined) {
    checkPipeline(STEPS, STEP_PIPELINE, STEP_TRANSITIONS || {}, STEP_ORDER, errors);
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validateRegistry };
