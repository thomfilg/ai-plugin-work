/**
 * cli.js
 *
 * CLI entry-point logic for work.workflow.js — parses argv, dispatches
 * to the appropriate command (plan/transition/transitions/graph/actions),
 * and prints JSON output.
 *
 * All runtime side effects (inspect, generatePlan, transitionStep, etc.)
 * are injected via `deps` for testability and to avoid circular imports.
 */

const { stampVersionAnchor } = require('../lib/version-skew');

/**
 * Minimal fresh defer-state for the plan path when no work state exists yet
 * (GH-154). Extracted from the former inline `minimalState` literal so the
 * shape is directly assertable; carries the version anchor from birth (GH-768).
 */
function buildMinimalPlanState({ ALL_STEPS, safeName, timestamp, deferredSteps }) {
  const ws = {
    ticketId: safeName,
    description: '',
    currentStep: 1,
    status: 'in_progress',
    stepStatus: {},
    checkProgress: {},
    errors: [],
    startTime: new Date().toISOString(),
    lastPlanTimestamp: timestamp,
    deferredSteps,
  };
  ALL_STEPS.forEach((s) => {
    ws.stepStatus[s] = 'pending';
  });
  stampVersionAnchor(ws);
  return ws;
}

/** Print an error payload as JSON and exit 1. */
function printErrorExit(message, extra) {
  console.log(JSON.stringify({ error: true, message, ...extra }));
  process.exit(1);
}

/**
 * Parse a `<TICKET>[/suffix]` CLI arg into the sanitized path-safe ticket name
 * (shared by the transition/transitions/actions commands). Exits 1 on parse error.
 */
function parseSafeTicketArg(deps, input, providerCfg) {
  const { parseTicketInput, tp } = deps;
  let parsed;
  try {
    parsed = parseTicketInput(input);
  } catch (e) {
    printErrorExit(e.message);
  }
  const base = String(parsed.ticketBase).toUpperCase();
  return tp.sanitizeTicketIdForPath(base, providerCfg) + (parsed.suffix ? '/' + parsed.suffix : '');
}

/** Parse plan args: `--rework` flag, raw ticket input, and optional suffix. */
function parsePlanInput(parseTicketInput, rest) {
  const rework = rest.includes('--rework');
  let raw = rest
    .filter((a) => a !== '--rework')
    .join(' ')
    .trim();
  if (!raw) {
    printErrorExit('Provide ticket ID or description');
  }
  let suffix = null;
  try {
    const parsed = parseTicketInput(raw);
    raw = parsed.ticketBase;
    suffix = parsed.suffix;
  } catch (err) {
    printErrorExit(err.message);
  }
  return { raw, suffix, rework };
}

/**
 * Resolve the provider config: rewrite GitHub issue URLs to `#N`, and infer a
 * default GitHub provider when a bare `#N` arrives with no configured provider.
 */
function resolveProviderConfig(tp, rawInput) {
  let raw = rawInput;
  let providerConfig = tp.getProviderConfig({ skipPrompt: true });
  const isGitHub = providerConfig?.provider === 'github';

  let ghUrlMeta = null;
  const ghParsed = tp.parseGitHubUrl(raw);
  if (ghParsed && (isGitHub || !providerConfig)) {
    ghUrlMeta = ghParsed;
    raw = '#' + ghParsed.number;
  }
  if (/^#\d+$/.test(raw) && !isGitHub && !providerConfig) {
    providerConfig = { provider: 'github', projectKey: '' };
  }
  return { raw, providerConfig, ghUrlMeta };
}

/**
 * Classify the normalized input as a ticket ID (Jira key, `#N` GitHub issue)
 * or free-text description (ticket: null).
 */
function classifyTicket(raw, isGitHubEffective) {
  const isJiraTicket = /^[A-Z]+-\d+$/i.test(raw);
  const isGitHubIssue = /^#?\d+$/.test(raw) && isGitHubEffective;
  const isGitHubPrefixed = /^GH-\d+$/i.test(raw) && isGitHubEffective;
  const isTicket = isJiraTicket || isGitHubIssue || isGitHubPrefixed;
  let ticket = isTicket ? raw.toUpperCase() : null;
  if (isGitHubIssue || isGitHubPrefixed) {
    const num = raw.replace(/^#|^GH-/i, '');
    ticket = '#' + num;
  }
  return { ticket, isTicket };
}

/**
 * Resolve the provider config and normalize the raw input into a ticket ID
 * (Jira key, `#N` GitHub issue, or null for free-text descriptions).
 */
function resolveProviderAndTicket(tp, rawInput) {
  const { raw, providerConfig, ghUrlMeta } = resolveProviderConfig(tp, rawInput);
  const isGitHubEffective = providerConfig?.provider === 'github';
  const { ticket, isTicket } = classifyTicket(raw, isGitHubEffective);
  if (ghUrlMeta && isGitHubEffective) {
    providerConfig.owner = ghUrlMeta.owner;
    providerConfig.repo = ghUrlMeta.repo;
  }
  return { raw, providerConfig, ghUrlMeta, ticket, isTicket };
}

/** Persist DEFER metadata into work state for transition guard (GH-154). */
function persistDeferMetadata(deps, { ticket, suffix, providerConfig, result }) {
  const { tp, loadWorkState, saveWorkState, appendAction, ALL_STEPS, STEPS } = deps;
  if (!ticket) return;
  const safeBase = tp.sanitizeTicketIdForPath(ticket, providerConfig);
  const safeName = suffix ? safeBase + '/' + suffix : safeBase;
  const deferSteps = result.plan.filter((s) => s.action === 'DEFER').map((s) => s.step);
  const planState = loadWorkState(safeName);
  if (planState) {
    planState.lastPlanTimestamp = result.timestamp;
    planState.deferredSteps = deferSteps;
    saveWorkState(safeName, planState);
  } else if (deferSteps.length > 0) {
    const minimalState = buildMinimalPlanState({
      ALL_STEPS,
      safeName,
      timestamp: result.timestamp,
      deferredSteps: deferSteps,
    });
    saveWorkState(safeName, minimalState);
    appendAction(safeName, { step: STEPS.ticket, what: 'workflow started' });
  }
}

/** Compact state view attached to the plan output when inspect() ran. */
function buildPlanStateView(state) {
  return {
    worktreeExists: state.worktreeExists,
    branch: state.branch,
    headSha: state.headSha?.substring(0, 8) || null,
    hasDiffVsMain: state.hasDiffVsMain,
    diffSummary: state.diffSummary,
    lastCommitMsg: state.lastCommitMsg,
    hasUncommitted: state.hasUncommitted,
    uncommittedCount: state.uncommittedCount,
    hasUnpushed: state.hasUnpushed,
    pr: state.pr ? { number: state.pr.number, isDraft: state.pr.isDraft } : null,
    reports: state.reports,
    allReportsPass: state.allReportsPass,
    missingReports: state.missingReports,
    failedReports: state.failedReports,
    prEverUpdated: state.prEverUpdated,
    prShaMatch: state.prShaMatch,
    hasDevSession: state.hasDevSession,
    workStateStatus: state.workState?.status || null,
  };
}

/** Attach aggregate action counts over the generated plan. */
function attachPlanSummary(result) {
  const by = (a) => result.plan.filter((s) => s.action === a);
  result.summary = {
    total: result.plan.length,
    run: by('RUN').length,
    defer: by('DEFER').length,
    pending: by('PENDING').length,
    firstAction: by('RUN')[0]?.step || by('DEFER')[0]?.step || 'none',
    stepsToRun: by('RUN').map((s) => s.step),
    stepsDeferred: by('DEFER').map((s) => s.step),
  };
}

function runPlanCommand(deps, rest) {
  const { parseTicketInput, inspect, generatePlan, tp, STEP_TRANSITIONS } = deps;
  const { raw: parsedRaw, suffix, rework } = parsePlanInput(parseTicketInput, rest);
  const { raw, providerConfig, ghUrlMeta, ticket, isTicket } = resolveProviderAndTicket(
    tp,
    parsedRaw
  );
  const state = ticket ? inspect(ticket, providerConfig, suffix) : null;
  let result;
  try {
    result = generatePlan(ticket, isTicket ? null : raw, state, rework, providerConfig, suffix);
  } catch (err) {
    printErrorExit(err?.message || String(err));
  }

  result.timestamp = new Date().toISOString();
  persistDeferMetadata(deps, { ticket, suffix, providerConfig, result });

  if (ghUrlMeta && providerConfig) {
    result.ticketUrl = tp.ticketUrl(ticket, providerConfig);
  }
  if (state) {
    result.currentStep = state.currentStep;
    result.allowedTransitions = STEP_TRANSITIONS[state.currentStep] || [];
    result.state = buildPlanStateView(state);
  }
  attachPlanSummary(result);
  console.log(JSON.stringify(result, null, 2));
}

function runTransitionCommand(deps, rest) {
  const { tp, transitionStep, ALL_STEPS } = deps;
  if (rest.length < 2) {
    printErrorExit('Usage: transition <TICKET> <step>', { validSteps: ALL_STEPS });
  }
  const transProviderCfg = tp.getProviderConfig({ skipPrompt: true });
  const safeTransTicket = parseSafeTicketArg(deps, rest[0], transProviderCfg);
  console.log(JSON.stringify(transitionStep(safeTransTicket, rest[1]), null, 2));
}

function runTransitionsCommand(deps, rest) {
  const { tp, getAvailableTransitions } = deps;
  if (!rest[0]) {
    printErrorExit('Usage: transitions <TICKET>');
  }
  const transitionsProviderCfg = tp.getProviderConfig({ skipPrompt: true });
  const safeTransitionsTicket = parseSafeTicketArg(deps, rest[0], transitionsProviderCfg);
  console.log(JSON.stringify(getAvailableTransitions(safeTransitionsTicket), null, 2));
}

function runActionsCommand(deps, rest) {
  const { tp, loadActions, analyzeActions } = deps;
  if (!rest[0]) {
    printErrorExit('Usage: actions <TICKET> [--raw]');
  }
  const actionsProviderCfg = tp.getProviderConfig({ skipPrompt: true });
  const ticket = parseSafeTicketArg(deps, rest[0], actionsProviderCfg);
  const raw = rest.includes('--raw');
  const actions = loadActions(ticket);
  if (raw) {
    console.log(JSON.stringify({ ticket, actions }, null, 2));
  } else {
    const analysis = analyzeActions(actions);
    console.log(JSON.stringify({ ticket, analysis, actions }, null, 2));
  }
}

function main(deps) {
  const { requirePaths, ALL_STEPS, STEP_TRANSITIONS } = deps;

  const args = process.argv.slice(2);
  if (args.length === 0) {
    printErrorExit('Usage: work-orchestrator.js [plan|transition|transitions|graph] <args>');
  }

  const subcommands = ['plan', 'transition', 'transitions', 'graph', 'actions'];
  const command = subcommands.includes(args[0]) ? args[0] : 'plan';
  const rest = subcommands.includes(args[0]) ? args.slice(1) : args;

  switch (command) {
    case 'plan': {
      requirePaths();
      runPlanCommand(deps, rest);
      break;
    }
    case 'transition': {
      requirePaths();
      runTransitionCommand(deps, rest);
      break;
    }
    case 'transitions': {
      requirePaths();
      runTransitionsCommand(deps, rest);
      break;
    }
    case 'graph': {
      console.log(JSON.stringify({ steps: ALL_STEPS, transitions: STEP_TRANSITIONS }, null, 2));
      break;
    }
    case 'actions': {
      requirePaths();
      runActionsCommand(deps, rest);
      break;
    }
  }
}

module.exports = { main, buildMinimalPlanState };
