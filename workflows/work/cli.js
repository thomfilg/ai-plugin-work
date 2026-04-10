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

function main(deps) {
  const {
    parseTicketInput,
    inspect,
    generatePlan,
    transitionStep,
    getAvailableTransitions,
    loadActions,
    analyzeActions,
    loadWorkState,
    saveWorkState,
    appendAction,
    requirePaths,
    tp,
    STEPS,
    ALL_STEPS,
    STEP_TRANSITIONS,
  } = deps;

  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(
      JSON.stringify({
        error: true,
        message: 'Usage: work-orchestrator.js [plan|transition|transitions|graph] <args>',
      })
    );
    process.exit(1);
  }

  const subcommands = ['plan', 'transition', 'transitions', 'graph', 'actions'];
  const command = subcommands.includes(args[0]) ? args[0] : 'plan';
  const rest = subcommands.includes(args[0]) ? args.slice(1) : args;

  switch (command) {
    case 'plan': {
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

      let suffix = null;
      try {
        const parsed = parseTicketInput(raw);
        raw = parsed.ticketBase;
        suffix = parsed.suffix;
      } catch (err) {
        console.log(JSON.stringify({ error: true, message: err.message }));
        process.exit(1);
      }

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
      const isGitHubEffective = providerConfig?.provider === 'github';
      const isJiraTicket = /^[A-Z]+-\d+$/i.test(raw);
      const isGitHubIssue = /^#?\d+$/.test(raw) && isGitHubEffective;
      const isGitHubPrefixed = /^GH-\d+$/i.test(raw) && isGitHubEffective;
      const isTicket = isJiraTicket || isGitHubIssue || isGitHubPrefixed;
      let ticket = isTicket ? raw.toUpperCase() : null;
      if (isTicket && isGitHubEffective) {
        const num = raw.replace(/^#|^GH-/i, '');
        ticket = '#' + num;
      }
      if (ghUrlMeta && isGitHubEffective) {
        providerConfig.owner = ghUrlMeta.owner;
        providerConfig.repo = ghUrlMeta.repo;
      }
      const state = ticket ? inspect(ticket, providerConfig, suffix) : null;
      const result = generatePlan(
        ticket,
        isTicket ? null : raw,
        state,
        rework,
        providerConfig,
        suffix
      );

      result.timestamp = new Date().toISOString();

      // Persist DEFER metadata into work state for transition guard (GH-154)
      if (ticket) {
        const safeBase_plan = tp.sanitizeTicketIdForPath(ticket, providerConfig);
        const safeName_plan = suffix ? safeBase_plan + '/' + suffix : safeBase_plan;
        const planState = loadWorkState(safeName_plan);
        if (planState) {
          planState.lastPlanTimestamp = result.timestamp;
          planState.deferredSteps = result.plan
            .filter((s) => s.action === 'DEFER')
            .map((s) => s.step);
          saveWorkState(safeName_plan, planState);
        } else {
          const deferSteps = result.plan.filter((s) => s.action === 'DEFER').map((s) => s.step);
          if (deferSteps.length > 0) {
            const minimalState = {
              ticketId: safeName_plan,
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
            saveWorkState(safeName_plan, minimalState);
            appendAction(safeName_plan, { step: STEPS.ticket, what: 'workflow started' });
          }
        }
      }

      if (ghUrlMeta && providerConfig) {
        result.ticketUrl = tp.ticketUrl(ticket, providerConfig);
      }
      if (state) {
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
      const by = (a) => result.plan.filter((s) => s.action === a);
      result.summary = {
        total: result.plan.length,
        run: by('RUN').length,
        skip: by('SKIP').length,
        defer: by('DEFER').length,
        pending: by('PENDING').length,
        firstAction: by('RUN')[0]?.step || by('DEFER')[0]?.step || 'none',
        stepsToRun: by('RUN').map((s) => s.step),
        stepsDeferred: by('DEFER').map((s) => s.step),
        stepsSkipped: by('SKIP').map((s) => s.step),
      };
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'transition': {
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
      const transProviderCfg = tp.getProviderConfig({ skipPrompt: true });
      let transParsed;
      try {
        transParsed = parseTicketInput(rest[0]);
      } catch (e) {
        console.log(JSON.stringify({ error: true, message: e.message }));
        process.exit(1);
      }
      const transBase =
        transProviderCfg?.provider === 'github'
          ? transParsed.ticketBase
          : transParsed.ticketBase.toUpperCase();
      const safeTransTicket =
        tp.sanitizeTicketIdForPath(transBase, transProviderCfg) +
        (transParsed.suffix ? '/' + transParsed.suffix : '');
      console.log(JSON.stringify(transitionStep(safeTransTicket, rest[1]), null, 2));
      break;
    }

    case 'transitions': {
      requirePaths();
      if (!rest[0]) {
        console.log(JSON.stringify({ error: true, message: 'Usage: transitions <TICKET>' }));
        process.exit(1);
      }
      const transitionsProviderCfg = tp.getProviderConfig({ skipPrompt: true });
      let transParsed2;
      try {
        transParsed2 = parseTicketInput(rest[0]);
      } catch (e) {
        console.log(JSON.stringify({ error: true, message: e.message }));
        process.exit(1);
      }
      const transBase2 =
        transitionsProviderCfg?.provider === 'github'
          ? transParsed2.ticketBase
          : transParsed2.ticketBase.toUpperCase();
      const safeTransitionsTicket =
        tp.sanitizeTicketIdForPath(transBase2, transitionsProviderCfg) +
        (transParsed2.suffix ? '/' + transParsed2.suffix : '');
      console.log(JSON.stringify(getAvailableTransitions(safeTransitionsTicket), null, 2));
      break;
    }

    case 'graph': {
      console.log(JSON.stringify({ steps: ALL_STEPS, transitions: STEP_TRANSITIONS }, null, 2));
      break;
    }

    case 'actions': {
      requirePaths();
      if (!rest[0]) {
        console.log(JSON.stringify({ error: true, message: 'Usage: actions <TICKET> [--raw]' }));
        process.exit(1);
      }
      const actionsProviderCfg = tp.getProviderConfig({ skipPrompt: true });
      let actionsParsed;
      try {
        actionsParsed = parseTicketInput(rest[0]);
      } catch (e) {
        console.log(JSON.stringify({ error: true, message: e.message }));
        process.exit(1);
      }
      const actionsBase =
        actionsProviderCfg?.provider === 'github'
          ? actionsParsed.ticketBase
          : actionsParsed.ticketBase.toUpperCase();
      const ticket =
        tp.sanitizeTicketIdForPath(actionsBase, actionsProviderCfg) +
        (actionsParsed.suffix ? '/' + actionsParsed.suffix : '');
      const raw = rest.includes('--raw');
      const actions = loadActions(ticket);
      if (raw) {
        console.log(JSON.stringify({ ticket, actions }, null, 2));
      } else {
        const analysis = analyzeActions(actions);
        console.log(JSON.stringify({ ticket, analysis, actions }, null, 2));
      }
      break;
    }
  }
}

module.exports = { main };
