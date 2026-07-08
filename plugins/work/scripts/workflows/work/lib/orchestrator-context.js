'use strict';

/**
 * orchestrator-context.js — shared DI wiring for the /work orchestrators.
 *
 * Both `work-next.js` (script-driven auto-advance) and
 * `engine/work.workflow.js` (workflow-router entry) need the same set of
 * thin wrappers that inject TASKS_BASE / STEPS / ALL_STEPS into the
 * extracted engine modules (inspect, plan-generator, transition-step, …).
 * Previously each file carried its own verbatim copy of these wrappers;
 * this factory is the single home for them.
 *
 * Callers provide the runtime configuration (paths, ticket provider,
 * action logger, report matchers) and receive the fully-wired helper set.
 */

const path = require('path');

function loadEngineModules(workDir) {
  return {
    stepRegistry: require(path.join(workDir, 'step-registry')),
    workHelpers: require(path.join(workDir, 'lib', 'work-helpers')),
    taskParser: require(path.join(workDir, 'lib', 'task-parser')),
    artifactArchival: require(path.join(workDir, 'lib', 'artifact-archival')),
    gitUtils: require(path.join(workDir, 'lib', 'git-utils')),
    tdd: require(path.join(workDir, 'lib', 'tdd-enforcement')),
    inspectMod: require(path.join(workDir, 'engine', 'inspect')),
    planGeneratorMod: require(path.join(workDir, 'engine', 'plan-generator')),
    transitionMod: require(path.join(workDir, 'engine', 'transition-step')),
    checkGateMod: require(path.join(workDir, 'gates', 'check-gate')),
  };
}

/** Thin state wrappers: inject TASKS_BASE / STEPS / ALL_STEPS. */
function makeStateHelpers(cfg) {
  const { helpers, TASKS_BASE, STEPS, ALL_STEPS, tdd, checkGateMod } = cfg;
  return {
    loadWorkState: (ticket) => helpers.loadWorkState(TASKS_BASE, ticket),
    saveWorkState: (ticket, state) => helpers.saveWorkState(TASKS_BASE, ticket, state),
    getCurrentStep: (workState) => helpers.getCurrentStep(workState, STEPS, ALL_STEPS),
    readTddEvidence: (ticketId, stepId, taskNum) =>
      tdd.readTddEvidence(TASKS_BASE, ticketId, stepId, taskNum),
    validateCheckGate: (ticket) => checkGateMod.validateCheckGate(TASKS_BASE, ticket),
  };
}

function makeInspect(cfg) {
  const { modules, stateHelpers, io, tp, REQUIRED_REPORTS, paths } = cfg;
  return (ticket, providerConfig, suffix) =>
    modules.inspectMod.inspect(ticket, providerConfig, suffix, {
      tp,
      run: io.run,
      fileExists: io.fileExists,
      readFile: io.readFile,
      listFiles: io.listFiles,
      loadWorkState: stateHelpers.loadWorkState,
      getCurrentStep: stateHelpers.getCurrentStep,
      REQUIRED_REPORTS,
      WORKTREES_BASE: paths.WORKTREES_BASE,
      TASKS_BASE: paths.TASKS_BASE,
      MAIN_WORKTREE_FOLDER: paths.MAIN_WORKTREE_FOLDER,
    });
}

function makeGeneratePlan(cfg) {
  const { modules, io, tp, STEPS, TDD_GATED_STEPS, paths } = cfg;
  return (ticket, description, s, rework, callerProviderCfg, suffix) =>
    modules.planGeneratorMod.generatePlan(
      ticket,
      description,
      s,
      rework,
      callerProviderCfg,
      suffix,
      {
        tp,
        TDD_PROTOCOL: modules.tdd.TDD_PROTOCOL,
        TDD_GATED_STEPS,
        STEPS,
        parseTasks: modules.taskParser.parseTasks,
        buildTaskPrompt: modules.taskParser.buildTaskPrompt,
        fileExists: io.fileExists,
        run: io.run,
        WORKTREES_BASE: paths.WORKTREES_BASE,
        TASKS_BASE: paths.TASKS_BASE,
        MAIN_WORKTREE_FOLDER: paths.MAIN_WORKTREE_FOLDER,
      }
    );
}

/**
 * Lazy-init workflow definition (GH-260) — cached after the first call to
 * avoid re-creating on every transition.
 */
function makeWorkflowDefinitionGetter(cfg) {
  const { workDir, tp, TASKS_BASE, gitUtils } = cfg;
  let workflowDef = null;
  return function getWorkflowDefinition() {
    if (!workflowDef) {
      const createWorkflowDefinition = require(path.join(workDir, 'workflow-definition'));
      // Compute providerConfig once (avoids repeated execSync/file reads)
      const providerConfig = tp.getProviderConfig({ skipPrompt: true });
      workflowDef = createWorkflowDefinition({
        TASKS_BASE,
        safeTicketPath: (id) => tp.sanitizeTicketIdForPath(id, providerConfig),
        resolveGitHead: () => gitUtils.resolveGitHead(),
      });
    }
    return workflowDef;
  };
}

function makeTransitionHelpers(cfg) {
  const { modules, stateHelpers, registry, tp, appendAction, TASKS_BASE, TDD_GATED_STEPS } = cfg;
  const getWorkflowDefinition = makeWorkflowDefinitionGetter(cfg);
  function buildTransitionDeps() {
    const { workflow } = getWorkflowDefinition();
    return {
      tp,
      STEPS: registry.STEPS,
      ALL_STEPS: registry.ALL_STEPS,
      STEP_TRANSITIONS: registry.STEP_TRANSITIONS,
      workflowCanTransition: registry.workflowCanTransition,
      TDD_GATED_STEPS,
      readTddEvidence: stateHelpers.readTddEvidence,
      validateTddEvidence: modules.tdd.validateTddEvidence,
      validateCheckGate: stateHelpers.validateCheckGate,
      archiveStepArtifacts: modules.artifactArchival.archiveStepArtifacts,
      appendAction,
      loadWorkState: stateHelpers.loadWorkState,
      saveWorkState: stateHelpers.saveWorkState,
      getCurrentStep: stateHelpers.getCurrentStep,
      TASKS_BASE,
      // GH-260: generic step-verify gate — always uses real verify functions.
      softSteps: workflow.softSteps,
      commandMap: workflow.commandMap,
      // GH-299: check-drift gate dep
      getHeadSha: modules.gitUtils.getHeadSha,
    };
  }
  return {
    getWorkflowDefinition,
    buildTransitionDeps,
    transitionStep: (ticket, targetStep) =>
      modules.transitionMod.transitionStep(ticket, targetStep, buildTransitionDeps()),
    getAvailableTransitions: (ticket) =>
      modules.transitionMod.getAvailableTransitions(ticket, buildTransitionDeps()),
  };
}

/**
 * Build the orchestrator helper set.
 *
 * @param {object} opts
 * @param {string} opts.workDir - workflows/work directory (module root)
 * @param {object} opts.tp - ticket provider module
 * @param {Function} opts.appendAction - action logger
 * @param {string} opts.TASKS_BASE
 * @param {string} opts.WORKTREES_BASE
 * @param {string} opts.MAIN_WORKTREE_FOLDER
 * @param {Array}  opts.REQUIRED_REPORTS - check-report matchers for inspect()
 */
function createOrchestratorContext(opts) {
  const { workDir, tp, appendAction, REQUIRED_REPORTS } = opts;
  const { TASKS_BASE, WORKTREES_BASE, MAIN_WORKTREE_FOLDER } = opts;
  const modules = loadEngineModules(workDir);
  const registry = modules.stepRegistry;
  const { STEPS, ALL_STEPS } = registry;
  const { run, fileExists, readFile, listFiles, ...helpers } = modules.workHelpers;
  const io = { run, fileExists, readFile, listFiles };
  const paths = { TASKS_BASE, WORKTREES_BASE, MAIN_WORKTREE_FOLDER };
  const TDD_GATED_STEPS = [STEPS.implement];
  const stateHelpers = makeStateHelpers({
    helpers,
    TASKS_BASE,
    STEPS,
    ALL_STEPS,
    tdd: modules.tdd,
    checkGateMod: modules.checkGateMod,
  });
  const transitionHelpers = makeTransitionHelpers({
    modules,
    stateHelpers,
    registry,
    tp,
    appendAction,
    TASKS_BASE,
    TDD_GATED_STEPS,
    workDir,
    gitUtils: modules.gitUtils,
  });
  return {
    STEPS,
    STEP_TRANSITIONS: registry.STEP_TRANSITIONS,
    ALL_STEPS,
    workflowCanTransition: registry.workflowCanTransition,
    run,
    fileExists,
    readFile,
    listFiles,
    TDD_GATED_STEPS,
    TDD_PROTOCOL: modules.tdd.TDD_PROTOCOL,
    validateTddEvidence: modules.tdd.validateTddEvidence,
    parseTasks: modules.taskParser.parseTasks,
    buildTaskPrompt: modules.taskParser.buildTaskPrompt,
    archiveStepArtifacts: modules.artifactArchival.archiveStepArtifacts,
    getHeadSha: modules.gitUtils.getHeadSha,
    ...stateHelpers,
    inspect: makeInspect({ modules, stateHelpers, io, tp, REQUIRED_REPORTS, paths }),
    generatePlan: makeGeneratePlan({ modules, io, tp, STEPS, TDD_GATED_STEPS, paths }),
    ...transitionHelpers,
  };
}

module.exports = { createOrchestratorContext };
