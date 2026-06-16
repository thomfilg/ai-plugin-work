'use strict';

/**
 * draft-test-strategy.js — GH-590 Task 11 validators split out of draft.js
 * to satisfy the static-quality gate (max-lines, cyclomatic-complexity,
 * cognitive-complexity). All public functions remain feature-flagged via
 * `WORK_TEST_STRATEGY_VALIDATOR` and tolerantly handle missing helper
 * modules so the legacy ### Test Command path keeps working.
 */

const config = require('../../../lib/config');

let strategyModule = null;
let dispatcherModule = null;
let ownershipModule = null;
let envrcModule = null;
try {
  strategyModule = require('../../../lib/test-strategy');
} catch {
  strategyModule = null;
}
try {
  dispatcherModule = require('../../../lib/command-existence-dispatcher');
} catch {
  dispatcherModule = null;
}
try {
  ownershipModule = require('../../../lib/tdd-ownership-graph');
} catch {
  ownershipModule = null;
}
try {
  envrcModule = require('../../../lib/envrc-resolver');
} catch {
  envrcModule = null;
}

let parseTasksLazy = null;
function _loadParseTasks() {
  if (parseTasksLazy !== null) return parseTasksLazy;
  try {
    parseTasksLazy = require('../../../work/lib/task-parser').parseTasks || null;
  } catch {
    parseTasksLazy = null;
  }
  return parseTasksLazy;
}

const STRATEGY_FLAG_KEY = 'WORK_TEST_STRATEGY_VALIDATOR';
const STRATEGY_FLAG_ON_VALUE = '1';

function strategyFlagOn() {
  const v = process.env[STRATEGY_FLAG_KEY] ?? config[STRATEGY_FLAG_KEY];
  return v === STRATEGY_FLAG_ON_VALUE;
}

function resolveWorkDir() {
  const explicit = process.env.WORK_DRAFT_WORKDIR;
  if (explicit && typeof explicit === 'string') return explicit;
  return process.cwd();
}

function _loadEnvrc(workDir) {
  if (!envrcModule || typeof envrcModule.findNearestEnvrc !== 'function') return null;
  try {
    return envrcModule.findNearestEnvrc(workDir);
  } catch {
    return null;
  }
}

function _loadPackageJson(workDir) {
  if (!envrcModule || typeof envrcModule.findNearestPackageJson !== 'function') return null;
  try {
    return envrcModule.findNearestPackageJson(workDir) || null;
  } catch {
    return null;
  }
}

function _loadParsedTasks(tasksDir) {
  const parseTasks = _loadParseTasks();
  if (!parseTasks) return null;
  try {
    return parseTasks(tasksDir);
  } catch {
    return null;
  }
}

function loadStrategyContext(tasksDir) {
  const workDir = resolveWorkDir();
  return {
    parsedTasks: _loadParsedTasks(tasksDir),
    envrc: _loadEnvrc(workDir),
    packageJson: _loadPackageJson(workDir),
    workDir,
  };
}

function taskHeadingFor(task) {
  if (!task) return '<unknown task>';
  if (task.title) return `Task ${task.num} — ${task.title}`;
  return `Task ${task.num}`;
}

/**
 * Walk fenced blocks inside the `### Test Strategy` section and return the
 * first non-empty body that does NOT look like a yaml `kind:` key block.
 */
function _closeFence(buf) {
  const content = buf.join('\n').trim();
  return content && !/^\s*kind\s*:/m.test(content) ? content : null;
}

function _firstNonKindFenceBody(strategyBody) {
  const state = { inFence: false, buf: [] };
  for (const raw of strategyBody.split('\n')) {
    if (/^\s*```/.test(raw)) {
      if (!state.inFence) {
        state.inFence = true;
        state.buf = [];
      } else {
        const closed = _closeFence(state.buf);
        if (closed) return closed;
        state.inFence = false;
        state.buf = [];
      }
      continue;
    }
    if (state.inFence) state.buf.push(raw);
  }
  return null;
}

function extractRawStrategyBody(rawContent) {
  if (typeof rawContent !== 'string' || !rawContent) return null;
  const m = rawContent.match(/(?:^|\n)###\s+Test Strategy[^\n]*\n([\s\S]*?)(?=\n###|\n## |$)/);
  if (!m) return null;
  return _firstNonKindFenceBody(m[1]);
}

function _resolveStrategy(task) {
  let strategy = task && task.testStrategy;
  if (strategy && typeof strategy === 'object') return strategy;
  const rawBody = task && task.rawContent ? extractRawStrategyBody(task.rawContent) : null;
  return rawBody ? { kind: 'custom', customBody: rawBody } : null;
}

function _appendPeerErrors(strategy, parsedTasks, task, errors) {
  if (typeof strategyModule.validatePeerCitation !== 'function') return;
  try {
    const peerErrors = strategyModule.validatePeerCitation(strategy, parsedTasks, task) || [];
    for (const e of peerErrors) errors.push(e);
  } catch {
    /* peer-citation helper unstable — keep going */
  }
}

function _appendShapeErrors(strategy, task, errors) {
  if (typeof strategyModule.validateStrategyShape !== 'function') return;
  try {
    const shapeErrors = strategyModule.validateStrategyShape(strategy, task) || [];
    for (const e of shapeErrors) errors.push(e);
  } catch {
    /* shape helper unstable — keep going */
  }
}

function _synthesize(strategy, envrc) {
  try {
    return strategyModule.synthesizeCommand(strategy, envrc);
  } catch {
    return null;
  }
}

function _dispatchAndAppend(command, dispatchCtx, heading, errors) {
  try {
    const result = dispatcherModule.dispatch(command, dispatchCtx);
    if (result && Array.isArray(result.errors)) {
      for (const e of result.errors) errors.push(e);
    }
  } catch (err) {
    errors.push(`${heading}: command-existence dispatcher failed: ${err && err.message}`);
  }
}

function _validateOneTask(task, ctx, errors) {
  const strategy = _resolveStrategy(task);
  if (!strategy) return;
  const heading = taskHeadingFor(task);
  _appendShapeErrors(strategy, task, errors);
  _appendPeerErrors(strategy, ctx.parsedTasks, task, errors);
  const command = _synthesize(strategy, ctx.envrc);
  if (!command) return;
  const dispatchCtx = {
    worktree: ctx.workDir,
    packageJson: ctx.packageJson,
    envrc: ctx.envrc,
    taskHeading: heading,
  };
  _dispatchAndAppend(command, dispatchCtx, heading, errors);
}

function _strategyValidatorReady() {
  return strategyFlagOn() && strategyModule && dispatcherModule;
}

function _normalizeStrategyCtx(ctx) {
  const safeCtx = ctx || {};
  return {
    parsedTasks: safeCtx.parsedTasks || null,
    envrc: safeCtx.envrc || null,
    packageJson: safeCtx.packageJson || null,
    workDir: safeCtx.workDir || resolveWorkDir(),
  };
}

function validateTestStrategy(_tasksDir, ctx) {
  const errors = [];
  if (!_strategyValidatorReady()) return errors;
  const fullCtx = _normalizeStrategyCtx(ctx);
  if (!Array.isArray(fullCtx.parsedTasks)) return errors;
  for (const task of fullCtx.parsedTasks) {
    _validateOneTask(task, fullCtx, errors);
  }
  return errors;
}

function _entryCoversOrphan(entry, orphanPath) {
  if (entry === orphanPath) return true;
  const stripped = entry.replace(/\.(?:test|spec)(\.[a-zA-Z0-9]+)$/, '$1');
  if (stripped === orphanPath) return true;
  const noTestsDir = stripped.replace(/(^|\/)__tests__\//, '$1');
  return noTestsDir === orphanPath;
}

function _isRealOrphan(orphan, parsedTasks) {
  if (!orphan || !orphan.path) return false;
  for (const t of parsedTasks) {
    const strat = t && t.testStrategy;
    const entry = strat && typeof strat === 'object' ? strat.entry : null;
    if (typeof entry === 'string' && entry && _entryCoversOrphan(entry, orphan.path)) {
      return false;
    }
  }
  return true;
}

function _safeBuildGraph(parsedTasks) {
  try {
    return ownershipModule.buildCoverageGraph(parsedTasks);
  } catch {
    return null;
  }
}

function _safeFindOrphans(parsedTasks, graph) {
  try {
    return ownershipModule.findOrphanedPaths(parsedTasks, graph) || [];
  } catch {
    return null;
  }
}

function _formatOrphanError(orphan) {
  const heading = `Task ${orphan.owner}`;
  const remediation = Array.isArray(orphan.remediation)
    ? orphan.remediation.map((r) => `  - ${r}`).join('\n')
    : '';
  return `${heading}: \`${orphan.path}\` is owned by ${heading} but no task's Test Strategy entry transitively touches it. Remediation options:\n${remediation}`;
}

function _ownershipReady() {
  return strategyFlagOn() && ownershipModule;
}

function _collectOrphans(parsedTasks) {
  const graph = _safeBuildGraph(parsedTasks);
  if (!graph) return null;
  return _safeFindOrphans(parsedTasks, graph);
}

function validateTddOwnership(_tasksDir, ctx) {
  const errors = [];
  if (!_ownershipReady()) return errors;
  const parsedTasks = (ctx && ctx.parsedTasks) || null;
  if (!Array.isArray(parsedTasks) || parsedTasks.length === 0) return errors;
  const orphans = _collectOrphans(parsedTasks);
  if (!orphans) return errors;
  for (const orphan of orphans) {
    if (_isRealOrphan(orphan, parsedTasks)) errors.push(_formatOrphanError(orphan));
  }
  return errors;
}

function runStrategyValidators(tasksDir) {
  if (!strategyFlagOn()) return [];
  const ctx = loadStrategyContext(tasksDir);
  return [...validateTestStrategy(tasksDir, ctx), ...validateTddOwnership(tasksDir, ctx)];
}

module.exports = {
  validateTestStrategy,
  validateTddOwnership,
  runStrategyValidators,
  loadStrategyContext,
  extractRawStrategyBody,
  strategyFlagOn,
  resolveWorkDir,
  taskHeadingFor,
  STRATEGY_FLAG_KEY,
  STRATEGY_FLAG_ON_VALUE,
};
