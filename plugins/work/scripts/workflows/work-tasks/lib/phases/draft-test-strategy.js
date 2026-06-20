'use strict';

// GH-590 Task 11 — strategy + ownership validators, feature-flagged.

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

function resolveWorkDir(override) {
  // Precedence: explicit override from the orchestrator (ctx.worktreeRoot) →
  // env-var test seam → process.cwd() last-resort fallback. Caller passes the
  // override to avoid resolving package.json / .envrc against the wrong tree
  // when /work-tasks runs from a cwd that isn't the ticket worktree.
  if (override && typeof override === 'string') return override;
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

function loadStrategyContext(tasksDir, workDirOverride) {
  const workDir = resolveWorkDir(workDirOverride);
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

function _headingFor(task) {
  return taskHeadingFor(task);
}

function _appendPeerErrors(strategy, parsedTasks, task, errors) {
  if (typeof strategyModule.validatePeerCitation !== 'function') return;
  try {
    const peerErrors = strategyModule.validatePeerCitation(strategy, parsedTasks, task) || [];
    for (const e of peerErrors) errors.push(e);
  } catch (err) {
    // Don't swallow — surface a hard error so a malformed task can't slip
    // past the gate when validatePeerCitation throws on it.
    errors.push(
      `${_headingFor(task)}: peer-citation validator threw — ${err && err.message ? err.message : 'unknown error'}`
    );
  }
}

function _appendShapeErrors(strategy, task, errors) {
  if (typeof strategyModule.validateStrategyShape !== 'function') return;
  try {
    const shapeErrors = strategyModule.validateStrategyShape(strategy, task) || [];
    for (const e of shapeErrors) errors.push(e);
  } catch (err) {
    errors.push(
      `${_headingFor(task)}: shape validator threw — ${err && err.message ? err.message : 'unknown error'}`
    );
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

const { hasLegacyTestCommand: _hasLegacyTestCommand } = require('./_legacy-test-command');

function _validateOneTask(task, ctx, errors) {
  const strategy = _resolveStrategy(task);
  if (!strategy) {
    if (_hasLegacyTestCommand(task)) {
      errors.push(
        `${taskHeadingFor(task)}: flag on but task still uses legacy \`### Test Command\`. Convert to \`### Test Strategy\` (kind: unit|integration|e2e|custom|verified-by|wiring-citation). See skills/split-in-tasks/docs/test-strategy.md.`
      );
    }
    return;
  }
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

function _missingStrategyModules() {
  const missing = [];
  if (!strategyModule) missing.push('lib/test-strategy');
  if (!dispatcherModule) missing.push('lib/command-existence-dispatcher');
  return missing;
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
  // Flag off → silent pass (legacy ### Test Command path remains active).
  if (!strategyFlagOn()) return errors;
  // Flag on but helper modules failed to load → fail closed with a hard
  // error so the draft gate doesn't silently pass on a half-installed plugin.
  const missing = _missingStrategyModules();
  if (missing.length > 0) {
    errors.push(
      `Test Strategy validator could not load required helper module(s): ${missing.join(', ')}. ` +
        `With WORK_TEST_STRATEGY_VALIDATOR=1 every helper must be loadable.`
    );
    return errors;
  }
  const fullCtx = _normalizeStrategyCtx(ctx);
  if (!Array.isArray(fullCtx.parsedTasks)) {
    // Flag is ON but parseTasks returned null (parser missing or threw).
    // Don't silently pass — surface a hard error so the draft gate fails
    // visibly instead of giving a false green.
    errors.push(
      'Test Strategy validator could not parse tasks.md (task-parser unavailable or threw). ' +
        'With WORK_TEST_STRATEGY_VALIDATOR=1, every task must be parseable so its strategy can be validated.'
    );
    return errors;
  }
  for (const task of fullCtx.parsedTasks) {
    _validateOneTask(task, fullCtx, errors);
  }
  return errors;
}

// Delegate to the glob-aware reference check in lib/test-strategy.js so a
// test entry can cover an orphan declared via a glob like `lib/**/*.ts`
// — string equality alone would miss this.
function _entryCoversOrphan(entry, orphanPath) {
  try {
    const { entryReferencesScope } = require('../../../lib/test-strategy');
    if (typeof entryReferencesScope === 'function') {
      return entryReferencesScope(entry, [orphanPath]);
    }
  } catch {
    /* fall through to local check */
  }
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
    return { graph: ownershipModule.buildCoverageGraph(parsedTasks), error: null };
  } catch (err) {
    return { graph: null, error: err && err.message ? err.message : 'unknown error' };
  }
}

function _safeFindOrphans(parsedTasks, graph) {
  try {
    return { orphans: ownershipModule.findOrphanedPaths(parsedTasks, graph) || [], error: null };
  } catch (err) {
    return { orphans: null, error: err && err.message ? err.message : 'unknown error' };
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

function _ownershipModuleMissing() {
  return strategyFlagOn() && !ownershipModule;
}

function _collectOrphans(parsedTasks) {
  const buildResult = _safeBuildGraph(parsedTasks);
  if (buildResult.error)
    return { orphans: null, error: `coverage graph build failed: ${buildResult.error}` };
  if (!buildResult.graph) return { orphans: null, error: 'coverage graph builder returned null' };
  return _safeFindOrphans(parsedTasks, buildResult.graph);
}

function _ownershipPreflight(errors) {
  if (!strategyFlagOn()) return false;
  if (_ownershipModuleMissing()) {
    errors.push(
      'TDD-ownership validator could not load required helper module: lib/tdd-ownership-graph. ' +
        'With WORK_TEST_STRATEGY_VALIDATOR=1 every helper must be loadable.'
    );
    return false;
  }
  return true;
}

function validateTddOwnership(_tasksDir, ctx) {
  const errors = [];
  if (!_ownershipPreflight(errors)) return errors;
  const parsedTasks = (ctx && ctx.parsedTasks) || null;
  if (!Array.isArray(parsedTasks) || parsedTasks.length === 0) return errors;
  const { orphans, error: collectError } = _collectOrphans(parsedTasks);
  if (collectError) {
    // Fail closed — graph build / orphan detection failure must not silently
    // bypass the gate. Surface a hard error so reviewers see what broke.
    errors.push(
      `TDD-ownership graph validator failed — ${collectError}. With WORK_TEST_STRATEGY_VALIDATOR=1 every task's coverage must be derivable.`
    );
    return errors;
  }
  if (!orphans) return errors;
  for (const orphan of orphans) {
    if (_isRealOrphan(orphan, parsedTasks)) errors.push(_formatOrphanError(orphan));
  }
  return errors;
}

function runStrategyValidators(tasksDir, workDirOverride) {
  if (!strategyFlagOn()) return [];
  const ctx = loadStrategyContext(tasksDir, workDirOverride);
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
