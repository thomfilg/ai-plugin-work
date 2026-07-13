/**
 * cli.js
 *
 * CLI entry-point logic for work.workflow.js — parses argv, dispatches
 * to the appropriate command (plan/transition/transitions/graph/actions/cancel),
 * and prints JSON output.
 *
 * All runtime side effects (inspect, generatePlan, transitionStep, etc.)
 * are injected via `deps` for testability and to avoid circular imports.
 * The `cancel` subcommand machinery lives in the sibling `cli-cancel.js` to keep
 * this entry-point module within the static quality budget.
 */

'use strict';

const path = require('path');

const { runCancel } = require(path.join(__dirname, 'cli-cancel'));

/**
 * Normalize a raw ticket base: resolve a GitHub URL to `#N` (recording the URL
 * metadata) and default the provider config to github for a bare `#N` when no
 * provider is configured. Returns the (possibly rewritten) raw string, the
 * (possibly defaulted) provider config, and the GitHub URL metadata (or null).
 * @param {string} raw
 * @param {object} providerConfig
 * @param {object} tp
 */
function normalizeRawTicket(raw, providerConfig, tp) {
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
 * Classify a normalized raw string against the provider config: is it a ticket
 * (Jira / GitHub issue / GH-prefixed) and, if so, its canonical id (`#N` for
 * GitHub, uppercased otherwise). isGitHubIssue/isGitHubPrefixed already fold in
 * the effective-provider check, so the id rewrite needs no re-test.
 * @param {string} raw
 * @param {object} providerConfig
 */
function classifyTicket(raw, providerConfig) {
  const isGitHubEffective = providerConfig?.provider === 'github';
  const isJiraTicket = /^[A-Z]+-\d+$/i.test(raw);
  const isGitHubIssue = /^#?\d+$/.test(raw) && isGitHubEffective;
  const isGitHubPrefixed = /^GH-\d+$/i.test(raw) && isGitHubEffective;
  const isTicket = isJiraTicket || isGitHubIssue || isGitHubPrefixed;
  let ticket = isTicket ? raw.toUpperCase() : null;
  if (isGitHubIssue || isGitHubPrefixed) {
    ticket = '#' + raw.replace(/^#|^GH-/i, '');
  }
  return { ticket, isTicket };
}

/**
 * Parse + normalize a raw plan argument into a resolved ticket + provider
 * config. May throw (via parseTicketInput) on a parse failure — the caller
 * reports + exits. Returns the resolved ticket (or null for a free-text
 * description), the effective provider config, GitHub URL metadata, whether the
 * input is a ticket, the optional suffix, and the normalized raw string.
 * @param {string} rawInput
 * @param {object} deps
 */
function resolvePlanTicket(rawInput, deps) {
  const { parseTicketInput, tp } = deps;
  const parsed = parseTicketInput(rawInput);
  const suffix = parsed.suffix;
  const initialCfg = tp.getProviderConfig({ skipPrompt: true });
  const { raw, providerConfig, ghUrlMeta } = normalizeRawTicket(parsed.ticketBase, initialCfg, tp);
  const { ticket, isTicket } = classifyTicket(raw, providerConfig);
  if (ghUrlMeta && providerConfig?.provider === 'github') {
    providerConfig.owner = ghUrlMeta.owner;
    providerConfig.repo = ghUrlMeta.repo;
  }
  return { ticket, providerConfig, ghUrlMeta, isTicket, suffix, raw };
}

/**
 * Persist DEFER metadata into work state for the transition guard (GH-154):
 * refresh an existing state's plan timestamp + deferred steps, or mint a
 * minimal state when the plan has DEFER steps but no state file yet.
 * @param {string} ticket
 * @param {object} result — the generated plan (with .timestamp + .plan)
 * @param {object} providerConfig
 * @param {string|null} suffix
 * @param {object} deps
 */
function persistDeferMetadata(ticket, result, providerConfig, suffix, deps) {
  const { tp, loadWorkState, saveWorkState, appendAction, STEPS, ALL_STEPS } = deps;
  const safeBase = tp.sanitizeTicketIdForPath(ticket, providerConfig);
  const safeName = suffix ? safeBase + '/' + suffix : safeBase;
  const planState = loadWorkState(safeName);
  if (planState) {
    planState.lastPlanTimestamp = result.timestamp;
    planState.deferredSteps = result.plan.filter((s) => s.action === 'DEFER').map((s) => s.step);
    saveWorkState(safeName, planState);
    return;
  }
  const deferSteps = result.plan.filter((s) => s.action === 'DEFER').map((s) => s.step);
  if (deferSteps.length === 0) return;
  const minimalState = {
    ticketId: safeName,
    description: '',
    currentStep: 1,
    status: 'in_progress',
    stepStatus: {},
    checkProgress: {},
    errors: [],
    startTime: new Date().toISOString(),
    lastPlanTimestamp: result.timestamp,
    deferredSteps: deferSteps,
  };
  ALL_STEPS.forEach((s) => {
    minimalState.stepStatus[s] = 'pending';
  });
  saveWorkState(safeName, minimalState);
  appendAction(safeName, { step: STEPS.ticket, what: 'workflow started' });
}

/**
 * Attach the inspected git/PR/report snapshot + allowed transitions onto the
 * plan result (only when a ticket state was inspected).
 * @param {object} result
 * @param {object} state
 * @param {object} STEP_TRANSITIONS
 */
function attachStateSnapshot(result, state, STEP_TRANSITIONS) {
  result.currentStep = state.currentStep;
  result.allowedTransitions = STEP_TRANSITIONS[state.currentStep] || [];
  result.state = {
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

/**
 * Stamp + enrich a generated plan result in place: timestamp, persisted DEFER
 * metadata, ticket URL, inspected-state snapshot, and the RUN/DEFER summary.
 * The summary object literal is kept inline here (not extracted into a helper)
 * so the GH-245 source-shape test can locate the assignment; it deliberately
 * carries only run/defer/pending counters.
 * @param {object} result
 * @param {{ticket, providerConfig, ghUrlMeta, suffix, state}} ctx
 * @param {object} deps
 */
function finalizePlanResult(result, ctx, deps) {
  const { ticket, providerConfig, ghUrlMeta, suffix, state } = ctx;
  const { tp, STEP_TRANSITIONS } = deps;
  result.timestamp = new Date().toISOString();
  if (ticket) persistDeferMetadata(ticket, result, providerConfig, suffix, deps);
  if (ghUrlMeta && providerConfig) result.ticketUrl = tp.ticketUrl(ticket, providerConfig);
  if (state) attachStateSnapshot(result, state, STEP_TRANSITIONS);
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

/**
 * `plan` subcommand: resolve the ticket, inspect state, generate + persist the
 * plan, and print it. Exits non-zero on empty input or a parse/generate error.
 * @param {string[]} rest
 * @param {object} deps
 */
function runPlan(rest, deps) {
  const { inspect, generatePlan, requirePaths } = deps;
  requirePaths();
  const rework = rest.includes('--rework');
  let raw = rest
    .filter((a) => a !== '--rework')
    .join(' ')
    .trim();
  if (!raw) {
    console.log(JSON.stringify({ error: true, message: 'Provide ticket ID or description' }));
    process.exit(1);
  }

  let ticket;
  let providerConfig;
  let ghUrlMeta;
  let isTicket;
  let suffix;
  try {
    ({ ticket, providerConfig, ghUrlMeta, isTicket, suffix, raw } = resolvePlanTicket(raw, deps));
  } catch (err) {
    console.log(JSON.stringify({ error: true, message: err.message }));
    process.exit(1);
  }

  const state = ticket ? inspect(ticket, providerConfig, suffix) : null;
  let result;
  try {
    result = generatePlan(ticket, isTicket ? null : raw, state, rework, providerConfig, suffix);
  } catch (err) {
    console.log(JSON.stringify({ error: true, message: err?.message || String(err) }));
    process.exit(1);
  }

  finalizePlanResult(result, { ticket, providerConfig, ghUrlMeta, suffix, state }, deps);
  console.log(JSON.stringify(result, null, 2));
}

/**
 * Parse + sanitize a raw ticket argv token into its filesystem-safe form,
 * shared by the transition/transitions/actions subcommands. Throws (via
 * parseTicketInput) on a parse failure.
 * @param {string} rawArg
 * @param {object} deps
 * @returns {string}
 */
function sanitizeTicketArg(rawArg, deps) {
  const { parseTicketInput, tp } = deps;
  const providerCfg = tp.getProviderConfig({ skipPrompt: true });
  const parsed = parseTicketInput(rawArg);
  const base = String(parsed.ticketBase).toUpperCase();
  return tp.sanitizeTicketIdForPath(base, providerCfg) + (parsed.suffix ? '/' + parsed.suffix : '');
}

/** `transition` subcommand: transition <TICKET> to <step>. */
function runTransition(rest, deps) {
  const { transitionStep, requirePaths, ALL_STEPS } = deps;
  requirePaths();
  if (rest.length < 2) {
    console.log(
      JSON.stringify({
        error: true,
        message: 'Usage: transition <TICKET> <step>',
        validSteps: ALL_STEPS,
      })
    );
    process.exit(1);
  }
  let ticket;
  try {
    ticket = sanitizeTicketArg(rest[0], deps);
  } catch (e) {
    console.log(JSON.stringify({ error: true, message: e.message }));
    process.exit(1);
  }
  console.log(JSON.stringify(transitionStep(ticket, rest[1]), null, 2));
}

/** `transitions` subcommand: list available transitions for <TICKET>. */
function runTransitions(rest, deps) {
  const { getAvailableTransitions, requirePaths } = deps;
  requirePaths();
  if (!rest[0]) {
    console.log(JSON.stringify({ error: true, message: 'Usage: transitions <TICKET>' }));
    process.exit(1);
  }
  let ticket;
  try {
    ticket = sanitizeTicketArg(rest[0], deps);
  } catch (e) {
    console.log(JSON.stringify({ error: true, message: e.message }));
    process.exit(1);
  }
  console.log(JSON.stringify(getAvailableTransitions(ticket), null, 2));
}

/** `graph` subcommand: print the full step + transition graph. */
function runGraph(deps) {
  const { ALL_STEPS, STEP_TRANSITIONS } = deps;
  console.log(JSON.stringify({ steps: ALL_STEPS, transitions: STEP_TRANSITIONS }, null, 2));
}

/** `actions` subcommand: dump (or analyze) the recorded actions for <TICKET>. */
function runActions(rest, deps) {
  const { loadActions, analyzeActions, requirePaths } = deps;
  requirePaths();
  if (!rest[0]) {
    console.log(JSON.stringify({ error: true, message: 'Usage: actions <TICKET> [--raw]' }));
    process.exit(1);
  }
  let ticket;
  try {
    ticket = sanitizeTicketArg(rest[0], deps);
  } catch (e) {
    console.log(JSON.stringify({ error: true, message: e.message }));
    process.exit(1);
  }
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
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(
      JSON.stringify({
        error: true,
        message:
          'Usage: work-orchestrator.js [plan|transition|transitions|graph|actions|cancel] <args>',
      })
    );
    process.exit(1);
  }

  const subcommands = ['plan', 'transition', 'transitions', 'graph', 'actions', 'cancel'];
  const command = subcommands.includes(args[0]) ? args[0] : 'plan';
  const rest = subcommands.includes(args[0]) ? args.slice(1) : args;

  switch (command) {
    case 'plan':
      runPlan(rest, deps);
      break;
    case 'transition':
      runTransition(rest, deps);
      break;
    case 'transitions':
      runTransitions(rest, deps);
      break;
    case 'graph':
      runGraph(deps);
      break;
    case 'actions':
      runActions(rest, deps);
      break;
    case 'cancel':
      runCancel(rest, {
        parseTicketInput: deps.parseTicketInput,
        tp: deps.tp,
        loadWorkState: deps.loadWorkState,
        requirePaths: deps.requirePaths,
      });
      break;
  }
}

module.exports = { main };
