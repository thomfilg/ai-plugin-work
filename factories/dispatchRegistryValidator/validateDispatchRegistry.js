'use strict';

/**
 * validateDispatchRegistry — completeness checks for an event-driven
 * dispatch registry: a tuple `{ handlers, dispatch, baseDispatch?,
 * handlerShape?, tagSet?, allowOrphans? }`. Returns
 * `{ valid: bool, errors: string[], warnings: string[] }`.
 *
 * The problem it solves: a typo like
 * `dispatch['implement'] = [..., 'commiStall']` (missing `t`) silently
 * never fires that handler. Nothing crashes — the handler just never
 * runs. This validator catches that at test time.
 *
 * Checks:
 *   R1. Every name in `baseDispatch` is a key in `handlers`.
 *   R2. Every name in any `dispatch[*]` list is a key in `handlers`.
 *   R3. No duplicate handler names within a single list.
 *   R4. (Optional) When `tagSet` is provided — a Set of known dispatch
 *       tags — every `dispatch` key is a member of `tagSet`. Catches
 *       phase/route/tag typos.
 *   R5. Each handler conforms to `handlerShape`: every field in
 *       `handlerShape.requiredFields` is present, and (when both `name`
 *       and `detect` are required) `name` matches the registry key and
 *       `detect` is a function.
 *
 * Warnings (non-fatal):
 *   W1. Handlers registered but never referenced by any dispatch list
 *       (orphan). Promoted to an error when `allowOrphans === false`.
 *
 * Backwards-compatible shape: `dispatch` and `baseDispatch` may be
 * either a flat `string[]` of handler names, or the legacy
 * `{ detectors: string[] }` shape that legacy phase registries use.
 */

const DEFAULT_HANDLER_SHAPE = {
  requiredFields: ['name', 'detect'],
  optionalFields: [],
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function asList(entry) {
  if (Array.isArray(entry)) return entry;
  if (entry && Array.isArray(entry.detectors)) return entry.detectors;
  return null;
}

function handlersForTag(baseDispatch, override) {
  const overrideList = asList(override);
  if (overrideList) return overrideList;
  return asList(baseDispatch) || [];
}

function checkBaseDispatch(baseDispatch, handlers, errors) {
  if (baseDispatch === undefined || baseDispatch === null) return;
  const list = asList(baseDispatch);
  if (list === null) {
    errors.push('R1: baseDispatch must be an array or { detectors: [...] }');
    return;
  }
  for (const name of list) {
    if (!(name in handlers)) errors.push(`R1: baseDispatch references unknown handler "${name}"`);
  }
}

function checkDispatchLists(dispatch, handlers, errors) {
  for (const [tag, entry] of Object.entries(dispatch)) {
    const list = asList(entry);
    if (list === null) continue;
    for (const name of list) {
      if (!(name in handlers))
        errors.push(`R2: dispatch["${tag}"] references unknown handler "${name}"`);
    }
  }
}

function checkNoDuplicates(baseDispatch, dispatch, errors) {
  const allLists = [];
  const baseList = asList(baseDispatch);
  if (baseList) allLists.push(['baseDispatch', baseList]);
  for (const [tag, entry] of Object.entries(dispatch)) {
    const list = asList(entry);
    if (list) allLists.push([tag, list]);
  }
  for (const [label, list] of allLists) {
    const seen = new Set();
    for (const name of list) {
      if (seen.has(name)) errors.push(`R3: duplicate handler "${name}" in ${label}`);
      seen.add(name);
    }
  }
}

function checkDispatchKeysAgainstTagSet(dispatch, tagSet, errors) {
  if (!tagSet) return;
  for (const tag of Object.keys(dispatch)) {
    if (!tagSet.has(tag)) {
      errors.push(`R4: dispatch key "${tag}" is not a known tag`);
    }
  }
}

function checkRequiredFields(key, mod, required, errors) {
  for (const field of required) {
    if (!(field in mod)) {
      errors.push(`R5: handlers["${key}"] is missing required field "${field}"`);
    }
  }
}

function checkDetectFunction(key, mod, required, errors) {
  if (!required.includes('detect')) return;
  if ('detect' in mod && typeof mod.detect !== 'function') {
    errors.push(`R5: handlers["${key}"].detect is not a function`);
  }
}

function checkNameMatchesKey(key, mod, required, errors) {
  if (!required.includes('name')) return;
  if (mod.name && mod.name !== key) {
    errors.push(`R5: handlers["${key}"].name === "${mod.name}" — key and exported name disagree`);
  }
}

function checkOneHandlerShape(key, mod, required, errors) {
  if (!mod || typeof mod !== 'object') {
    errors.push(`R5: handlers["${key}"] is not a module object`);
    return;
  }
  checkRequiredFields(key, mod, required, errors);
  checkDetectFunction(key, mod, required, errors);
  checkNameMatchesKey(key, mod, required, errors);
}

function checkHandlerShape(handlers, handlerShape, errors) {
  const required = handlerShape.requiredFields || [];
  for (const [key, mod] of Object.entries(handlers)) {
    checkOneHandlerShape(key, mod, required, errors);
  }
}

function collectReferencedHandlers(baseDispatch, dispatch) {
  const referenced = new Set(asList(baseDispatch) || []);
  for (const entry of Object.values(dispatch)) {
    const list = asList(entry);
    if (list) for (const name of list) referenced.add(name);
  }
  return referenced;
}

function collectOrphans(baseDispatch, dispatch, handlers, allowOrphans, errors, warnings) {
  const referenced = collectReferencedHandlers(baseDispatch, dispatch);
  for (const key of Object.keys(handlers)) {
    if (!referenced.has(key)) {
      const msg = `handler "${key}" is registered but never referenced by any dispatch list`;
      if (allowOrphans === false) errors.push(`R6: ${msg}`);
      else warnings.push(`W1: ${msg}`);
    }
  }
}

function validateDispatchRegistry(input) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(input)) {
    return { valid: false, errors: ['registry object required'], warnings };
  }
  const {
    handlers,
    dispatch,
    baseDispatch,
    handlerShape = DEFAULT_HANDLER_SHAPE,
    tagSet,
    allowOrphans = true,
  } = input;

  if (!isPlainObject(handlers)) errors.push('handlers must be an object');
  if (!isPlainObject(dispatch)) errors.push('dispatch must be an object');
  if (errors.length) return { valid: false, errors, warnings };

  checkBaseDispatch(baseDispatch, handlers, errors);
  checkDispatchLists(dispatch, handlers, errors);
  checkNoDuplicates(baseDispatch, dispatch, errors);
  checkDispatchKeysAgainstTagSet(dispatch, tagSet, errors);
  checkHandlerShape(handlers, handlerShape, errors);
  collectOrphans(baseDispatch, dispatch, handlers, allowOrphans, errors, warnings);

  return { valid: errors.length === 0, errors, warnings };
}

module.exports = { validateDispatchRegistry, handlersForTag };
